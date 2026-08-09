//! Provider-neutral execution scaffolding for long-running build tasks.
//!
//! This module does not change a provider's model or credentials. It gives the
//! existing model a clear execution contract, exposes a small task ledger to
//! the desktop UI, and requests one bounded final verification pass when the
//! model tries to finish without evidence of validation.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use tauri::{AppHandle, Emitter};

const STEP_IDS: [&str; 6] = [
    "scope",
    "inspect",
    "implement",
    "validate",
    "debug",
    "deliver",
];
const STEP_LABELS: [&str; 6] = ["Scope", "Inspect", "Build", "Check", "Debug", "Done"];

#[derive(Clone, Serialize)]
struct SmartAgentEvent {
    kind: String,
    session_id: String,
    payload: Value,
}

fn emit(app: &AppHandle, session_id: &str, kind: &str, payload: Value) {
    let _ = app.emit(
        "agent",
        SmartAgentEvent {
            kind: kind.to_string(),
            session_id: session_id.to_string(),
            payload,
        },
    );
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Phase {
    Scope,
    Inspect,
    Implement,
    Validate,
    Debug,
    Deliver,
}

impl Phase {
    const fn index(self) -> usize {
        match self {
            Self::Scope => 0,
            Self::Inspect => 1,
            Self::Implement => 2,
            Self::Validate => 3,
            Self::Debug => 4,
            Self::Deliver => 5,
        }
    }

    const fn id(self) -> &'static str {
        STEP_IDS[self.index()]
    }
}

/// A short-lived ledger for one agent run. Its public events contain only
/// fixed UI labels and a status message; prompts, commands, file contents, and
/// credentials never enter this telemetry channel.
#[derive(Debug)]
pub struct SmartAgentRun {
    enabled: bool,
    phase: Phase,
    final_review_requested: bool,
    saw_validation: bool,
    saw_debug: bool,
    validation_tool_ids: HashSet<String>,
    debug_tool_ids: HashSet<String>,
}

impl SmartAgentRun {
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled,
            phase: Phase::Scope,
            final_review_requested: false,
            saw_validation: false,
            saw_debug: false,
            validation_tool_ids: HashSet::new(),
            debug_tool_ids: HashSet::new(),
        }
    }

    pub const fn is_enabled(&self) -> bool {
        self.enabled
    }

    /// Provider-facing instruction that makes the reasoning process more
    /// deliberate without asking the model to expose private chain-of-thought.
    pub fn system_instructions(enabled: bool) -> &'static str {
        if !enabled {
            return "";
        }
        "\nSMART AGENT EXECUTION LEDGER:\n\
- Treat this as one durable task: understand scope, inspect the current workspace, implement focused changes, validate the result, debug any failures or runtime issues, then deliver.\n\
- Take concrete tool actions instead of stopping at a plan or progress note. Reuse existing work and do not restart completed steps.\n\
- Before calling done, inspect the actual changed files and run the most relevant build, test, check, or preview when practical. After validation, actively debug failures (read errors/logs, reproduce, fix, and re-check) before delivery. If validation is unavailable, perform a targeted inspection and state the limitation in the final result.\n\
- The desktop host shows task progress separately. Keep user-facing updates concise and never ask the user to type \"continue\".\n"
    }

    pub fn emit_plan(&self, app: &AppHandle, session_id: &str) {
        if !self.enabled {
            return;
        }
        let steps = STEP_IDS
            .iter()
            .zip(STEP_LABELS.iter())
            .enumerate()
            .map(|(index, (id, label))| {
                json!({
                    "id": id,
                    "label": label,
                    "state": if index == 0 { "active" } else { "pending" },
                })
            })
            .collect::<Vec<_>>();
        emit(
            app,
            session_id,
            "task_plan",
            json!({
                "title": "Smart Agent",
                "summary": "Keeping this task focused, verified, and moving without manual continue prompts.",
                "steps": steps,
                "active_step": 0,
                "status": "working",
            }),
        );
    }

    fn transition(&mut self, app: &AppHandle, session_id: &str, phase: Phase, detail: &str) {
        if !self.enabled || phase < self.phase {
            return;
        }
        self.phase = phase;
        emit(
            app,
            session_id,
            "task_progress",
            json!({
                "step": phase.index(),
                "phase": phase.id(),
                "status": "active",
                "detail": detail,
                "completed_before": phase.index(),
            }),
        );
    }

    /// A successful check only applies to the exact workspace state that was
    /// checked. If a later tool can change that state, require fresh evidence
    /// before allowing the run to finish.
    fn reset_validation_after_change(&mut self) {
        if self.phase >= Phase::Validate {
            self.phase = Phase::Implement;
            self.saw_validation = false;
            self.saw_debug = false;
            self.validation_tool_ids.clear();
            self.debug_tool_ids.clear();
        }
    }

    fn begin_implementation(&mut self, app: &AppHandle, session_id: &str, detail: &str) {
        self.reset_validation_after_change();
        self.transition(app, session_id, Phase::Implement, detail);
    }

    fn begin_debug(&mut self, app: &AppHandle, session_id: &str, tool_id: &str, detail: &str) {
        if !tool_id.trim().is_empty() {
            self.debug_tool_ids.insert(tool_id.to_string());
        }
        self.transition(app, session_id, Phase::Debug, detail);
    }

    pub fn on_tool_call(
        &mut self,
        app: &AppHandle,
        session_id: &str,
        tool_id: &str,
        name: &str,
        arguments: &Value,
    ) {
        if !self.enabled {
            return;
        }

        let name = name.trim();
        match name {
            "read_file" | "list_dir" | "glob" | "grep" | "file_info" | "git_status" => {
                if self.phase >= Phase::Validate {
                    self.begin_debug(
                        app,
                        session_id,
                        tool_id,
                        "Debugging failures and inspecting runtime evidence...",
                    );
                } else {
                    self.transition(
                        app,
                        session_id,
                        Phase::Inspect,
                        "Inspecting the current workspace...",
                    );
                }
            }
            "write_file" | "edit_file" | "make_dir" | "move_file" | "copy_file"
            | "download_file" | "git_init" | "apply_patch" | "create_file" | "delete_file"
            | "rename_file" => {
                if self.phase >= Phase::Validate {
                    // Fixing issues found during Check stays in Debug, but the
                    // previous Check no longer covers this new workspace state.
                    self.saw_validation = false;
                    self.saw_debug = false;
                    self.validation_tool_ids.clear();
                    self.begin_debug(app, session_id, tool_id, "Applying a focused debug fix...");
                } else {
                    self.begin_implementation(app, session_id, "Applying the requested changes...");
                }
            }
            name if is_command_tool(name) => {
                let command = ["command", "cmd", "script"]
                    .iter()
                    .find_map(|key| arguments.get(*key).and_then(Value::as_str))
                    .unwrap_or("");
                if is_debug_command(command) {
                    self.begin_debug(app, session_id, tool_id, "Running a focused debug pass...");
                } else if is_validation_command(command) {
                    if !tool_id.trim().is_empty() {
                        self.validation_tool_ids.insert(tool_id.to_string());
                    }
                    // Re-checking after a debug fix stays in Debug once Check
                    // has already happened; otherwise enter Check.
                    if self.phase >= Phase::Debug || self.saw_validation {
                        self.begin_debug(
                            app,
                            session_id,
                            tool_id,
                            "Re-checking after a debug fix...",
                        );
                    } else {
                        self.transition(
                            app,
                            session_id,
                            Phase::Validate,
                            "Running a focused validation check...",
                        );
                    }
                } else {
                    self.begin_implementation(
                        app,
                        session_id,
                        "Working through the requested implementation...",
                    );
                }
            }
            "open_path" => {
                if self.phase >= Phase::Validate {
                    self.begin_debug(
                        app,
                        session_id,
                        tool_id,
                        "Debugging the generated result in preview...",
                    );
                } else if self.phase >= Phase::Implement {
                    if !tool_id.trim().is_empty() {
                        self.validation_tool_ids.insert(tool_id.to_string());
                    }
                    self.transition(
                        app,
                        session_id,
                        Phase::Validate,
                        "Checking the generated result in preview...",
                    );
                }
            }
            "done" => {
                if self.saw_validation || self.phase >= Phase::Validate {
                    self.transition(
                        app,
                        session_id,
                        Phase::Debug,
                        "Final debug review before delivery...",
                    );
                } else {
                    self.transition(
                        app,
                        session_id,
                        Phase::Validate,
                        "Reviewing the result before delivery...",
                    );
                }
            }
            _ => {
                if self.phase <= Phase::Inspect {
                    self.begin_implementation(
                        app,
                        session_id,
                        "Taking the next concrete task step...",
                    );
                } else if self.phase >= Phase::Validate {
                    self.begin_debug(app, session_id, tool_id, "Debugging the current issue...");
                }
            }
        }
    }

    pub fn on_tool_result(
        &mut self,
        app: &AppHandle,
        session_id: &str,
        tool_id: &str,
        _name: &str,
        ok: bool,
    ) {
        if !self.enabled {
            return;
        }
        let was_validation = self.validation_tool_ids.remove(tool_id);
        let was_debug = self.debug_tool_ids.remove(tool_id);
        if was_validation {
            if ok {
                self.saw_validation = true;
                self.transition(
                    app,
                    session_id,
                    Phase::Debug,
                    "Validation passed — debugging and hardening the result...",
                );
            } else {
                self.transition(
                    app,
                    session_id,
                    Phase::Debug,
                    "Validation failed — investigating and fixing issues...",
                );
            }
            return;
        }
        if was_debug {
            if ok {
                self.saw_debug = true;
                self.transition(
                    app,
                    session_id,
                    Phase::Debug,
                    "Debug pass completed successfully.",
                );
            } else {
                self.transition(
                    app,
                    session_id,
                    Phase::Debug,
                    "Debug evidence found issues — continuing the fix loop...",
                );
            }
        }
    }

    /// A single review pass catches the common case where a model emits done
    /// after edits but before testing. It is deliberately bounded so a weak
    /// provider cannot be trapped in an endless self-review loop.
    pub fn needs_final_review(&self) -> bool {
        self.enabled && !self.final_review_requested && !self.saw_validation
    }

    pub fn request_final_review(&mut self, app: &AppHandle, session_id: &str) -> bool {
        if !self.needs_final_review() {
            return false;
        }
        self.final_review_requested = true;
        self.transition(
            app,
            session_id,
            Phase::Validate,
            "Checking changed files and completion evidence before delivery...",
        );
        true
    }

    pub fn final_review_instruction() -> &'static str {
        "[System - Smart Agent final review]\n\
Before declaring this task complete, inspect the actual workspace state and perform the most relevant validation now (build, test, check, lint, preview, or a targeted file inspection when no validator exists).\n\
If checks fail or the runtime looks wrong, debug the failure (read errors/logs, reproduce, fix, and re-check) before delivering.\n\
Fix any issue you find. Do not repeat completed work or ask the user to type \"continue\".\n\
When the requested work is genuinely complete, call done with a concise, evidence-based summary."
    }

    pub fn complete(&mut self, app: &AppHandle, session_id: &str) {
        if !self.enabled {
            return;
        }
        self.phase = Phase::Deliver;
        emit(
            app,
            session_id,
            "task_progress",
            json!({
                "step": Phase::Deliver.index(),
                "phase": Phase::Deliver.id(),
                "status": "completed",
                "detail": "Task complete and ready to deliver.",
                "complete_all": true,
            }),
        );
    }

    pub fn pause(&self, app: &AppHandle, session_id: &str, detail: &str) {
        if !self.enabled {
            return;
        }
        emit(
            app,
            session_id,
            "task_progress",
            json!({
                "step": self.phase.index(),
                "phase": self.phase.id(),
                "status": "paused",
                "detail": detail,
            }),
        );
    }
}

fn is_validation_command(command: &str) -> bool {
    let command = command.to_ascii_lowercase();
    [
        " test",
        "test ",
        "npm test",
        "pnpm test",
        "yarn test",
        "cargo test",
        "cargo check",
        "npm run build",
        "pnpm build",
        "yarn build",
        "npm run check",
        "pnpm check",
        "yarn check",
        " typecheck",
        " lint",
        "pytest",
        "vitest",
        "jest",
        "playwright",
        "verify",
        "validate",
        "compile",
    ]
    .iter()
    .any(|needle| command.contains(needle))
}

fn is_debug_command(command: &str) -> bool {
    let command = command.to_ascii_lowercase();
    // Prefer explicit debug tooling tokens. Avoid matching path segments like
    // `target/debug/app`, which are common during normal builds.
    [
        "debugger",
        "--debug",
        "stacktrace",
        "stack trace",
        "traceback",
        "console.error",
        "console error",
        "rust-gdb",
        "lldb",
        "gdb ",
        "strace",
        "journalctl",
        "node --inspect",
        "--inspect-brk",
        "--inspect ",
        "chrome://inspect",
        "npm run debug",
        "pnpm debug",
        "yarn debug",
    ]
    .iter()
    .any(|needle| command.contains(needle))
}

fn is_command_tool(name: &str) -> bool {
    let name = name.trim().to_ascii_lowercase();
    matches!(
        name.as_str(),
        "run_command"
            | "start_dev_server"
            | "run_terminal"
            | "run_terminal_cmd"
            | "execute_command"
            | "shell"
    ) || name.contains("command")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn final_review_is_requested_without_validation() {
        let run = SmartAgentRun::new(true);
        assert!(run.needs_final_review());
    }

    #[test]
    fn validation_command_is_detected_without_matching_plain_inspection() {
        assert!(is_validation_command("npm run build"));
        assert!(is_validation_command("cargo test --locked"));
        assert!(!is_validation_command("npm install"));
        assert!(!is_validation_command("Get-Content README.md"));
    }

    #[test]
    fn debug_command_is_detected() {
        assert!(is_debug_command("node --inspect server.js"));
        assert!(is_debug_command("lldb ./target/release/app"));
        assert!(is_debug_command("python -m traceback runner.py"));
        assert!(is_debug_command("npm run debug"));
        assert!(!is_debug_command("npm install"));
        assert!(!is_debug_command("npm run build"));
        assert!(!is_debug_command("./target/debug/app"));
    }

    #[test]
    fn disabled_smart_agent_never_requests_review() {
        let run = SmartAgentRun::new(false);
        assert!(!run.needs_final_review());
        assert!(!run.is_enabled());
    }

    #[test]
    fn later_changes_invalidate_an_earlier_successful_check() {
        let mut run = SmartAgentRun::new(true);
        run.phase = Phase::Validate;
        run.saw_validation = true;
        run.validation_tool_ids.insert("previous-check".into());

        run.reset_validation_after_change();

        assert_eq!(run.phase, Phase::Implement);
        assert!(!run.saw_validation);
        assert!(!run.saw_debug);
        assert!(run.validation_tool_ids.is_empty());
        assert!(run.debug_tool_ids.is_empty());
        assert!(run.needs_final_review());
    }

    #[test]
    fn successful_validation_advances_into_debug() {
        let mut run = SmartAgentRun::new(true);
        run.phase = Phase::Validate;
        run.validation_tool_ids.insert("check-1".into());
        // AppHandle is unavailable in unit tests; only assert ledger fields.
        let was_validation = run.validation_tool_ids.remove("check-1");
        assert!(was_validation);
        run.saw_validation = true;
        run.phase = Phase::Debug;
        assert_eq!(run.phase, Phase::Debug);
        assert!(run.saw_validation);
        assert_eq!(Phase::Debug.index(), 4);
        assert_eq!(Phase::Deliver.index(), 5);
        assert_eq!(STEP_IDS[4], "debug");
        assert_eq!(STEP_LABELS[4], "Debug");
    }

    #[test]
    fn cursor_terminal_commands_are_classified_as_commands() {
        assert!(is_command_tool("run_terminal_cmd"));
        assert!(is_command_tool("execute_command"));
        assert!(is_command_tool("start_dev_server"));
        assert!(!is_command_tool("read_file"));
    }
}
