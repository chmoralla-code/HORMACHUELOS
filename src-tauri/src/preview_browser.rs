use serde::{Deserialize, Serialize};
use tauri::{
    webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Webview, WebviewUrl,
};

const BROWSER_LABEL_PREFIX: &str = "preview-browser-";
const BROWSER_EVENT: &str = "preview-browser-event";
const MAX_BROWSER_URL_LEN: usize = 8_192;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewBrowserBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewBrowserEvent {
    label: String,
    kind: &'static str,
    url: Option<String>,
    title: Option<String>,
}

fn ensure_main_caller(caller: &Webview) -> Result<(), String> {
    if caller.label() == "main" {
        Ok(())
    } else {
        Err("Browser controls are available only to the Hormachuelos app shell.".into())
    }
}

fn validate_label(label: &str) -> Result<(), String> {
    let suffix = label
        .strip_prefix(BROWSER_LABEL_PREFIX)
        .ok_or_else(|| "Invalid preview browser label.".to_string())?;
    if suffix.is_empty()
        || label.len() > 96
        || !suffix
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, b'-' | b'_'))
    {
        return Err("Invalid preview browser label.".into());
    }
    Ok(())
}

fn parse_browser_url(raw: &str) -> Result<tauri::Url, String> {
    let value = raw.trim();
    if value.is_empty() || value.len() > MAX_BROWSER_URL_LEN || value.contains('\0') {
        return Err("Enter a valid web address.".into());
    }
    let url = tauri::Url::parse(value).map_err(|_| "Enter a valid web address.".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Only safe http:// and https:// web addresses are supported.".into());
    }
    Ok(url)
}

fn validate_bounds(bounds: PreviewBrowserBounds) -> Result<PreviewBrowserBounds, String> {
    let values = [bounds.x, bounds.y, bounds.width, bounds.height];
    if values.iter().any(|value| !value.is_finite())
        || bounds.x < 0.0
        || bounds.y < 0.0
        || bounds.width < 2.0
        || bounds.height < 2.0
        || bounds.x > 32_768.0
        || bounds.y > 32_768.0
        || bounds.width > 32_768.0
        || bounds.height > 32_768.0
    {
        return Err("Invalid preview browser bounds.".into());
    }
    Ok(bounds)
}

fn emit_browser_event(
    app: &AppHandle,
    label: impl Into<String>,
    kind: &'static str,
    url: Option<String>,
    title: Option<String>,
) {
    let _ = app.emit_to(
        "main",
        BROWSER_EVENT,
        PreviewBrowserEvent {
            label: label.into(),
            kind,
            url,
            title,
        },
    );
}

fn get_browser(app: &AppHandle, label: &str) -> Result<Webview, String> {
    validate_label(label)?;
    app.get_webview(label)
        .ok_or_else(|| "That browser tab is no longer available.".to_string())
}

#[cfg(windows)]
fn browser_history_action(webview: &Webview, forward: bool) -> Result<(), String> {
    use std::{sync::mpsc, time::Duration};

    let (sender, receiver) = mpsc::channel();
    webview
        .with_webview(move |platform| {
            let result = unsafe {
                platform.controller().CoreWebView2().and_then(|core| {
                    if forward {
                        core.GoForward()
                    } else {
                        core.GoBack()
                    }
                })
            }
            .map_err(|error| error.to_string());
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| "The browser did not respond to the history request.".to_string())?
}

#[cfg(not(windows))]
fn browser_history_action(webview: &Webview, forward: bool) -> Result<(), String> {
    let script = if forward {
        "window.history.forward()"
    } else {
        "window.history.back()"
    };
    webview.eval(script).map_err(|error| error.to_string())
}

/// Create an embedded native browser surface over the preview viewport.
///
/// The caller check and URL allow-list are intentionally repeated for every
/// command. Remote pages receive no capability granting them these commands;
/// this guard is a second boundary if a future Tauri configuration changes.
#[tauri::command]
pub async fn create_preview_browser(
    caller: Webview,
    app: AppHandle,
    label: String,
    url: String,
    bounds: PreviewBrowserBounds,
    visible: bool,
) -> Result<(), String> {
    ensure_main_caller(&caller)?;
    validate_label(&label)?;
    let url = parse_browser_url(&url)?;
    let bounds = validate_bounds(bounds)?;

    if let Some(stale) = app.get_webview(&label) {
        stale.close().map_err(|error| error.to_string())?;
    }

    let window = app
        .get_window("main")
        .ok_or_else(|| "The main application window is unavailable.".to_string())?;

    let navigation_app = app.clone();
    let navigation_label = label.clone();
    let popup_app = app.clone();
    let popup_label = label.clone();
    let load_app = app.clone();
    let title_app = app.clone();

    let builder = WebviewBuilder::new(label.clone(), WebviewUrl::External(url))
        .focused(false)
        .zoom_hotkeys_enabled(true)
        .devtools(cfg!(debug_assertions))
        .on_navigation(move |next| {
            if parse_browser_url(next.as_str()).is_ok() {
                true
            } else {
                emit_browser_event(
                    &navigation_app,
                    navigation_label.clone(),
                    "blocked",
                    Some(next.to_string()),
                    None,
                );
                false
            }
        })
        .on_new_window(move |next, _features| {
            if parse_browser_url(next.as_str()).is_ok() {
                emit_browser_event(
                    &popup_app,
                    popup_label.clone(),
                    "popup",
                    Some(next.to_string()),
                    None,
                );
            }
            NewWindowResponse::Deny
        })
        .on_page_load(move |webview, payload| {
            let kind = match payload.event() {
                PageLoadEvent::Started => "loading",
                PageLoadEvent::Finished => "ready",
            };
            emit_browser_event(
                &load_app,
                webview.label().to_string(),
                kind,
                Some(payload.url().to_string()),
                None,
            );
        })
        .on_document_title_changed(move |webview, title| {
            emit_browser_event(
                &title_app,
                webview.label().to_string(),
                "title",
                webview.url().ok().map(|value| value.to_string()),
                Some(title),
            );
        });

    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|error| error.to_string())?;
    if !visible {
        webview.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn set_preview_browser_bounds(
    caller: Webview,
    app: AppHandle,
    label: String,
    bounds: PreviewBrowserBounds,
    visible: bool,
) -> Result<(), String> {
    ensure_main_caller(&caller)?;
    let bounds = validate_bounds(bounds)?;
    let webview = get_browser(&app, &label)?;
    webview
        .set_position(LogicalPosition::new(bounds.x, bounds.y))
        .map_err(|error| error.to_string())?;
    webview
        .set_size(LogicalSize::new(bounds.width, bounds.height))
        .map_err(|error| error.to_string())?;
    if visible {
        webview.show().map_err(|error| error.to_string())?;
    } else {
        webview.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn navigate_preview_browser(
    caller: Webview,
    app: AppHandle,
    label: String,
    url: String,
) -> Result<(), String> {
    ensure_main_caller(&caller)?;
    let url = parse_browser_url(&url)?;
    get_browser(&app, &label)?
        .navigate(url)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn preview_browser_action(
    caller: Webview,
    app: AppHandle,
    label: String,
    action: String,
) -> Result<(), String> {
    ensure_main_caller(&caller)?;
    let webview = get_browser(&app, &label)?;
    match action.as_str() {
        "back" => browser_history_action(&webview, false),
        "forward" => browser_history_action(&webview, true),
        "reload" => webview.reload().map_err(|error| error.to_string()),
        "focus" => webview.set_focus().map_err(|error| error.to_string()),
        _ => Err("Unsupported browser action.".into()),
    }
}

#[tauri::command]
pub async fn close_preview_browser(
    caller: Webview,
    app: AppHandle,
    label: String,
) -> Result<(), String> {
    ensure_main_caller(&caller)?;
    match get_browser(&app, &label) {
        Ok(webview) => webview.close().map_err(|error| error.to_string()),
        Err(error) if error.contains("no longer available") => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_urls_allow_only_credential_free_http_and_https() {
        assert!(parse_browser_url("https://www.google.com/search?q=hormachuelos").is_ok());
        assert!(parse_browser_url("http://localhost:3000").is_ok());
        assert!(parse_browser_url("javascript:alert(1)").is_err());
        assert!(parse_browser_url("file:///C:/Windows/System32/calc.exe").is_err());
        assert!(parse_browser_url("data:text/html,unsafe").is_err());
        assert!(parse_browser_url("https://user:secret@example.com").is_err());
    }

    #[test]
    fn browser_labels_and_bounds_are_bounded() {
        assert!(validate_label("preview-browser-42").is_ok());
        assert!(validate_label("main").is_err());
        assert!(validate_label("preview-browser-../main").is_err());
        assert!(validate_bounds(PreviewBrowserBounds {
            x: 200.0,
            y: 100.0,
            width: 900.0,
            height: 600.0,
        })
        .is_ok());
        assert!(validate_bounds(PreviewBrowserBounds {
            x: -1.0,
            y: 0.0,
            width: 900.0,
            height: 600.0,
        })
        .is_err());
    }
}
