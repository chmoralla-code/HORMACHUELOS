//! Realtime desktop + in-app visual feedback for Computer Use actions.

use serde::Serialize;
use std::sync::OnceLock;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUseFxEvent {
    pub kind: String,
    pub x: i32,
    pub y: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub char_index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_chars: Option<u32>,
}

static FX_EMITTER: OnceLock<Box<dyn Fn(ComputerUseFxEvent) + Send + Sync>> = OnceLock::new();

pub fn install_emitter(emitter: impl Fn(ComputerUseFxEvent) + Send + Sync + 'static) {
    let _ = FX_EMITTER.set(Box::new(emitter));
}

pub fn emit(event: ComputerUseFxEvent) {
    if let Some(emitter) = FX_EMITTER.get() {
        emitter(event);
    }
}

pub fn cursor_move(x: i32, y: i32) {
    emit(ComputerUseFxEvent {
        kind: "cursor_move".into(),
        x,
        y,
        text: None,
        char_index: None,
        total_chars: None,
    });
}

pub fn click(x: i32, y: i32, button: &str) {
    emit(ComputerUseFxEvent {
        kind: "click".into(),
        x,
        y,
        text: Some(button.to_string()),
        char_index: None,
        total_chars: None,
    });
}

pub fn scroll(x: i32, y: i32, delta_y: i32) {
    emit(ComputerUseFxEvent {
        kind: "scroll".into(),
        x,
        y,
        text: Some(delta_y.to_string()),
        char_index: None,
        total_chars: None,
    });
}

pub fn drag(from_x: i32, from_y: i32, to_x: i32, to_y: i32) {
    emit(ComputerUseFxEvent {
        kind: "drag".into(),
        x: to_x,
        y: to_y,
        text: Some(format!("{from_x},{from_y}")),
        char_index: None,
        total_chars: None,
    });
}

fn private_typing_event(
    kind: &str,
    x: i32,
    y: i32,
    _typed_text: &str,
    char_index: u32,
    total_chars: u32,
) -> ComputerUseFxEvent {
    ComputerUseFxEvent {
        kind: kind.into(),
        x,
        y,
        // Typed content may contain passwords, tokens, or private messages. Keep
        // the legacy optional field in the event schema, but never send its value
        // across the Tauri event boundary. Consumers use progress metadata only.
        text: None,
        char_index: Some(char_index),
        total_chars: Some(total_chars),
    }
}

pub fn type_char(x: i32, y: i32, preview: &str, char_index: u32, total_chars: u32) {
    emit(private_typing_event(
        "type_char",
        x,
        y,
        preview,
        char_index,
        total_chars,
    ));
}

pub fn type_done(x: i32, y: i32, text: &str, total_chars: u32) {
    emit(private_typing_event(
        "type_done",
        x,
        y,
        text,
        total_chars.saturating_sub(1),
        total_chars,
    ));
}

pub fn clear() {
    emit(ComputerUseFxEvent {
        kind: "clear".into(),
        x: 0,
        y: 0,
        text: None,
        char_index: None,
        total_chars: None,
    });
}

#[cfg(test)]
mod tests {
    use super::private_typing_event;

    const SENTINEL_SECRET: &str = "typed-secret-SENTINEL-9f0c2d";

    #[test]
    fn typing_fx_never_serializes_typed_content() {
        for event in [
            private_typing_event("type_char", 10, 20, SENTINEL_SECRET, 3, 24),
            private_typing_event("type_done", 10, 20, SENTINEL_SECRET, 23, 24),
        ] {
            let payload = serde_json::to_string(&event).expect("typing event should serialize");
            assert!(!payload.contains(SENTINEL_SECRET));
            assert!(event.text.is_none());
            assert_eq!(event.total_chars, Some(24));
        }
    }
}
