pub mod agent;
pub mod computer_fx;
pub mod computer_use;
pub mod config;
pub mod cursor_bridge;
pub mod integration_chat;
pub mod integrations;
pub mod license;
pub mod llm;
pub mod state;
pub mod templates;
pub mod tools;
pub mod workspace;

use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionTestResult {
    ok: bool,
    latency_ms: u128,
    error_code: Option<String>,
    message: String,
}

#[tauri::command]
fn get_project_root(state: tauri::State<'_, state::AppState>) -> Option<String> {
    state.project_root.lock().unwrap().clone()
}

#[tauri::command]
fn set_project_root(path: String, state: tauri::State<'_, state::AppState>) -> Result<(), String> {
    let root = workspace::canonical_project_root(std::path::Path::new(&path))
        .map_err(|error| error.to_string())?;
    let canonical = root.to_string_lossy().to_string();
    *state.project_root.lock().unwrap() = Some(canonical.clone());
    state.add_recent_project(canonical);
    Ok(())
}

#[tauri::command]
fn list_recent_projects(state: tauri::State<'_, state::AppState>) -> Vec<String> {
    state.recent_projects.lock().unwrap().clone()
}

#[tauri::command]
async fn get_settings(
    state: tauri::State<'_, state::AppState>,
) -> Result<config::Settings, String> {
    Ok(state.settings.lock().unwrap().clone())
}

#[tauri::command]
async fn save_settings(
    mut settings: config::Settings,
    state: tauri::State<'_, state::AppState>,
) -> Result<(), String> {
    // Normalize permission mode + auto_approve together
    let mode = settings.permission_mode.trim().to_ascii_lowercase();
    settings.permission_mode = match mode.as_str() {
        "plan" | "auto" | "research" | "full" => mode,
        _ => {
            if settings.auto_approve {
                "auto".into()
            } else {
                "plan".into()
            }
        }
    };
    settings.auto_approve =
        settings.permission_mode == "auto" || settings.permission_mode == "full";
    settings.validate().map_err(|e| e.to_string())?;
    settings.save().map_err(|e| e.to_string())?;
    *state.settings.lock().unwrap() = settings;
    Ok(())
}

#[tauri::command]
fn get_computer_use_status() -> computer_use::ComputerUseStatus {
    computer_use::status()
}

#[tauri::command]
fn set_computer_use_paused(
    paused: bool,
    app: tauri::AppHandle,
    state: tauri::State<'_, state::AppState>,
) -> computer_use::ComputerUseStatus {
    computer_use::set_paused(paused);
    if paused {
        state.stop_all_runs();
    }
    let status = computer_use::status();
    let _ = app.emit("computer-use-status", &status);
    status
}

#[tauri::command]
async fn set_api_key(provider: String, key: String) -> Result<(), String> {
    config::store_api_key(&provider, &key).map_err(|e| e.to_string())
}

#[tauri::command]
async fn has_api_key(provider: String) -> Result<bool, String> {
    config::validate_provider_id(&provider).map_err(|e| e.to_string())?;
    if provider.eq_ignore_ascii_case("cursor") {
        return Ok(config::load_cursor_sdk_api_key("cursor")
            .map(|key| !key.trim().is_empty())
            .unwrap_or(false));
    }
    Ok(config::has_api_key(&provider))
}

#[tauri::command]
async fn clear_api_key(provider: String) -> Result<(), String> {
    config::delete_api_key(&provider).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_website_session(token: String) -> Result<(), String> {
    config::store_website_session(&token).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_website_session() -> Result<Option<String>, String> {
    match config::load_website_session() {
        Ok(t) if !t.trim().is_empty() => Ok(Some(t)),
        _ => Ok(None),
    }
}

#[tauri::command]
fn clear_website_session() -> Result<(), String> {
    config::clear_website_session().map_err(|e| e.to_string())
}

#[tauri::command]
fn open_external_url(url: String, app: tauri::AppHandle) -> Result<(), String> {
    let url = url.trim();
    if !(url.starts_with("https://")
        || url.starts_with("http://localhost")
        || url.starts_with("http://127.0.0.1"))
    {
        return Err("Only http(s) URLs can be opened.".into());
    }
    app.opener()
        .open_url(url, None::<String>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn respond_to_question(
    answer: String,
    session_id: String,
    state: tauri::State<'_, state::AppState>,
) -> Result<(), String> {
    let run = state
        .get_run(&session_id)
        .ok_or_else(|| "No active run for this session.".to_string())?;
    let tx = run.question_tx.lock().unwrap().take();
    match tx {
        Some(tx) => {
            let _ = tx.send(answer);
            Ok(())
        }
        None => Err("No pending question to respond to.".into()),
    }
}

#[tauri::command]
async fn respond_to_confirm(
    approved: bool,
    session_id: String,
    state: tauri::State<'_, state::AppState>,
) -> Result<(), String> {
    let run = state
        .get_run(&session_id)
        .ok_or_else(|| "No active run for this session.".to_string())?;
    let tx = run.confirm_tx.lock().unwrap().take();
    match tx {
        Some(tx) => {
            let _ = tx.send(approved);
            Ok(())
        }
        None => Err("No pending tool confirmation.".into()),
    }
}

#[tauri::command]
async fn test_provider_connection(
    provider: String,
    model: String,
    base_url: Option<String>,
) -> Result<ConnectionTestResult, String> {
    config::validate_provider_id(&provider).map_err(|e| e.to_string())?;
    if model.trim().is_empty() || model.len() > 200 || model.chars().any(char::is_control) {
        return Err("Model must be 1-200 characters without control characters.".into());
    }
    if let Some(url) = base_url.as_deref() {
        llm::validate_provider_base_url(&provider, url).map_err(|e| e.to_string())?;
    }

    let started = std::time::Instant::now();
    let key = if llm::provider_needs_key(&provider) {
        match config::load_api_key(&provider) {
            Ok(key) => key,
            Err(_) => {
                return Ok(ConnectionTestResult {
                    ok: false,
                    latency_ms: started.elapsed().as_millis(),
                    error_code: Some("missing_api_key".into()),
                    message: "Save an API key for this provider first.".into(),
                });
            }
        }
    } else {
        String::new()
    };

    let client = llm::build_provider(&provider, &key, base_url.as_deref(), model.trim())
        .map_err(|e| e.to_string())?;
    let messages = [
        llm::ChatMessage::system("This is a connection test. Reply with OK only."),
        llm::ChatMessage::user("OK"),
    ];
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        client.chat(&messages, &[], None, None, None),
    )
    .await;

    let latency_ms = started.elapsed().as_millis();
    match result {
        Ok(Ok(_)) => Ok(ConnectionTestResult {
            ok: true,
            latency_ms,
            error_code: None,
            message: format!("Connected to {} in {} ms.", model.trim(), latency_ms),
        }),
        Ok(Err(error)) => {
            let text = error.to_string();
            let code = text
                .split_once(':')
                .map(|(code, _)| code)
                .filter(|code| code.chars().all(|ch| ch.is_ascii_lowercase() || ch == '_'))
                .unwrap_or("provider_error")
                .to_string();
            Ok(ConnectionTestResult {
                ok: false,
                latency_ms,
                error_code: Some(code),
                message: text,
            })
        }
        Err(_) => Ok(ConnectionTestResult {
            ok: false,
            latency_ms,
            error_code: Some("provider_timeout".into()),
            message: "The provider did not respond within 20 seconds.".into(),
        }),
    }
}

#[tauri::command]
async fn list_provider_models(
    provider: String,
    base_url: Option<String>,
) -> Result<Vec<String>, String> {
    config::validate_provider_id(&provider).map_err(|e| e.to_string())?;
    let license = license::LicenseStatus::load().unwrap_or_default();
    let use_hosted = license::should_use_hosted(&license);
    if provider.eq_ignore_ascii_case("cursor") && !use_hosted {
        let key = config::load_cursor_sdk_api_key("cursor")
            .map_err(|_| "Save a Cursor / OpenAI key before refreshing models.".to_string())?;
        return cursor_bridge::list_cursor_models(&key)
            .await
            .map_err(|e| e.to_string());
    }
    let (key, base_url) = if use_hosted {
        (license.license_key.clone(), license::hosted_chat_base_url())
    } else {
        let base_url = base_url
            .as_deref()
            .or_else(|| llm::provider_default_base_url(&provider))
            .ok_or_else(|| "A base URL is required for this provider.".to_string())?;
        let base_url =
            llm::validate_provider_base_url(&provider, base_url).map_err(|e| e.to_string())?;
        let key = if llm::provider_needs_key(&provider) {
            config::load_api_key(&provider).map_err(|_| {
                "Save an API key for this provider before refreshing models.".to_string()
            })?
        } else {
            String::new()
        };
        (key, base_url)
    };
    match provider.to_lowercase().as_str() {
        "anthropic" => llm::anthropic::fetch_model_ids(&key, &base_url).await,
        "gemini" => llm::gemini::fetch_model_ids(&key, &base_url).await,
        _ => llm::openai::fetch_model_ids(&provider, &key, &base_url).await,
    }
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_project_dir(
    path: String,
    template_id: Option<String>,
    state: tauri::State<'_, state::AppState>,
) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    let tid = template_id.unwrap_or_else(|| "blank".into());
    templates::scaffold(&tid, p).map_err(|e| e.to_string())?;
    let root = workspace::canonical_project_root(p).map_err(|error| error.to_string())?;
    let canonical = root.to_string_lossy().to_string();
    *state.project_root.lock().unwrap() = Some(canonical.clone());
    state.add_recent_project(canonical);
    Ok(())
}

#[tauri::command]
fn list_project_templates() -> Vec<serde_json::Value> {
    templates::TEMPLATES
        .iter()
        .map(|t| {
            serde_json::json!({
                "id": t.id,
                "label": t.label,
                "blurb": t.blurb,
            })
        })
        .collect()
}

#[tauri::command]
fn export_client_pack(
    dest_path: Option<String>,
    handoff_summary: Option<String>,
    state: tauri::State<'_, state::AppState>,
) -> Result<workspace::ClientPackResult, String> {
    let root = state
        .project_root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "Open a project before exporting a client pack.".to_string())?;
    let root_path = std::path::Path::new(&root);
    let zip_path = if let Some(dest) = dest_path.filter(|s| !s.trim().is_empty()) {
        std::path::PathBuf::from(dest)
    } else {
        let name = root_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "project".into());
        root_path
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .join(format!("{name}-client-pack.zip"))
    };
    workspace::export_client_pack(root_path, &zip_path, handoff_summary.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_license_status() -> Result<license::LicenseStatus, String> {
    license::LicenseStatus::load()
        .map(|s| s.for_api())
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn apply_license_key(key: String) -> Result<license::LicenseStatus, String> {
    license::apply_license_key(&key)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn record_license_usage(tokens: u64) -> Result<license::LicenseStatus, String> {
    license::record_token_usage(tokens).map_err(|e| e.to_string())
}

/// Persist a clipboard / drag-drop image so the composer can attach it by path.
#[tauri::command]
fn save_pasted_image(data_base64: String, mime: Option<String>) -> Result<String, String> {
    use base64::Engine;
    let raw = data_base64.trim();
    let b64 = raw
        .strip_prefix("data:")
        .and_then(|s| s.split_once(',').map(|(_, d)| d))
        .unwrap_or(raw);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(b64))
        .map_err(|e| format!("Invalid image data: {e}"))?;
    if bytes.is_empty() {
        return Err("Empty image data.".into());
    }
    if bytes.len() > 25 * 1024 * 1024 {
        return Err("Image is too large (max 25 MB).".into());
    }
    let mime_l = mime.unwrap_or_default().to_ascii_lowercase();
    let ext = if mime_l.contains("jpeg") || mime_l.contains("jpg") {
        "jpg"
    } else if mime_l.contains("webp") {
        "webp"
    } else if mime_l.contains("gif") {
        "gif"
    } else if mime_l.contains("bmp") {
        "bmp"
    } else if mime_l.contains("svg") {
        "svg"
    } else {
        "png"
    };
    let dir = std::env::temp_dir().join("hormachuelos-paste");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("paste-{}.{}", uuid::Uuid::new_v4(), ext));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn list_project_files(
    max_depth: Option<u32>,
    state: tauri::State<'_, state::AppState>,
) -> Result<workspace::ProjectTree, String> {
    let root = state
        .project_root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "Open a project to browse its files.".to_string())?;
    workspace::list_project_files(std::path::Path::new(&root), max_depth.unwrap_or(8))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn read_project_file(
    relative_path: String,
    state: tauri::State<'_, state::AppState>,
) -> Result<workspace::FilePreview, String> {
    let root = state
        .project_root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "Open a project to preview a file.".to_string())?;
    workspace::read_project_file(std::path::Path::new(&root), &relative_path)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn agent_run(
    prompt: String,
    session_id: String,
    history: Option<Vec<agent::HistoryTurn>>,
    app: tauri::AppHandle,
    state: tauri::State<'_, state::AppState>,
) -> Result<(), String> {
    if session_id.trim().is_empty() {
        return Err("Missing session id.".into());
    }
    if !config::has_website_session() {
        return Err(
            "Sign in with your Hormachuelos website account first (Download → Log in / Sign up)."
                .into(),
        );
    }
    // Soft server-side reminder if a forced update is published (UI gate is primary).
    if let Ok(client) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(4))
        .build()
    {
        let current = env!("CARGO_PKG_VERSION");
        let url = format!("https://hormachuelos.vercel.app/api/update?current={current}");
        if let Ok(resp) = client.get(&url).send().await {
            if let Ok(value) = resp.json::<serde_json::Value>().await {
                if value.get("forceUpdate").and_then(|v| v.as_bool()) == Some(true) {
                    let latest = value
                        .pointer("/latest/version")
                        .and_then(|v| v.as_str())
                        .unwrap_or("latest");
                    return Err(format!(
                        "Update required: install Hormachuelos {latest} from hormachuelos.vercel.app/#/update before running agents."
                    ));
                }
            }
        }
    }
    let project_root = state
        .project_root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "No project open. Create or open a project first.".to_string())?;
    // Always reload settings from disk so Plan/Auto/Full mode changes apply
    // even if in-memory state was stale.
    let settings = match config::Settings::load() {
        Ok(s) => {
            *state.settings.lock().unwrap() = s.clone();
            s
        }
        Err(_) => state.settings.lock().unwrap().clone(),
    };

    // Block new runs when plan period usage is already exhausted (multi-session safe).
    if let Ok(mut lic) = license::LicenseStatus::load() {
        let _ = lic.refresh_plan_block();
        if !lic.active {
            return Err(if lic.message.trim().is_empty() {
                "This license is inactive. Renew it before starting a new run.".into()
            } else {
                lic.message
            });
        }
        if !license::usage_limits_disabled() && lic.is_rate_blocked() {
            return Err(
                "You've used up this plan period. Mag-load via GCash or upgrade to continue."
                    .into(),
            );
        }
    }

    let run = state.start_run(&session_id)?;
    let app_handle = Arc::new(app);
    let cursor_resume = state.cursor_agent_id(&session_id);
    let result = agent::run_loop(
        app_handle,
        project_root,
        prompt,
        settings,
        session_id.clone(),
        run,
        history.unwrap_or_default(),
        cursor_resume,
    )
    .await;
    match &result {
        Ok(Some(agent_id)) => state.set_cursor_agent_id(&session_id, Some(agent_id.clone())),
        Ok(None) => {}
        Err(_) => {}
    }
    state.finish_run(&session_id);
    result.map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn agent_stop(session_id: String, state: tauri::State<'_, state::AppState>) -> Result<(), String> {
    if session_id.trim().is_empty() {
        return Err("Missing session id.".into());
    }
    if !state.stop_run(&session_id) {
        return Err("No active run for this session.".into());
    }
    Ok(())
}

#[tauri::command]
fn open_project_in_explorer(
    relative_path: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, state::AppState>,
) -> Result<(), String> {
    let root = state
        .project_root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "Open a project first.".to_string())?;
    let path = workspace::resolve_project_path(
        std::path::Path::new(&root),
        relative_path.as_deref().unwrap_or(""),
    )
    .map_err(|error| error.to_string())?;
    app.opener()
        .open_path(path.to_string_lossy().to_string(), None::<String>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[derive(serde::Serialize)]
struct AgentSkill {
    id: String,
    name: String,
    path: String,
    source: String,
}

/// Discover agent skills from common Cursor / Claude skill directories.
#[tauri::command]
fn list_agent_skills(state: tauri::State<'_, state::AppState>) -> Vec<AgentSkill> {
    let mut out: Vec<AgentSkill> = Vec::new();
    let mut seen = std::collections::HashSet::<String>::new();

    let mut roots: Vec<(std::path::PathBuf, &'static str)> = Vec::new();
    if let Some(home) = directories::UserDirs::new().map(|u| u.home_dir().to_path_buf()) {
        roots.push((home.join(".agents").join("skills"), "agents"));
        roots.push((home.join(".cursor").join("skills-cursor"), "cursor"));
        roots.push((home.join(".cursor").join("skills"), "cursor"));
        roots.push((home.join(".claude").join("skills"), "claude"));
    }
    if let Some(project) = state.project_root.lock().unwrap().clone() {
        let p = std::path::PathBuf::from(project);
        roots.push((p.join(".agents").join("skills"), "project"));
        roots.push((p.join(".cursor").join("skills"), "project"));
        roots.push((p.join("skills"), "project"));
    }

    for (root, source) in roots {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let skill_md = path.join("SKILL.md");
            if !skill_md.is_file() {
                // Also accept bare folders with a skill.md lowercase
                let alt = path.join("skill.md");
                if !alt.is_file() {
                    continue;
                }
            }
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("skill")
                .to_string();
            let full = path.to_string_lossy().to_string();
            if !seen.insert(full.clone()) {
                continue;
            }
            out.push(AgentSkill {
                id: format!("{source}:{name}"),
                name,
                path: full,
                source: source.to_string(),
            });
        }
    }

    out.sort_by(|a, b| {
        a.name
            .to_ascii_lowercase()
            .cmp(&b.name.to_ascii_lowercase())
    });
    out
}

#[tauri::command]
fn list_integrations() -> Result<Vec<integrations::IntegrationStatus>, String> {
    integrations::list_status().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_integration_token(id: String, token: String) -> Result<(), String> {
    integrations::store_token(&id, &token).map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_integration_token(id: String) -> Result<(), String> {
    integrations::clear_token(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_integration_extras(
    id: String,
    fields: std::collections::HashMap<String, String>,
) -> Result<(), String> {
    integrations::set_extras(&id, fields).map_err(|e| e.to_string())
}

#[tauri::command]
async fn test_integration(id: String) -> Result<integrations::IntegrationTestResult, String> {
    integrations::test_connection(&id)
        .await
        .map_err(|e| e.to_string())
}

/// Open browser / device-flow auth for an integration (GitHub web login, token pages, …).
#[tauri::command]
async fn start_integration_browser_auth(
    id: String,
) -> Result<integrations::IntegrationTestResult, String> {
    // Run blocking CLI/device flow off the async runtime
    let id2 = id.clone();
    tokio::task::spawn_blocking(move || integrations::browser_connect(&id2))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

fn ensure_computer_fx_overlay(app: &AppHandle) {
    if app.get_webview_window("computer-fx").is_some() {
        return;
    }
    if let Ok(window) = WebviewWindowBuilder::new(
        app,
        "computer-fx",
        WebviewUrl::App("computer-fx.html".into()),
    )
    .title("Computer FX")
    .transparent(true)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(true)
    .focused(false)
    .resizable(false)
    .fullscreen(true)
    .build()
    {
        let _ = window.set_ignore_cursor_events(true);
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(state::AppState::new())
        .invoke_handler(tauri::generate_handler![
            get_project_root,
            set_project_root,
            list_recent_projects,
            get_settings,
            save_settings,
            get_computer_use_status,
            set_computer_use_paused,
            set_api_key,
            has_api_key,
            clear_api_key,
            set_website_session,
            get_website_session,
            clear_website_session,
            open_external_url,
            respond_to_question,
            respond_to_confirm,
            test_provider_connection,
            list_provider_models,
            create_project_dir,
            list_project_templates,
            list_project_files,
            read_project_file,
            export_client_pack,
            get_license_status,
            apply_license_key,
            record_license_usage,
            save_pasted_image,
            agent_run,
            agent_stop,
            open_project_in_explorer,
            app_version,
            list_agent_skills,
            list_integrations,
            set_integration_token,
            clear_integration_token,
            set_integration_extras,
            test_integration,
            start_integration_browser_auth,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            computer_fx::install_emitter(move |event| {
                ensure_computer_fx_overlay(&handle);
                let _ = handle.emit("computer-use-fx", &event);
            });
            computer_use::install_emergency_hotkey(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Hormachuelos");
}

#[cfg(test)]
mod desktop_config_tests {
    #[test]
    fn packaged_csp_allows_the_hosted_account_api() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("valid Tauri config");
        let csp = config
            .pointer("/app/security/csp")
            .and_then(serde_json::Value::as_str)
            .expect("string CSP");
        let connect_src = csp
            .split(';')
            .find(|directive| directive.trim_start().starts_with("connect-src "))
            .expect("connect-src directive");

        assert!(
            connect_src
                .split_ascii_whitespace()
                .any(|source| source == "https://hormachuelos.vercel.app"),
            "the packaged webview must be allowed to start and poll browser sign-in"
        );
    }
}
