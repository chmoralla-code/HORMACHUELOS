use crate::llm::{
    ChatMessage, ContentSink, LlmProvider, LlmResponse, ReasoningSink, ToolCall, ToolCallSink,
};
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::time::Duration;

fn encode_message(message: &ChatMessage) -> Value {
    let mut encoded = json!({
        "role": message.role,
        "content": message.content,
    });
    if let Some(tool_calls) = &message.tool_calls {
        encoded["tool_calls"] = Value::Array(
            tool_calls
                .iter()
                .map(|tool_call| {
                    json!({
                        "id": tool_call.id,
                        "type": "function",
                        "function": {
                            "name": tool_call.name,
                            "arguments": serde_json::to_string(&tool_call.arguments)
                                .unwrap_or_else(|_| "{}".to_string()),
                        },
                    })
                })
                .collect(),
        );
    }
    if let Some(id) = &message.tool_call_id {
        encoded["tool_call_id"] = Value::String(id.clone());
    }
    if let Some(name) = &message.name {
        encoded["name"] = Value::String(name.clone());
    }
    if let Some(reasoning) = &message.reasoning_content {
        encoded["reasoning_content"] = Value::String(reasoning.clone());
    }
    encoded
}

fn normalized_xai_reasoning_effort(value: Option<&str>) -> &'static str {
    match value.unwrap_or("high").trim().to_ascii_lowercase().as_str() {
        "light" | "low" => "low",
        "medium" => "medium",
        // xAI currently accepts low, medium, and high. UI-only xHigh/Ultra
        // intentionally map to high rather than producing a 400 response.
        _ => "high",
    }
}

fn build_request_body(
    model: &str,
    messages: &[ChatMessage],
    tools: &[Value],
    provider_kind: &str,
    reasoning_effort: Option<&str>,
) -> Value {
    let mut body = json!({
        "model": model,
        "messages": messages.iter().map(encode_message).collect::<Vec<_>>(),
    });
    let normalized_model = model.to_ascii_lowercase();
    let is_xai_grok = provider_kind.eq_ignore_ascii_case("xai") && normalized_model == "grok-4.5";
    let is_reasoning_model = normalized_model.starts_with("gpt-5")
        || normalized_model.starts_with("o1")
        || normalized_model.starts_with("o3")
        || normalized_model.starts_with("o4")
        || is_xai_grok;
    if !is_reasoning_model {
        body["temperature"] = json!(0.2);
    }
    if is_xai_grok {
        body["reasoning_effort"] = json!(normalized_xai_reasoning_effort(reasoning_effort));
    }
    if !tools.is_empty() {
        body["tools"] = Value::Array(tools.to_vec());
        body["tool_choice"] = json!("auto");
    }
    body
}

fn provider_http_error(status: reqwest::StatusCode, body: &str) -> anyhow::Error {
    // A 402 can originate either from the Hormachuelos wallet or from an
    // upstream provider. Keep those cases distinct so a client with a healthy
    // plan meter does not receive a misleading generic provider failure.
    let hosted_wallet_empty = body.to_ascii_lowercase().contains("usage_exhausted")
        || body
            .to_ascii_lowercase()
            .contains("hosted credits exhausted");
    let (code, message) = match status.as_u16() {
        400 | 422 => (
            "invalid_request",
            "The provider rejected the request. Check the model name and base URL.",
        ),
        401 | 403 => (
            "authentication_failed",
            "The provider rejected the API key. Save a current key in Settings.",
        ),
        402 if hosted_wallet_empty => (
            "usage_exhausted",
            "Your hosted plan wallet is empty. Refreshing the account balance now.",
        ),
        402 => (
            "provider_payment_required",
            "The upstream provider requires credits or rejected this request.",
        ),
        404 => (
            "model_or_endpoint_not_found",
            "The model or API endpoint was not found.",
        ),
        408 => (
            "provider_timeout",
            "The provider timed out while processing the request.",
        ),
        429 => (
            "rate_limited",
            "The provider rate limit was reached. Wait briefly or choose another model.",
        ),
        500..=599 => (
            "provider_unavailable",
            "The provider is temporarily unavailable.",
        ),
        _ => (
            "provider_error",
            "The provider returned an unexpected response.",
        ),
    };
    anyhow!("{}: {} (HTTP {})", code, message, status.as_u16())
}

fn request_error(error: &reqwest::Error) -> anyhow::Error {
    if error.is_timeout() {
        anyhow!("provider_timeout: The provider did not respond before the timeout.")
    } else if error.is_connect() {
        anyhow!("connection_failed: Could not connect to the provider. Check the base URL and network connection.")
    } else {
        anyhow!("network_error: The provider request could not be completed.")
    }
}

/// Split `<think>…</think>` (or `<thinking>…</thinking>`) out of model content.
fn extract_think_block(raw: &str) -> Option<(String, String)> {
    for (open, close) in [("<think>", "</think>"), ("<thinking>", "</thinking>")] {
        if let Some(start) = raw.find(open) {
            let after_open = start + open.len();
            if let Some(rel_end) = raw[after_open..].find(close) {
                let end = after_open + rel_end;
                let thought = raw[after_open..end].trim().to_string();
                let mut rest = String::new();
                rest.push_str(raw[..start].trim());
                let after = raw[end + close.len()..].trim();
                if !rest.is_empty() && !after.is_empty() {
                    rest.push('\n');
                }
                rest.push_str(after);
                if !thought.is_empty() {
                    return Some((thought, rest.trim().to_string()));
                }
            }
        }
    }
    None
}

fn parse_response(text: &str) -> Result<LlmResponse> {
    let value: Value = serde_json::from_str(text)
        .map_err(|_| anyhow!("invalid_response: The provider returned malformed JSON."))?;
    let choice = value
        .get("choices")
        .and_then(|choices| choices.get(0))
        .ok_or_else(|| anyhow!("invalid_response: The provider returned no choices."))?;
    let message = choice.get("message").cloned().unwrap_or(Value::Null);
    let mut content = message
        .get("content")
        .and_then(|content| content.as_str())
        .map(str::to_string);

    // Providers disagree on the field name for chain-of-thought.
    let mut reasoning_content = [
        "reasoning_content",
        "reasoning",
        "thinking",
        "reasoning_text",
    ]
    .iter()
    .find_map(|key| {
        message
            .get(*key)
            .and_then(|value| value.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    });

    // Some free/open models embed thoughts as <think>…</think> inside content.
    if reasoning_content.is_none() {
        if let Some(raw) = content.as_deref() {
            if let Some((thought, rest)) = extract_think_block(raw) {
                reasoning_content = Some(thought);
                content = if rest.is_empty() { None } else { Some(rest) };
            }
        }
    }
    let stop_reason = choice
        .get("finish_reason")
        .and_then(|reason| reason.as_str())
        .unwrap_or("stop")
        .to_string();

    let mut tool_calls = Vec::new();
    if let Some(calls) = message.get("tool_calls").and_then(|calls| calls.as_array()) {
        for call in calls {
            let id = call
                .get("id")
                .and_then(|id| id.as_str())
                .unwrap_or("call")
                .to_string();
            let function = call.get("function").cloned().unwrap_or(Value::Null);
            let name = function
                .get("name")
                .and_then(|name| name.as_str())
                .unwrap_or("")
                .to_string();
            let arguments = function
                .get("arguments")
                .and_then(|arguments| arguments.as_str())
                .and_then(|arguments| serde_json::from_str(arguments).ok())
                .unwrap_or(Value::Null);
            tool_calls.push(ToolCall {
                id,
                name,
                arguments,
            });
        }
    }

    let usage_tokens = value
        .get("usage")
        .and_then(|usage| usage.get("total_tokens"))
        .and_then(|tokens| tokens.as_u64())
        .unwrap_or(0);

    Ok(LlmResponse {
        text: content,
        tool_calls,
        reasoning_content,
        stop_reason,
        usage_tokens,
    })
}

#[derive(Default)]
struct StreamToolCall {
    id: String,
    name: String,
    arguments: String,
    preview_arguments: String,
    previewed_arguments: bool,
    previewed_name: String,
}

const FIRST_TOOL_PREVIEW_BYTES: usize = 64;
const TOOL_PREVIEW_BATCH_BYTES: usize = 512;

#[derive(Default)]
struct StreamAccumulator {
    text: String,
    reasoning: String,
    tool_calls: Vec<StreamToolCall>,
    stop_reason: String,
    usage_tokens: u64,
    saw_event: bool,
    saw_done: bool,
    saw_terminal_choice: bool,
}

impl StreamAccumulator {
    fn apply(
        &mut self,
        value: &Value,
        on_reasoning: Option<&ReasoningSink>,
        on_content: Option<&ContentSink>,
        on_tool_call: Option<&ToolCallSink>,
    ) {
        if let Some(tokens) = value
            .get("usage")
            .and_then(|usage| usage.get("total_tokens"))
            .and_then(Value::as_u64)
        {
            self.usage_tokens = tokens;
        }

        let Some(choice) = value.get("choices").and_then(|choices| choices.get(0)) else {
            return;
        };
        self.saw_event = true;

        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            if !reason.trim().is_empty() {
                self.stop_reason = reason.to_string();
                self.saw_terminal_choice = true;
            }
        }

        let delta = choice
            .get("delta")
            .or_else(|| choice.get("message"))
            .unwrap_or(&Value::Null);

        if let Some(content) = delta.get("content").and_then(Value::as_str) {
            if !content.is_empty() {
                self.text.push_str(content);
                if let Some(sink) = on_content {
                    sink(content);
                }
            }
        }

        let reasoning_chunk = [
            "reasoning_content",
            "reasoning",
            "thinking",
            "reasoning_text",
        ]
        .iter()
        .find_map(|key| delta.get(*key).and_then(Value::as_str));
        if let Some(chunk) = reasoning_chunk.filter(|chunk| !chunk.is_empty()) {
            self.reasoning.push_str(chunk);
            if let Some(sink) = on_reasoning {
                sink(chunk);
            }
        }

        if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
            for (position, call) in calls.iter().enumerate() {
                let index = call
                    .get("index")
                    .and_then(Value::as_u64)
                    .map(|index| index as usize)
                    .unwrap_or(position);
                while self.tool_calls.len() <= index {
                    self.tool_calls.push(StreamToolCall::default());
                }
                let target = &mut self.tool_calls[index];
                if let Some(id) = call.get("id").and_then(Value::as_str) {
                    if !id.is_empty() {
                        target.id.push_str(id);
                    }
                }
                let function = call.get("function").unwrap_or(&Value::Null);
                if let Some(name) = function.get("name").and_then(Value::as_str) {
                    target.name.push_str(name);
                }
                let arguments_delta = function
                    .get("arguments")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if !arguments_delta.is_empty() {
                    target.arguments.push_str(arguments_delta);
                    target.preview_arguments.push_str(arguments_delta);
                }
                let name_changed = !target.name.is_empty() && target.name != target.previewed_name;
                if name_changed {
                    if let Some(sink) = on_tool_call {
                        sink(index, &target.name, "");
                    }
                    target.previewed_name.clone_from(&target.name);
                }
                let preview_threshold = if target.previewed_arguments {
                    TOOL_PREVIEW_BATCH_BYTES
                } else {
                    FIRST_TOOL_PREVIEW_BYTES
                };
                if target.preview_arguments.len() >= preview_threshold {
                    if let Some(sink) = on_tool_call {
                        sink(index, &target.name, &target.preview_arguments);
                    }
                    target.preview_arguments.clear();
                    target.previewed_arguments = true;
                }
            }
        }
    }

    fn flush_tool_previews(&mut self, on_tool_call: Option<&ToolCallSink>) {
        let Some(sink) = on_tool_call else {
            return;
        };
        for (index, call) in self.tool_calls.iter_mut().enumerate() {
            if call.preview_arguments.is_empty() {
                continue;
            }
            sink(index, &call.name, &call.preview_arguments);
            call.preview_arguments.clear();
            call.previewed_arguments = true;
        }
    }

    fn completed(&self) -> bool {
        self.saw_done || self.saw_terminal_choice
    }

    fn into_response(self) -> Result<LlmResponse> {
        let completed = self.completed();
        if !completed {
            // A proxy or upstream can close a stream after partial text or a
            // partial tool call. Never execute an incomplete tool payload as
            // if it were valid; return a resumable stop so the host continues
            // the same task with the preserved workspace and conversation.
            return Ok(LlmResponse {
                text: (!self.text.is_empty()).then_some(self.text),
                tool_calls: Vec::new(),
                reasoning_content: (!self.reasoning.is_empty()).then_some(self.reasoning),
                stop_reason: "stream_interrupted".to_string(),
                usage_tokens: self.usage_tokens,
            });
        }
        let mut tool_calls = Vec::with_capacity(self.tool_calls.len());
        for (index, call) in self.tool_calls.into_iter().enumerate() {
            if call.name.is_empty() {
                continue;
            }
            let arguments = if call.arguments.trim().is_empty() {
                Value::Object(Default::default())
            } else {
                serde_json::from_str(&call.arguments).map_err(|_| {
                    anyhow!("invalid_response: The provider streamed malformed tool arguments.")
                })?
            };
            tool_calls.push(ToolCall {
                id: if call.id.is_empty() {
                    format!("call_{index}")
                } else {
                    call.id
                },
                name: call.name,
                arguments,
            });
        }

        Ok(LlmResponse {
            text: (!self.text.is_empty()).then_some(self.text),
            tool_calls,
            reasoning_content: (!self.reasoning.is_empty()).then_some(self.reasoning),
            stop_reason: if self.stop_reason.is_empty() {
                "stop".to_string()
            } else {
                self.stop_reason
            },
            usage_tokens: self.usage_tokens,
        })
    }
}

fn apply_sse_line(
    line: &str,
    accumulator: &mut StreamAccumulator,
    on_reasoning: Option<&ReasoningSink>,
    on_content: Option<&ContentSink>,
    on_tool_call: Option<&ToolCallSink>,
) -> Result<()> {
    let line = line.trim();
    if line.is_empty() || line.starts_with(':') || line.starts_with("event:") {
        return Ok(());
    }
    let data = line.strip_prefix("data:").map(str::trim).unwrap_or(line);
    if data.is_empty() {
        return Ok(());
    }
    if data == "[DONE]" {
        accumulator.saw_done = true;
        return Ok(());
    }
    let value: Value = serde_json::from_str(data)
        .map_err(|_| anyhow!("invalid_response: The provider streamed malformed JSON."))?;
    accumulator.apply(&value, on_reasoning, on_content, on_tool_call);
    Ok(())
}

fn parse_model_ids(text: &str, require_tools: bool, free_only: bool) -> Result<Vec<String>> {
    let value: Value = serde_json::from_str(text)
        .map_err(|_| anyhow!("invalid_response: The provider returned malformed model data."))?;
    let data = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("invalid_response: The provider returned no model list."))?;
    let mut models: Vec<String> = data
        .iter()
        .filter(|model| {
            !require_tools
                || model
                    .get("supported_parameters")
                    .and_then(Value::as_array)
                    .is_some_and(|params| {
                        params.iter().any(|param| param.as_str() == Some("tools"))
                    })
        })
        .filter_map(|model| model.get("id").and_then(Value::as_str))
        .filter(|model| !free_only || model.ends_with(":free") || *model == "openrouter/free")
        .filter(|model| !model.is_empty() && model.len() <= 200)
        .map(str::to_string)
        .collect();
    models.sort();
    models.dedup();
    models.truncate(200);
    Ok(models)
}

pub async fn fetch_model_ids(
    provider_kind: &str,
    api_key: &str,
    base_url: &str,
) -> Result<Vec<String>> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| anyhow!("network_error: Could not initialize the provider client."))?;
    let is_openrouter = provider_kind == "openrouter" || base_url.contains("openrouter.ai");
    let mut request = client.get(format!("{}/models", base_url.trim_end_matches('/')));
    if provider_kind != "ollama" {
        request = request.bearer_auth(api_key);
    }
    if api_key.to_ascii_uppercase().starts_with("HORMA-")
        || base_url.contains("hormachuelos")
        || base_url.contains("/api/v1")
    {
        request = request.header("X-Horma-Provider", provider_kind);
    }
    if is_openrouter {
        request = request
            .query(&[("supported_parameters", "tools")])
            .header("HTTP-Referer", "https://hormachuelos.vercel.app")
            .header("X-Title", "Hormachuelos");
    }
    let response = request
        .send()
        .await
        .map_err(|error| request_error(&error))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|_| anyhow!("invalid_response: The provider model list could not be read."))?;
    if !status.is_success() {
        return Err(provider_http_error(status, &text));
    }
    let models = parse_model_ids(&text, is_openrouter, is_openrouter)?;
    if models.is_empty() {
        return Err(anyhow!(
            "no_compatible_models: The provider returned no compatible models."
        ));
    }
    Ok(models)
}

pub struct OpenAi {
    client: reqwest::Client,
    api_key: String,
    base_url: String,
    model: String,
    provider_kind: String,
    reasoning_effort: Option<String>,
}

impl OpenAi {
    pub fn new(api_key: &str, base_url: Option<&str>, model: &str, provider_kind: &str) -> Self {
        let default_base = match provider_kind {
            "ollama" => "http://localhost:11434/v1",
            "openrouter" => "https://openrouter.ai/api/v1",
            "pollinations" => "https://gen.pollinations.ai/v1",
            "deepseek" => "https://api.deepseek.com",
            "glm" => "https://opencode.ai/zen/v1",
            "cursor" => "https://api.cursor.com/v1",
            "xai" => crate::config::XAI_API_BASE_URL,
            "hormachuelos_free" => "https://hormachuelos.vercel.app/api/v1",
            _ => "https://api.openai.com/v1",
        };
        Self {
            client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                // No overall request timeout: streaming a large file/response can
                // take well over a minute. Use a per-chunk idle timeout instead so
                // only a genuinely stalled connection errors, not a slow-but-active
                // stream (was causing `provider_timeout` mid file-write).
                .read_timeout(Duration::from_secs(120))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
            api_key: api_key.to_string(),
            base_url: base_url
                .unwrap_or(default_base)
                .trim_end_matches('/')
                .to_string(),
            model: model.to_string(),
            provider_kind: provider_kind.to_string(),
            reasoning_effort: None,
        }
    }

    pub fn with_reasoning_effort(mut self, effort: Option<&str>) -> Self {
        if self.provider_kind.eq_ignore_ascii_case("xai") {
            self.reasoning_effort = Some(normalized_xai_reasoning_effort(effort).into());
        }
        self
    }

    fn skip_auth(&self) -> bool {
        self.provider_kind == "ollama"
    }

    fn is_openrouter(&self) -> bool {
        self.provider_kind == "openrouter" || self.base_url.contains("openrouter.ai")
    }

    fn is_hosted_proxy(&self) -> bool {
        self.api_key.to_ascii_uppercase().starts_with("HORMA-")
            || self.provider_kind.eq_ignore_ascii_case("hormachuelos_free")
            || self.base_url.contains("hormachuelos.vercel.app")
    }
}

#[async_trait::async_trait]
impl LlmProvider for OpenAi {
    async fn chat(
        &self,
        messages: &[ChatMessage],
        tools: &[Value],
        on_reasoning: Option<ReasoningSink>,
        on_content: Option<ContentSink>,
        on_tool_call: Option<ToolCallSink>,
    ) -> Result<LlmResponse> {
        let mut body = build_request_body(
            &self.model,
            messages,
            tools,
            &self.provider_kind,
            self.reasoning_effort.as_deref(),
        );
        body["stream"] = Value::Bool(true);

        for attempt in 0..3 {
            let mut request = self
                .client
                .post(format!("{}/chat/completions", self.base_url));
            if !self.skip_auth() {
                request = request.bearer_auth(&self.api_key);
            }
            if self.is_hosted_proxy() {
                request = request.header("X-Horma-Provider", &self.provider_kind);
            }
            if self.is_openrouter() {
                request = request
                    .header("HTTP-Referer", "https://hormachuelos.vercel.app")
                    .header("X-Title", "Hormachuelos");
            }
            let response = request
                .json(&body)
                .send()
                .await
                .map_err(|error| request_error(&error))?;
            let status = response.status();
            if !status.is_success() {
                let text = response.text().await.map_err(|_| {
                    anyhow!("invalid_response: The provider response could not be read.")
                })?;
                let retryable = matches!(status.as_u16(), 429 | 502 | 503 | 504);
                if retryable && attempt < 2 {
                    tokio::time::sleep(Duration::from_millis(400 * (1 << attempt))).await;
                    continue;
                }
                return Err(provider_http_error(status, &text));
            }

            let mut response = response;
            let mut pending = String::new();
            let mut full_body = String::new();
            let mut accumulator = StreamAccumulator::default();

            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|error| request_error(&error))?
            {
                let text = String::from_utf8_lossy(&chunk);
                full_body.push_str(&text);
                pending.push_str(&text);

                while let Some(newline) = pending.find('\n') {
                    let line = pending[..newline].trim_end_matches('\r').to_string();
                    pending.drain(..=newline);
                    apply_sse_line(
                        &line,
                        &mut accumulator,
                        on_reasoning.as_ref(),
                        on_content.as_ref(),
                        on_tool_call.as_ref(),
                    )?;
                }
            }
            if !pending.trim().is_empty() {
                apply_sse_line(
                    &pending,
                    &mut accumulator,
                    on_reasoning.as_ref(),
                    on_content.as_ref(),
                    on_tool_call.as_ref(),
                )?;
            }

            // Some compatible endpoints ignore `stream: true` and return one
            // ordinary JSON response. Preserve support for those providers.
            if !accumulator.saw_event {
                let parsed = parse_response(full_body.trim())?;
                if let (Some(reasoning), Some(sink)) =
                    (parsed.reasoning_content.as_deref(), on_reasoning.as_ref())
                {
                    sink(reasoning);
                }
                if let (Some(text), Some(sink)) = (parsed.text.as_deref(), on_content.as_ref()) {
                    sink(text);
                }
                return Ok(parsed);
            }

            if accumulator.completed() {
                accumulator.flush_tool_previews(on_tool_call.as_ref());
            }
            return accumulator.into_response();
        }
        Err(anyhow!(
            "provider_unavailable: The provider did not return a response."
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_tool_calls_for_a_second_openai_compatible_turn() {
        let messages = vec![ChatMessage {
            role: "assistant".into(),
            content: Value::Null,
            tool_calls: Some(vec![ToolCall {
                id: "call_123".into(),
                name: "read_file".into(),
                arguments: json!({ "path": "src/main.ts" }),
            }]),
            tool_call_id: None,
            name: None,
            reasoning_content: Some("I should inspect the file first.".into()),
        }];

        let body = build_request_body("deepseek-v4-pro", &messages, &[], "deepseek", None);
        let assistant = &body["messages"][0];

        assert_eq!(assistant["content"], Value::Null);
        assert_eq!(
            assistant["reasoning_content"],
            "I should inspect the file first."
        );
        assert_eq!(assistant["tool_calls"][0]["id"], "call_123");
        assert_eq!(assistant["tool_calls"][0]["type"], "function");
        assert_eq!(assistant["tool_calls"][0]["function"]["name"], "read_file");
        assert_eq!(
            assistant["tool_calls"][0]["function"]["arguments"],
            r#"{"path":"src/main.ts"}"#
        );
        assert_eq!(body["temperature"], json!(0.2));
    }

    #[test]
    fn omits_temperature_for_reasoning_models() {
        let messages = vec![ChatMessage {
            role: "user".into(),
            content: json!("Help me improve this project."),
            tool_calls: None,
            tool_call_id: None,
            name: None,
            reasoning_content: None,
        }];

        let body = build_request_body("gpt-5.6-sol", &messages, &[], "openai", None);

        assert!(body.get("temperature").is_none());
    }

    #[test]
    fn xai_grok_uses_supported_reasoning_fields_and_never_marks_the_direct_url_hosted() {
        let messages = vec![ChatMessage::user("Test the integration.")];
        let body = build_request_body("grok-4.5", &messages, &[], "xai", Some("ultra"));

        assert!(body.get("temperature").is_none());
        assert_eq!(body["reasoning_effort"], "high");

        let direct = OpenAi::new(
            "xai-example",
            Some("https://api.x.ai/v1"),
            "grok-4.5",
            "xai",
        );
        assert!(!direct.is_hosted_proxy());
    }

    #[test]
    fn classifies_provider_errors_without_echoing_response_bodies() {
        let secret_body = r#"{"error":{"message":"bad key sk-live-secret"}}"#;
        let error = provider_http_error(reqwest::StatusCode::UNAUTHORIZED, secret_body);

        assert!(error.to_string().contains("authentication_failed"));
        assert!(!error.to_string().contains("sk-live-secret"));
    }

    #[test]
    fn distinguishes_hosted_wallet_402_from_an_upstream_payment_error() {
        let wallet = provider_http_error(
            reqwest::StatusCode::PAYMENT_REQUIRED,
            r#"{"code":"usage_exhausted","error":"Hosted credits exhausted"}"#,
        );
        let upstream = provider_http_error(
            reqwest::StatusCode::PAYMENT_REQUIRED,
            r#"{"error":"upstream account needs credits"}"#,
        );

        assert!(wallet.to_string().contains("usage_exhausted"));
        assert!(upstream.to_string().contains("provider_payment_required"));
    }

    #[test]
    fn parses_reasoning_and_tool_calls_for_replay() {
        let response = parse_response(
            r#"{
            "choices": [{
                "finish_reason": "tool_calls",
                "message": {
                    "content": null,
                    "reasoning_content": "Inspect the project first.",
                    "tool_calls": [{
                        "id": "call_9",
                        "type": "function",
                        "function": {"name": "list_dir", "arguments": "{\"path\":\".\"}"}
                    }]
                }
            }],
            "usage": {"total_tokens": 42}
        }"#,
        )
        .expect("fixture should parse");

        assert_eq!(
            response.reasoning_content.as_deref(),
            Some("Inspect the project first.")
        );
        assert_eq!(response.tool_calls[0].id, "call_9");
        assert_eq!(response.tool_calls[0].name, "list_dir");
        assert_eq!(response.tool_calls[0].arguments, json!({ "path": "." }));
        assert_eq!(response.usage_tokens, 42);
    }

    #[test]
    fn interrupted_stream_never_executes_a_partial_tool_call() {
        let mut accumulator = StreamAccumulator::default();
        accumulator.apply(
            &json!({
                "choices": [{
                    "delta": {
                        "content": "I am applying the change...",
                        "tool_calls": [{
                            "index": 0,
                            "id": "call_partial",
                            "function": {
                                "name": "write_file",
                                "arguments": "{\"path\":\"src/main"
                            }
                        }]
                    }
                }]
            }),
            None,
            None,
            None,
        );

        let response = accumulator.into_response().expect("resumable response");
        assert_eq!(response.stop_reason, "stream_interrupted");
        assert!(response.tool_calls.is_empty());
        assert_eq!(
            response.text.as_deref(),
            Some("I am applying the change...")
        );
    }

    #[test]
    fn accumulates_live_reasoning_and_fragmented_tool_calls() {
        let received = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let received_for_sink = received.clone();
        let sink: ReasoningSink = std::sync::Arc::new(move |chunk| {
            received_for_sink.lock().unwrap().push_str(chunk);
        });
        let previews = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let previews_for_sink = previews.clone();
        let tool_sink: ToolCallSink = std::sync::Arc::new(move |index, name, arguments_delta| {
            previews_for_sink.lock().unwrap().push((
                index,
                name.to_string(),
                arguments_delta.to_string(),
            ));
        });
        let mut stream = StreamAccumulator::default();

        for line in [
            r#"data: {"choices":[{"delta":{"reasoning_content":"Inspect "}}]}"#,
            r#"data: {"choices":[{"delta":{"reasoning_content":"files.","tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_","arguments":"{\"path\":"}}]}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"\"src/"}}]}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"main.ts\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"total_tokens":17}}"#,
            "data: [DONE]",
        ] {
            apply_sse_line(line, &mut stream, Some(&sink), None, Some(&tool_sink))
                .expect("valid SSE fixture");
        }

        stream.flush_tool_previews(Some(&tool_sink));
        let response = stream.into_response().expect("stream should assemble");
        assert_eq!(*received.lock().unwrap(), "Inspect files.");
        assert_eq!(
            *previews.lock().unwrap(),
            vec![
                (0, "read_".to_string(), String::new()),
                (0, "read_file".to_string(), String::new()),
                (
                    0,
                    "read_file".to_string(),
                    r#"{"path":"src/main.ts"}"#.to_string(),
                ),
            ]
        );
        assert_eq!(
            response.reasoning_content.as_deref(),
            Some("Inspect files.")
        );
        assert_eq!(response.tool_calls[0].name, "read_file");
        assert_eq!(
            response.tool_calls[0].arguments,
            json!({ "path": "src/main.ts" })
        );
        assert_eq!(response.usage_tokens, 17);
    }

    #[test]
    fn batches_large_tool_argument_previews_before_completion() {
        let previews = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let previews_for_sink = previews.clone();
        let tool_sink: ToolCallSink = std::sync::Arc::new(move |index, name, delta| {
            previews_for_sink
                .lock()
                .unwrap()
                .push((index, name.to_string(), delta.to_string()));
        });
        let argument_delta = format!(r#"{{"path":"game.js","content":"{}"#, "x".repeat(80));
        let event = json!({
            "choices": [{
                "delta": {
                    "tool_calls": [{
                        "index": 0,
                        "function": {
                            "name": "write_file",
                            "arguments": argument_delta,
                        }
                    }]
                }
            }]
        });
        let mut stream = StreamAccumulator::default();

        stream.apply(&event, None, None, Some(&tool_sink));

        let received = previews.lock().unwrap();
        assert_eq!(received.len(), 2);
        assert_eq!(received[0], (0, "write_file".to_string(), String::new()));
        assert_eq!(received[1].0, 0);
        assert_eq!(received[1].1, "write_file");
        assert!(received[1].2.contains(r#""content":"#));
        assert!(stream.tool_calls[0].preview_arguments.is_empty());
    }

    #[test]
    fn discovers_only_tool_capable_openrouter_models() {
        let fixture = r#"{"data":[
            {"id":"tool/model:free","supported_parameters":["tools","temperature"]},
            {"id":"text/model:free","supported_parameters":["temperature"]},
            {"id":"tool/paid","supported_parameters":["tools"]}
        ]}"#;

        let models = parse_model_ids(fixture, true, true).expect("fixture should parse");
        assert_eq!(models, vec!["tool/model:free"]);
    }
}
