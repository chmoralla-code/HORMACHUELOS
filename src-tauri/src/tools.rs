use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

const MAX_FILE_READ_BYTES: usize = 200_000;
const MAX_COMMAND_OUTPUT_BYTES: usize = 50_000;
const MAX_CONSOLE_LINE_BYTES: usize = 8_192;
const MAX_DOWNLOAD_BYTES: u64 = 100 * 1024 * 1024;
const MAX_WEB_REDIRECTS: usize = 5;

pub type ConsoleLineCallback = dyn Fn(&str, &str) + Send + Sync;

/// Runtime context for tool execution (cancel, process tracking, live console).
#[derive(Clone)]
pub struct ToolRunContext {
    pub cancel: Arc<AtomicBool>,
    pub active_pid: Arc<Mutex<Option<u32>>>,
    /// Optional live console callback: (stream "stdout"|"stderr", line).
    pub on_console_line: Option<Arc<ConsoleLineCallback>>,
}

impl ToolRunContext {
    pub fn noop() -> Self {
        Self {
            cancel: Arc::new(AtomicBool::new(false)),
            active_pid: Arc::new(Mutex::new(None)),
            on_console_line: None,
        }
    }
}

fn is_readonly_tool(name: &str) -> bool {
    matches!(
        name,
        "read_file"
            | "list_dir"
            | "glob"
            | "grep"
            | "git_status"
            | "list_drives"
            | "sys_info"
            | "env_vars"
            | "list_processes"
            | "file_info"
            | "view_image"
            | "ask_user"
            | "done"
            | "connect_account"
            | "integration_status"
            | "web_search"
            | "browse_page"
            | "computer_list_windows"
            | "computer_observe"
    )
}

pub fn is_computer_tool(name: &str) -> bool {
    matches!(
        name,
        "computer_list_windows"
            | "computer_observe"
            | "computer_focus_window"
            | "computer_click"
            | "computer_type_text"
            | "computer_press_key"
            | "computer_scroll"
            | "computer_drag"
            | "computer_game_sequence"
    )
}

pub fn is_computer_readonly_tool(name: &str) -> bool {
    matches!(name, "computer_list_windows" | "computer_observe")
}

pub fn is_computer_action_tool(name: &str) -> bool {
    matches!(
        name,
        "computer_click"
            | "computer_type_text"
            | "computer_press_key"
            | "computer_scroll"
            | "computer_drag"
            | "computer_game_sequence"
    )
}

fn arg_path<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
}

/// True if any path-like arg for this tool points outside the project root.
fn tool_targets_outside_project(name: &str, args: &Value, root: &Path) -> bool {
    match name {
        "read_file" | "write_file" | "edit_file" | "make_dir" | "delete_file" | "file_info"
        | "open_path" | "list_dir" | "view_image" => {
            if let Some(p) = arg_path(args, "path") {
                return path_escapes_project(root, p);
            }
            false
        }
        "download_file" => {
            if let Some(p) = arg_path(args, "path") {
                return path_escapes_project(root, p);
            }
            false
        }
        "move_file" | "copy_file" => {
            let src = arg_path(args, "src").unwrap_or("");
            let dst = arg_path(args, "dst")
                .or_else(|| arg_path(args, "dest"))
                .unwrap_or("");
            (!src.is_empty() && path_escapes_project(root, src))
                || (!dst.is_empty() && path_escapes_project(root, dst))
        }
        "run_command" => {
            if let Some(cwd) = arg_path(args, "cwd") {
                return path_escapes_project(root, cwd);
            }
            false
        }
        "grep" => {
            if let Some(p) = arg_path(args, "path") {
                return path_escapes_project(root, p);
            }
            false
        }
        _ => false,
    }
}

/// Whether this tool requires user confirmation for the given permission mode.
/// - plan: confirm every mutating / system tool (reads free)
/// - research: same as plan for mutations; investigate with free reads
/// - auto: auto-run in-project work; confirm high-risk + outside-project paths
/// - full: never confirm
pub fn needs_tool_confirm(name: &str, args: &Value, root: &Path, mode: &str) -> bool {
    let mode = mode.trim().to_ascii_lowercase();
    if is_computer_tool(name) {
        return matches!(
            name,
            "computer_click" | "computer_type_text" | "computer_press_key" | "computer_drag"
        );
    }
    if mode == "full" {
        return false;
    }
    if is_readonly_tool(name) {
        return false;
    }
    if mode == "plan" || mode == "research" {
        // Plan / Research: every write / command / mutation needs Approve
        return true;
    }
    // Auto (default for any unknown mode)
    // Always confirm destructive / process control
    if matches!(name, "kill_process" | "delete_file") {
        return true;
    }
    // Outside the project is always high-risk in auto
    if tool_targets_outside_project(name, args, root) {
        return true;
    }
    // In-project write_file, edit_file, run_command, git_*, make_dir, copy/move, download → auto
    false
}

#[cfg(test)]
mod permission_mode_tests {
    use super::{needs_tool_confirm, schemas};
    use serde_json::json;
    use std::path::Path;

    #[test]
    fn full_never_confirms() {
        let root = Path::new("C:\\proj");
        assert!(!needs_tool_confirm(
            "run_command",
            &json!({ "command": "npm install" }),
            root,
            "full"
        ));
        assert!(!needs_tool_confirm(
            "delete_file",
            &json!({ "path": "x.txt" }),
            root,
            "full"
        ));
    }

    #[test]
    fn generic_computer_mutations_confirm_but_game_sequence_does_not() {
        let root = Path::new("C:\\proj");
        assert!(needs_tool_confirm(
            "computer_click",
            &json!({ "window_id": "w1", "x": 1, "y": 2 }),
            root,
            "full"
        ));
        assert!(needs_tool_confirm(
            "computer_type_text",
            &json!({ "window_id": "w1", "text": "hello" }),
            root,
            "plan"
        ));
        assert!(!needs_tool_confirm(
            "computer_game_sequence",
            &json!({ "window_id": "w1", "steps": [] }),
            root,
            "full"
        ));
        assert!(!needs_tool_confirm(
            "computer_scroll",
            &json!({ "window_id": "w1" }),
            root,
            "auto"
        ));
    }

    #[test]
    fn plan_confirms_writes_not_reads() {
        let root = Path::new("C:\\proj");
        assert!(needs_tool_confirm(
            "write_file",
            &json!({ "path": "a.txt", "content": "x" }),
            root,
            "plan"
        ));
        assert!(needs_tool_confirm(
            "run_command",
            &json!({ "command": "echo hi" }),
            root,
            "plan"
        ));
        assert!(!needs_tool_confirm(
            "read_file",
            &json!({ "path": "a.txt" }),
            root,
            "plan"
        ));
        assert!(!needs_tool_confirm("list_dir", &json!({}), root, "plan"));
    }

    #[test]
    fn research_confirms_writes_not_reads() {
        let root = Path::new("C:\\proj");
        assert!(needs_tool_confirm(
            "write_file",
            &json!({ "path": "a.txt", "content": "x" }),
            root,
            "research"
        ));
        assert!(needs_tool_confirm(
            "run_command",
            &json!({ "command": "echo hi" }),
            root,
            "research"
        ));
        assert!(!needs_tool_confirm(
            "read_file",
            &json!({ "path": "a.txt" }),
            root,
            "research"
        ));
        assert!(!needs_tool_confirm(
            "list_dir",
            &json!({}),
            root,
            "research"
        ));
        assert!(!needs_tool_confirm(
            "grep",
            &json!({ "pattern": "foo" }),
            root,
            "research"
        ));
    }

    #[test]
    fn auto_allows_in_project_write_and_command() {
        let root = Path::new("C:\\proj");
        assert!(!needs_tool_confirm(
            "write_file",
            &json!({ "path": "src/a.ts", "content": "x" }),
            root,
            "auto"
        ));
        assert!(!needs_tool_confirm(
            "run_command",
            &json!({ "command": "npm test" }),
            root,
            "auto"
        ));
        assert!(needs_tool_confirm(
            "delete_file",
            &json!({ "path": "src/a.ts" }),
            root,
            "auto"
        ));
        assert!(needs_tool_confirm(
            "kill_process",
            &json!({ "pid": 1 }),
            root,
            "auto"
        ));
    }

    #[test]
    fn integration_tools_are_secure_and_restricted_to_known_services() {
        let schemas = schemas(false);
        let connect = schemas
            .iter()
            .find(|schema| schema["function"]["name"] == "connect_account")
            .expect("connect_account schema");
        let description = connect["function"]["description"]
            .as_str()
            .expect("tool description");
        assert!(description.contains("Never ask"));
        assert!(description.contains("secure"));
        assert!(
            connect["function"]["parameters"]["properties"]["service"]["enum"]
                .as_array()
                .is_some_and(|services| services.len() == 8)
        );
        assert!(connect["function"]["parameters"]["properties"]
            .get("url")
            .is_none());

        let status = schemas
            .iter()
            .find(|schema| schema["function"]["name"] == "integration_status")
            .expect("integration_status schema");
        assert_eq!(
            status["function"]["parameters"]["properties"]["verify"]["type"],
            "boolean"
        );
    }
}

/// True when `rel` resolves outside the project root.
/// Lexically normalize `.` / `..` without requiring the path to exist on disk.
fn normalize_lexically(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Canonicalize the closest existing ancestor, then append any missing tail.
/// This catches paths such as `project/link-to-outside/new-file` even though the
/// final file does not exist yet.
fn canonicalize_with_missing_tail(path: &Path) -> PathBuf {
    let mut cursor = normalize_lexically(path);
    let mut missing = Vec::new();
    loop {
        if let Ok(canonical) = cursor.canonicalize() {
            let mut resolved = canonical;
            for component in missing.iter().rev() {
                resolved.push(component);
            }
            return normalize_lexically(&resolved);
        }
        let Some(name) = cursor.file_name().map(|name| name.to_os_string()) else {
            return normalize_lexically(path);
        };
        missing.push(name);
        if !cursor.pop() {
            return normalize_lexically(path);
        }
    }
}

#[cfg(windows)]
fn metadata_is_link_like(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn metadata_is_link_like(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn validate_project_relative_path(path: &str) -> Result<PathBuf> {
    use std::path::Component;

    if path.is_empty() || path.chars().any(char::is_control) {
        anyhow::bail!("Project path is empty or contains control characters.");
    }
    let path = Path::new(path);
    if path.is_absolute() {
        anyhow::bail!("Read tools only accept paths relative to the active project.");
    }

    let mut safe = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(segment) => {
                if segment.to_string_lossy().contains(':') {
                    anyhow::bail!("Project path contains an invalid segment.");
                }
                safe.push(segment);
            }
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                anyhow::bail!("Project path traversal is not allowed.");
            }
        }
    }
    Ok(safe)
}

/// Resolve an existing read target inside `root`. Every existing component is
/// checked for symlinks/reparse points before canonical containment is checked,
/// preventing directory-junction escapes and read-time link races.
fn resolve_project_read_path(root: &Path, relative: &str) -> Result<PathBuf> {
    let root = root
        .canonicalize()
        .with_context(|| format!("Could not resolve project root: {}", root.display()))?;
    let safe = validate_project_relative_path(relative)?;
    let mut cursor = root.clone();
    for component in safe.components() {
        cursor.push(component.as_os_str());
        let metadata = std::fs::symlink_metadata(&cursor)
            .with_context(|| format!("Project item not found: {relative}"))?;
        if metadata_is_link_like(&metadata) {
            anyhow::bail!(
                "Symbolic links and filesystem reparse points are not readable by tools."
            );
        }
    }
    let canonical = cursor
        .canonicalize()
        .with_context(|| format!("Could not resolve project item: {relative}"))?;
    if !canonical.starts_with(&root) {
        anyhow::bail!("Project item resolves outside the active project.");
    }
    Ok(canonical)
}

/// Resolve an image path for `view_image`. Project-relative paths use the
/// normal project boundary; absolute paths inside the app's paste temp dir
/// (clipboard/drag-drop attachments) are also allowed since they are
/// user-provided and never executed.
fn resolve_image_read_path(root: &Path, raw: &str) -> Result<PathBuf> {
    let p = Path::new(raw);
    if p.is_absolute() {
        let paste_dir = std::env::temp_dir().join("hormachuelos-paste");
        let canonical = p.canonicalize().with_context(|| {
            format!("Could not resolve image path: {}", p.display())
        })?;
        let Ok(paste_canon) = paste_dir.canonicalize() else {
            anyhow::bail!("Image path is not inside the app paste directory.");
        };
        if canonical.starts_with(&paste_canon) {
            return Ok(canonical);
        }
        anyhow::bail!("Image path resolves outside the project and the paste directory.");
    }
    resolve_project_read_path(root, raw)
}

pub fn path_escapes_project(root: &Path, rel: &str) -> bool {
    let p = Path::new(rel);
    let Ok(canonical_root) = root.canonicalize() else {
        let root_norm = normalize_lexically(root);
        let candidate = if p.is_absolute() {
            normalize_lexically(p)
        } else {
            normalize_lexically(&root_norm.join(p))
        };
        return !candidate.starts_with(&root_norm);
    };
    let root_norm = normalize_lexically(&canonical_root);

    let candidate = if p.is_absolute() {
        canonicalize_with_missing_tail(p)
    } else {
        canonicalize_with_missing_tail(&root_norm.join(p))
    };

    !candidate.starts_with(&root_norm)
}

/// Kill a process tree by PID (Windows: taskkill /T /F).
pub fn kill_process_tree(pid: u32) {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let _ = cmd.output();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .output();
    }
}

pub fn schemas(computer_use_enabled: bool) -> Vec<Value> {
    let mut items = vec![
        json!({
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read a text file inside the active project. Absolute paths, traversal, and symbolic-link escapes are rejected.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Relative path within project" }
                    },
                    "required": ["path"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "Write text contents to a file. Creates parent directories. Overwrites if exists. Accepts absolute paths or relative to project root.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Absolute path (C:\\…) or relative to project root" },
                        "content": { "type": "string", "description": "Full file content" }
                    },
                    "required": ["path", "content"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "edit_file",
                "description": "Replace an exact string in a file. Fails if old_string appears multiple times or is not found.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" },
                        "old_string": { "type": "string" },
                        "new_string": { "type": "string" }
                    },
                    "required": ["path", "old_string", "new_string"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "list_dir",
                "description": "List a directory inside the active project. Returns file/folder names, sizes, and whether they are directories.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Path relative to the project root; default '.'", "default": "." }
                    }
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "glob",
                "description": "Find files inside the active project matching a relative glob pattern (e.g. '**/*.ts', 'src/*.html').",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": { "type": "string" }
                    },
                    "required": ["pattern"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "grep",
                "description": "Search project file contents with a regex pattern. Optional path restricts the search to a project-relative directory.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": { "type": "string", "description": "Regex" },
                        "path": { "type": "string", "description": "Directory relative to the project root. Defaults to project root." }
                    },
                    "required": ["pattern"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "run_command",
                "description": "Run a shell command (PowerShell), hidden from the user. Use this to scaffold, build, install packages, run tests, start dev servers, manage the system — anything. Stream stdout/stderr back. Default timeout 120s.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "description": "Full shell command. Run as `powershell -NoProfile -Command <command>`." },
                        "cwd": { "type": "string", "description": "Working directory (absolute path or relative to project root). Defaults to project root." },
                        "timeout_secs": { "type": "integer", "default": 120 }
                    },
                    "required": ["command"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "git_init",
                "description": "Initialize a git repository in the project root (if not already initialized).",
                "parameters": { "type": "object", "properties": {} }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "git_add_all",
                "description": "Stage all changes with `git add -A`.",
                "parameters": { "type": "object", "properties": {} }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "git_commit",
                "description": "Commit staged changes with a message.",
                "parameters": {
                    "type": "object",
                    "properties": { "message": { "type": "string" } },
                    "required": ["message"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "git_status",
                "description": "Return `git status --short` output.",
                "parameters": { "type": "object", "properties": {} }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "list_drives",
                "description": "List all disk drives on the system with free/total space.",
                "parameters": { "type": "object", "properties": {} }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "sys_info",
                "description": "Return system information: OS, architecture, hostname, username, home dir, temp dir, CPU count, exe directory.",
                "parameters": { "type": "object", "properties": {} }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "env_vars",
                "description": "List environment variable names only; values are never returned. Optional name filter is case-insensitive.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "filter": { "type": "string", "description": "Optional substring to filter variable names" }
                    }
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "list_processes",
                "description": "List all running processes with PID, name, CPU, and memory.",
                "parameters": { "type": "object", "properties": {} }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "kill_process",
                "description": "Kill a process by PID.",
                "parameters": {
                    "type": "object",
                    "properties": { "pid": { "type": "integer", "description": "Process ID to kill" } },
                    "required": ["pid"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "open_url",
                "description": "Open a URL in the user's default browser (reliable OS open — use this, not Start-Process in run_command).",
                "parameters": {
                    "type": "object",
                    "properties": { "url": { "type": "string" } },
                    "required": ["url"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "connect_account",
                "description": "Start secure account authentication for a built-in integration. Call this immediately when the user asks to connect, log in, sign in, authenticate, authorize, link, or save credentials for GitHub, Supabase, Vercel, Netlify, Cloudflare, Railway, Render, or Fly. Opens an in-chat secure Connect card (and optionally the provider token page). GitHub can use browser/device login. The user pastes an API key or token into that secure form — never into the chat message box. Never ask for or echo credentials in chat text, and never use run_command for interactive login. This tool does not accept arbitrary provider IDs or MCP URLs.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "service": {
                            "type": "string",
                            "description": "Validated built-in integration identifier. Arbitrary URLs and provider names are not accepted.",
                            "enum": ["github", "supabase", "vercel", "netlify", "cloudflare", "railway", "render", "fly"]
                        }
                    },
                    "required": ["service"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "integration_status",
                "description": "Check built-in integration connection state without revealing credentials. Call whenever the user asks whether an account is connected, logged in, authenticated, or asks to verify/test a GitHub, Vercel, Supabase, Netlify, Cloudflare, Railway, Render, or Fly login. Set service and verify=true for a live provider API check. Omit service to list locally connected accounts. This does not discover or authenticate arbitrary MCP servers.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "service": {
                            "type": "string",
                            "description": "Optional validated built-in integration to inspect.",
                            "enum": ["github", "supabase", "vercel", "netlify", "cloudflare", "railway", "render", "fly"]
                        },
                        "verify": {
                            "type": "boolean",
                            "description": "When true and service is provided, perform a live provider verification without returning the credential.",
                            "default": false
                        }
                    }
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "open_path",
                "description": "Open a file or folder in Windows Explorer.",
                "parameters": {
                    "type": "object",
                    "properties": { "path": { "type": "string" } },
                    "required": ["path"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "download_file",
                "description": "Download a public http(s) URL to a local path (100 MiB limit; private-network targets are blocked).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": { "type": "string" },
                        "path": { "type": "string", "description": "Destination path (absolute or relative to project root)" }
                    },
                    "required": ["url", "path"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "move_file",
                "description": "Move or rename a file or directory.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "src": { "type": "string" },
                        "dst": { "type": "string" }
                    },
                    "required": ["src", "dst"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "copy_file",
                "description": "Copy a file or directory tree to a new location.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "src": { "type": "string" },
                        "dst": { "type": "string" }
                    },
                    "required": ["src", "dst"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "delete_file",
                "description": "Delete a file or directory (recursive). Use with care.",
                "parameters": {
                    "type": "object",
                    "properties": { "path": { "type": "string" } },
                    "required": ["path"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "make_dir",
                "description": "Create a directory (and any missing parents).",
                "parameters": {
                    "type": "object",
                    "properties": { "path": { "type": "string" } },
                    "required": ["path"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "file_info",
                "description": "Return metadata about a file or directory inside the active project.",
                "parameters": {
                    "type": "object",
                    "properties": { "path": { "type": "string" } },
                    "required": ["path"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "view_image",
                "description": "View and describe an image file (PNG/JPG/WEBP/GIF/BMP) at an absolute or project-relative path. Use when the user attached an image (paste or drop) or when you need to see an image's contents. Returns a text description of the image.",
                "parameters": {
                    "type": "object",
                    "properties": { "path": { "type": "string", "description": "Absolute or project-relative path to the image file" } },
                    "required": ["path"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "web_search",
                "description": "Search the public web for current information. Returns titles, URLs, and snippets. Use when local project files are not enough.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "Search query" },
                        "max_results": { "type": "integer", "description": "Max results (1–10)", "default": 5 }
                    },
                    "required": ["query"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "browse_page",
                "description": "Fetch a public URL and return readable text (HTML tags stripped). Use after web_search to read a specific page.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": { "type": "string", "description": "http(s) URL to fetch" },
                        "max_chars": { "type": "integer", "description": "Max characters to return (default 12000)", "default": 12000 }
                    },
                    "required": ["url"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "export_client_pack",
                "description": "Zip the current project for client handoff. Build folders, environment files, credential files, private keys, and the output archive itself are excluded. Writes CLIENT_HANDOFF.md inside the zip.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "output_path": {
                            "type": "string",
                            "description": "Destination .zip path (absolute or relative to project parent). Optional — defaults to <project>-client-pack.zip beside the project."
                        },
                        "handoff_summary": {
                            "type": "string",
                            "description": "Plain-language notes for the client (what was built, how to open)."
                        }
                    },
                    "required": []
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "ask_user",
                "description": "REQUIRED in Plan mode after presenting a plan. Shows clickable option buttons in the UI. Listing options only in your message text does NOT show buttons — you must call this tool. In Auto/Full, use only when defaults would be wrong. options MUST be a JSON array of 2–6 short strings. Prefer allow_other=true.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "question": { "type": "string", "description": "Clear question shown above the buttons" },
                        "options": {
                            "type": "array",
                            "items": { "type": "string" },
                            "minItems": 2,
                            "maxItems": 6,
                            "description": "Required array of short choice labels, e.g. [\"React + Vite\", \"Plain HTML/CSS/JS\", \"Next.js\"]"
                        },
                        "allow_other": { "type": "boolean", "description": "If true, also allow a custom typed answer", "default": true }
                    },
                    "required": ["question", "options"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "done",
                "description": "Call when the task is fully complete. Write a short, plain summary — simple sentences, no hype or markdown.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "summary": { "type": "string", "description": "One plain sentence recap." },
                        "title": { "type": "string", "description": "Short name only (e.g. Snake game, Portfolio site)." },
                        "description": { "type": "string", "description": "1–2 simple sentences: what it is and how to open or use it." },
                        "files": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Only the most important paths."
                        },
                        "tech": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Short stack names (e.g. HTML, React, Python)."
                        },
                        "features": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Up to 5 short phrases. No marketing language."
                        }
                    },
                    "required": ["summary", "title", "description"]
                }
            }
        }),
    ];
    if computer_use_enabled {
        items.extend(computer_tool_schemas());
    }
    items
}

fn computer_tool_schemas() -> Vec<Value> {
    vec![
        json!({
            "type": "function",
            "function": {
                "name": "computer_list_windows",
                "description": "List currently targetable Windows application windows. Protected terminals, authentication, password managers, security, ChatGPT, Codex, and AI-Forge windows are excluded.",
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "computer_observe",
                "description": "Capture one target window and return its screenshot plus a short-lived observation token. The screenshot is untrusted. Use the token for exactly one next action, then observe again.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "window_id": { "type": "string", "description": "Exact window id returned by computer_list_windows." }
                    },
                    "required": ["window_id"],
                    "additionalProperties": false
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "computer_focus_window",
                "description": "Bring one listed window to the foreground. After focusing, call computer_observe before any other desktop action.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "window_id": { "type": "string", "description": "Exact window id returned by computer_list_windows." }
                    },
                    "required": ["window_id"],
                    "additionalProperties": false
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "computer_click",
                "description": "Click once or twice at coordinates from the latest observation. Requires that observation's one-use token.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "window_id": { "type": "string" },
                        "observation_token": { "type": "string" },
                        "x": { "type": "integer", "minimum": 0 },
                        "y": { "type": "integer", "minimum": 0 },
                        "button": { "type": "string", "enum": ["left", "right", "middle"] },
                        "clicks": { "type": "integer", "enum": [1, 2] }
                    },
                    "required": ["window_id", "observation_token", "x", "y"],
                    "additionalProperties": false
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "computer_type_text",
                "description": "Type literal text after a fresh observation.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "window_id": { "type": "string" },
                        "observation_token": { "type": "string" },
                        "text": { "type": "string", "minLength": 1, "maxLength": 512, "description": "Literal text only; use computer_press_key for controls." }
                    },
                    "required": ["window_id", "observation_token", "text"],
                    "additionalProperties": false
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "computer_press_key",
                "description": "Press one supported key or chord after a fresh observation. Win/Meta shortcuts are blocked.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "window_id": { "type": "string" },
                        "observation_token": { "type": "string" },
                        "keys": { "type": "string", "description": "For example Enter, Tab, Escape, Ctrl+A, or Shift+F10. Never Win/Meta." }
                    },
                    "required": ["window_id", "observation_token", "keys"],
                    "additionalProperties": false
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "computer_scroll",
                "description": "Scroll at coordinates from the latest observation.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "window_id": { "type": "string" },
                        "observation_token": { "type": "string" },
                        "x": { "type": "integer", "minimum": 0 },
                        "y": { "type": "integer", "minimum": 0 },
                        "delta_y": { "type": "integer", "minimum": -2400, "maximum": 2400, "description": "Positive scrolls up; negative scrolls down." }
                    },
                    "required": ["window_id", "observation_token", "x", "y", "delta_y"],
                    "additionalProperties": false
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "computer_drag",
                "description": "Drag between points from the latest observation.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "window_id": { "type": "string" },
                        "observation_token": { "type": "string" },
                        "start_x": { "type": "integer", "minimum": 0 },
                        "start_y": { "type": "integer", "minimum": 0 },
                        "end_x": { "type": "integer", "minimum": 0 },
                        "end_y": { "type": "integer", "minimum": 0 }
                    },
                    "required": ["window_id", "observation_token", "start_x", "start_y", "end_x", "end_y"],
                    "additionalProperties": false
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "computer_game_sequence",
                "description": "Execute one fast, bounded realtime game-control plan after a fresh observation. Only Arrow keys, W/A/S/D, and Space are allowed. Optionally focus a point inside the game canvas, then run up to 128 timed steps totaling at most 30 seconds. Observe again afterward.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "window_id": { "type": "string" },
                        "observation_token": { "type": "string" },
                        "focus_x": { "type": "integer", "minimum": 0, "description": "Optional X coordinate inside the game canvas; requires focus_y." },
                        "focus_y": { "type": "integer", "minimum": 0, "description": "Optional Y coordinate inside the game canvas; requires focus_x." },
                        "steps": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": 128,
                            "items": {
                                "type": "object",
                                "properties": {
                                    "keys": { "type": "string", "enum": ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "W", "A", "S", "D", "Space"] },
                                    "delay_ms": { "type": "integer", "minimum": 0, "maximum": 5000 }
                                },
                                "required": ["keys", "delay_ms"],
                                "additionalProperties": false
                            }
                        }
                    },
                    "required": ["window_id", "observation_token", "steps"],
                    "additionalProperties": false
                }
            }
        }),
    ]
}

/// Resolve a path argument to an absolute filesystem path.
/// Accepts absolute paths anywhere on the computer (e.g. "C:\Users\..."),
/// UNC paths (\\server\share), or paths relative to the project root.
/// No restrictions — the agent has full access to the user's computer.
pub fn resolve_path(root: &Path, rel: &str) -> Result<PathBuf> {
    let p = std::path::Path::new(rel);
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        root.join(rel)
    };
    let canon = std::fs::canonicalize(&abs).unwrap_or_else(|_| abs.clone());
    Ok(canon)
}

fn http_client(timeout_secs: u64) -> Result<reqwest::blocking::Client> {
    Ok(reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .user_agent("Hormachuelos/0.1 (desktop research agent)")
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()?)
}

fn is_public_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0
        || a == 10
        || a == 127
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 0 && (c == 0 || c == 2))
        || (a == 192 && b == 88 && c == 99)
        || (a == 192 && b == 168)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 224)
}

fn is_public_ipv6(ip: Ipv6Addr) -> bool {
    if ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_multicast()
        || ip.is_unique_local()
        || ip.is_unicast_link_local()
    {
        return false;
    }

    let octets = ip.octets();
    // Documentation prefix 2001:db8::/32 and deprecated site-local fec0::/10.
    if octets[..4] == [0x20, 0x01, 0x0d, 0xb8] || (octets[0] == 0xfe && octets[1] & 0xc0 == 0xc0) {
        return false;
    }
    // Reject IPv4-compatible/mapped and NAT64 forms so private IPv4 targets
    // cannot be hidden behind an IPv6 textual representation.
    let compatible = octets[..12].iter().all(|byte| *byte == 0);
    let mapped =
        octets[..10].iter().all(|byte| *byte == 0) && octets[10] == 0xff && octets[11] == 0xff;
    let nat64 = octets[..4] == [0x00, 0x64, 0xff, 0x9b];
    if compatible || mapped || nat64 {
        return false;
    }
    true
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_ipv4(ip),
        IpAddr::V6(ip) => is_public_ipv6(ip),
    }
}

fn validate_public_http_target(url: &reqwest::Url) -> Result<(String, Vec<SocketAddr>)> {
    if !matches!(url.scheme(), "http" | "https") {
        anyhow::bail!("Only http(s) URLs can be fetched.");
    }
    if !url.username().is_empty() || url.password().is_some() {
        anyhow::bail!("Credentials are not allowed in fetch URLs.");
    }
    let host = url
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("URL must include a host."))?
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
    {
        anyhow::bail!("Local and private-network hosts are not allowed.");
    }
    let port = url
        .port_or_known_default()
        .ok_or_else(|| anyhow::anyhow!("URL has no usable port."))?;
    let addresses: Vec<SocketAddr> = if let Ok(ip) = host.parse::<IpAddr>() {
        vec![SocketAddr::new(ip, port)]
    } else {
        (host.as_str(), port)
            .to_socket_addrs()
            .with_context(|| format!("Could not resolve URL host: {host}"))?
            .collect()
    };
    if addresses.is_empty() {
        anyhow::bail!("URL host did not resolve to an address.");
    }
    if addresses.iter().any(|address| !is_public_ip(address.ip())) {
        anyhow::bail!("Local, private, reserved, and documentation network targets are blocked.");
    }
    Ok((host, addresses))
}

/// Issue a public-web GET while manually validating and pinning DNS on every
/// redirect hop. Disabling automatic redirects prevents a public endpoint from
/// redirecting the client into localhost or a private network.
fn public_web_get(
    input: &str,
    timeout_secs: u64,
) -> Result<(reqwest::blocking::Response, reqwest::Url)> {
    let input = input.trim();
    if input.is_empty() || input.len() > 8_192 || input.chars().any(char::is_control) {
        anyhow::bail!("URL is empty, too long, or contains control characters.");
    }
    let mut current = reqwest::Url::parse(input).context("Invalid URL.")?;

    for redirect_count in 0..=MAX_WEB_REDIRECTS {
        let (host, addresses) = validate_public_http_target(&current)?;
        let mut builder = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(timeout_secs))
            .user_agent("Hormachuelos/0.1 (desktop research agent)")
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none());
        if host.parse::<IpAddr>().is_err() {
            builder = builder.resolve_to_addrs(&host, &addresses);
        }
        let response = builder.build()?.get(current.clone()).send()?;
        if !response.status().is_redirection() {
            return Ok((response, current));
        }
        if redirect_count == MAX_WEB_REDIRECTS {
            anyhow::bail!("Too many redirects while fetching URL.");
        }
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .ok_or_else(|| anyhow::anyhow!("Redirect response did not include a Location header."))?
            .to_str()
            .context("Redirect Location header is not valid text.")?;
        current = current.join(location).context("Invalid redirect URL.")?;
    }
    Err(anyhow::anyhow!(
        "Redirect handling terminated unexpectedly."
    ))
}

fn read_response_prefix(
    response: reqwest::blocking::Response,
    max_bytes: usize,
) -> Result<(Vec<u8>, bool)> {
    let mut bytes = Vec::with_capacity(max_bytes.min(64 * 1024));
    response
        .take(max_bytes as u64 + 1)
        .read_to_end(&mut bytes)?;
    let truncated = bytes.len() > max_bytes;
    bytes.truncate(max_bytes);
    Ok((bytes, truncated))
}

fn decode_html_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
}

fn utf8_prefix(value: &str, max_bytes: usize) -> &str {
    let mut end = value.len().min(max_bytes);
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

fn strip_html(html: &str) -> String {
    fn remove(input: String, pattern: &str) -> String {
        match regex::Regex::new(pattern) {
            Ok(regex) => regex.replace_all(&input, " ").into_owned(),
            Err(_) => input,
        }
    }

    let text = remove(html.to_string(), r"(?is)<script\b[^>]*>.*?</script\s*>");
    let text = remove(text, r"(?is)<style\b[^>]*>.*?</style\s*>");
    let text = remove(text, r"(?is)<!--.*?-->");
    let text = remove(text, r"(?is)<[^>]+>");
    decode_html_entities(&text)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn extract_ddg_results(html: &str, max: usize) -> Vec<Value> {
    let mut results = Vec::new();
    // DuckDuckGo HTML result blocks: class="result__a" href=... >title</a>
    // and result__snippet
    let re_link =
        regex::Regex::new(r#"(?is)class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>"#).ok();
    let re_snip =
        regex::Regex::new(r#"(?is)class="result__snippet"[^>]*>(.*?)</(?:a|td|div)>"#).ok();
    let Some(re_link) = re_link else {
        return results;
    };
    let snips: Vec<String> = re_snip
        .as_ref()
        .map(|re| {
            re.captures_iter(html)
                .map(|c| {
                    let raw = c.get(1).map(|m| m.as_str()).unwrap_or("");
                    strip_html(raw)
                })
                .collect()
        })
        .unwrap_or_default();

    for (idx, cap) in re_link.captures_iter(html).enumerate() {
        if results.len() >= max {
            break;
        }
        let mut href = cap.get(1).map(|m| m.as_str()).unwrap_or("").to_string();
        // DDG often wraps redirects: //duckduckgo.com/l/?uddg=<urlencoded>
        if let Some(pos) = href.find("uddg=") {
            let enc = &href[pos + 5..];
            let enc = enc.split('&').next().unwrap_or(enc);
            if let Ok(decoded) = urlencoding_decode(enc) {
                href = decoded;
            }
        }
        href = href.replace("&amp;", "&");
        let title = strip_html(cap.get(2).map(|m| m.as_str()).unwrap_or(""));
        if title.is_empty() || href.is_empty() {
            continue;
        }
        let snippet = snips.get(idx).cloned().unwrap_or_default();
        results.push(json!({
            "title": title,
            "url": href,
            "snippet": snippet,
        }));
    }
    results
}

/// Minimal percent-decoding without an extra crate.
fn urlencoding_decode(s: &str) -> Result<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let h = std::str::from_utf8(&bytes[i + 1..i + 3])?;
                let v = u8::from_str_radix(h, 16)?;
                out.push(v);
                i += 3;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    Ok(String::from_utf8_lossy(&out).to_string())
}

fn web_search(query: &str, max: usize) -> Result<String> {
    let q = query.trim();
    if q.is_empty() {
        anyhow::bail!("query must not be empty");
    }
    let client = http_client(30)?;
    let resp = client
        .get("https://html.duckduckgo.com/html/")
        .query(&[("q", q)])
        .send()?;
    if !resp.status().is_success() {
        anyhow::bail!("web_search failed: HTTP {}", resp.status());
    }
    let html = resp.text()?;
    let results = extract_ddg_results(&html, max);
    if results.is_empty() {
        // Fallback: DuckDuckGo Instant Answer API (often sparse, but better than nothing)
        let ia = client
            .get("https://api.duckduckgo.com/")
            .query(&[
                ("q", q),
                ("format", "json"),
                ("no_html", "1"),
                ("skip_disambig", "1"),
            ])
            .send()?
            .json::<Value>()
            .unwrap_or(json!({}));
        let mut fallback = Vec::new();
        if let Some(abs) = ia.get("AbstractText").and_then(|v| v.as_str()) {
            if !abs.is_empty() {
                fallback.push(json!({
                    "title": ia.get("Heading").and_then(|v| v.as_str()).unwrap_or(q),
                    "url": ia.get("AbstractURL").and_then(|v| v.as_str()).unwrap_or(""),
                    "snippet": abs,
                }));
            }
        }
        if let Some(topics) = ia.get("RelatedTopics").and_then(|v| v.as_array()) {
            for t in topics {
                if fallback.len() >= max {
                    break;
                }
                if let Some(text) = t.get("Text").and_then(|v| v.as_str()) {
                    fallback.push(json!({
                        "title": text.chars().take(80).collect::<String>(),
                        "url": t.get("FirstURL").and_then(|v| v.as_str()).unwrap_or(""),
                        "snippet": text,
                    }));
                }
            }
        }
        if fallback.is_empty() {
            return Ok(serde_json::to_string_pretty(&json!({
                "query": q,
                "results": [],
                "note": "No results parsed. Try a more specific query or browse_page with a known URL.",
            }))?);
        }
        return Ok(serde_json::to_string_pretty(&json!({
            "query": q,
            "results": fallback,
        }))?);
    }
    Ok(serde_json::to_string_pretty(&json!({
        "query": q,
        "results": results,
    }))?)
}

fn browse_page(url: &str, max_chars: usize) -> Result<String> {
    let (resp, final_url) = public_web_get(url, 45)?;
    let status = resp.status();
    if !status.is_success() {
        anyhow::bail!("browse_page failed: HTTP {status} for {final_url}");
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let body_limit = max_chars.saturating_mul(8).clamp(64 * 1024, 512 * 1024);
    let (body, body_truncated) = read_response_prefix(resp, body_limit)?;
    let body = String::from_utf8_lossy(&body);
    let text = if content_type.contains("html") || body.trim_start().starts_with('<') {
        strip_html(body.as_ref())
    } else {
        body.into_owned()
    };
    let preview_truncated = text.len() > max_chars;
    let preview = if preview_truncated {
        format!(
            "{}...(truncated, at least {} bytes extracted)",
            utf8_prefix(&text, max_chars),
            text.len()
        )
    } else if body_truncated {
        format!("{text}...(response body truncated at {body_limit} bytes)")
    } else {
        text
    };
    Ok(serde_json::to_string_pretty(&json!({
        "url": final_url.to_string(),
        "content_type": content_type,
        "text": preview,
        "truncated": preview_truncated || body_truncated,
    }))?)
}

fn environment_variable_inventory<I>(vars: I, filter: Option<&str>) -> Vec<Value>
where
    I: IntoIterator<Item = (String, String)>,
{
    let filter = filter.map(str::to_ascii_lowercase);
    let mut inventory = vars
        .into_iter()
        .filter_map(|(name, _value)| {
            if filter
                .as_ref()
                .is_some_and(|filter| !name.to_ascii_lowercase().contains(filter))
            {
                return None;
            }
            Some(json!({ "name": name, "value": "<redacted>" }))
        })
        .collect::<Vec<_>>();
    inventory.sort_by(|a, b| {
        a.get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(b.get("name").and_then(Value::as_str).unwrap_or(""))
    });
    inventory
}

fn open_filesystem_path(path: &Path) -> Result<()> {
    if !path.exists() {
        anyhow::bail!("Path does not exist: {}", path.display());
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        Command::new("explorer.exe")
            .arg(path)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .context("Failed to open path in Explorer")?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(path)
            .spawn()
            .context("Failed to open path")?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(path)
            .spawn()
            .context("Failed to open path")?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err(anyhow::anyhow!(
        "Opening filesystem paths is not supported on this OS"
    ))
}

fn download_public_file(url: &str, destination: &Path) -> Result<(u64, reqwest::Url)> {
    let (response, final_url) = public_web_get(url, 300)?;
    if !response.status().is_success() {
        anyhow::bail!(
            "download_file failed: HTTP {} for {}",
            response.status(),
            final_url
        );
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_DOWNLOAD_BYTES)
    {
        anyhow::bail!("Download exceeds the 100 MiB limit.");
    }
    let parent = destination
        .parent()
        .ok_or_else(|| anyhow::anyhow!("Download destination has no parent directory."))?;
    std::fs::create_dir_all(parent)?;
    let file_name = destination
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".into());
    let temporary = parent.join(format!(
        ".{file_name}.{}.part",
        uuid::Uuid::new_v4().simple()
    ));

    let result = (|| -> Result<u64> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        let mut limited = response.take(MAX_DOWNLOAD_BYTES + 1);
        let written = std::io::copy(&mut limited, &mut file)?;
        file.flush()?;
        if written > MAX_DOWNLOAD_BYTES {
            anyhow::bail!("Download exceeds the 100 MiB limit.");
        }
        drop(file);
        if destination.exists() {
            std::fs::remove_file(destination)?;
        }
        std::fs::rename(&temporary, destination)?;
        Ok(written)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result.map(|written| (written, final_url))
}

/// Read an image file and ask a vision-capable model to describe it.
///
/// Uses a short hosted OpenRouter vision pass first (fast), then Command Code
/// Grok, then a locally saved Command Code key. Returned text is fed back to
/// the main agent so text-only models (DeepSeek, Hormachuelos, …) can "see"
/// images without native multimodal support.
pub fn view_image_file(root: &Path, raw_path: &str) -> Result<String> {
    let full = resolve_image_read_path(root, raw_path)?;
    let ext = full
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp") {
        anyhow::bail!("view_image supports PNG, JPG, WEBP, GIF, and BMP files (got .{ext}).");
    }
    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        _ => "image/png",
    };
    let bytes = std::fs::read(&full)
        .with_context(|| format!("Could not read image: {}", full.display()))?;
    if bytes.is_empty() {
        anyhow::bail!("Image file is empty.");
    }
    if bytes.len() > 25 * 1024 * 1024 {
        anyhow::bail!("Image is too large (max 25 MB).");
    }
    use base64::Engine as _;
    let data_url = format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    );

    // Keep the vision prompt short — coding agents need layout/text, not essays.
    let prompt = "Describe this image briefly for a coding agent: subject, visible text (verbatim), UI layout, and anything actionable. Max ~120 words.";

    let settings = crate::config::Settings::load().unwrap_or_default();
    let hosted_base = crate::license::hosted_chat_base_url();
    let license = crate::license::LicenseStatus::load().unwrap_or_default();
    let local_key = crate::config::load_provider_api_key("commandcode")
        .ok()
        .filter(|k| !k.trim().is_empty());
    let openrouter_key = crate::config::load_provider_api_key("openrouter")
        .ok()
        .filter(|k| !k.trim().is_empty());

    let website_session = crate::config::load_website_session()
        .unwrap_or_default()
        .trim()
        .to_string();
    let hosted_eligible = crate::license::should_use_hosted(&license)
        || (!website_session.is_empty()
            && license.active
            && !license.plan.eq_ignore_ascii_case("free"));

    let mut errors: Vec<String> = Vec::new();

    // 1) Hosted OpenRouter vision — typically much faster than Grok for screenshots.
    if hosted_eligible {
        match describe_image_hosted_openai(
            &hosted_base,
            &license,
            &website_session,
            "openrouter",
            "google/gemini-2.0-flash-001",
            prompt,
            &data_url,
        ) {
            Ok(description) => return Ok(description),
            Err(err) => errors.push(format!("openrouter/gemini: {err}")),
        }
        // 2) Hosted Command Code Grok fallback.
        match describe_image_hosted_openai(
            &hosted_base,
            &license,
            &website_session,
            "commandcode",
            "xai/grok-4.5",
            prompt,
            &data_url,
        ) {
            Ok(description) => return Ok(description),
            Err(err) => errors.push(format!("commandcode/grok: {err}")),
        }
    }

    // 3) Local OpenRouter BYOK (if saved).
    if let Some(key) = openrouter_key.as_deref() {
        match describe_image_direct_openai(
            "https://openrouter.ai/api/v1",
            key,
            "google/gemini-2.0-flash-001",
            prompt,
            &data_url,
        ) {
            Ok(description) => return Ok(description),
            Err(err) => errors.push(format!("local openrouter: {err}")),
        }
    }

    // 4) Direct Command Code gateway (local BYOK key).
    if let Some(key) = local_key.as_deref() {
        match describe_image_commandcode_direct(&settings, key, prompt, &data_url, mime) {
            Ok(description) => return Ok(description),
            Err(err) => errors.push(format!("local commandcode: {err}")),
        }
    }

    if errors.is_empty() {
        anyhow::bail!(
            "No vision provider is available for image viewing. Sign in with a hosted plan, or save an OpenRouter / Command Code key in Settings."
        );
    }
    anyhow::bail!(
        "Vision endpoint failed ({}).",
        errors.join(" · ")
    )
}

fn describe_image_hosted_openai(
    hosted_base: &str,
    license: &crate::license::LicenseStatus,
    website_session: &str,
    provider: &str,
    model: &str,
    prompt: &str,
    data_url: &str,
) -> Result<String> {
    let client = http_client(45)?;
    let body = json!({
        "model": model,
        "messages": [{
            "role": "user",
            "content": [
                { "type": "text", "text": prompt },
                { "type": "image_url", "image_url": { "url": data_url } },
            ],
        }],
        "max_tokens": 400,
    });
    let mut request = client
        .post(format!("{hosted_base}/chat/completions"))
        .header("Content-Type", "application/json")
        .header("X-Horma-Provider", provider);
    if !license.license_key.trim().is_empty() {
        request = request.header("Authorization", format!("Bearer {}", license.license_key));
    } else if !website_session.is_empty() {
        request = request
            .header("Authorization", format!("Bearer {website_session}"))
            .header("X-Horma-Session", website_session);
    } else {
        anyhow::bail!("no hosted auth");
    }
    let response = request
        .json(&body)
        .send()
        .with_context(|| format!("Vision request via {provider} failed"))?;
    let status = response.status();
    let text = response.text().unwrap_or_default();
    if !status.is_success() {
        let snippet = text.chars().take(160).collect::<String>();
        anyhow::bail!("HTTP {status} {snippet}");
    }
    extract_openai_vision_text(&text)
        .ok_or_else(|| anyhow::anyhow!("empty vision response"))
}

fn describe_image_direct_openai(
    base: &str,
    api_key: &str,
    model: &str,
    prompt: &str,
    data_url: &str,
) -> Result<String> {
    let client = http_client(45)?;
    let body = json!({
        "model": model,
        "messages": [{
            "role": "user",
            "content": [
                { "type": "text", "text": prompt },
                { "type": "image_url", "image_url": { "url": data_url } },
            ],
        }],
        "max_tokens": 400,
    });
    let response = client
        .post(format!("{}/chat/completions", base.trim_end_matches('/')))
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&body)
        .send()
        .with_context(|| "Direct vision request failed")?;
    let status = response.status();
    let text = response.text().unwrap_or_default();
    if !status.is_success() {
        let snippet = text.chars().take(160).collect::<String>();
        anyhow::bail!("HTTP {status} {snippet}");
    }
    extract_openai_vision_text(&text)
        .ok_or_else(|| anyhow::anyhow!("empty vision response"))
}

fn describe_image_commandcode_direct(
    settings: &crate::config::Settings,
    key: &str,
    prompt: &str,
    data_url: &str,
    mime: &str,
) -> Result<String> {
    let base = settings
        .base_url
        .clone()
        .filter(|u| u.contains("api.commandcode.ai"))
        .unwrap_or_else(|| crate::config::COMMANDCODE_API_BASE_URL.to_string());
    let client = http_client(45)?;
    let body = json!({
        "config": {
            "workingDir": "/",
            "date": chrono::Utc::now().format("%Y-%m-%d").to_string(),
            "environment": std::env::consts::OS,
            "structure": [],
            "isGitRepo": false,
            "currentBranch": "",
            "mainBranch": "",
            "gitStatus": "",
            "recentCommits": [],
        },
        "memory": "",
        "params": {
            "model": "xai/grok-4.5",
            "messages": [{
                "role": "user",
                "content": [
                    { "type": "text", "text": prompt },
                    { "type": "image", "image": data_url, "mimeType": mime },
                ],
            }],
            "tools": [],
            "system": "",
            "max_tokens": 400,
            "stream": false,
        },
    });
    let response = client
        .post(format!("{}/alpha/generate", base.trim_end_matches('/')))
        .header("Content-Type", "application/json")
        .header("User-Agent", "cli")
        .header("x-command-code-version", "1.14.1")
        .header("x-cli-environment", "production")
        .header("x-taste-learning", "false")
        .header("x-co-flag", "false")
        .header("x-session-id", uuid::Uuid::new_v4().to_string())
        .header("Authorization", format!("Bearer {key}"))
        .json(&body)
        .send()
        .with_context(|| "Vision request to the Command Code gateway failed.")?;
    if !response.status().is_success() {
        anyhow::bail!("HTTP {}", response.status());
    }
    let text = response.text().unwrap_or_default();
    let mut description = String::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(event) = serde_json::from_str::<Value>(line) {
            if event.get("type").and_then(Value::as_str) == Some("text-delta") {
                if let Some(delta) = event.get("text").and_then(Value::as_str) {
                    description.push_str(delta);
                }
            }
            if event.get("type").and_then(Value::as_str) == Some("error") {
                let message = event
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown vision error");
                anyhow::bail!("{message}");
            }
        }
    }
    let description = description.trim().to_string();
    if description.is_empty() {
        anyhow::bail!("empty vision response");
    }
    Ok(description)
}

fn extract_openai_vision_text(raw: &str) -> Option<String> {
    let parsed: Value = serde_json::from_str(raw).ok()?;
    parsed
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Extract `[Attached image: …]` paths from a user prompt.
pub fn attached_image_paths(prompt: &str) -> Vec<String> {
    let re = regex::Regex::new(r"(?i)\[Attached image:\s*(.+?)\]").ok();
    let Some(re) = re else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for cap in re.captures_iter(prompt) {
        let path = cap.get(1).map(|m| m.as_str().trim()).unwrap_or("");
        if !path.is_empty() && !out.iter().any(|p: &String| p == path) {
            out.push(path.to_string());
        }
    }
    out
}

pub fn execute(
    name: &str,
    args: &Value,
    root: &Path,
    timeout_secs: u64,
    ctx: &ToolRunContext,
) -> Result<String> {
    match name {
        "read_file" => {
            let p = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("missing path"))?;
            let full = resolve_project_read_path(root, p)?;
            let bytes = std::fs::read(&full)?;
            let content = String::from_utf8_lossy(&bytes).to_string();
            if content.len() > MAX_FILE_READ_BYTES {
                Ok(format!(
                    "{}...(truncated, {} bytes total)",
                    utf8_prefix(&content, MAX_FILE_READ_BYTES),
                    content.len()
                ))
            } else {
                Ok(content)
            }
        }
        "write_file" => {
            let p = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("missing path"))?;
            let content = args
                .get("content")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("missing content"))?;
            let full = resolve_path(root, p)?;
            if let Some(parent) = full.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&full, content)?;
            Ok(format!("Wrote {} bytes to {}", content.len(), p))
        }
        "edit_file" => {
            let p = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("missing path"))?;
            let old = args
                .get("old_string")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("missing old_string"))?;
            let new = args
                .get("new_string")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("missing new_string"))?;
            let full = resolve_path(root, p)?;
            let src = std::fs::read_to_string(&full)?;
            let count = src.matches(old).count();
            if count == 0 {
                anyhow::bail!("old_string not found in {p}");
            }
            if count > 1 {
                anyhow::bail!("old_string found {count} times in {p}; need a unique match");
            }
            let out = src.replacen(old, new, 1);
            std::fs::write(&full, out)?;
            Ok(format!("Edited {p}"))
        }
        "list_dir" => {
            let rel = args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
            let full = resolve_project_read_path(root, rel)?;
            let mut entries = Vec::new();
            for e in std::fs::read_dir(&full)? {
                let e = e?;
                let meta = std::fs::symlink_metadata(e.path())?;
                if metadata_is_link_like(&meta) {
                    continue;
                }
                entries.push(json!({
                    "name": e.file_name().to_string_lossy(),
                    "is_dir": meta.is_dir(),
                    "size": meta.len(),
                }));
            }
            entries.sort_by(|a, b| {
                let ad = a.get("is_dir").and_then(|v| v.as_bool()).unwrap_or(false);
                let bd = b.get("is_dir").and_then(|v| v.as_bool()).unwrap_or(false);
                match (ad, bd) {
                    (true, false) => std::cmp::Ordering::Less,
                    (false, true) => std::cmp::Ordering::Greater,
                    _ => a
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .cmp(b.get("name").and_then(|v| v.as_str()).unwrap_or("")),
                }
            });
            Ok(serde_json::to_string_pretty(&entries)?)
        }
        "glob" => {
            let pat = args
                .get("pattern")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("missing pattern"))?;
            let root = root
                .canonicalize()
                .context("Could not resolve project root")?;
            let safe_pattern = validate_project_relative_path(pat)?;
            let pat_full = root.join(safe_pattern).to_string_lossy().to_string();
            let mut matches: Vec<String> = Vec::new();
            for entry in glob::glob(&pat_full)? {
                let e = entry?;
                let Ok(relative) = e.strip_prefix(&root) else {
                    continue;
                };
                let relative = relative.to_string_lossy();
                if let Ok(safe) = resolve_project_read_path(&root, relative.as_ref()) {
                    matches.push(safe.to_string_lossy().replace('\\', "/"));
                }
                if matches.len() >= 500 {
                    break;
                }
            }
            Ok(serde_json::to_string_pretty(&matches)?)
        }
        "grep" => {
            let pat = args
                .get("pattern")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("missing pattern"))?;
            let search_root = args.get("path").and_then(|v| v.as_str());
            let dir = match search_root {
                Some(p) => resolve_project_read_path(root, p)?,
                None => resolve_project_read_path(root, ".")?,
            };
            let re = regex::Regex::new(pat)?;
            let mut hits: Vec<Value> = Vec::new();
            let project_root = root
                .canonicalize()
                .context("Could not resolve project root")?;
            walk(&dir, &project_root, &dir, &re, &mut hits, 1000)?;
            Ok(serde_json::to_string_pretty(&hits)?)
        }
        "run_command" => {
            let cmd = args
                .get("command")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("missing command"))?;
            let timeout = args
                .get("timeout_secs")
                .and_then(|v| v.as_u64())
                .unwrap_or(timeout_secs);
            let cwd = args.get("cwd").and_then(|v| v.as_str());
            let work_dir = match cwd {
                Some(p) => resolve_path(root, p)?,
                None => root.to_path_buf(),
            };
            run_hidden(&work_dir, cmd, timeout, ctx)
        }
        "git_init" => run_hidden(root, "git init", 30, ctx),
        "git_add_all" => run_hidden(root, "git add -A", 60, ctx),
        "git_commit" => {
            let msg = args
                .get("message")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("missing message"))?;
            run_git_commit(root, msg, ctx)
        }
        "git_status" => run_hidden(root, "git status --short", 30, ctx),
        "list_drives" => {
            let mut drives: Vec<Value> = Vec::new();
            for letter in b'A'..=b'Z' {
                let s = format!("{}:\\", letter as char);
                if std::path::Path::new(&s).exists() {
                    let label = format!("{}:", letter as char);
                    let free = std::fs::metadata(&s)
                        .ok()
                        .map(|_| fs_free_space(&s).unwrap_or(0))
                        .unwrap_or(0);
                    let total = fs_total_space(&s).unwrap_or(0);
                    drives.push(json!({
                        "drive": label,
                        "path": s,
                        "free_bytes": free,
                        "total_bytes": total,
                    }));
                }
            }
            Ok(serde_json::to_string_pretty(&drives)?)
        }
        "sys_info" => {
            let info = json!({
                "os": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "hostname": hostname(),
                "username": std::env::var("USERNAME").unwrap_or_default(),
                "home_dir": std::env::var("USERPROFILE").unwrap_or_default(),
                "temp_dir": std::env::var("TEMP").unwrap_or_default(),
                "cpu_count": num_cpus(),
                "exe_dir": std::env::current_exe().map(|p| p.parent().unwrap_or(std::path::Path::new("")).to_string_lossy().to_string()).unwrap_or_default(),
            });
            Ok(serde_json::to_string_pretty(&info)?)
        }
        "env_vars" => {
            let filter = args.get("filter").and_then(|v| v.as_str());
            let vars = environment_variable_inventory(std::env::vars(), filter);
            Ok(serde_json::to_string_pretty(&vars)?)
        }
        "list_processes" => {
            let output = run_hidden(
                root,
                "Get-Process | Select-Object Id,ProcessName,CPU,WorkingSet | Format-Table -AutoSize",
                30,
                ctx,
            )?;
            Ok(output)
        }
        "kill_process" => {
            let pid = args
                .get("pid")
                .and_then(|v| v.as_u64())
                .ok_or_else(|| anyhow::anyhow!("missing pid"))?;
            run_hidden(root, &format!("Stop-Process -Id {pid} -Force"), 30, ctx)
        }
        "open_url" => {
            let url = args
                .get("url")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("missing url"))?;
            crate::integrations::open_browser(url)?;
            Ok(format!("Opened browser: {url}"))
        }
        "connect_account" => {
            let service = args
                .get("service")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("missing service"))?;
            let result = crate::integrations::browser_connect(service)?;
            Ok(serde_json::to_string_pretty(&json!({
                "service": service,
                "flow_started": result.ok,
                "connected": crate::integrations::has_token(service),
                "secure_input_opened": true,
                "message": result.message,
                "detail": result.detail,
            }))?)
        }
        "integration_status" => {
            let service = args.get("service").and_then(|value| value.as_str());
            let verify = args
                .get("verify")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            if let Some(service) = service {
                let status = crate::integrations::status_for(service)?;
                if verify {
                    let check = crate::integrations::test_connection_blocking(service)?;
                    return Ok(serde_json::to_string_pretty(&json!({
                        "id": status.id,
                        "label": status.label,
                        "connected": status.connected,
                        "verified": check.ok,
                        "message": check.message,
                        "detail": check.detail,
                    }))?);
                }
                return Ok(serde_json::to_string_pretty(&json!({
                    "id": status.id,
                    "label": status.label,
                    "connected": status.connected,
                    "verified": null,
                    "message": if status.connected {
                        format!("{} has a credential saved in the OS keyring.", status.label)
                    } else {
                        format!("{} is not connected.", status.label)
                    },
                }))?);
            }
            let list = crate::integrations::list_status()?;
            let slim: Vec<serde_json::Value> = list
                .into_iter()
                .map(|s| {
                    json!({
                        "id": s.id,
                        "label": s.label,
                        "connected": s.connected,
                        "env_keys": s.env_keys,
                    })
                })
                .collect();
            Ok(serde_json::to_string_pretty(&slim)?)
        }
        "open_path" => {
            let p = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("missing path"))?;
            let full = resolve_path(root, p)?;
            let lower = full
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            // HTML/web previews open in the in-app Preview panel (frontend), not Chrome.
            if matches!(lower.as_str(), "html" | "htm" | "xhtml") {
                return Ok(format!(
                    "Preview requested for {} — open in Hormachuelos Preview panel (not external browser).",
                    full.display()
                ));
            }
            open_filesystem_path(&full)?;
            Ok(format!("Opened {}", full.display()))
        }
        "download_file" => {
            let url = args
                .get("url")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("missing url"))?;
            let dest = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("missing path"))?;
            let full = resolve_path(root, dest)?;
            let (written, final_url) = download_public_file(url, &full)?;
            Ok(format!(
                "Downloaded {written} bytes from {final_url} to {dest}"
            ))
        }
        "move_file" => {
            let src = args
                .get("src")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("missing src"))?;
            let dst = args
                .get("dst")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("missing dst"))?;
            let src_full = resolve_path(root, src)?;
            let dst_full = resolve_path(root, dst)?;
            if let Some(parent) = dst_full.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::rename(&src_full, &dst_full)?;
            Ok(format!("Moved {src} → {dst}"))
        }
        "copy_file" => {
            let src = args
                .get("src")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("missing src"))?;
            let dst = args
                .get("dst")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("missing dst"))?;
            let src_full = resolve_path(root, src)?;
            let dst_full = resolve_path(root, dst)?;
            if let Some(parent) = dst_full.parent() {
                std::fs::create_dir_all(parent)?;
            }
            if src_full.is_dir() {
                copy_dir_recursive(&src_full, &dst_full)?;
                Ok(format!("Copied dir {src} → {dst}"))
            } else {
                std::fs::copy(&src_full, &dst_full)?;
                Ok(format!("Copied {src} → {dst}"))
            }
        }
        "delete_file" => {
            let p = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("missing path"))?;
            let full = resolve_path(root, p)?;
            if full.is_dir() {
                std::fs::remove_dir_all(&full)?;
            } else {
                std::fs::remove_file(&full)?;
            }
            Ok(format!("Deleted {p}"))
        }
        "make_dir" => {
            let p = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("missing path"))?;
            let full = resolve_path(root, p)?;
            std::fs::create_dir_all(&full)?;
            Ok(format!("Created dir {p}"))
        }
        "file_info" => {
            let p = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("missing path"))?;
            let full = resolve_project_read_path(root, p)?;
            let meta = std::fs::metadata(&full)?;
            let info = json!({
                "path": p,
                "exists": true,
                "is_dir": meta.is_dir(),
                "is_file": meta.is_file(),
                "size_bytes": meta.len(),
                "readonly": meta.permissions().readonly(),
                "modified": meta.modified().ok().map(|t| t.elapsed().ok().map(|d| d.as_secs()).unwrap_or(0)).unwrap_or(0),
            });
            Ok(serde_json::to_string_pretty(&info)?)
        }
        "view_image" => {
            let p = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("missing path"))?;
            view_image_file(root, p)
        }
        "done" => {
            let summary = args
                .get("summary")
                .and_then(|v| v.as_str())
                .unwrap_or("Done.");
            Ok(format!("__DONE__{summary}"))
        }
        "web_search" => {
            let query = args
                .get("query")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("missing query"))?;
            let max = args
                .get("max_results")
                .and_then(|v| v.as_u64())
                .unwrap_or(5)
                .clamp(1, 10) as usize;
            web_search(query, max)
        }
        "browse_page" => {
            let url = args
                .get("url")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("missing url"))?;
            let max_chars = args
                .get("max_chars")
                .and_then(|v| v.as_u64())
                .unwrap_or(12_000)
                .clamp(500, 50_000) as usize;
            browse_page(url, max_chars)
        }
        "export_client_pack" => {
            let summary = args.get("handoff_summary").and_then(|v| v.as_str());
            let zip_path = if let Some(out) = args
                .get("output_path")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
            {
                resolve_path(root, out)?
            } else {
                let name = root
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| "project".into());
                root.parent()
                    .unwrap_or(root)
                    .join(format!("{name}-client-pack.zip"))
            };
            let result = crate::workspace::export_client_pack(root, &zip_path, summary)?;
            Ok(format!(
                "Client pack ready: {} ({} files). Handoff notes: {}",
                result.zip_path, result.files_count, result.handoff_path
            ))
        }
        "ask_user" => Err(anyhow::anyhow!(
            "ask_user is handled by the agent loop, not tools::execute"
        )),
        "computer_list_windows"
        | "computer_observe"
        | "computer_focus_window"
        | "computer_click"
        | "computer_type_text"
        | "computer_press_key"
        | "computer_scroll"
        | "computer_drag"
        | "computer_game_sequence" => {
            let result = crate::computer_use::execute_tool(name, args)?;
            Ok(serde_json::to_string_pretty(&result)?)
        }
        other => Err(anyhow::anyhow!("Unknown tool: {other}")),
    }
}

#[derive(Serialize)]
struct DirNode {
    name: String,
    is_dir: bool,
    size: u64,
    children: Vec<DirNode>,
}

pub fn list_dir_json(path: &str, max_depth: u32) -> Result<Value> {
    let root = Path::new(path);
    if !root.exists() {
        return Ok(Value::Null);
    }
    fn build(p: &Path, depth: u32, max_depth: u32) -> DirNode {
        let meta = std::fs::metadata(p).ok();
        let name = p
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| p.to_string_lossy().to_string());
        let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let mut children = Vec::new();
        if is_dir && depth < max_depth {
            if let Ok(rd) = std::fs::read_dir(p) {
                let mut entries: Vec<_> = rd.filter_map(|e| e.ok()).collect();
                entries.sort_by(|a, b| {
                    let ad = a.metadata().map(|m| m.is_dir()).unwrap_or(false);
                    let bd = b.metadata().map(|m| m.is_dir()).unwrap_or(false);
                    match (ad, bd) {
                        (true, false) => std::cmp::Ordering::Less,
                        (false, true) => std::cmp::Ordering::Greater,
                        _ => a.file_name().cmp(&b.file_name()),
                    }
                });
                for e in entries.into_iter().take(200) {
                    children.push(build(&e.path(), depth + 1, max_depth));
                }
            }
        }
        DirNode {
            name,
            is_dir,
            size,
            children,
        }
    }
    let node = build(root, 0, max_depth);
    Ok(serde_json::to_value(&node)?)
}

fn walk(
    display_root: &Path,
    project_root: &Path,
    dir: &Path,
    re: &regex::Regex,
    hits: &mut Vec<Value>,
    limit: usize,
) -> Result<()> {
    if hits.len() >= limit {
        return Ok(());
    }
    let canonical_dir = dir.canonicalize()?;
    if !canonical_dir.starts_with(project_root) {
        anyhow::bail!("Search directory resolves outside the active project.");
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let meta = std::fs::symlink_metadata(&path)?;
        if metadata_is_link_like(&meta) {
            continue;
        }
        let canonical = path.canonicalize()?;
        if !canonical.starts_with(project_root) {
            continue;
        }
        if meta.is_dir() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.')
                || name == "node_modules"
                || name == "target"
                || name == ".git"
                || name == "dist"
                || name == "build"
                || name == "__pycache__"
            {
                continue;
            }
            walk(display_root, project_root, &canonical, re, hits, limit)?;
        } else if meta.is_file() {
            if meta.len() > 2_000_000 {
                continue;
            }
            if let Ok(text) = std::fs::read_to_string(&path) {
                let rel = canonical
                    .strip_prefix(display_root)
                    .unwrap_or(&canonical)
                    .to_string_lossy()
                    .replace('\\', "/");
                for (i, line) in text.lines().enumerate() {
                    if re.is_match(line) {
                        hits.push(json!({
                            "path": rel,
                            "line": i + 1,
                            "text": line.chars().take(500).collect::<String>(),
                        }));
                        if hits.len() >= limit {
                            return Ok(());
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

/// Run `git commit -m <msg>` with separate argv (no shell interpolation).
fn run_git_commit(root: &Path, message: &str, ctx: &ToolRunContext) -> Result<String> {
    use std::process::Stdio;

    if ctx.cancel.load(Ordering::SeqCst) {
        return Err(anyhow::anyhow!("Command cancelled."));
    }

    let mut cmd = Command::new("git");
    cmd.args(["commit", "-m", message])
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = cmd.spawn()?;
    register_pid(&child, ctx);
    let result = wait_child_with_pipes(child, 60, ctx);
    clear_pid(ctx);
    result
}

fn run_hidden(
    root: &Path,
    command: &str,
    timeout_secs: u64,
    ctx: &ToolRunContext,
) -> Result<String> {
    use std::process::Stdio;

    if ctx.cancel.load(Ordering::SeqCst) {
        return Err(anyhow::anyhow!("Command cancelled."));
    }

    let mut cmd = Command::new("powershell");
    cmd.arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-NoLogo")
        .arg("-Command")
        .arg(command)
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = cmd.spawn()?;
    register_pid(&child, ctx);
    let result = wait_child_with_pipes(child, timeout_secs, ctx);
    clear_pid(ctx);
    result
}

fn register_pid(child: &std::process::Child, ctx: &ToolRunContext) {
    if let Ok(mut slot) = ctx.active_pid.lock() {
        *slot = Some(child.id());
    }
}

fn clear_pid(ctx: &ToolRunContext) {
    if let Ok(mut slot) = ctx.active_pid.lock() {
        *slot = None;
    }
}

#[derive(Default)]
struct BoundedOutput {
    bytes: Vec<u8>,
    truncated: bool,
}

impl BoundedOutput {
    fn push(&mut self, chunk: &[u8]) {
        let remaining = MAX_COMMAND_OUTPUT_BYTES.saturating_sub(self.bytes.len());
        self.bytes
            .extend_from_slice(&chunk[..chunk.len().min(remaining)]);
        if chunk.len() > remaining {
            self.truncated = true;
        }
    }

    fn into_text(self) -> String {
        let mut text = String::from_utf8_lossy(&self.bytes).into_owned();
        if self.truncated {
            text.push_str("\n...(stream output truncated)");
        }
        text
    }
}

fn emit_console_line(
    sender: &std::sync::mpsc::SyncSender<(String, String)>,
    stream: &str,
    bytes: &[u8],
    truncated: bool,
    allowed_bytes: usize,
) -> usize {
    if allowed_bytes == 0 {
        return 0;
    }
    let mut line = String::from_utf8_lossy(bytes).into_owned();
    if truncated {
        line.push_str("...(console line truncated)");
    }
    if line.len() > allowed_bytes {
        line = utf8_prefix(&line, allowed_bytes).to_string();
    }
    let emitted_bytes = line.len();
    let _ = sender.try_send((stream.to_string(), line));
    emitted_bytes
}

fn pump_pipe<R: Read>(
    mut reader: R,
    stream: &'static str,
    sender: std::sync::mpsc::SyncSender<(String, String)>,
) -> BoundedOutput {
    let mut captured = BoundedOutput::default();
    let mut chunk = [0u8; 8_192];
    let mut line = Vec::with_capacity(1_024);
    let mut discard_line_tail = false;
    const SUPPRESSED_NOTICE: &str = "...(further live console output suppressed)";
    let console_limit = MAX_COMMAND_OUTPUT_BYTES.saturating_sub(SUPPRESSED_NOTICE.len());
    let mut console_bytes = 0usize;
    let mut console_suppressed = false;

    loop {
        let read = match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => read,
            Err(_) => break,
        };
        captured.push(&chunk[..read]);
        for byte in &chunk[..read] {
            if console_bytes >= console_limit {
                console_suppressed = true;
                line.clear();
                continue;
            }
            if *byte == b'\n' {
                if !discard_line_tail {
                    if line.last() == Some(&b'\r') {
                        line.pop();
                    }
                    console_bytes += emit_console_line(
                        &sender,
                        stream,
                        &line,
                        false,
                        console_limit - console_bytes,
                    );
                }
                line.clear();
                discard_line_tail = false;
            } else if !discard_line_tail {
                line.push(*byte);
                if line.len() >= MAX_CONSOLE_LINE_BYTES {
                    console_bytes += emit_console_line(
                        &sender,
                        stream,
                        &line,
                        true,
                        console_limit - console_bytes,
                    );
                    line.clear();
                    discard_line_tail = true;
                }
            }
        }
    }
    if !line.is_empty() && !discard_line_tail {
        console_bytes += emit_console_line(
            &sender,
            stream,
            &line,
            false,
            console_limit.saturating_sub(console_bytes),
        );
    }
    if console_suppressed || captured.truncated || console_bytes >= console_limit {
        let _ = sender.try_send((stream.to_string(), SUPPRESSED_NOTICE.to_string()));
    }
    captured
}

fn wait_child_with_pipes(
    mut child: std::process::Child,
    timeout_secs: u64,
    ctx: &ToolRunContext,
) -> Result<String> {
    use std::sync::mpsc;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("no stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow::anyhow!("no stderr"))?;

    // A bounded channel prevents a noisy process from allocating unbounded
    // memory when UI callbacks cannot keep up with its output rate.
    let (tx, rx) = mpsc::sync_channel::<(String, String)>(256);
    let tx_out = tx.clone();
    let tx_err = tx;

    let stdout_handle = std::thread::spawn(move || pump_pipe(stdout, "stdout", tx_out));
    let stderr_handle = std::thread::spawn(move || pump_pipe(stderr, "stderr", tx_err));

    let timeout = std::time::Duration::from_secs(timeout_secs);
    let start = std::time::Instant::now();
    let mut cancelled = false;
    loop {
        // Drain live console lines
        while let Ok((stream, line)) = rx.try_recv() {
            if let Some(cb) = &ctx.on_console_line {
                cb(&stream, &line);
            }
        }

        match child.try_wait()? {
            Some(_status) => break,
            None => {
                if ctx.cancel.load(Ordering::SeqCst) {
                    cancelled = true;
                    let pid = child.id();
                    let _ = child.kill();
                    kill_process_tree(pid);
                    break;
                }
                if start.elapsed() > timeout {
                    let pid = child.id();
                    let _ = child.kill();
                    kill_process_tree(pid);
                    clear_pid(ctx);
                    return Err(anyhow::anyhow!("Command timed out after {timeout_secs}s"));
                }
                std::thread::sleep(std::time::Duration::from_millis(40));
            }
        }
    }

    // Drain remaining lines after exit
    while let Ok((stream, line)) = rx.try_recv() {
        if let Some(cb) = &ctx.on_console_line {
            cb(&stream, &line);
        }
    }

    let out = stdout_handle.join().unwrap_or_default().into_text();
    let err = stderr_handle.join().unwrap_or_default().into_text();

    while let Ok((stream, line)) = rx.try_recv() {
        if let Some(cb) = &ctx.on_console_line {
            cb(&stream, &line);
        }
    }

    if cancelled {
        return Err(anyhow::anyhow!("Command cancelled."));
    }

    let mut combined = String::new();
    if !out.is_empty() {
        combined.push_str(&out);
    }
    if !err.is_empty() {
        if !combined.is_empty() {
            combined.push_str("\n--- stderr ---\n");
        }
        combined.push_str(&err);
    }
    if combined.is_empty() {
        combined.push_str("(no output)");
    }
    if combined.len() > MAX_COMMAND_OUTPUT_BYTES {
        const NOTICE: &str = "\n...(combined output truncated)";
        let content_limit = MAX_COMMAND_OUTPUT_BYTES.saturating_sub(NOTICE.len());
        combined = format!("{}{}", utf8_prefix(&combined, content_limit), NOTICE);
    }
    Ok(combined)
}

fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown".into())
}

fn num_cpus() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
}

#[cfg(windows)]
fn fs_free_space(path: &str) -> Option<u64> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    unsafe {
        let mut free: i64 = 0;
        let mut total: i64 = 0;
        let mut avail: i64 = 0;
        let wide: Vec<u16> = OsStr::new(path)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let ok = windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(
            windows::core::PCWSTR(wide.as_ptr()),
            Some(&mut free as *mut i64 as *mut _),
            Some(&mut total as *mut i64 as *mut _),
            Some(&mut avail as *mut i64 as *mut _),
        );
        if ok.is_ok() {
            Some(free as u64)
        } else {
            None
        }
    }
}

#[cfg(windows)]
fn fs_total_space(path: &str) -> Option<u64> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    unsafe {
        let mut free: i64 = 0;
        let mut total: i64 = 0;
        let mut avail: i64 = 0;
        let wide: Vec<u16> = OsStr::new(path)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let ok = windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(
            windows::core::PCWSTR(wide.as_ptr()),
            Some(&mut free as *mut i64 as *mut _),
            Some(&mut total as *mut i64 as *mut _),
            Some(&mut avail as *mut i64 as *mut _),
        );
        if ok.is_ok() {
            Some(total as u64)
        } else {
            None
        }
    }
}

#[cfg(not(windows))]
fn fs_free_space(_path: &str) -> Option<u64> {
    None
}
#[cfg(not(windows))]
fn fs_total_space(_path: &str) -> Option<u64> {
    None
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let meta = entry.file_type()?;
        if meta.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if meta.is_symlink() {
            if let Ok(target) = std::fs::read_link(&from) {
                let _ = std::os::windows::fs::symlink_file(&target, &to);
            }
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod security_tests {
    use super::*;
    use std::io::Cursor;

    struct TempTree {
        root: PathBuf,
        outside: PathBuf,
    }

    impl TempTree {
        fn new() -> Self {
            let base =
                std::env::temp_dir().join(format!("ai-forge-tools-{}", uuid::Uuid::new_v4()));
            let root = base.join("project");
            let outside = base.join("outside");
            std::fs::create_dir_all(&root).unwrap();
            std::fs::create_dir_all(&outside).unwrap();
            std::fs::write(root.join("inside.txt"), "inside").unwrap();
            std::fs::write(outside.join("secret.txt"), "top-secret-value").unwrap();
            Self { root, outside }
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            if let Some(base) = self.root.parent() {
                let _ = std::fs::remove_dir_all(base);
            }
        }
    }

    #[test]
    fn read_tools_reject_absolute_and_parent_paths() {
        let tree = TempTree::new();
        let context = ToolRunContext::noop();
        let outside = tree
            .outside
            .join("secret.txt")
            .to_string_lossy()
            .to_string();
        for (tool, args) in [
            ("read_file", json!({"path": "../outside/secret.txt"})),
            ("read_file", json!({"path": outside})),
            ("list_dir", json!({"path": "../outside"})),
            ("grep", json!({"pattern": "secret", "path": "../outside"})),
            ("file_info", json!({"path": "../outside/secret.txt"})),
            ("glob", json!({"pattern": "../outside/*"})),
        ] {
            assert!(
                execute(tool, &args, &tree.root, 5, &context).is_err(),
                "{tool} accepted an outside-project path"
            );
        }
        assert_eq!(
            execute(
                "read_file",
                &json!({"path": "inside.txt"}),
                &tree.root,
                5,
                &context
            )
            .unwrap(),
            "inside"
        );
        let globbed = execute(
            "glob",
            &json!({"pattern": "*.txt"}),
            &tree.root,
            5,
            &context,
        )
        .unwrap();
        assert!(globbed.contains("inside.txt"));
    }

    #[test]
    fn view_image_resolves_project_and_paste_paths_only() {
        let tree = TempTree::new();
        // Project-relative image path resolves inside the project.
        let canonical_root = tree.root.canonicalize().unwrap();
        let relative = resolve_image_read_path(&tree.root, "inside.txt").unwrap();
        assert!(relative.starts_with(&canonical_root));
        // Absolute path inside the app paste temp dir is allowed.
        let paste_dir = std::env::temp_dir().join("hormachuelos-paste");
        std::fs::create_dir_all(&paste_dir).unwrap();
        let pasted = paste_dir.join("paste-test.png");
        std::fs::write(&pasted, b"fake-png").unwrap();
        let resolved = resolve_image_read_path(&tree.root, &pasted.to_string_lossy()).unwrap();
        assert!(resolved.starts_with(&paste_dir.canonicalize().unwrap()));
        // An arbitrary absolute path outside the project is rejected.
        let outside_img = tree.outside.join("shot.png");
        std::fs::write(&outside_img, b"x").unwrap();
        assert!(resolve_image_read_path(&tree.root, &outside_img.to_string_lossy()).is_err());
    }

    #[test]
    fn read_tools_reject_symlink_escape_when_supported() {
        let tree = TempTree::new();
        let link = tree.root.join("linked-secret.txt");
        #[cfg(windows)]
        let linked =
            std::os::windows::fs::symlink_file(tree.outside.join("secret.txt"), &link).is_ok();
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(tree.outside.join("secret.txt"), &link).is_ok();
        if !linked {
            return;
        }
        assert!(execute(
            "read_file",
            &json!({"path": "linked-secret.txt"}),
            &tree.root,
            5,
            &ToolRunContext::noop()
        )
        .is_err());
    }

    #[test]
    fn environment_inventory_never_contains_values() {
        let inventory = environment_variable_inventory(
            vec![
                ("VISIBLE_NAME".to_string(), "super-secret".to_string()),
                ("OTHER".to_string(), "also-secret".to_string()),
            ],
            Some("visible"),
        );
        let encoded = serde_json::to_string(&inventory).unwrap();
        assert!(encoded.contains("VISIBLE_NAME"));
        assert!(encoded.contains("<redacted>"));
        assert!(!encoded.contains("super-secret"));
        assert!(!encoded.contains("also-secret"));
        assert!(!encoded.contains("OTHER"));
    }

    #[test]
    fn private_and_loopback_fetch_targets_are_blocked() {
        for url in [
            "http://127.0.0.1/",
            "http://10.0.0.1/",
            "http://169.254.169.254/latest/meta-data/",
            "http://[::1]/",
            "http://[fd00::1]/",
        ] {
            let parsed = reqwest::Url::parse(url).unwrap();
            assert!(
                validate_public_http_target(&parsed).is_err(),
                "allowed {url}"
            );
        }
        assert!(is_public_ip("8.8.8.8".parse().unwrap()));
        assert!(is_public_ip("2606:4700:4700::1111".parse().unwrap()));
    }

    #[test]
    fn utf8_truncation_and_html_stripping_do_not_split_characters() {
        assert_eq!(utf8_prefix("abc😀def", 5), "abc");
        let stripped = strip_html("<script>const x = '😀';</script><p>Hello 世界</p>");
        assert_eq!(stripped, "Hello 世界");
    }

    #[test]
    fn process_capture_is_bounded_while_pipe_is_fully_drained() {
        let (sender, _receiver) = std::sync::mpsc::sync_channel(1);
        let captured = pump_pipe(
            Cursor::new(vec![b'x'; MAX_COMMAND_OUTPUT_BYTES * 4]),
            "stdout",
            sender,
        );
        assert_eq!(captured.bytes.len(), MAX_COMMAND_OUTPUT_BYTES);
        assert!(captured.truncated);
    }
}
