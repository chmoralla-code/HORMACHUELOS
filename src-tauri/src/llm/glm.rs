use crate::llm::{
    ChatMessage, ContentSink, LlmProvider, LlmResponse, ReasoningSink, ToolCall, ToolCallSink,
};
use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// Generate a Zhipu BigModel JWT token from an "api_key.secret" format key.
/// The JWT is signed with HMAC-SHA256 using the secret portion.
fn make_zhipu_jwt(api_key: &str, secret: &str) -> Result<String> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let exp_ms = now_ms + 3600 * 1000; // 1 hour

    let header = json!({
        "alg": "HS256",
        "sign_type": "SIG"
    });
    let payload = json!({
        "api_key": api_key,
        "exp": exp_ms,
        "timestamp": now_ms
    });

    let header_b64 = URL_SAFE_NO_PAD.encode(serde_json::to_string(&header)?);
    let payload_b64 = URL_SAFE_NO_PAD.encode(serde_json::to_string(&payload)?);
    let signing_input = format!("{header_b64}.{payload_b64}");

    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())?;
    mac.update(signing_input.as_bytes());
    let sig = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());

    Ok(format!("{signing_input}.{sig}"))
}

pub struct Glm {
    client: reqwest::Client,
    raw_key: String,
    base_url: String,
    model: String,
}

impl Glm {
    pub fn new(api_key: &str, base_url: Option<&str>, model: &str) -> Self {
        let default_base = "https://open.bigmodel.cn/api/paas/v4";
        Self {
            client: reqwest::Client::new(),
            raw_key: api_key.to_string(),
            base_url: base_url
                .unwrap_or(default_base)
                .trim_end_matches('/')
                .to_string(),
            model: model.to_string(),
        }
    }

    fn auth_token(&self) -> Result<String> {
        let dot = self.raw_key.find('.').ok_or_else(|| {
            anyhow!(
                "GLM key must be in 'api_key.secret' format, got: {}",
                &self.raw_key[..self.raw_key.len().min(20)]
            )
        })?;
        let (api_key, secret) = self.raw_key.split_at(dot);
        let secret = &secret[1..]; // skip the '.'
        make_zhipu_jwt(api_key, secret)
    }
}

#[async_trait::async_trait]
impl LlmProvider for Glm {
    async fn chat(
        &self,
        messages: &[ChatMessage],
        tools: &[Value],
        _on_reasoning: Option<ReasoningSink>,
        _on_content: Option<ContentSink>,
        _on_tool_call: Option<ToolCallSink>,
    ) -> Result<LlmResponse> {
        let token = self.auth_token()?;

        let mut body = json!({
            "model": self.model,
            "messages": messages.iter().map(|m| {
                let mut o = json!({ "role": m.role });
                if let Value::String(s) = &m.content {
                    o["content"] = Value::String(s.clone());
                } else {
                    o["content"] = m.content.clone();
                }
                if let Some(tc) = &m.tool_calls {
                    o["tool_calls"] = serde_json::to_value(tc).unwrap_or(Value::Null);
                }
                if let Some(id) = &m.tool_call_id {
                    o["tool_call_id"] = Value::String(id.clone());
                }
                if let Some(n) = &m.name {
                    o["name"] = Value::String(n.clone());
                }
                o
            }).collect::<Vec<_>>(),
            "temperature": 0.2,
        });
        if !tools.is_empty() {
            body["tools"] = Value::Array(tools.to_vec());
            body["tool_choice"] = json!("auto");
        }

        let res = self
            .client
            .post(format!("{}/chat/completions", self.base_url))
            .bearer_auth(&token)
            .json(&body)
            .send()
            .await?;

        let status = res.status();
        let text = res.text().await.context("failed reading GLM response")?;
        if !status.is_success() {
            return Err(anyhow!("GLM error {status}: {text}"));
        }

        let v: Value = serde_json::from_str(&text)?;
        let choice = v
            .get("choices")
            .and_then(|c| c.get(0))
            .ok_or_else(|| anyhow!("no choices in response: {text}"))?;
        let msg = choice.get("message").cloned().unwrap_or(Value::Null);
        let content = msg
            .get("content")
            .and_then(|c| c.as_str())
            .map(|s| s.to_string());
        let finish = choice
            .get("finish_reason")
            .and_then(|f| f.as_str())
            .unwrap_or("stop")
            .to_string();

        let mut tool_calls = Vec::new();
        if let Some(tc_arr) = msg.get("tool_calls").and_then(|t| t.as_array()) {
            for tc in tc_arr {
                let id = tc
                    .get("id")
                    .and_then(|i| i.as_str())
                    .unwrap_or("call")
                    .to_string();
                let func = tc.get("function").cloned().unwrap_or(Value::Null);
                let name = func
                    .get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or("")
                    .to_string();
                let args_str = func
                    .get("arguments")
                    .and_then(|a| a.as_str())
                    .unwrap_or("{}");
                let args: Value = serde_json::from_str(args_str).unwrap_or(Value::Null);
                tool_calls.push(ToolCall {
                    id,
                    name,
                    arguments: args,
                });
            }
        }

        let usage = v
            .get("usage")
            .and_then(|u| u.get("total_tokens"))
            .and_then(|t| t.as_u64())
            .unwrap_or(0);

        Ok(LlmResponse {
            text: content,
            tool_calls,
            reasoning_content: None,
            stop_reason: finish,
            usage_tokens: usage,
        })
    }
}
