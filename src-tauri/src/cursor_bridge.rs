//! Cursor provider uses the official `@cursor/sdk` local agent (Node bridge).
//! `api.cursor.com` has no OpenAI-compatible `/chat/completions` endpoint.

use crate::agent::HistoryTurn;
use crate::smart_agent::SmartAgentRun;
use crate::state::SessionRun;
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

#[derive(Debug, Deserialize)]
struct BridgeEvent {
    #[serde(rename = "type")]
    kind: String,
    text: Option<String>,
    message: Option<String>,
    id: Option<String>,
    name: Option<String>,
    arguments: Option<Value>,
    content: Option<String>,
    ok: Option<bool>,
    #[allow(dead_code)]
    status: Option<String>,
    #[allow(dead_code)]
    result: Option<String>,
    #[serde(rename = "agentId")]
    agent_id: Option<String>,
    /// The bridge sets this only when an implementation task explicitly
    /// declared the hidden completion marker in its final answer.
    completed: Option<bool>,
    #[serde(rename = "requestId")]
    request_id: Option<String>,
    summary: Option<String>,
    turn_tokens: Option<u64>,
    total_tokens: Option<u64>,
    iteration: Option<u32>,
}

// This is not a task or tool-loop limit. It only stops repeated Cursor passes
// that produce no tool activity at all; every concrete tool action resets it.
const MAX_CURSOR_CONSECUTIVE_STALLED_RECOVERIES: u8 = 4;
const CURSOR_FIRST_EVENT_TIMEOUT: Duration = Duration::from_secs(45);
const CURSOR_IDLE_TIMEOUT: Duration = Duration::from_secs(12 * 60);
const CURSOR_MAX_ACTIVE_DURATION: Duration = Duration::from_secs(45 * 60);

const CURSOR_AUTOMATIC_CONTINUATION_PROMPT: &str = "[System - Automatic continuation]\n\
The previous agent pass ended without the required completion marker. Continue the SAME implementation task from the current workspace and durable agent state.\n\
Do not repeat completed work and do not ask the client to type \"continue\". Inspect what remains, implement and verify the next steps, then finish with [[HORMACHUELOS_TASK_COMPLETE]] only when the full requested task is genuinely complete.";

#[derive(Debug)]
struct CursorTurnOutcome {
    agent_id: Option<String>,
    completion_marker_seen: bool,
    terminal: bool,
    made_concrete_progress: bool,
}

impl CursorTurnOutcome {
    fn terminal(agent_id: Option<String>) -> Self {
        Self {
            agent_id,
            completion_marker_seen: false,
            terminal: true,
            made_concrete_progress: false,
        }
    }
}

#[derive(Default)]
struct CursorPassActivity {
    made_concrete_progress: bool,
}

impl CursorPassActivity {
    fn record_tool_activity(&mut self) {
        self.made_concrete_progress = true;
    }
}

fn next_cursor_stalled_recovery_count(previous: u8, made_concrete_progress: bool) -> u8 {
    if made_concrete_progress {
        0
    } else {
        previous.saturating_add(1)
    }
}

#[derive(Clone, serde::Serialize)]
struct RunEvent {
    kind: String,
    session_id: String,
    payload: Value,
}

fn emit(app: &AppHandle, session_id: &str, kind: &str, payload: Value) {
    let _ = app.emit(
        "agent",
        RunEvent {
            kind: kind.to_string(),
            session_id: session_id.to_string(),
            payload,
        },
    );
}

async fn await_bridge_approval(
    _app: &AppHandle,
    _session_id: &str,
    _run: &SessionRun,
    _id: &str,
    _name: &str,
    _arguments: &Value,
    _summary: &str,
) -> bool {
    true
}

fn strip_windows_verbatim(path: PathBuf) -> PathBuf {
    let raw = path.to_string_lossy();
    // Windows canonicalize() yields \\?\C:\... which Node realpath mishandles as "C:".
    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = raw.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path
    }
}

fn current_exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
}

fn bridge_script_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(exe_dir) = current_exe_dir() {
        candidates.extend([
            exe_dir.join("scripts/cursor-bridge.mjs"),
            exe_dir.join("runtime/scripts/cursor-bridge.mjs"),
            exe_dir.join("resources/scripts/cursor-bridge.mjs"),
            exe_dir.join("resources/runtime/scripts/cursor-bridge.mjs"),
            exe_dir.join("resources/cursor-bridge.mjs"),
            exe_dir.join("_up_/scripts/cursor-bridge.mjs"),
            exe_dir.join("_up_/runtime/scripts/cursor-bridge.mjs"),
        ]);
    }
    // Source-tree paths are development fallbacks. Packaged releases must not
    // prefer a mutable checkout that happens to exist on the same machine.
    candidates.extend([
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/cursor-bridge.mjs"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../scripts/cursor-bridge.mjs"),
    ]);
    candidates
}

fn bridge_script_path() -> Result<PathBuf> {
    let candidates = bridge_script_candidates();
    for path in candidates {
        if let Ok(resolved) = path.canonicalize() {
            let resolved = strip_windows_verbatim(resolved);
            if resolved.is_file() {
                return Ok(resolved);
            }
        }
        if path.is_file() {
            return Ok(strip_windows_verbatim(path));
        }
    }
    Err(anyhow!(
        "Cursor bridge script not found. Bundle scripts/cursor-bridge.mjs under the app resources directory."
    ))
}

fn node_runtime_candidates(bridge: &Path) -> Vec<PathBuf> {
    let binary = if cfg!(windows) { "node.exe" } else { "node" };
    let mut candidates = Vec::new();
    if let Some(exe_dir) = current_exe_dir() {
        candidates.extend([
            exe_dir.join(binary),
            exe_dir.join("runtime").join(binary),
            exe_dir.join("resources").join(binary),
            exe_dir.join("resources/runtime").join(binary),
        ]);
    }
    if let Some(scripts_dir) = bridge.parent() {
        candidates.extend([
            scripts_dir.join(binary),
            scripts_dir.join("runtime").join(binary),
            scripts_dir
                .parent()
                .unwrap_or(scripts_dir)
                .join("runtime")
                .join(binary),
        ]);
    }
    candidates
}

fn node_runtime_path(bridge: &Path) -> PathBuf {
    for path in node_runtime_candidates(bridge) {
        if let Ok(resolved) = path.canonicalize() {
            let resolved = strip_windows_verbatim(resolved);
            if resolved.is_file() {
                return resolved;
            }
        }
        if path.is_file() {
            return strip_windows_verbatim(path);
        }
    }
    PathBuf::from(if cfg!(windows) { "node.exe" } else { "node" })
}

fn project_node_modules(bridge: &Path) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(scripts) = bridge.parent() {
        candidates.push(scripts.join("node_modules"));
        if let Some(root) = scripts.parent() {
            candidates.push(root.join("node_modules"));
        }
    }
    if let Some(exe_dir) = current_exe_dir() {
        candidates.extend([
            exe_dir.join("node_modules"),
            exe_dir.join("resources/node_modules"),
        ]);
    }
    candidates.into_iter().find(|path| path.is_dir())
}

/// Ask the Cursor SDK for every model available to this API key (installer built-in catalog).
pub async fn list_cursor_models(api_key: &str) -> Result<Vec<String>> {
    let bridge = bridge_script_path()?;
    let node_runtime = node_runtime_path(&bridge);
    let forge_root = bridge
        .parent()
        .and_then(|scripts| scripts.parent())
        .map(|p| strip_windows_verbatim(p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    let request = json!({
        "action": "list_models",
        "apiKey": api_key,
    });

    let mut cmd = Command::new(&node_runtime);
    cmd.arg(bridge.to_string_lossy().as_ref())
        .current_dir(&forge_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    if let Some(node_modules) = project_node_modules(&bridge) {
        let node_modules = strip_windows_verbatim(node_modules);
        let sep = if cfg!(windows) { ";" } else { ":" };
        let existing = std::env::var("NODE_PATH").unwrap_or_default();
        let node_path = if existing.is_empty() {
            node_modules.display().to_string()
        } else {
            format!("{}{}{}", node_modules.display(), sep, existing)
        };
        cmd.env("NODE_PATH", node_path);
    }
    cmd.env("NODE_NO_WARNINGS", "1");

    let mut child = cmd.spawn().with_context(|| {
        format!(
            "Failed to start Cursor runtime for model list at '{}'.",
            node_runtime.display()
        )
    })?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("Cursor bridge stdin missing"))?;
    stdin.write_all(format!("{request}\n").as_bytes()).await?;
    stdin.flush().await?;
    drop(stdin);

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("Cursor bridge stdout missing"))?;
    let mut lines = BufReader::new(stdout).lines();
    let mut models = Vec::new();
    let mut error: Option<String> = None;
    while let Some(line) = lines.next_line().await? {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let kind = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if kind == "models" {
            if let Some(arr) = event.get("models").and_then(|v| v.as_array()) {
                models = arr
                    .iter()
                    .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
                    .filter(|s| !s.is_empty())
                    .collect();
            }
        } else if kind == "error" {
            error = event
                .get("message")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
        }
    }
    let _ = child.wait().await;
    if models.is_empty() {
        if let Some(msg) = error {
            return Err(anyhow!(msg));
        }
        return Err(anyhow!("Cursor returned no models for this API key."));
    }
    Ok(models)
}

const CURSOR_HISTORY_MAX_TURNS: usize = 24;
const CURSOR_HISTORY_MAX_CHARS: usize = 24_000;
const CURSOR_HISTORY_MAX_TURN_CHARS: usize = 4_000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct BridgeHistoryTurn {
    role: String,
    content: String,
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn history_turn_content(turn: &HistoryTurn) -> String {
    let mut content = turn.content.trim().to_string();
    if turn.role.eq_ignore_ascii_case("tool") {
        let tool_name = turn.name.as_deref().unwrap_or("tool");
        content = format!("Tool result ({tool_name}): {content}");
    }
    if let Some(tool_calls) = turn.tool_calls.as_ref().filter(|calls| !calls.is_empty()) {
        let summaries = tool_calls
            .iter()
            .take(6)
            .map(|call| {
                let args = serde_json::to_string(&call.arguments).unwrap_or_else(|_| "{}".into());
                format!("{}({})", call.name, truncate_chars(&args, 500))
            })
            .collect::<Vec<_>>()
            .join(", ");
        if !content.is_empty() {
            content.push('\n');
        }
        content.push_str(&format!("Tool calls: {summaries}"));
    }
    truncate_chars(&content, CURSOR_HISTORY_MAX_TURN_CHARS)
}

fn bounded_cursor_history(history: &[HistoryTurn]) -> Vec<BridgeHistoryTurn> {
    let mut remaining = CURSOR_HISTORY_MAX_CHARS;
    let mut newest_first = Vec::new();

    for turn in history.iter().rev() {
        if newest_first.len() >= CURSOR_HISTORY_MAX_TURNS || remaining == 0 {
            break;
        }
        let role = match turn.role.trim().to_ascii_lowercase().as_str() {
            "user" => "user",
            "assistant" => "assistant",
            "system" => "system",
            "tool" => "tool",
            _ => continue,
        };
        let content = history_turn_content(turn);
        if content.is_empty() {
            continue;
        }
        let content = truncate_chars(&content, remaining);
        remaining = remaining.saturating_sub(content.chars().count());
        newest_first.push(BridgeHistoryTurn {
            role: role.into(),
            content,
        });
    }

    newest_first.reverse();
    newest_first
}

fn cursor_permission_enforcement(mode: &str) -> &'static str {
    match mode {
        "full" => "cursor_sdk_agent",
        "auto" => "cursor_sdk_auto_review",
        "research" | "plan" => "cursor_sdk_plan_read_only",
        _ => "cursor_sdk_plan_read_only",
    }
}

#[allow(clippy::too_many_arguments)]
fn handle_event(
    app: &AppHandle,
    session_id: &str,
    event: BridgeEvent,
    agent_id_out: &mut Option<String>,
    completion_marker_seen: &mut bool,
    saw_error: &mut Option<String>,
    smart_agent: &mut SmartAgentRun,
    activity: &mut CursorPassActivity,
    model: &str,
) -> bool {
    match event.kind.as_str() {
        "thinking" => {
            emit(app, session_id, "thinking", json!({ "iteration": 0 }));
        }
        "reasoning" => {
            if let Some(text) = event.text.filter(|t| !t.is_empty()) {
                emit(
                    app,
                    session_id,
                    "reasoning",
                    json!({ "text": text, "iteration": 0 }),
                );
            }
        }
        "text" => {
            if let Some(text) = event.text.filter(|t| !t.is_empty()) {
                emit(app, session_id, "text", json!({ "text": text }));
            }
        }
        "tool_call" => {
            let name = event.name.unwrap_or_else(|| "tool".into());
            let id = event.id.unwrap_or_else(|| name.clone());
            let arguments = event.arguments.unwrap_or_else(|| json!({}));
            smart_agent.on_tool_call(app, session_id, &id, &name, &arguments);
            activity.record_tool_activity();
            emit(
                app,
                session_id,
                "tool_call",
                json!({
                    "id": id,
                    "name": name,
                    "arguments": arguments,
                }),
            );
        }
        "tool_result" => {
            let name = event.name.unwrap_or_else(|| "tool".into());
            let id = event.id.unwrap_or_else(|| name.clone());
            let ok = event.ok.unwrap_or(true);
            smart_agent.on_tool_result(app, session_id, &id, &name, ok);
            activity.record_tool_activity();
            emit(
                app,
                session_id,
                "tool_result",
                json!({
                    "id": id,
                    "name": name,
                    "ok": ok,
                    "content": event.content.unwrap_or_default(),
                    "streamed": false,
                }),
            );
        }
        "done" => {
            if let Some(id) = event.agent_id.filter(|s| !s.is_empty()) {
                *agent_id_out = Some(id);
            }
            if event.completed.unwrap_or(false) {
                *completion_marker_seen = true;
            }
        }
        "usage" => {
            let raw = event.turn_tokens.unwrap_or(0);
            let billable = crate::license::to_billable_tokens("cursor", model, raw);
            // Cursor uses the customer's Cursor subscription/API key. It is
            // useful to show per-session tokens, but it must never burn or
            // hard-stop the separate Hormachuelos hosted-plan wallet.
            emit(
                app,
                session_id,
                "usage",
                json!({
                    "iteration": event.iteration.unwrap_or(0),
                    "turn_tokens": billable,
                    "raw_tokens": raw,
                    "total_tokens": event.total_tokens.unwrap_or(raw),
                    "license": null,
                }),
            );
        }
        "error" => {
            let msg = event
                .message
                .or(event.text)
                .unwrap_or_else(|| "Cursor SDK error".into());
            emit(
                app,
                session_id,
                "text",
                json!({ "text": format!("Error: {msg}") }),
            );
            *saw_error = Some(msg);
        }
        _ => {}
    }
    false
}

/// Run one user turn through Cursor's local SDK agent.
/// Returns the durable local agent id for follow-up turns in this session.
#[allow(clippy::too_many_arguments)]
pub async fn run_cursor_turn(
    app: Arc<AppHandle>,
    project_root: &str,
    prompt: &str,
    api_key: &str,
    model: &str,
    effort: &str,
    permission_mode: &str,
    computer_use_enabled: bool,
    session_id: &str,
    run: Arc<SessionRun>,
    history: &[HistoryTurn],
    resume_agent_id: Option<String>,
    requires_project_completion: bool,
    smart_agent_enabled: bool,
) -> Result<Option<String>> {
    let mut continuation_pass: u32 = 0;
    let mut consecutive_stalled_recoveries: u8 = 0;
    let mut current_prompt = prompt.to_string();
    let mut current_agent_id = resume_agent_id;
    let mut smart_agent = SmartAgentRun::new(smart_agent_enabled && requires_project_completion);
    smart_agent.emit_plan(&app, session_id);

    loop {
        let outcome = run_cursor_attempt(
            app.clone(),
            project_root,
            &current_prompt,
            api_key,
            model,
            effort,
            permission_mode,
            computer_use_enabled,
            session_id,
            run.clone(),
            history,
            current_agent_id.clone(),
            requires_project_completion,
            &mut smart_agent,
        )
        .await?;

        if let Some(id) = outcome.agent_id.filter(|id| !id.is_empty()) {
            current_agent_id = Some(id);
        }

        if outcome.terminal {
            return Ok(current_agent_id);
        }

        if outcome.completion_marker_seen {
            if smart_agent.request_final_review(&app, session_id) {
                continuation_pass = continuation_pass.saturating_add(1);
                emit(
                    &app,
                    session_id,
                    "reasoning",
                    json!({
                        "text": "Verifying the workspace before delivery...",
                        "iteration": continuation_pass,
                    }),
                );
                current_prompt = SmartAgentRun::final_review_instruction().to_string();
                continue;
            }
            smart_agent.complete(&app, session_id);
            emit(
                &app,
                session_id,
                "end",
                json!({ "reason": "completed", "iteration": continuation_pass }),
            );
            return Ok(current_agent_id);
        }

        if !requires_project_completion {
            // A regular Cursor reply is not an explicit task-completion
            // handshake. Keep its terminal reason distinct so the frontend
            // never announces it as "done working".
            emit(
                &app,
                session_id,
                "end",
                json!({ "reason": "no_tool_calls", "iteration": continuation_pass }),
            );
            return Ok(current_agent_id);
        }

        consecutive_stalled_recoveries = next_cursor_stalled_recovery_count(
            consecutive_stalled_recoveries,
            outcome.made_concrete_progress,
        );

        if current_agent_id.is_none() {
            smart_agent.pause(
                &app,
                session_id,
                "The Cursor agent ended without a resumable checkpoint.",
            );
            emit(
                &app,
                session_id,
                "text",
                json!({
                    "text": "\n\n— The Cursor agent finished without a resumable checkpoint, so automatic continuation could not safely preserve its state."
                }),
            );
            emit(
                &app,
                session_id,
                "end",
                json!({ "reason": "continuation_checkpoint_missing", "iteration": continuation_pass }),
            );
            return Ok(None);
        }

        if consecutive_stalled_recoveries >= MAX_CURSOR_CONSECUTIVE_STALLED_RECOVERIES {
            smart_agent.pause(
                &app,
                session_id,
                "Automatic recovery paused after repeated Cursor passes without tool activity.",
            );
            emit(
                &app,
                session_id,
                "text",
                json!({
                    "text": "\n\n— Automatic recovery paused after repeated Cursor passes without a concrete tool action. Your workspace and agent checkpoint are preserved."
                }),
            );
            emit(
                &app,
                session_id,
                "end",
                json!({ "reason": "continuation_safety_guard", "iteration": continuation_pass }),
            );
            return Ok(current_agent_id);
        }

        continuation_pass = continuation_pass.saturating_add(1);
        emit(
            &app,
            session_id,
            "reasoning",
            json!({
                "text": "Continuing automatically from the unfinished Cursor task...",
                "iteration": continuation_pass,
            }),
        );
        current_prompt = CURSOR_AUTOMATIC_CONTINUATION_PROMPT.to_string();
    }
}

/// Run one Cursor SDK pass. The outer runner owns automatic continuation so
/// the desktop keeps one user-initiated session active across resumed passes.
#[allow(clippy::too_many_arguments)]
async fn run_cursor_attempt(
    app: Arc<AppHandle>,
    project_root: &str,
    prompt: &str,
    api_key: &str,
    model: &str,
    effort: &str,
    permission_mode: &str,
    computer_use_enabled: bool,
    session_id: &str,
    run: Arc<SessionRun>,
    history: &[HistoryTurn],
    resume_agent_id: Option<String>,
    requires_project_completion: bool,
    smart_agent: &mut SmartAgentRun,
) -> Result<CursorTurnOutcome> {
    let bridge = bridge_script_path()?;
    let node_runtime = node_runtime_path(&bridge);
    let forge_root = bridge
        .parent()
        .and_then(|scripts| scripts.parent())
        .map(|p| strip_windows_verbatim(p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    let bridge_arg = bridge.to_string_lossy().to_string();
    let cancel = run.cancel.clone();
    let computer_use_active = computer_use_enabled && !crate::computer_use::is_paused();
    let computer_helper_path = if computer_use_active {
        std::env::current_exe()
            .ok()
            .map(strip_windows_verbatim)
            .map(|path| path.to_string_lossy().into_owned())
    } else {
        None
    };
    let computer_session_secret = computer_use_active.then(|| uuid::Uuid::new_v4().to_string());

    emit(
        &app,
        session_id,
        "start",
        json!({
            "prompt": prompt,
            "provider": "OpenAI",
            "model": model,
            "permission_mode": permission_mode,
            "permission_enforcement": cursor_permission_enforcement(permission_mode),
            "host_approval_callbacks": computer_use_active,
            "computer_use": computer_use_active,
        }),
    );
    emit(&app, session_id, "thinking", json!({ "iteration": 0 }));

    let bounded_history = bounded_cursor_history(history);
    let request = json!({
        "apiKey": api_key,
        "model": model,
        "effort": effort,
        "permissionMode": permission_mode,
        "cwd": strip_windows_verbatim(PathBuf::from(project_root)).to_string_lossy(),
        "prompt": prompt,
        "history": bounded_history,
        "agentId": resume_agent_id,
        "sessionId": session_id,
        "completionMarker": requires_project_completion.then_some("[[HORMACHUELOS_TASK_COMPLETE]]"),
        "computerUseEnabled": computer_use_active,
        "computerHelperPath": computer_helper_path,
        "computerSessionSecret": computer_session_secret,
    });

    // Prefer a bundled runtime. PATH is a development fallback only.
    let mut cmd = Command::new(&node_runtime);
    cmd.arg(&bridge_arg)
        .current_dir(&forge_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    // Hide the Node console window that otherwise pops over the desktop app.
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    if let Some(node_modules) = project_node_modules(&bridge) {
        let node_modules = strip_windows_verbatim(node_modules);
        let sep = if cfg!(windows) { ";" } else { ":" };
        let existing = std::env::var("NODE_PATH").unwrap_or_default();
        let node_path = if existing.is_empty() {
            node_modules.display().to_string()
        } else {
            format!("{}{}{}", node_modules.display(), sep, existing)
        };
        cmd.env("NODE_PATH", node_path);
    }
    cmd.env("NODE_NO_WARNINGS", "1");

    let mut child = cmd.spawn().with_context(|| {
        format!(
            "Failed to start the Cursor SDK Node runtime at '{}'. Bundle runtime/node.exe for releases or install Node.js 22+ for development.",
            node_runtime.display()
        )
    })?;

    if let Some(pid) = child.id() {
        *run.active_pid.lock().unwrap() = Some(pid);
    }

    let mut child_stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("Cursor bridge stdin missing"))?;
    let request_line = format!("{request}\n");
    child_stdin.write_all(request_line.as_bytes()).await?;
    child_stdin.flush().await?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("Cursor bridge stdout missing"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("Cursor bridge stderr missing"))?;

    let mut stdout_lines = BufReader::new(stdout).lines();
    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut tail = String::new();
        while let Ok(Some(line)) = lines.next_line().await {
            if tail.len() < 4000 {
                tail.push_str(&line);
                tail.push('\n');
            }
        }
        tail
    });

    let mut agent_id_out: Option<String> = None;
    let mut completion_marker_seen = !requires_project_completion;
    let mut saw_error: Option<String> = None;
    let mut activity = CursorPassActivity::default();
    let mut saw_bridge_event = false;
    let started = std::time::Instant::now();
    let mut last_bridge_event = started;

    loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = child.start_kill();
            emit(&app, session_id, "cancelled", json!({ "iteration": 0 }));
            *run.active_pid.lock().unwrap() = None;
            let _ = stderr_task.await;
            return Ok(CursorTurnOutcome::terminal(agent_id_out));
        }

        if !saw_bridge_event && started.elapsed() > CURSOR_FIRST_EVENT_TIMEOUT {
            let _ = child.start_kill();
            let msg = "Cursor SDK took too long to start. Check your Cursor API key and network, then try again.";
            emit(
                &app,
                session_id,
                "text",
                json!({ "text": format!("Error: {msg}") }),
            );
            emit(
                &app,
                session_id,
                "end",
                json!({ "reason": "timeout", "iteration": 0 }),
            );
            *run.active_pid.lock().unwrap() = None;
            let _ = stderr_task.await;
            return Err(anyhow!(msg));
        }

        if last_bridge_event.elapsed() > CURSOR_IDLE_TIMEOUT {
            let _ = child.start_kill();
            let msg = "Cursor SDK stopped reporting progress for 12 minutes.";
            emit(
                &app,
                session_id,
                "text",
                json!({ "text": format!("Error: {msg}") }),
            );
            emit(
                &app,
                session_id,
                "end",
                json!({ "reason": "timeout", "iteration": 0 }),
            );
            *run.active_pid.lock().unwrap() = None;
            let _ = stderr_task.await;
            return Err(anyhow!(msg));
        }

        if started.elapsed() > CURSOR_MAX_ACTIVE_DURATION {
            let _ = child.start_kill();
            let msg = "Cursor SDK reached the 45-minute active-run safety window.";
            emit(
                &app,
                session_id,
                "text",
                json!({ "text": format!("Error: {msg}") }),
            );
            emit(
                &app,
                session_id,
                "end",
                json!({ "reason": "timeout", "iteration": 0 }),
            );
            *run.active_pid.lock().unwrap() = None;
            let _ = stderr_task.await;
            return Err(anyhow!(msg));
        }

        match tokio::time::timeout(Duration::from_secs(2), stdout_lines.next_line()).await {
            Ok(Ok(Some(line))) => {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                saw_bridge_event = true;
                last_bridge_event = std::time::Instant::now();
                if let Ok(event) = serde_json::from_str::<BridgeEvent>(line) {
                    if event.kind == "approval_request" {
                        let Some(request_id) = event.request_id.filter(|value| !value.is_empty())
                        else {
                            saw_error =
                                Some("Cursor bridge sent an invalid approval request.".into());
                            break;
                        };
                        let name = event.name.unwrap_or_else(|| "computer_action".into());
                        let arguments = event.arguments.unwrap_or_else(|| json!({}));
                        let summary = event
                            .summary
                            .filter(|value| !value.is_empty())
                            .unwrap_or_else(|| format!("Allow {name}?"));
                        let approved = await_bridge_approval(
                            &app,
                            session_id,
                            &run,
                            &request_id,
                            &name,
                            &arguments,
                            &summary,
                        )
                        .await;
                        let response = json!({
                            "type": "approval_response",
                            "requestId": request_id,
                            "approved": approved,
                        });
                        let response_line = format!("{response}\n");
                        if let Err(error) = child_stdin.write_all(response_line.as_bytes()).await {
                            saw_error =
                                Some(format!("Failed writing Cursor bridge approval: {error}"));
                            break;
                        }
                        if let Err(error) = child_stdin.flush().await {
                            saw_error =
                                Some(format!("Failed flushing Cursor bridge approval: {error}"));
                            break;
                        }
                        continue;
                    }
                    let usage_blocked = handle_event(
                        &app,
                        session_id,
                        event,
                        &mut agent_id_out,
                        &mut completion_marker_seen,
                        &mut saw_error,
                        smart_agent,
                        &mut activity,
                        model,
                    );
                    if usage_blocked {
                        cancel.store(true, Ordering::SeqCst);
                        let _ = child.start_kill();
                        *run.active_pid.lock().unwrap() = None;
                        let _ = stderr_task.await;
                        emit(
                            &app,
                            session_id,
                            "end",
                            json!({ "reason": "usage_limit", "iteration": 0 }),
                        );
                        return Ok(CursorTurnOutcome::terminal(agent_id_out));
                    }
                }
            }
            Ok(Ok(None)) => break,
            Ok(Err(err)) => {
                saw_error = Some(format!("Failed reading Cursor bridge output: {err}"));
                break;
            }
            Err(_) => {
                // Periodic wake to re-check cancel + timeouts.
                continue;
            }
        }
    }

    if saw_error.is_some() {
        let _ = child.start_kill();
    }
    drop(child_stdin);
    let status = child
        .wait()
        .await
        .context("Cursor bridge process wait failed")?;
    let stderr_tail = stderr_task.await.unwrap_or_default();
    *run.active_pid.lock().unwrap() = None;

    if !status.success() && saw_error.is_none() {
        saw_error = Some(if stderr_tail.trim().is_empty() {
            format!("Cursor SDK exited with status {status}")
        } else {
            stderr_tail.trim().to_string()
        });
    }

    if let Some(err) = saw_error {
        emit(&app, session_id, "error", json!({ "message": err.clone() }));
        emit(
            &app,
            session_id,
            "end",
            json!({ "reason": "error", "iteration": 0 }),
        );
        return Err(anyhow!(err));
    }

    Ok(CursorTurnOutcome {
        agent_id: agent_id_out,
        completion_marker_seen,
        terminal: false,
        made_concrete_progress: activity.made_concrete_progress,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(role: &str, content: impl Into<String>) -> HistoryTurn {
        HistoryTurn {
            role: role.into(),
            content: content.into(),
            tool_calls: None,
            tool_call_id: None,
            name: None,
        }
    }

    #[test]
    fn cursor_history_keeps_the_newest_bounded_turns() {
        let history = (0..40)
            .map(|index| turn("user", format!("turn-{index}")))
            .collect::<Vec<_>>();

        let bounded = bounded_cursor_history(&history);

        assert_eq!(bounded.len(), CURSOR_HISTORY_MAX_TURNS);
        assert_eq!(bounded.first().unwrap().content, "turn-16");
        assert_eq!(bounded.last().unwrap().content, "turn-39");
    }

    #[test]
    fn cursor_history_is_unicode_safe_and_respects_character_budget() {
        let history = vec![turn(
            "assistant",
            "😀".repeat(CURSOR_HISTORY_MAX_CHARS + 100),
        )];

        let bounded = bounded_cursor_history(&history);

        assert_eq!(bounded.len(), 1);
        assert_eq!(
            bounded[0].content.chars().count(),
            CURSOR_HISTORY_MAX_TURN_CHARS
        );
    }

    #[test]
    fn packaged_bridge_and_runtime_locations_are_considered() {
        let bridge_candidates = bridge_script_candidates()
            .into_iter()
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .collect::<Vec<_>>();
        assert!(bridge_candidates
            .iter()
            .any(|path| path.ends_with("resources/scripts/cursor-bridge.mjs")));
        assert!(bridge_candidates
            .iter()
            .any(|path| path.ends_with("runtime/scripts/cursor-bridge.mjs")));

        let runtime_candidates =
            node_runtime_candidates(Path::new("resources/scripts/cursor-bridge.mjs"))
                .into_iter()
                .map(|path| path.to_string_lossy().replace('\\', "/"))
                .collect::<Vec<_>>();
        assert!(runtime_candidates
            .iter()
            .any(|path| path.contains("resources/runtime/node")));
    }

    #[test]
    fn restricted_modes_report_read_only_sdk_enforcement() {
        assert_eq!(
            cursor_permission_enforcement("plan"),
            "cursor_sdk_plan_read_only"
        );
        assert_eq!(
            cursor_permission_enforcement("research"),
            "cursor_sdk_plan_read_only"
        );
        assert_eq!(
            cursor_permission_enforcement("auto"),
            "cursor_sdk_auto_review"
        );
    }

    #[test]
    fn cursor_recovery_watchdog_resets_after_tool_activity() {
        let mut stalls = 0;
        for _ in 0..(MAX_CURSOR_CONSECUTIVE_STALLED_RECOVERIES - 1) {
            stalls = next_cursor_stalled_recovery_count(stalls, false);
        }
        assert!(stalls < MAX_CURSOR_CONSECUTIVE_STALLED_RECOVERIES);

        stalls = next_cursor_stalled_recovery_count(stalls, true);
        assert_eq!(stalls, 0);
    }
}
