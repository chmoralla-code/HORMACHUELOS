//! Claude Code stream-json harness integration for Build mode.
//!
//! Claude Code owns its own agent loop, native tools, and Task subagents. The
//! desktop app must therefore treat this process as a complete turn and only
//! render its stream-json activity; sending its tool calls back through the
//! Hormachuelos tool dispatcher would execute work twice.

use anyhow::{anyhow, Context, Result};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::Command;

const DEFAULT_FCC_PORT: u16 = 8082;
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const STDERR_MAX_BYTES: usize = 64 * 1024;
const TOOL_RESULT_MAX_BYTES: usize = 50 * 1024;

pub type EventSink = Arc<dyn Fn(ClaudeCodeEvent) + Send + Sync>;

#[derive(Debug, Clone)]
pub enum ClaudeCodeEvent {
    SessionId(String),
    Thinking(String),
    Content(String),
    ToolPreview {
        id: String,
        name: String,
        arguments_delta: String,
    },
    ToolCall {
        id: String,
        name: String,
        arguments: Value,
    },
    ToolResult {
        id: String,
        name: String,
        ok: bool,
        content: String,
    },
    AgentSpawn {
        id: String,
        name: String,
        arguments: Value,
    },
    Status(String),
}

#[derive(Debug, Clone, Default)]
pub struct ClaudeCodeTurn {
    pub session_id: Option<String>,
    pub text: Option<String>,
    pub usage_tokens: u64,
    pub stop_reason: String,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HarnessKind {
    FreeClaudeCode,
    ClaudeCodeCli,
}

impl HarnessKind {
    fn label(self) -> &'static str {
        match self {
            Self::FreeClaudeCode => "Free Claude Code launcher",
            Self::ClaudeCodeCli => "Claude Code CLI",
        }
    }
}

#[derive(Debug, Clone)]
struct HarnessCommand {
    kind: HarnessKind,
    program: PathBuf,
}

#[derive(Debug, Clone, Default)]
struct ToolState {
    id: String,
    name: String,
    raw_arguments: String,
}

struct StreamParser {
    sink: EventSink,
    session_id: Option<String>,
    visible_text: String,
    final_text: Option<String>,
    usage_tokens: u64,
    input_tokens: u64,
    output_tokens: u64,
    stop_reason: String,
    current_message_id: Option<String>,
    partial_message_ids: std::collections::HashSet<String>,
    tools_by_index: HashMap<usize, ToolState>,
    tools_by_id: HashMap<String, ToolState>,
    emitted_tool_ids: std::collections::HashSet<String>,
}

impl StreamParser {
    fn new(sink: EventSink) -> Self {
        Self {
            sink,
            session_id: None,
            visible_text: String::new(),
            final_text: None,
            usage_tokens: 0,
            input_tokens: 0,
            output_tokens: 0,
            stop_reason: String::new(),
            current_message_id: None,
            partial_message_ids: std::collections::HashSet::new(),
            tools_by_index: HashMap::new(),
            tools_by_id: HashMap::new(),
            emitted_tool_ids: std::collections::HashSet::new(),
        }
    }

    fn parse_line(&mut self, line: &str) -> Result<()> {
        let value: Value = serde_json::from_str(line)
            .with_context(|| format!("Claude Code emitted invalid JSON: {}", clip(line, 240)))?;
        self.observe_session_id(&value);
        self.consume_event(&value)
    }

    fn consume_event(&mut self, value: &Value) -> Result<()> {
        let kind = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if kind == "stream_event" {
            if let Some(event) = value.get("event") {
                self.observe_session_id(event);
                return self.consume_event(event);
            }
            return Ok(());
        }

        match kind {
            "system" => {
                if let Some(subtype) = value.get("subtype").and_then(Value::as_str) {
                    let clean = subtype.trim().to_ascii_lowercase();
                    if clean == "compacting" || clean == "compact_start" {
                        (self.sink)(ClaudeCodeEvent::Status("Compacting context…".into()));
                    } else if !clean.is_empty()
                        && clean != "init"
                        && clean != "thinking_tokens"
                        && !clean.contains("thinking")
                    {
                        (self.sink)(ClaudeCodeEvent::Status(format!(
                            "Claude Code · {}",
                            subtype.replace('_', " ")
                        )));
                    }
                }
            }
            "message_start" => {
                self.current_message_id = value
                    .pointer("/message/id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| value.get("id").and_then(Value::as_str).map(str::to_string));
                self.update_usage(value);
            }
            "content_block_start" => {
                let index = value
                    .get("index")
                    .and_then(Value::as_u64)
                    .unwrap_or(self.tools_by_index.len() as u64)
                    as usize;
                let Some(block) = value.get("content_block") else {
                    return Ok(());
                };
                if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                    return Ok(());
                }
                let id = block
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.trim().is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("claude-tool-{index}"));
                let name = block
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("tool")
                    .to_string();
                let mut state = ToolState {
                    id,
                    name,
                    raw_arguments: String::new(),
                };
                if let Some(input) = block.get("input") {
                    if !input.is_null() {
                        state.raw_arguments = serde_json::to_string(input)?;
                    }
                }
                self.tools_by_index.insert(index, state);
            }
            "content_block_delta" => {
                let delta = value.get("delta").unwrap_or(&Value::Null);
                match delta.get("type").and_then(Value::as_str) {
                    Some("text_delta") => {
                        if let Some(text) = delta.get("text").and_then(Value::as_str) {
                            self.partial_message_seen();
                            self.visible_text.push_str(text);
                            if !text.is_empty() {
                                (self.sink)(ClaudeCodeEvent::Content(text.to_string()));
                            }
                        }
                    }
                    Some("thinking_delta") => {
                        if let Some(text) = delta
                            .get("thinking")
                            .or_else(|| delta.get("text"))
                            .and_then(Value::as_str)
                        {
                            self.partial_message_seen();
                            if !text.is_empty() {
                                (self.sink)(ClaudeCodeEvent::Thinking(text.to_string()));
                            }
                        }
                    }
                    Some("input_json_delta") => {
                        let index = value
                            .get("index")
                            .and_then(Value::as_u64)
                            .unwrap_or_default() as usize;
                        let Some(state) = self.tools_by_index.get_mut(&index) else {
                            return Ok(());
                        };
                        let delta = delta
                            .get("partial_json")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        state.raw_arguments.push_str(delta);
                        (self.sink)(ClaudeCodeEvent::ToolPreview {
                            id: state.id.clone(),
                            name: state.name.clone(),
                            arguments_delta: delta.to_string(),
                        });
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                let index = value
                    .get("index")
                    .and_then(Value::as_u64)
                    .unwrap_or_default() as usize;
                if let Some(state) = self.tools_by_index.remove(&index) {
                    self.finish_tool(state)?;
                }
            }
            "message_delta" => {
                if let Some(reason) = value
                    .pointer("/delta/stop_reason")
                    .and_then(Value::as_str)
                    .or_else(|| value.get("stop_reason").and_then(Value::as_str))
                {
                    self.stop_reason = reason.to_string();
                }
                self.update_usage(value);
            }
            "assistant" => {
                self.consume_assistant_message(value)?;
            }
            "user" => {
                self.consume_tool_results(value)?;
            }
            "result" => {
                self.update_usage(value);
                if let Some(reason) = value.get("subtype").and_then(Value::as_str) {
                    self.stop_reason = reason.to_string();
                }
                if let Some(result) = value.get("result").and_then(Value::as_str) {
                    self.final_text = Some(result.to_string());
                    if self.visible_text.trim().is_empty() && !result.is_empty() {
                        self.visible_text.push_str(result);
                        (self.sink)(ClaudeCodeEvent::Content(result.to_string()));
                    }
                } else if let Some(message) = value.get("message") {
                    self.consume_message_content(message, value)?;
                }
                let is_error = value.get("is_error").and_then(Value::as_bool) == Some(true)
                    || value
                        .get("subtype")
                        .and_then(Value::as_str)
                        .is_some_and(|subtype| subtype != "success");
                if is_error {
                    let detail = value
                        .get("result")
                        .and_then(Value::as_str)
                        .or_else(|| value.get("error").and_then(Value::as_str))
                        .unwrap_or("Claude Code reported an unsuccessful result.");
                    return Err(anyhow!(detail.to_string()));
                }
            }
            "error" => {
                let detail = value
                    .get("error")
                    .and_then(|error| error.get("message").or_else(|| error.get("error")))
                    .and_then(Value::as_str)
                    .or_else(|| value.get("message").and_then(Value::as_str))
                    .unwrap_or("Claude Code emitted an error.");
                return Err(anyhow!(detail.to_string()));
            }
            _ => {}
        }
        Ok(())
    }

    fn observe_session_id(&mut self, value: &Value) {
        let candidate = [
            value.get("session_id"),
            value.get("sessionId"),
            value.pointer("/message/session_id"),
            value.pointer("/message/sessionId"),
            value.get("conversation_id"),
        ]
        .into_iter()
        .flatten()
        .find_map(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string);
        let Some(candidate) = candidate else {
            return;
        };
        if self.session_id.as_deref() == Some(candidate.as_str()) {
            return;
        }
        self.session_id = Some(candidate.clone());
        (self.sink)(ClaudeCodeEvent::SessionId(candidate));
    }

    fn partial_message_seen(&mut self) {
        if let Some(id) = &self.current_message_id {
            self.partial_message_ids.insert(id.clone());
        }
    }

    fn consume_assistant_message(&mut self, value: &Value) -> Result<()> {
        let message = value.get("message").unwrap_or(value);
        self.update_usage(message);
        self.consume_message_content(message, value)
    }

    fn consume_message_content(&mut self, message: &Value, outer: &Value) -> Result<()> {
        let message_id = message
            .get("id")
            .and_then(Value::as_str)
            .or_else(|| outer.get("message_id").and_then(Value::as_str));
        let has_partial = message_id
            .map(|id| self.partial_message_ids.contains(id))
            .unwrap_or(false);
        let content = message.get("content").unwrap_or(&Value::Null);
        if let Some(text) = content.as_str() {
            if !has_partial && !text.is_empty() {
                self.visible_text.push_str(text);
                (self.sink)(ClaudeCodeEvent::Content(text.to_string()));
            }
            return Ok(());
        }
        let Some(blocks) = content.as_array() else {
            return Ok(());
        };
        for block in blocks {
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if !has_partial {
                        if let Some(text) = block.get("text").and_then(Value::as_str) {
                            self.visible_text.push_str(text);
                            if !text.is_empty() {
                                (self.sink)(ClaudeCodeEvent::Content(text.to_string()));
                            }
                        }
                    }
                }
                Some("thinking") => {
                    if !has_partial {
                        if let Some(text) = block
                            .get("thinking")
                            .or_else(|| block.get("text"))
                            .and_then(Value::as_str)
                        {
                            if !text.is_empty() {
                                (self.sink)(ClaudeCodeEvent::Thinking(text.to_string()));
                            }
                        }
                    }
                }
                Some("tool_use") => {
                    let id = block
                        .get("id")
                        .and_then(Value::as_str)
                        .filter(|id| !id.trim().is_empty())
                        .unwrap_or("claude-tool")
                        .to_string();
                    let name = block
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("tool")
                        .to_string();
                    let arguments = block.get("input").cloned().unwrap_or_else(|| {
                        block
                            .get("arguments")
                            .cloned()
                            .unwrap_or_else(|| Value::Object(Default::default()))
                    });
                    self.emit_tool_call(id, name, arguments);
                }
                _ => {}
            }
        }
        Ok(())
    }

    fn consume_tool_results(&mut self, value: &Value) -> Result<()> {
        let message = value.get("message").unwrap_or(value);
        let content = message
            .get("content")
            .or_else(|| value.get("content"))
            .unwrap_or(&Value::Null);
        let Some(blocks) = content.as_array() else {
            return Ok(());
        };
        for block in blocks {
            if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                continue;
            }
            let id = block
                .get("tool_use_id")
                .or_else(|| block.get("toolUseId"))
                .and_then(Value::as_str)
                .unwrap_or("claude-tool")
                .to_string();
            let name = self
                .tools_by_id
                .get(&id)
                .map(|tool| tool.name.clone())
                .unwrap_or_else(|| "tool".into());
            let content = clip(
                &content_to_text(block.get("content").unwrap_or(&Value::Null)),
                TOOL_RESULT_MAX_BYTES,
            );
            let ok = block.get("is_error").and_then(Value::as_bool) != Some(true);
            (self.sink)(ClaudeCodeEvent::ToolResult {
                id,
                name,
                ok,
                content,
            });
        }
        Ok(())
    }

    fn finish_tool(&mut self, state: ToolState) -> Result<()> {
        let arguments = if state.raw_arguments.trim().is_empty() {
            Value::Object(Default::default())
        } else {
            serde_json::from_str(&state.raw_arguments).unwrap_or_else(
                |_| serde_json::json!({ "_raw": clip(&state.raw_arguments, 12_000) }),
            )
        };
        self.tools_by_id.insert(state.id.clone(), state.clone());
        self.emit_tool_call(state.id, state.name, arguments);
        Ok(())
    }

    fn emit_tool_call(&mut self, id: String, name: String, arguments: Value) {
        if !self.emitted_tool_ids.insert(id.clone()) {
            return;
        }
        self.tools_by_id
            .entry(id.clone())
            .or_insert_with(|| ToolState {
                id: id.clone(),
                name: name.clone(),
                raw_arguments: String::new(),
            });
        if is_agent_tool(&name) {
            (self.sink)(ClaudeCodeEvent::AgentSpawn {
                id: id.clone(),
                name: name.clone(),
                arguments: arguments.clone(),
            });
        }
        (self.sink)(ClaudeCodeEvent::ToolCall {
            id,
            name,
            arguments,
        });
    }

    fn update_usage(&mut self, value: &Value) {
        let Some(usage) = value
            .get("usage")
            .or_else(|| value.pointer("/message/usage"))
        else {
            return;
        };
        let input = usage
            .get("input_tokens")
            .or_else(|| usage.get("inputTokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let output = usage
            .get("output_tokens")
            .or_else(|| usage.get("outputTokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let total = usage
            .get("total_tokens")
            .or_else(|| usage.get("totalTokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        self.input_tokens = self.input_tokens.max(input);
        self.output_tokens = self.output_tokens.max(output);
        self.usage_tokens = self
            .usage_tokens
            .max(total)
            .max(self.input_tokens.saturating_add(self.output_tokens));
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn run_turn(
    root: &Path,
    prompt: &str,
    system_prompt: &str,
    model: &str,
    effort: &str,
    resume_session_id: Option<&str>,
    provider: &str,
    base_url: Option<&str>,
    cancel: Arc<AtomicBool>,
    active_pid: Arc<Mutex<Option<u32>>>,
    sink: EventSink,
) -> Result<ClaudeCodeTurn> {
    let harness = select_harness().await?;

    let is_batch = cfg!(windows)
        && harness
            .program
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"));

    let mut command = if is_batch {
        let mut cmd = Command::new("cmd.exe");
        cmd.arg("/C").arg(&harness.program);
        cmd
    } else {
        Command::new(&harness.program)
    };
    command
        .current_dir(root)
        .arg("-p")
        .arg(prompt)
        .arg("--output-format")
        .arg("stream-json")
        .arg("--include-partial-messages")
        .arg("--forward-subagent-text")
        .arg("--dangerously-skip-permissions")
        .arg("--verbose")
        .arg("--no-chrome")
        .arg("--effort")
        .arg(claude_effort(effort))
        .arg("--add-dir")
        .arg(root)
        .arg("--append-system-prompt")
        .arg(system_prompt)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(session_id) = resume_session_id.filter(|id| is_valid_session_id(id)) {
        command.arg("--resume").arg(session_id);
    }
    if let Some(model) = claude_model(model) {
        command.arg("--model").arg(model);
    }

    // Free Claude Code manages its own provider environment through its proxy.
    // Direct Claude Code can reuse an explicitly configured Anthropic key
    // without ever exposing it to the frontend event stream.
    if harness.kind == HarnessKind::ClaudeCodeCli && provider.eq_ignore_ascii_case("anthropic") {
        if let Ok(key) = crate::config::load_provider_api_key("anthropic") {
            if !key.trim().is_empty() {
                command.env("ANTHROPIC_API_KEY", key);
            }
        }
        if let Some(base_url) = base_url.filter(|url| !url.trim().is_empty()) {
            command.env("ANTHROPIC_BASE_URL", base_url);
        }
    }
    command.env("TERM", "dumb");
    command.env("CLAUDE_CODE_AUTO_COMPACT_WINDOW", "190000");
    command.env("PYTHONIOENCODING", "utf-8");

    #[cfg(windows)]
    {
        command.creation_flags(0x08000000);
    }

    let mut child = command.spawn().with_context(|| {
        format!(
            "Could not start {} at {}.",
            harness.kind.label(),
            harness.program.display()
        )
    })?;
    let pid = child.id();
    if let Some(pid) = pid {
        *active_pid.lock().unwrap() = Some(pid);
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("Claude Code stdout was not available."))?;
    let stderr = child.stderr.take();
    let stderr_task = stderr.map(|stream| {
        tokio::spawn(async move {
            let mut bytes = Vec::new();
            let _ = stream
                .take((STDERR_MAX_BYTES + 1) as u64)
                .read_to_end(&mut bytes)
                .await;
            bytes
        })
    });

    let mut lines = BufReader::new(stdout).lines();
    let mut parser = StreamParser::new(sink);
    loop {
        let next = tokio::select! {
            biased;
            _ = wait_until_cancelled(&cancel) => {
                stop_child(pid, &mut child).await;
                clear_active_pid(&active_pid, pid);
                return Ok(ClaudeCodeTurn { cancelled: true, ..Default::default() });
            }
            next = tokio::time::timeout(STREAM_IDLE_TIMEOUT, lines.next_line()) => next,
        };
        let line = match next {
            Ok(Ok(Some(line))) => line,
            Ok(Ok(None)) => break,
            Ok(Err(error)) => {
                stop_child(pid, &mut child).await;
                clear_active_pid(&active_pid, pid);
                return Err(anyhow!("Could not read Claude Code output: {error}"));
            }
            Err(_) => {
                stop_child(pid, &mut child).await;
                clear_active_pid(&active_pid, pid);
                return Err(anyhow!(
                    "Claude Code produced no stream event for {} minutes.",
                    STREAM_IDLE_TIMEOUT.as_secs() / 60
                ));
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        if let Err(error) = parser.parse_line(&line) {
            stop_child(pid, &mut child).await;
            clear_active_pid(&active_pid, pid);
            return Err(error);
        }
    }

    let status = child
        .wait()
        .await
        .context("Could not wait for Claude Code to finish.")?;
    clear_active_pid(&active_pid, pid);
    let stderr = match stderr_task {
        Some(task) => task.await.unwrap_or_default(),
        None => Vec::new(),
    };
    if cancel.load(Ordering::SeqCst) {
        return Ok(ClaudeCodeTurn {
            cancelled: true,
            ..Default::default()
        });
    }
    if !status.success() {
        let detail = String::from_utf8_lossy(&stderr);
        let detail = detail.trim();
        return Err(anyhow!(
            "Claude Code exited with {}{}",
            status,
            if detail.is_empty() {
                String::new()
            } else {
                format!(": {}", clip(detail, 4_000))
            }
        ));
    }

    Ok(ClaudeCodeTurn {
        session_id: parser.session_id,
        text: parser
            .final_text
            .or_else(|| (!parser.visible_text.trim().is_empty()).then_some(parser.visible_text)),
        usage_tokens: parser.usage_tokens,
        stop_reason: parser.stop_reason,
        cancelled: false,
    })
}

async fn select_harness() -> Result<HarnessCommand> {
    let preference = std::env::var("AI_FORGE_CLAUDE_HARNESS")
        .unwrap_or_else(|_| "auto".into())
        .trim()
        .to_ascii_lowercase();
    let fcc = resolve_installed_fcc();
    let direct = resolve_installed_claude();

    if matches!(preference.as_str(), "fcc" | "free-claude-code" | "free") {
        return fcc
            .map(|program| HarnessCommand {
                kind: HarnessKind::FreeClaudeCode,
                program,
            })
            .ok_or_else(|| anyhow!("Free Claude Code launcher was not found."));
    }
    if matches!(preference.as_str(), "claude" | "cli" | "direct") {
        return direct
            .map(|program| HarnessCommand {
                kind: HarnessKind::ClaudeCodeCli,
                program,
            })
            .ok_or_else(|| anyhow!("Claude Code CLI was not found."));
    }

    if let Some(program) = fcc.as_ref() {
        if fcc_server_reachable().await {
            return Ok(HarnessCommand {
                kind: HarnessKind::FreeClaudeCode,
                program: program.clone(),
            });
        }
    }
    direct
        .map(|program| HarnessCommand {
            kind: HarnessKind::ClaudeCodeCli,
            program,
        })
        .or_else(|| {
            fcc.map(|program| HarnessCommand {
                kind: HarnessKind::FreeClaudeCode,
                program,
            })
        })
        .ok_or_else(|| anyhow!("Neither Free Claude Code nor Claude Code CLI was found."))
}

fn explicit_binary_from_env(env_name: &str) -> Option<PathBuf> {
    if let Ok(value) = std::env::var(env_name) {
        let path = PathBuf::from(value.trim());
        if !path.as_os_str().is_empty() && path.is_file() {
            #[cfg(windows)]
            {
                if !is_valid_windows_executable(&path) {
                    return None;
                }
            }
            return Some(path);
        }
    }
    None
}

#[cfg(windows)]
fn is_valid_windows_executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
    {
        Some(ext) => matches!(ext.as_str(), "exe" | "cmd" | "bat" | "com"),
        None => false,
    }
}

fn resolve_installed_claude() -> Option<PathBuf> {
    if let Some(explicit) = explicit_binary_from_env("AI_FORGE_CLAUDE_BINARY")
        .or_else(|| explicit_binary_from_env("CLAUDE_CODE_PATH"))
        .or_else(|| explicit_binary_from_env("CLAUDE_PATH"))
    {
        return Some(explicit);
    }

    let mut candidates = Vec::new();
    let appdata = std::env::var_os("APPDATA").map(PathBuf::from);
    let localappdata = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let home = user_home();

    if let Some(appdata) = &appdata {
        candidates.push(
            appdata
                .join("npm")
                .join("node_modules")
                .join("@anthropic-ai")
                .join("claude-code")
                .join("bin")
                .join("claude.exe"),
        );
        candidates.push(
            appdata
                .join("npm")
                .join("node_modules")
                .join("@anthropic-ai")
                .join("claude-code")
                .join("node_modules")
                .join("@anthropic-ai")
                .join("claude-code-win32-x64")
                .join("claude.exe"),
        );
    }
    if let Some(localappdata) = &localappdata {
        candidates.push(
            localappdata
                .join("Programs")
                .join("@anthropic-ai")
                .join("claude-code")
                .join("bin")
                .join("claude.exe"),
        );
        candidates.push(
            localappdata
                .join("Programs")
                .join("claude")
                .join("claude.exe"),
        );
    }
    if let Some(home) = &home {
        candidates.push(home.join(".local").join("bin").join(if cfg!(windows) {
            "claude.exe"
        } else {
            "claude"
        }));
        candidates.push(home.join(".claude").join("bin").join(if cfg!(windows) {
            "claude.exe"
        } else {
            "claude"
        }));
        candidates.push(
            home.join("AppData")
                .join("Roaming")
                .join("npm")
                .join("node_modules")
                .join("@anthropic-ai")
                .join("claude-code")
                .join("bin")
                .join("claude.exe"),
        );
        candidates.push(
            home.join(".npm-global")
                .join("node_modules")
                .join("@anthropic-ai")
                .join("claude-code")
                .join("bin")
                .join(if cfg!(windows) {
                    "claude.exe"
                } else {
                    "claude"
                }),
        );
    }

    #[cfg(unix)]
    {
        candidates.push(PathBuf::from("/usr/local/bin/claude"));
        candidates.push(PathBuf::from("/opt/homebrew/bin/claude"));
    }

    for candidate in candidates {
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    #[cfg(windows)]
    {
        if let Some(found) = find_on_path(&["claude.exe"]) {
            return Some(found);
        }
        if let Some(cmd_path) = find_on_path(&["claude.cmd", "claude.bat"]) {
            if let Some(parent) = cmd_path.parent() {
                let direct_exe = parent
                    .join("node_modules")
                    .join("@anthropic-ai")
                    .join("claude-code")
                    .join("bin")
                    .join("claude.exe");
                if direct_exe.is_file() {
                    return Some(direct_exe);
                }
                let nested_exe = parent
                    .join("node_modules")
                    .join("@anthropic-ai")
                    .join("claude-code")
                    .join("node_modules")
                    .join("@anthropic-ai")
                    .join("claude-code-win32-x64")
                    .join("claude.exe");
                if nested_exe.is_file() {
                    return Some(nested_exe);
                }
            }
            return Some(cmd_path);
        }
    }

    #[cfg(not(windows))]
    {
        if let Some(found) = find_on_path(&["claude"]) {
            return Some(found);
        }
    }

    None
}

fn resolve_installed_fcc() -> Option<PathBuf> {
    if let Some(explicit) = explicit_binary_from_env("AI_FORGE_FCC_BINARY")
        .or_else(|| explicit_binary_from_env("FCC_CLAUDE_PATH"))
        .or_else(|| explicit_binary_from_env("FCC_PATH"))
    {
        return Some(explicit);
    }

    let mut candidates = Vec::new();
    let home = user_home();
    let localappdata = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);

    if let Some(home) = &home {
        candidates.push(home.join(".local").join("bin").join(if cfg!(windows) {
            "fcc-claude.exe"
        } else {
            "fcc-claude"
        }));
        candidates.push(home.join(".fcc").join("bin").join(if cfg!(windows) {
            "fcc-claude.exe"
        } else {
            "fcc-claude"
        }));
    }
    if let Some(localappdata) = &localappdata {
        candidates.push(
            localappdata
                .join("Programs")
                .join("fcc-claude")
                .join("fcc-claude.exe"),
        );
    }

    #[cfg(unix)]
    {
        candidates.push(PathBuf::from("/usr/local/bin/fcc-claude"));
        candidates.push(PathBuf::from("/opt/homebrew/bin/fcc-claude"));
    }

    for candidate in candidates {
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    #[cfg(windows)]
    {
        find_on_path(&["fcc-claude.exe", "fcc-claude.cmd", "fcc-claude.bat"])
    }
    #[cfg(not(windows))]
    {
        find_on_path(&["fcc-claude"])
    }
}

fn find_on_path(names: &[&str]) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for directory in std::env::split_paths(&path) {
        for name in names {
            let candidate = directory.join(name);
            if candidate.is_file() {
                #[cfg(windows)]
                {
                    if !is_valid_windows_executable(&candidate) {
                        continue;
                    }
                }
                return Some(candidate);
            }
        }
    }
    None
}

fn user_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

fn fcc_port() -> u16 {
    for key in ["AI_FORGE_FCC_PORT", "FCC_PORT"] {
        if let Ok(value) = std::env::var(key) {
            if let Ok(port) = value.trim().parse::<u16>() {
                return port;
            }
        }
    }
    if let Some(home) = user_home() {
        let env_file = home.join(".fcc").join(".env");
        if let Ok(contents) = std::fs::read_to_string(env_file) {
            for line in contents.lines() {
                let Some((key, value)) = line.split_once('=') else {
                    continue;
                };
                if key.trim() == "PORT" {
                    if let Ok(port) = value.trim().trim_matches('"').parse::<u16>() {
                        return port;
                    }
                }
            }
        }
    }
    DEFAULT_FCC_PORT
}

async fn fcc_server_reachable() -> bool {
    tokio::time::timeout(
        Duration::from_millis(350),
        TcpStream::connect(("127.0.0.1", fcc_port())),
    )
    .await
    .is_ok_and(|result| result.is_ok())
}

fn claude_effort(effort: &str) -> &'static str {
    match effort.trim().to_ascii_lowercase().as_str() {
        "low" | "light" => "low",
        "medium" => "medium",
        "high" => "high",
        "xhigh" | "extra" | "extra-high" | "extrahigh" => "xhigh",
        "ultra" | "max" => "max",
        _ => "high",
    }
}

fn claude_model(model: &str) -> Option<&str> {
    let trimmed = model.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();
    (lower.starts_with("claude")
        || lower.contains("sonnet")
        || lower.contains("opus")
        || lower.contains("haiku"))
    .then_some(trimmed)
}

pub fn is_valid_session_id(value: &str) -> bool {
    uuid::Uuid::parse_str(value.trim()).is_ok()
}

fn is_agent_tool(name: &str) -> bool {
    matches!(
        name.trim()
            .replace([' ', '-', '.'], "_")
            .to_ascii_lowercase()
            .as_str(),
        "task" | "agent" | "spawn_agent" | "subagent" | "task_create"
    )
}

fn content_to_text(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.to_string();
    }
    if let Some(array) = value.as_array() {
        return array
            .iter()
            .map(content_to_text)
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
    }
    if let Some(text) = value.get("text").and_then(Value::as_str) {
        return text.to_string();
    }
    value.to_string()
}

fn clip(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &value[..end])
}

async fn wait_until_cancelled(cancel: &AtomicBool) {
    while !cancel.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

async fn stop_child(pid: Option<u32>, child: &mut tokio::process::Child) {
    if let Some(pid) = pid {
        crate::tools::kill_process_tree(pid);
    }
    let _ = child.kill().await;
}

fn clear_active_pid(active_pid: &Mutex<Option<u32>>, pid: Option<u32>) {
    let mut active = active_pid.lock().unwrap();
    if active.as_ref() == pid.as_ref() {
        *active = None;
    }
}

#[cfg(test)]
mod tests {
    use super::{is_agent_tool, is_valid_session_id, ClaudeCodeEvent, StreamParser};
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    #[test]
    fn parser_streams_thinking_text_tools_and_results_once() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let events_for_sink = events.clone();
        let sink = Arc::new(move |event| events_for_sink.lock().unwrap().push(event));
        let mut parser = StreamParser::new(sink);

        parser
            .parse_line(
                &json!({
                    "type": "system",
                    "session_id": "00000000-0000-4000-8000-000000000001"
                })
                .to_string(),
            )
            .unwrap();
        parser
            .parse_line(
                &json!({
                    "type": "stream_event",
                    "session_id": "00000000-0000-4000-8000-000000000001",
                    "event": {
                        "type": "message_start",
                        "message": {
                            "id": "msg_1",
                            "usage": {"input_tokens": 12}
                        }
                    }
                })
                .to_string(),
            )
            .unwrap();
        for line in [
            json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Inspect "}}}),
            json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"the repo."}}}),
            json!({"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"I found it."}}}),
            json!({"type":"stream_event","event":{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"tool_1","name":"Task","input":{}}}}),
            json!({"type":"stream_event","event":{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"description\":\"check\"}"}}}),
            json!({"type":"stream_event","event":{"type":"content_block_stop","index":2}}),
            json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool_1","content":"agent finished"}]}}),
            json!({"type":"result","subtype":"success","result":"I found it.","usage":{"output_tokens":9}}),
        ] {
            parser.parse_line(&line.to_string()).unwrap();
        }

        let events = events.lock().unwrap();
        assert!(events
            .iter()
            .any(|event| matches!(event, ClaudeCodeEvent::Thinking(text) if text == "Inspect ")));
        assert!(events
            .iter()
            .any(|event| matches!(event, ClaudeCodeEvent::Content(text) if text == "I found it.")));
        assert!(events.iter().any(
            |event| matches!(event, ClaudeCodeEvent::AgentSpawn { name, .. } if name == "Task")
        ));
        assert!(events.iter().any(|event| matches!(event, ClaudeCodeEvent::ToolResult { ok: true, content, .. } if content == "agent finished")));
        assert_eq!(parser.usage_tokens, 21);
    }

    #[test]
    fn recognizes_valid_resume_ids_and_agent_tools() {
        assert!(is_valid_session_id("00000000-0000-4000-8000-000000000001"));
        assert!(!is_valid_session_id("cursor-agent-id"));
        assert!(is_agent_tool("Task"));
        assert!(is_agent_tool("spawn-agent"));
        assert!(!is_agent_tool("Bash"));
    }

    #[test]
    fn resolves_installed_claude_binary_when_available() {
        let binary = super::resolve_installed_claude();
        if let Some(binary) = binary {
            assert!(binary.is_file());
            #[cfg(windows)]
            {
                assert!(super::is_valid_windows_executable(&binary));
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn validates_windows_executable_extensions() {
        use std::path::Path;
        assert!(super::is_valid_windows_executable(Path::new(
            "C:\\Windows\\System32\\cmd.exe"
        )));
        assert!(!super::is_valid_windows_executable(Path::new(
            "C:\\Users\\test\\npm\\claude"
        )));
        assert!(!super::is_valid_windows_executable(Path::new(
            "C:\\Users\\test\\npm\\claude.ps1"
        )));
    }
}
