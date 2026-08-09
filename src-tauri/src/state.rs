use crate::config::Settings;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

pub type QuestionResponder = tokio::sync::oneshot::Sender<String>;
pub type ConfirmResponder = tokio::sync::oneshot::Sender<bool>;

/// Per-session agent run handles — allows multiple sessions to run concurrently.
pub struct SessionRun {
    pub cancel: Arc<AtomicBool>,
    pub question_tx: Mutex<Option<QuestionResponder>>,
    pub confirm_tx: Mutex<Option<ConfirmResponder>>,
    pub active_pid: Arc<Mutex<Option<u32>>>,
}

impl SessionRun {
    pub fn new() -> Self {
        Self {
            cancel: Arc::new(AtomicBool::new(false)),
            question_tx: Mutex::new(None),
            confirm_tx: Mutex::new(None),
            active_pid: Arc::new(Mutex::new(None)),
        }
    }

    pub fn request_stop(&self) {
        self.cancel.store(true, Ordering::SeqCst);
        if let Some(pid) = self.active_pid.lock().unwrap().take() {
            crate::tools::kill_process_tree(pid);
        }
        // Unblock any waiters so the loop can exit promptly
        if let Some(tx) = self.confirm_tx.lock().unwrap().take() {
            let _ = tx.send(false);
        }
        if let Some(tx) = self.question_tx.lock().unwrap().take() {
            let _ = tx.send("User cancelled.".into());
        }
    }
}

impl Default for SessionRun {
    fn default() -> Self {
        Self::new()
    }
}

pub struct AppState {
    pub project_root: Mutex<Option<String>>,
    pub settings: Mutex<Settings>,
    pub recent_projects: Mutex<Vec<String>>,
    /// Active agent runs keyed by frontend session id.
    pub runs: Mutex<HashMap<String, Arc<SessionRun>>>,
    /// Cursor SDK local agent ids keyed by session (for multi-turn resume).
    pub cursor_agent_ids: Mutex<HashMap<String, String>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

impl AppState {
    pub fn new() -> Self {
        let settings = Settings::load().unwrap_or_default();
        let recent = load_recent().unwrap_or_default();
        Self {
            project_root: Mutex::new(None),
            settings: Mutex::new(settings),
            recent_projects: Mutex::new(recent),
            runs: Mutex::new(HashMap::new()),
            cursor_agent_ids: Mutex::new(HashMap::new()),
        }
    }

    pub fn cursor_agent_id(&self, session_id: &str) -> Option<String> {
        self.cursor_agent_ids
            .lock()
            .unwrap()
            .get(session_id)
            .cloned()
    }

    pub fn set_cursor_agent_id(&self, session_id: &str, agent_id: Option<String>) {
        let mut map = self.cursor_agent_ids.lock().unwrap();
        match agent_id {
            Some(id) if !id.is_empty() => {
                map.insert(session_id.to_string(), id);
            }
            _ => {
                map.remove(session_id);
            }
        }
    }

    pub fn start_run(&self, session_id: &str) -> Result<Arc<SessionRun>, String> {
        let mut runs = self.runs.lock().unwrap();
        if runs.contains_key(session_id) {
            return Err(
                "This session is already running. Stop it or wait for it to finish.".into(),
            );
        }
        let run = Arc::new(SessionRun::new());
        runs.insert(session_id.to_string(), run.clone());
        Ok(run)
    }

    pub fn get_run(&self, session_id: &str) -> Option<Arc<SessionRun>> {
        self.runs.lock().unwrap().get(session_id).cloned()
    }

    pub fn finish_run(&self, session_id: &str) {
        self.runs.lock().unwrap().remove(session_id);
    }

    pub fn stop_run(&self, session_id: &str) -> bool {
        if let Some(run) = self.runs.lock().unwrap().get(session_id).cloned() {
            run.request_stop();
            true
        } else {
            false
        }
    }

    pub fn stop_all_runs(&self) {
        let runs: Vec<Arc<SessionRun>> = self.runs.lock().unwrap().values().cloned().collect();
        for run in runs {
            run.request_stop();
        }
    }

    /// When any session hits usage limit, stop every concurrent run (all models).
    pub fn halt_all_for_usage_limit(app: &AppHandle) {
        if let Some(state) = app.try_state::<AppState>() {
            state.stop_all_runs();
        }
    }

    pub fn add_recent_project(&self, path: String) {
        let mut list = self.recent_projects.lock().unwrap();
        let key = project_path_key(&path);
        list.retain(|p| project_path_key(p) != key);
        list.insert(0, path);
        if list.len() > 20 {
            list.truncate(20);
        }
        let _ = save_recent(list.clone());
    }

    /// Replace an accidentally selected empty child with the verified parent
    /// project so startup never reintroduces the stale workspace.
    pub fn replace_recent_project(&self, previous: &str, replacement: String) {
        let previous_key = project_path_key(previous);
        let replacement_key = project_path_key(&replacement);
        let mut list = self.recent_projects.lock().unwrap();
        list.retain(|path| {
            let key = project_path_key(path);
            key != previous_key && key != replacement_key
        });
        list.insert(0, replacement);
        if list.len() > 20 {
            list.truncate(20);
        }
        let _ = save_recent(list.clone());
    }
}

fn project_path_key(path: &str) -> String {
    let mut value = path.trim().replace('/', "\\");
    if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
        value = format!(r"\\{unc}");
    } else if let Some(plain) = value.strip_prefix(r"\\?\") {
        value = plain.to_string();
    }
    value.trim_end_matches('\\').to_ascii_lowercase()
}

fn recent_path() -> Option<std::path::PathBuf> {
    let proj = directories::ProjectDirs::from("com", "ai-forge", "AI-Forge")?;
    let dir = proj.config_dir().to_path_buf();
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("recent.json"))
}

fn load_recent() -> anyhow::Result<Vec<String>> {
    let p = recent_path().ok_or_else(|| anyhow::anyhow!("no config dir"))?;
    if !p.exists() {
        return Ok(vec![]);
    }
    let raw = std::fs::read_to_string(&p)?;
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

fn save_recent(list: Vec<String>) -> anyhow::Result<()> {
    let p = recent_path().ok_or_else(|| anyhow::anyhow!("no config dir"))?;
    let raw = serde_json::to_string_pretty(&list)?;
    std::fs::write(&p, raw)?;
    Ok(())
}
