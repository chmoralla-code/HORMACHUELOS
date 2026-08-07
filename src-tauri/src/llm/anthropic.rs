use crate::llm::{
    build_client, request_error, ChatMessage, ContentSink, LlmProvider, LlmResponse, ReasoningSink,
    ToolCall, ToolCallSink,
};
use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use std::time::Duration;

fn parse_model_ids(text: &str) -> Result<Vec<String>> {
    let value: Value = serde_json::from_str(text)
        .map_err(|_| anyhow!("invalid_response: Anthropic returned malformed model data."))?;
    let data = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("invalid_response: Anthropic returned no model list."))?;
    let mut models: Vec<String> = data
        .iter()
        .filter_map(|model| model.get("id").and_then(Value::as_str))
        .filter(|model| !model.is_empty() && model.len() <= 200)
        .map(str::to_string)
        .collect();
    models.sort();
    models.dedup();
    models.truncate(200);
    Ok(models)
}

pub async fn fetch_model_ids(api_key: &str, base_url: &str) -> Result<Vec<String>> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| anyhow!("network_error: Could not initialize the Anthropic client."))?;
    let response = client
        .get(format!("{}/v1/models", base_url.trim_end_matches('/')))
        .query(&[("limit", "1000")])
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await
        .map_err(|_| anyhow!("network_error: Could not reach Anthropic."))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|_| anyhow!("invalid_response: Anthropic's model list could not be read."))?;
    if !status.is_success() {
        return Err(match status.as_u16() {
            401 | 403 => anyhow!("authentication_failed: Anthropic rejected the saved API key."),
            429 => anyhow!("rate_limited: Anthropic rate-limited the model request."),
            _ => anyhow!("provider_error: Anthropic could not list models (HTTP {status})."),
        });
    }
    let models = parse_model_ids(&text)?;
    if models.is_empty() {
        return Err(anyhow!(
            "no_compatible_models: Anthropic returned no models."
        ));
    }
    Ok(models)
}

pub struct Anthropic {
    client: reqwest::Client,
    api_key: String,
    base_url: String,
    model: String,
}

impl Anthropic {
    pub fn new(api_key: &str, base_url: Option<&str>, model: &str) -> Self {
        Self {
            client: build_client(),
            api_key: api_key.to_string(),
            base_url: base_url
                .unwrap_or("https://api.anthropic.com")
                .trim_end_matches('/')
                .to_string(),
            model: model.to_string(),
        }
    }
}

fn msg_to_anthropic(m: &ChatMessage) -> Option<Value> {
    match m.role.as_str() {
        "system" => None,
        "user" => Some(json!({ "role": "user", "content": m.content })),
        "assistant" => {
            let mut blocks = Vec::new();
            if let Some(t) = m.content.as_str() {
                if !t.is_empty() {
                    blocks.push(json!({ "type": "text", "text": t }));
                }
            }
            if let Some(tcs) = &m.tool_calls {
                for tc in tcs {
                    blocks.push(json!({
                        "type": "tool_use",
                        "id": tc.id,
                        "name": tc.name,
                        "input": tc.arguments,
                    }));
                }
            }
            if blocks.is_empty() {
                return None;
            }
            Some(json!({ "role": "assistant", "content": blocks }))
        }
        "tool" => {
            let content = m.content.as_str().unwrap_or("");
            Some(json!({
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": m.tool_call_id,
                    "content": content,
                }],
            }))
        }
        _ => None,
    }
}

#[async_trait::async_trait]
impl LlmProvider for Anthropic {
    async fn chat(
        &self,
        messages: &[ChatMessage],
        tools: &[Value],
        _on_reasoning: Option<ReasoningSink>,
        _on_content: Option<ContentSink>,
        _on_tool_call: Option<ToolCallSink>,
    ) -> Result<LlmResponse> {
        let system = messages
            .iter()
            .find_map(|m| {
                if m.role == "system" {
                    m.content.as_str().map(|s| s.to_string())
                } else {
                    None
                }
            })
            .unwrap_or_default();

        let conv: Vec<Value> = messages.iter().filter_map(msg_to_anthropic).collect();

        let mut body = json!({
            "model": self.model,
            "max_tokens": 4096,
            "system": system,
            "messages": conv,
            "temperature": 0.2,
        });

        if !tools.is_empty() {
            let tools_arr: Vec<Value> = tools.iter().map(|t| {
                json!({
                    "name": t.get("function").and_then(|f| f.get("name")).cloned().unwrap_or(Value::Null),
                    "description": t.get("function").and_then(|f| f.get("description")).cloned().unwrap_or(Value::Null),
                    "input_schema": t.get("function").and_then(|f| f.get("parameters")).cloned().unwrap_or(json!({})),
                })
            }).collect();
            body["tools"] = Value::Array(tools_arr);
        }

        // Retry transient upstream failures (429/5xx) with short backoff so a
        // blip does not abort an active run.
        let mut response = None;
        for attempt in 0..3 {
            let result = self
                .client
                .post(format!("{}/v1/messages", self.base_url))
                .header("x-api-key", &self.api_key)
                .header("anthropic-version", "2023-06-01")
                .json(&body)
                .send()
                .await
                .map_err(|error| request_error(&error));
            match result {
                Ok(res) => {
                    let status = res.status();
                    let retryable = matches!(status.as_u16(), 429 | 502 | 503 | 504);
                    let text = res
                        .text()
                        .await
                        .context("failed reading anthropic response")?;
                    if retryable && attempt < 2 {
                        tokio::time::sleep(Duration::from_millis(400 * (1 << attempt))).await;
                        continue;
                    }
                    if !status.is_success() {
                        return Err(anyhow!("Anthropic error {status}: {text}"));
                    }
                    response = Some(text);
                    break;
                }
                Err(error) => {
                    if attempt < 2 {
                        tokio::time::sleep(Duration::from_millis(400 * (1 << attempt))).await;
                        continue;
                    }
                    return Err(error);
                }
            }
        }
        let text = response.ok_or_else(|| anyhow!("Anthropic did not return a response."))?;

        let v: Value = serde_json::from_str(&text)?;
        let content_arr = v
            .get("content")
            .and_then(|c| c.as_array())
            .cloned()
            .unwrap_or_default();

        let mut text_out = String::new();
        let mut tool_calls = Vec::new();
        for block in &content_arr {
            let btype = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
            match btype {
                "text" => {
                    if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                        text_out.push_str(t);
                    }
                }
                "tool_use" => {
                    let id = block
                        .get("id")
                        .and_then(|i| i.as_str())
                        .unwrap_or("tool")
                        .to_string();
                    let name = block
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("")
                        .to_string();
                    let input = block.get("input").cloned().unwrap_or(Value::Null);
                    tool_calls.push(ToolCall {
                        id,
                        name,
                        arguments: input,
                    });
                }
                _ => {}
            }
        }

        let stop = v
            .get("stop_reason")
            .and_then(|s| s.as_str())
            .unwrap_or("end_turn")
            .to_string();
        let usage = v
            .get("usage")
            .and_then(|u| u.get("input_tokens"))
            .and_then(|t| t.as_u64())
            .unwrap_or(0);

        Ok(LlmResponse {
            text: if text_out.is_empty() {
                None
            } else {
                Some(text_out)
            },
            tool_calls,
            reasoning_content: None,
            stop_reason: stop,
            usage_tokens: usage,
        })
    }
}

#[cfg(test)]
mod model_tests {
    use super::parse_model_ids;

    #[test]
    fn parses_and_deduplicates_anthropic_models() {
        let fixture = r#"{"data":[
            {"id":"claude-sonnet-4-20250514"},
            {"id":"claude-opus-4-20250514"},
            {"id":"claude-sonnet-4-20250514"}
        ]}"#;
        assert_eq!(
            parse_model_ids(fixture).expect("fixture should parse"),
            vec![
                "claude-opus-4-20250514".to_string(),
                "claude-sonnet-4-20250514".to_string()
            ]
        );
    }
}
