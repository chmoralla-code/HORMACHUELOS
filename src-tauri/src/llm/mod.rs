use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

/// Receives provider-supplied reasoning text as it arrives.
///
/// Providers that do not expose reasoning may ignore this callback. It must
/// never be populated with invented status text.
pub type ReasoningSink = Arc<dyn Fn(&str) + Send + Sync>;

/// Receives assistant content tokens as they stream.
pub type ContentSink = Arc<dyn Fn(&str) + Send + Sync>;

/// Receives the index, currently accumulated name, and latest raw arguments
/// delta of a streamed tool call.
///
/// This is a UI preview only; execution still waits for the provider's complete,
/// JSON-valid tool call.
pub type ToolCallSink = Arc<dyn Fn(usize, &str, &str) + Send + Sync>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub call_id: String,
    pub name: String,
    pub ok: bool,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: Value,
    pub tool_calls: Option<Vec<ToolCall>>,
    pub tool_call_id: Option<String>,
    pub name: Option<String>,
    pub reasoning_content: Option<String>,
}

impl ChatMessage {
    pub fn user(text: &str) -> Self {
        Self {
            role: "user".into(),
            content: Value::String(text.into()),
            tool_calls: None,
            tool_call_id: None,
            name: None,
            reasoning_content: None,
        }
    }
    pub fn system(text: &str) -> Self {
        Self {
            role: "system".into(),
            content: Value::String(text.into()),
            tool_calls: None,
            tool_call_id: None,
            name: None,
            reasoning_content: None,
        }
    }
    pub fn assistant(
        text: &str,
        tool_calls: Option<Vec<ToolCall>>,
        reasoning_content: Option<String>,
    ) -> Self {
        let content = if text.is_empty() {
            Value::Null
        } else {
            Value::String(text.into())
        };
        Self {
            role: "assistant".into(),
            content,
            tool_calls,
            tool_call_id: None,
            name: None,
            reasoning_content,
        }
    }
    pub fn tool(call_id: &str, name: &str, content: &str) -> Self {
        Self {
            role: "tool".into(),
            content: Value::String(content.into()),
            tool_calls: None,
            tool_call_id: Some(call_id.into()),
            name: Some(name.into()),
            reasoning_content: None,
        }
    }
}

#[async_trait::async_trait]
pub trait LlmProvider: Send + Sync {
    async fn chat(
        &self,
        messages: &[ChatMessage],
        tools: &[Value],
        on_reasoning: Option<ReasoningSink>,
        on_content: Option<ContentSink>,
        on_tool_call: Option<ToolCallSink>,
    ) -> Result<LlmResponse>;
}

#[derive(Debug, Clone)]
pub struct LlmResponse {
    pub text: Option<String>,
    pub tool_calls: Vec<ToolCall>,
    pub reasoning_content: Option<String>,
    pub stop_reason: String,
    pub usage_tokens: u64,
}

pub mod anthropic;
pub mod gemini;
pub mod glm;
pub mod openai;

pub fn provider_needs_key(provider: &str) -> bool {
    !matches!(provider.to_lowercase().as_str(), "ollama")
}

pub fn provider_default_base_url(provider: &str) -> Option<&'static str> {
    match provider.to_lowercase().as_str() {
        "ollama" => Some("http://localhost:11434/v1"),
        "openrouter" => Some("https://openrouter.ai/api/v1"),
        "pollinations" => Some("https://gen.pollinations.ai/v1"),
        "deepseek" => Some("https://api.deepseek.com"),
        "glm" => Some("https://open.bigmodel.cn/api/paas/v4"),
        "openai" => Some("https://api.openai.com/v1"),
        "cursor" => Some("https://api.cursor.com/v1"),
        "anthropic" => Some("https://api.anthropic.com"),
        "gemini" => Some("https://generativelanguage.googleapis.com"),
        _ => None,
    }
}

pub fn validate_provider_base_url(provider: &str, base_url: &str) -> Result<String> {
    let parsed = reqwest::Url::parse(base_url)
        .map_err(|_| anyhow!("invalid_base_url: Enter a complete provider URL."))?;
    if parsed.host_str().is_none() || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(anyhow!(
            "invalid_base_url: Credentials and missing hosts are not allowed."
        ));
    }
    let local_ollama = provider.eq_ignore_ascii_case("ollama")
        && parsed.scheme() == "http"
        && matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if parsed.scheme() != "https" && !local_ollama {
        return Err(anyhow!(
            "invalid_base_url: API keys may only be sent over HTTPS."
        ));
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(anyhow!(
            "invalid_base_url: Query strings and fragments are not allowed."
        ));
    }
    Ok(base_url.trim_end_matches('/').to_string())
}

pub fn build_provider(
    provider: &str,
    api_key: &str,
    base_url: Option<&str>,
    model: &str,
) -> Result<Box<dyn LlmProvider>> {
    let prov = provider.to_lowercase();
    let key = if api_key.is_empty() && !provider_needs_key(&prov) {
        "unused".to_string()
    } else {
        api_key.to_string()
    };
    let base = base_url.or_else(|| provider_default_base_url(&prov));
    let validated_base = base
        .map(|url| validate_provider_base_url(&prov, url))
        .transpose()?;
    let base = validated_base.as_deref();
    match prov.as_str() {
        "openai" | "cursor" => Ok(Box::new(openai::OpenAi::new(&key, base, model, &prov))),
        "anthropic" => Ok(Box::new(anthropic::Anthropic::new(api_key, base, model))),
        "gemini" | "google" => Ok(Box::new(gemini::Gemini::new(api_key, base, model))),
        "ollama" => Ok(Box::new(openai::OpenAi::new(&key, base, model, &prov))),
        "openrouter" => Ok(Box::new(openai::OpenAi::new(&key, base, model, &prov))),
        "pollinations" => Ok(Box::new(openai::OpenAi::new(&key, base, model, &prov))),
        "deepseek" => Ok(Box::new(openai::OpenAi::new(&key, base, model, &prov))),
        "glm" => Ok(Box::new(openai::OpenAi::new(&key, base, model, &prov))),
        other => Err(anyhow!(
            "Unknown provider: {other}. Use deepseek | openrouter | glm | openai | cursor | anthropic | gemini | ollama | pollinations"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::{provider_default_base_url, provider_needs_key, validate_provider_base_url};

    #[test]
    fn rejects_insecure_remote_provider_urls() {
        let error = validate_provider_base_url("deepseek", "http://api.example.com/v1")
            .expect_err("remote HTTP must be rejected");
        assert!(error.to_string().contains("HTTPS"));
    }

    #[test]
    fn permits_local_http_for_ollama_only() {
        assert!(validate_provider_base_url("ollama", "http://localhost:11434/v1").is_ok());
        assert!(validate_provider_base_url("openai", "http://localhost:11434/v1").is_err());
    }

    #[test]
    fn exposes_defaults_for_every_built_in_cloud_provider() {
        for provider in [
            "openai",
            "cursor",
            "anthropic",
            "gemini",
            "openrouter",
            "pollinations",
            "deepseek",
            "glm",
        ] {
            assert!(
                provider_default_base_url(provider).is_some(),
                "missing default URL for {provider}"
            );
            assert!(
                provider_needs_key(provider),
                "{provider} must use a user-owned key"
            );
        }
        assert!(!provider_needs_key("ollama"));
    }
}
