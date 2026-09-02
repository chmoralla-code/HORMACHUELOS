//! PI mode — run a chat turn through the local pi CLI agent.
//!
//! pi (`@earendil-works/pi-coding-agent`) owns its own models, tools, and
//! session memory. The desktop host only renders pi's JSON activity as the
//! same agent events every other mode uses, so the UI surface is unchanged.
//!
//! Design:
//! - One Hormachuelos chat session maps to one pi session
//!   (`--session-id horma-<session>`), so follow-up turns keep pi's memory.
//! - pi is spawned non-interactively (`-p --mode json`) with the project
//!   folder as cwd, so its read/bash/edit/write tools operate on the open
//!   project.
//! - PI mode never touches the hosted wallet: pi runs on the user's own
//!   credentials (`pi auth`), so usage events are display-only.
//! - Stop (cancel) kills the pi process tree like any other run.

use crate::state::SessionRun;
use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};

fn emit(app: &AppHandle, session_id: &str, kind: &str, payload: Value) {
    #[derive(serde::Serialize, Clone)]
    struct PiRunEvent {
        kind: String,
        session_id: String,
        payload: Value,
    }
    let _ = app.emit(
        "agent",
        PiRunEvent {
            kind: kind.to_string(),
            session_id: session_id.to_string(),
            payload,
        },
    );
}

fn truncated(value: &str, max_chars: usize) -> String {
    let text = value.trim();
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let cut: String = text.chars().take(max_chars).collect();
    format!("{cut}…")
}

/// npm global prefix (e.g. %APPDATA%\npm) containing the `pi` shim.
fn npm_global_dir() -> Option<PathBuf> {
    let appdata = std::env::var("APPDATA").ok()?;
    let npm = Path::new(&appdata).join("npm");
    npm.join("pi.cmd").is_file().then_some(npm)
}

/// Parse the npm `pi.cmd` shim for the package entry script so pi can run
/// under node directly, without the quoting hazards of cmd wrappers.
fn pi_entry_script() -> Option<PathBuf> {
    let npm = npm_global_dir()?;
    let shim = std::fs::read_to_string(npm.join("pi.cmd")).ok()?;
    let text = shim.replace('\\', "/");
    let start = text.find("node_modules/")?;
    let rest = &text[start..];
    let js_end = rest.find(".js")? + ".js".len();
    let relative = &rest[..js_end];
    let path = npm.join(relative);
    path.is_file().then_some(path)
}

/// Prefer node.exe shipped for the Cursor bridge, then the npm prefix, then
/// whatever node is on PATH.
fn node_executable() -> PathBuf {
    let bundled = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .and_then(|target| target.parent().map(Path::to_path_buf))
        .map(|src_tauri| src_tauri.join("runtime").join("node.exe"))
        .filter(|path| path.is_file());
    if let Some(node) = bundled {
        return node;
    }
    if let Some(node) = npm_global_dir().map(|npm| npm.join("node.exe")).filter(|p| p.is_file()) {
        return node;
    }
    PathBuf::from("node.exe")
}

/// The pi launch configuration for one turn.
fn pi_command(session_id: &str) -> (PathBuf, Vec<String>) {
    if let Some(script) = pi_entry_script() {
        let args = vec![
            script.to_string_lossy().to_string(),
            "-p".into(),
            "--mode".into(),
            "json".into(),
            "--session-id".into(),
            format!("horma-{session_id}"),
        ];
        return (node_executable(), args);
    }
    // Fallback: run the shim directly; modern Rust escapes cmd wrappers.
    let args = vec![
        "-p".into(),
        "--mode".into(),
        "json".into(),
        "--session-id".into(),
        format!("horma-{session_id}"),
    ];
    (PathBuf::from("pi.cmd"), args)
}

/// Streaming translation state for one pi turn.
#[derive(Default)]
pub struct PiStreamState {
    turn: u32,
    tool_seq: u32,
    final_text: String,
    total_tokens: u64,
}

pub fn content_text(content: &Value) -> String {
    content
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

fn tool_result_text(result: &Value) -> String {
    let text = result.get("content").map(content_text).unwrap_or_default();
    if !text.is_empty() {
        return text;
    }
    result.to_string()
}

/// Pure translation of one pi JSON event into app agent events. Stays free
/// of I/O so the mapping is unit-testable.
pub fn pi_event_to_agent_events(event: &Value, state: &mut PiStreamState) -> Vec<(&'static str, Value)> {
    let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
    let mut out: Vec<(&'static str, Value)> = Vec::new();
    match kind {
        "agent_start" => {
            out.push(("thinking", json!({ "iteration": state.turn })));
        }
        "turn_start" => {
            state.turn = state.turn.saturating_add(1);
            out.push(("thinking", json!({ "iteration": state.turn })));
        }
        "message_update" => {
            let Some(msg_event) = event.get("assistantMessageEvent") else {
                return out;
            };
            match msg_event.get("type").and_then(Value::as_str).unwrap_or("") {
                "thinking_delta" => {
                    if let Some(delta) = msg_event.get("delta").and_then(Value::as_str) {
                        if !delta.is_empty() {
                            out.push((
                                "reasoning",
                                json!({ "text": delta, "iteration": state.turn }),
                            ));
                        }
                    }
                }
                "text_delta" => {
                    if let Some(delta) = msg_event.get("delta").and_then(Value::as_str) {
                        if !delta.is_empty() {
                            out.push(("text", json!({ "text": delta })));
                            state.final_text.push_str(delta);
                        }
                    }
                }
                "toolcall_start" => {
                    state.tool_seq = state.tool_seq.saturating_add(1);
                    let name = msg_event
                        .get("toolName")
                        .and_then(Value::as_str)
                        .unwrap_or("tool");
                    out.push((
                        "tool_preview",
                        json!({ "id": format!("pi-tool-{}", state.tool_seq), "name": name }),
                    ));
                }
                "toolcall_delta" => {
                    if let Some(delta) = msg_event.get("delta").and_then(Value::as_str) {
                        let name = msg_event
                            .get("toolName")
                            .and_then(Value::as_str)
                            .unwrap_or("tool");
                        out.push((
                            "tool_preview",
                            json!({
                                "id": format!("pi-tool-{}", state.tool_seq),
                                "name": name,
                                "arguments_delta": delta,
                            }),
                        ));
                    }
                }
                "toolcall_end" => {
                    let tool_call = msg_event.get("toolCall");
                    let id = tool_call
                        .and_then(|call| call.get("id"))
                        .and_then(Value::as_str)
                        .unwrap_or("pi-call")
                        .to_string();
                    let name = tool_call
                        .and_then(|call| call.get("name"))
                        .and_then(Value::as_str)
                        .unwrap_or("tool")
                        .to_string();
                    let arguments = tool_call
                        .and_then(|call| call.get("arguments"))
                        .cloned()
                        .unwrap_or_else(|| json!({}));
                    out.push((
                        "tool_call",
                        json!({
                            "id": id,
                            "name": name,
                            "arguments": arguments,
                            "preview_id": format!("pi-tool-{}", state.tool_seq),
                        }),
                    ));
                }
                _ => {}
            }
        }
        "tool_execution_start" => {
            let name = event.get("toolName").and_then(Value::as_str).unwrap_or("tool");
            out.push(("status", json!({ "message": format!("pi: running {name}…") })));
        }
        "tool_execution_end" => {
            let ok = !event
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let content = event.get("result").map(tool_result_text).unwrap_or_default();
            let preview = if content.len() > 8000 {
                format!("{}…(truncated)", truncated(&content, 8000))
            } else {
                content
            };
            // A tool result supersedes any streamed text as the turn's final
            // message; agent_end re-fills it with the closing assistant text.
            state.final_text.clear();
            out.push((
                "tool_result",
                json!({
                    "id": event.get("toolCallId").and_then(Value::as_str).unwrap_or("pi-call"),
                    "name": event.get("toolName").and_then(Value::as_str).unwrap_or("tool"),
                    "ok": ok,
                    "content": preview,
                }),
            ));
        }
        "message_end" => {
            if let Some(message) = event.get("message") {
                if message.get("role").and_then(Value::as_str) == Some("assistant") {
                    let used = message
                        .pointer("/usage/totalTokens")
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    if used > 0 {
                        state.total_tokens = state.total_tokens.saturating_add(used);
                        out.push((
                            "usage",
                            json!({
                                "iteration": state.turn,
                                "turn_tokens": used,
                                "raw_tokens": used,
                                "total_tokens": state.total_tokens,
                                "license": null,
                            }),
                        ));
                    }
                }
            }
        }
        "agent_end" => {
            if let Some(messages) = event.get("messages").and_then(Value::as_array) {
                if let Some(last) = messages
                    .iter()
                    .rev()
                    .find(|message| message.get("role").and_then(Value::as_str) == Some("assistant"))
                    .map(|message| content_text(message.get("content").unwrap_or(&Value::Null)))
                {
                    if !last.trim().is_empty() {
                        state.final_text = last;
                    }
                }
            }
        }
        _ => {}
    }
    out
}

/// Run one full pi turn for the session. Emits the same start/end envelope
/// every other provider path uses, so `sendPrompt` bookkeeping is unchanged.
pub async fn run_pi_turn(
    app: AppHandle,
    project_root: &str,
    prompt: &str,
    session_id: &str,
    run: Arc<SessionRun>,
) -> Result<()> {
    let root = Path::new(project_root);
    if !root.is_dir() {
        return Err(anyhow!("PI mode needs an open project folder."));
    }
    let (program, mut args) = pi_command(session_id);
    args.push(prompt.to_string());

    emit(
        &app,
        session_id,
        "start",
        json!({
            "prompt": prompt,
            "permission_mode": "pi",
            "provider": "pi",
        }),
    );

    let mut command = tokio::process::Command::new(&program);
    command
        .args(&args)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .with_context(|| format!("Could not start the pi CLI ({}).", program.display()))?;

    if let Some(pid) = child.id() {
        *run.active_pid.lock().unwrap() = Some(pid);
    }

    let stderr = child.stderr.take();
    let stderr_app = app.clone();
    let stderr_sid = session_id.to_string();
    let stderr_task = tokio::spawn(async move {
        if let Some(stderr) = stderr {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                emit(
                    &stderr_app,
                    &stderr_sid,
                    "console_chunk",
                    json!({ "stream": "pi", "text": format!("{line}\n") }),
                );
            }
        }
    });

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("pi CLI produced no output stream."))?;
    let mut lines = BufReader::new(stdout).lines();
    let mut state = PiStreamState::default();
    let mut aborted = false;

    while let Some(line) = lines.next_line().await? {
        if run.cancel.load(Ordering::SeqCst) {
            aborted = true;
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        for (kind, payload) in pi_event_to_agent_events(&event, &mut state) {
            emit(&app, session_id, kind, payload);
        }
    }
    stderr_task.abort();
    let status = child.wait().await;
    *run.active_pid.lock().unwrap() = None;

    if aborted || run.cancel.load(Ordering::SeqCst) {
        emit(&app, session_id, "cancelled", json!({ "iteration": state.turn }));
        emit(
            &app,
            session_id,
            "end",
            json!({ "reason": "cancelled", "iteration": state.turn, "total_tokens": state.total_tokens }),
        );
        return Ok(());
    }

    let status = match status {
        Ok(status) => status,
        Err(error) => return Err(anyhow!("pi CLI wait failed: {error}")),
    };
    if !status.success() {
        return Err(anyhow!(
            "pi CLI exited with {}. Install or repair it with `npm i -g @earendil-works/pi-coding-agent` and check `pi auth`.",
            status.code().unwrap_or(-1)
        ));
    }

    emit(
        &app,
        session_id,
        "done",
        json!({
            "summary": truncated(&state.final_text, 1200),
            "title": "",
            "description": "",
            "files": [],
            "tech": [],
            "features": [],
            "total_tokens": state.total_tokens,
        }),
    );
    emit(
        &app,
        session_id,
        "end",
        json!({
            "reason": "pi_complete",
            "iteration": state.turn,
            "total_tokens": state.total_tokens,
        }),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(line: &str) -> Value {
        serde_json::from_str(line).unwrap()
    }

    #[test]
    fn parses_npm_shim_entry_point() {
        let shim = "@ECHO off\r\nnode \"%~dp0\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js\" %*\r\n";
        let text = shim.replace('\\', "/");
        let start = text.find("node_modules/").unwrap();
        let rest = &text[start..];
        let js_end = rest.find(".js").unwrap() + ".js".len();
        let relative = &rest[..js_end];
        assert_eq!(
            relative,
            "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
        );
    }

    #[test]
    fn content_text_joins_blocks() {
        let value = parse(r#"[{"type":"text","text":"PI "},{"type":"text","text":"contents\n"}]"#);
        assert_eq!(content_text(&value), "PI contents\n");
    }

    #[test]
    fn tool_result_text_prefers_content_blocks() {
        let value = parse(r#"{"content":[{"type":"text","text":"42 rows"}],"isError":false}"#);
        assert_eq!(tool_result_text(&value), "42 rows");
    }

    #[test]
    fn maps_stream_events_to_agent_events() {
        let mut state = PiStreamState::default();

        pi_event_to_agent_events(&parse(r#"{"type":"agent_start"}"#), &mut state);
        assert_eq!(state.turn, 0);

        let events =
            pi_event_to_agent_events(&parse(r#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"TOOLS_OK"}}"#), &mut state);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, "text");
        assert_eq!(state.final_text, "TOOLS_OK");

        let events = pi_event_to_agent_events(
            &parse(
                r#"{"type":"message_update","assistantMessageEvent":{"type":"toolcall_end","toolCall":{"id":"call-1","name":"read","arguments":{"path":"a.txt"}}}}"#,
            ),
            &mut state,
        );
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, "tool_call");
        assert_eq!(events[0].1["preview_id"], "pi-tool-0");

        pi_event_to_agent_events(
            &parse(
                r#"{"type":"tool_execution_end","toolCallId":"call-1","toolName":"read","result":{"content":[{"type":"text","text":"ok"}]},"isError":false}"#,
            ),
            &mut state,
        );
        assert!(state.final_text.is_empty(), "tool result supersedes streamed text");

        pi_event_to_agent_events(
            &parse(r#"{"type":"message_end","message":{"role":"assistant","usage":{"totalTokens":42},"stopReason":"stop"}}"#),
            &mut state,
        );
        assert_eq!(state.total_tokens, 42);

        pi_event_to_agent_events(
            &parse(r#"{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"Final answer"}]}]}"#),
            &mut state,
        );
        assert_eq!(state.final_text, "Final answer");
    }
}
