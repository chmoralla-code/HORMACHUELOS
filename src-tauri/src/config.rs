use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

fn settings_path() -> Result<PathBuf> {
    let proj = directories::ProjectDirs::from("com", "ai-forge", "AI-Forge")
        .context("could not determine config dir")?;
    let dir = proj.config_dir().to_path_buf();
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("settings.json"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub provider: String,
    pub model: String,
    pub base_url: Option<String>,
    pub max_iterations: u32,
    pub command_timeout_secs: u64,
    pub auto_approve: bool,
    /// Permission mode: "plan" | "auto" | "research" | "full"
    #[serde(default = "default_permission_mode")]
    pub permission_mode: String,
    /// Capability chip: thinking | guided | agent | balanced | investigate | brief | autonomous | max
    #[serde(default = "default_capability_mode")]
    pub capability_mode: String,
    /// Mix English + Filipino (Taglish) in agent replies — PH freelancer default off.
    #[serde(default)]
    pub taglish: bool,
    /// Cursor SDK model effort: light | medium | high | xhigh | ultra
    /// (legacy: low | max also accepted)
    #[serde(default = "default_model_effort")]
    pub model_effort: String,
    /// Explicit opt-in for native Windows desktop control through Cursor SDK custom tools.
    #[serde(default)]
    pub computer_use_enabled: bool,
}

fn default_permission_mode() -> String {
    "plan".into()
}

fn default_capability_mode() -> String {
    "thinking".into()
}

fn default_model_effort() -> String {
    "high".into()
}

fn capability_for_mode(mode: &str) -> &'static str {
    match mode {
        "auto" => "agent",
        "research" => "investigate",
        "full" => "autonomous",
        _ => "thinking",
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            provider: "cursor".into(),
            model: "grok-4.5".into(),
            base_url: Some("https://api.cursor.com/v1".into()),
            max_iterations: 25,
            command_timeout_secs: 120,
            auto_approve: false,
            permission_mode: default_permission_mode(),
            capability_mode: default_capability_mode(),
            taglish: false,
            model_effort: default_model_effort(),
            computer_use_enabled: false,
        }
    }
}

impl Settings {
    pub fn load() -> Result<Self> {
        let p = settings_path()?;
        if !p.exists() {
            let s = Self::default();
            s.save()?;
            return Ok(s);
        }
        let raw = std::fs::read_to_string(&p)?;
        let mut s: Self = serde_json::from_str(&raw)?;
        if s.max_iterations == 0 {
            s.max_iterations = 25;
        }
        if s.command_timeout_secs == 0 {
            s.command_timeout_secs = 120;
        }
        if s.permission_mode.trim().is_empty() {
            s.permission_mode = default_permission_mode();
        }
        // Keep auto_approve in sync with mode for older code paths
        let mode = s.permission_mode.to_ascii_lowercase();
        match mode.as_str() {
            "auto" | "full" => {
                s.permission_mode = mode;
                s.auto_approve = true;
            }
            "plan" | "research" => {
                s.permission_mode = mode;
                s.auto_approve = false;
            }
            _ => {
                // Migrate legacy unknown values from auto_approve flag
                s.permission_mode = if s.auto_approve {
                    "auto".into()
                } else {
                    "plan".into()
                };
                s.auto_approve = s.permission_mode == "auto" || s.permission_mode == "full";
            }
        }
        let cap = s.capability_mode.trim().to_ascii_lowercase();
        s.capability_mode = match cap.as_str() {
            "thinking" | "guided" | "agent" | "balanced" | "investigate" | "brief"
            | "autonomous" | "max" => cap,
            _ => capability_for_mode(&s.permission_mode).into(),
        };
        let effort = s.model_effort.trim().to_ascii_lowercase();
        s.model_effort = match effort.as_str() {
            "low" | "light" => "light".into(),
            "medium" => "medium".into(),
            "high" => "high".into(),
            "xhigh" | "extra" | "extra-high" | "extrahigh" => "xhigh".into(),
            "ultra" | "max" => "ultra".into(),
            _ => default_model_effort(),
        };
        // Older builds stored a fabricated OpenAI/GPT label while sending the
        // request through Cursor/Grok. Migrate only that known alias.
        if s.provider.eq_ignore_ascii_case("openai")
            && s.base_url.as_deref() == Some("https://api.cursor.com/v1")
        {
            s.provider = "cursor".into();
            if s.model.trim().is_empty() {
                s.model = "grok-4.5".into();
            }
            s.base_url = Some("https://api.cursor.com/v1".into());
        }
        // Keep whatever Cursor/OpenAI model the user selected — do not force grok-only.
        match (s.provider.as_str(), s.model.as_str()) {
            ("deepseek", "deepseek-chat") => s.model = "deepseek-v4-flash".into(),
            ("deepseek", "deepseek-reasoner") => s.model = "deepseek-v4-pro".into(),
            _ => {}
        }
        if s.provider == "hormachuelos_free" {
            s.model = "hormachuelos-v1".into();
            s.base_url = Some("https://hormachuelos.vercel.app/api/v1".into());
        }
        if s.provider == "deepseek" && s.base_url.as_deref() == Some("https://api.deepseek.com/v1")
        {
            s.base_url = Some("https://api.deepseek.com".into());
        }
        if s.provider == "glm" && s.base_url.as_deref() == Some("https://api.atomeocean.com/v1") {
            s.base_url = Some("https://open.bigmodel.cn/api/paas/v4".into());
        }
        if s.provider == "pollinations"
            && s.base_url.as_deref() == Some("https://text.pollinations.ai/openai")
        {
            s.base_url = Some("https://gen.pollinations.ai/v1".into());
        }
        s.validate()?;
        Ok(s)
    }

    pub fn save(&self) -> Result<()> {
        self.validate()?;
        let p = settings_path()?;
        let raw = serde_json::to_string_pretty(self)?;
        std::fs::write(&p, raw)?;
        Ok(())
    }

    pub fn validate(&self) -> Result<()> {
        validate_provider_id(&self.provider)?;
        ensure!(
            !self.model.trim().is_empty() && self.model.len() <= 200,
            "Model must be 1-200 characters."
        );
        ensure!(
            !self.model.chars().any(char::is_control),
            "Model cannot contain control characters."
        );
        ensure!(
            (1..=100).contains(&self.max_iterations),
            "Max iterations must be between 1 and 100."
        );
        ensure!(
            (5..=600).contains(&self.command_timeout_secs),
            "Command timeout must be between 5 and 600 seconds."
        );
        ensure!(
            matches!(
                self.permission_mode.as_str(),
                "plan" | "auto" | "research" | "full"
            ),
            "Permission mode must be plan, auto, research, or full."
        );
        ensure!(
            matches!(
                self.capability_mode.as_str(),
                "thinking"
                    | "guided"
                    | "agent"
                    | "balanced"
                    | "investigate"
                    | "brief"
                    | "autonomous"
                    | "max"
            ),
            "Capability mode is invalid."
        );
        ensure!(
            matches!(
                self.model_effort.as_str(),
                "light" | "medium" | "high" | "xhigh" | "ultra" | "low" | "max"
            ),
            "Model effort must be light, medium, high, xhigh, or ultra."
        );
        if let Some(base_url) = &self.base_url {
            ensure!(
                !base_url.trim().is_empty() && base_url.len() <= 2048,
                "Base URL must be 1-2048 characters."
            );
            crate::llm::validate_provider_base_url(&self.provider, base_url)?;
        }
        if self.provider == "hormachuelos_free" {
            ensure!(
                self.model == "hormachuelos-v1",
                "HORMACHUELOS FREE only supports Hormachuelos v1."
            );
            ensure!(
                self.base_url.as_deref() == Some("https://hormachuelos.vercel.app/api/v1"),
                "HORMACHUELOS FREE uses the protected Hormachuelos endpoint."
            );
        }
        Ok(())
    }
}

pub fn validate_provider_id(provider: &str) -> Result<()> {
    ensure!(
        matches!(
            provider,
            "deepseek"
                | "openrouter"
                | "glm"
                | "openai"
                | "cursor"
                | "hormachuelos_free"
                | "anthropic"
                | "gemini"
                | "ollama"
                | "pollinations"
        ),
        "Unknown provider."
    );
    Ok(())
}

fn keyring_entry(provider: &str) -> Result<keyring::Entry> {
    validate_provider_id(provider)?;
    Ok(keyring::Entry::new("ai-forge", provider)?)
}

pub fn store_api_key(provider: &str, key: &str) -> Result<()> {
    let key = key.trim();
    ensure!(
        (8..=4096).contains(&key.len()),
        "API key must be between 8 and 4096 characters."
    );
    ensure!(
        !key.chars().any(char::is_control),
        "API key cannot contain control characters."
    );
    let entry = keyring_entry(provider)?;
    entry.set_password(key)?;
    Ok(())
}

pub fn load_api_key(provider: &str) -> Result<String> {
    let entry = keyring_entry(provider)?;
    Ok(entry.get_password()?)
}

pub fn has_api_key(provider: &str) -> bool {
    load_api_key(provider)
        .map(|key| !key.trim().is_empty())
        .unwrap_or(false)
}

/// Load the Cursor credential, with a narrow migration for old builds that
/// stored a `crsr_` key under the former OpenAI display alias.
pub fn load_cursor_sdk_api_key(_provider: &str) -> Result<String> {
    if let Ok(key) = load_api_key("cursor") {
        if !key.trim().is_empty() {
            return Ok(key);
        }
    }
    let legacy = load_api_key("openai")?;
    if legacy.trim().starts_with("crsr_") {
        return Ok(legacy);
    }
    Err(anyhow::anyhow!("No Cursor SDK key is configured."))
}

pub fn delete_api_key(provider: &str) -> Result<()> {
    let entry = keyring_entry(provider)?;
    let _ = entry.delete_credential();
    Ok(())
}

fn website_session_entry() -> Result<keyring::Entry> {
    Ok(keyring::Entry::new("ai-forge", "website_session")?)
}

pub fn store_website_session(token: &str) -> Result<()> {
    let token = token.trim();
    ensure!(
        (16..=4096).contains(&token.len()),
        "Session token must be between 16 and 4096 characters."
    );
    ensure!(
        !token.chars().any(char::is_control),
        "Session token cannot contain control characters."
    );
    website_session_entry()?.set_password(token)?;
    Ok(())
}

pub fn load_website_session() -> Result<String> {
    Ok(website_session_entry()?.get_password()?)
}

pub fn has_website_session() -> bool {
    load_website_session()
        .map(|t| !t.trim().is_empty())
        .unwrap_or(false)
}

pub fn clear_website_session() -> Result<()> {
    let _ = website_session_entry()?.delete_credential();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{validate_provider_id, Settings};

    #[test]
    fn rejects_unknown_provider_ids() {
        assert!(validate_provider_id("../../credential").is_err());
    }

    #[test]
    fn permits_custom_model_ids() {
        let settings = Settings {
            model: "vendor/new-tool-model".into(),
            ..Settings::default()
        };
        assert!(settings.validate().is_ok());
    }

    #[test]
    fn computer_use_is_opt_in() {
        assert!(!Settings::default().computer_use_enabled);
    }

    #[test]
    fn permits_only_the_pinned_hormachuelos_free_alias() {
        let settings = Settings {
            provider: "hormachuelos_free".into(),
            model: "hormachuelos-v1".into(),
            base_url: Some("https://hormachuelos.vercel.app/api/v1".into()),
            ..Settings::default()
        };
        assert!(settings.validate().is_ok());

        let wrong_model = Settings {
            model: "deepseek-v4-flash".into(),
            ..settings
        };
        assert!(wrong_model.validate().is_err());
    }
}
