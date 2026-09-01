/**
 * OpenAI Responses API adapter for hosted upstreams that only serve some
 * models on `POST {base}/responses` instead of `POST {base}/chat/completions`.
 *
 * OpenCode Zen is the live example: Muse Spark 1.2 (including the free
 * Contributor tier) is served through `/zen/v1/responses`. Sending it to
 * `/chat/completions` returns HTTP 500, or worse for agents: a text-only
 * reply with `finish_reason: "stop"` and no tool calls, which makes an agent
 * "announce an action and then stop" (upstream: anomalyco/opencode#44659).
 *
 * This module translates the desktop's OpenAI Chat Completions request into
 * the Responses envelope and translates Responses events (streaming SSE or
 * one-shot JSON) back into Chat Completions shapes, so existing clients keep
 * working unchanged.
 */

/** Model ids that must be routed to the Responses API. Keep this in one
 * place so admin-managed routes, environment routes, and future providers
 * all agree. Matching is a prefix match on the lower-cased id, so free /
 * contributor variants stay covered without listing every suffix. */
const RESPONSES_API_MODEL_PREFIXES = ["muse-spark"];

/** Hosts whose default API is the OpenAI Responses API. */
const RESPONSES_API_HOSTS = ["opencode.ai", "zen.opencode.ai"];

export function hostOf(baseUrl) {
  try {
    return new URL(String(baseUrl || "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** True when this upstream model id must use the Responses API. */
export function modelNeedsResponsesApi(upstreamModel) {
  const id = String(upstreamModel || "")
    .trim()
    .toLowerCase();
  return RESPONSES_API_MODEL_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/** True when the upstream base URL points at a Responses-first host. */
export function hostSupportsResponsesApi(baseUrl) {
  const host = hostOf(baseUrl);
  return RESPONSES_API_HOSTS.some(
    (candidate) => host === candidate || host.endsWith(`.${candidate}`),
  );
}

/** Resolve the API mode for a route. "responses" | "chat" */
export function upstreamApiMode(baseUrl, upstreamModel) {
  return modelNeedsResponsesApi(upstreamModel) &&
    hostSupportsResponsesApi(baseUrl)
    ? "responses"
    : "chat";
}

export function responsesUrl(baseUrl) {
  return `${String(baseUrl || "").replace(/\/+$/, "")}/responses`;
}

/**
 * Chat Completions request → Responses API request.
 *
 * - `system` messages become the top-level `instructions` field.
 * - Assistant tool calls become `function_call` output items; tool results
 *   become `function_call_output` items so multi-turn tool loops replay.
 * - `tools` are flattened (`{"type":"function","function":{...}}` →
 *   `{"type":"function","name":...,"parameters":...}`).
 */
export function buildResponsesRequest({
  model,
  messages,
  tools,
  maxTokens,
  temperature,
  stream,
}) {
  const input = [];
  const instructions = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = String(message?.role || "").toLowerCase();
    const text = typeof message?.content === "string" ? message.content : "";
    if (role === "system" || role === "developer") {
      if (text.trim()) instructions.push(text);
      continue;
    }
    if (role === "assistant") {
      if (text.trim())
        input.push({ type: "message", role: "assistant", content: text });
      for (const call of Array.isArray(message?.tool_calls)
        ? message.tool_calls
        : []) {
        let args = call?.function?.arguments;
        if (typeof args !== "string") args = JSON.stringify(args ?? {});
        input.push({
          type: "function_call",
          call_id: String(call?.id || "call"),
          name: String(call?.function?.name || ""),
          arguments: args,
        });
      }
      continue;
    }
    if (role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: String(message?.tool_call_id || "tool"),
        output: text,
      });
      continue;
    }
    if (role === "user") {
      input.push({ type: "message", role: "user", content: text || "" });
    }
  }

  const body = {
    model: String(model || ""),
    input,
    stream: Boolean(stream),
    store: false,
  };
  if (instructions.length) body.instructions = instructions.join("\n\n");
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools
      .map((tool) => {
        if (tool?.type !== "function") return null;
        const fn = tool.function || {};
        if (!fn.name) return null;
        return {
          type: "function",
          name: String(fn.name),
          description: String(fn.description || ""),
          parameters: fn.parameters || { type: "object", properties: {} },
        };
      })
      .filter(Boolean);
  }
  if (Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0) {
    body.max_output_tokens = Number(maxTokens);
  }
  if (typeof temperature === "number" && Number.isFinite(temperature)) {
    body.temperature = temperature;
  }
  return body;
}

/** Responses usage → Chat Completions total tokens. */
export function responsesUsageTotal(usage) {
  if (!usage) return 0;
  const total = Number(usage.total_tokens || 0);
  if (total > 0) return total;
  return Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0);
}

/**
 * One completed Responses API output item → OpenAI delta fragment.
 * Returns `{ content?, reasoning?, toolCall? }` or null for ignorable items.
 */
export function responsesItemToDelta(item) {
  if (!item || typeof item !== "object") return null;
  if (item.type === "message" && item.role === "assistant") {
    const content = Array.isArray(item.content)
      ? item.content
          .filter(
            (part) =>
              part?.type === "output_text" && typeof part.text === "string",
          )
          .map((part) => part.text)
          .join("")
      : typeof item.content === "string"
        ? item.content
        : "";
    return content ? { content } : null;
  }
  if (item.type === "reasoning") {
    const summary = Array.isArray(item.summary)
      ? item.summary
          .filter((part) => typeof part?.text === "string")
          .map((part) => part.text)
          .join("")
      : "";
    return summary ? { reasoning: summary } : null;
  }
  if (item.type === "function_call") {
    return {
      toolCall: {
        index: 0,
        id: String(item.call_id || item.id || "call"),
        type: "function",
        function: {
          name: String(item.name || ""),
          arguments:
            typeof item.arguments === "string"
              ? item.arguments
              : JSON.stringify(item.arguments ?? {}),
        },
      },
    };
  }
  return null;
}

/** Map a Responses terminal status to a Chat Completions finish reason. */
export function responsesStatusToFinishReason(status) {
  switch (String(status || "")) {
    case "completed":
      return "stop";
    case "incomplete":
      return "length";
    case "failed":
    case "cancelled":
      return "stop";
    default:
      return "stop";
  }
}

/** The Chat Completions-shaped chunk skeleton used by every emitter below. */
function emptyChunk() {
  return {
    id: `chatcmpl-responses-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "",
    choices: [{ index: 0, delta: {}, finish_reason: null }],
  };
}

/**
 * Translate a Responses API SSE stream into Chat Completions SSE lines.
 * Returns the total usage tokens observed. `onSse` receives each serialized
 * `data: {...}\n\n` line exactly like relayCommandCodeStream does.
 */
export async function relayResponsesStream({ reader, model = "", onSse }) {
  const decoder = new TextDecoder();
  let buffer = "";
  let usageRaw = 0;
  let announcedModel = String(model || "");

  function emitPayload(payload) {
    onSse(`data: ${JSON.stringify(payload)}\n\n`);
  }

  function emitDelta(delta, extra = {}) {
    const chunk = emptyChunk();
    if (announcedModel) chunk.model = announcedModel;
    else if (model) chunk.model = model;
    chunk.choices[0].delta = delta;
    Object.assign(chunk, extra);
    emitPayload(chunk);
  }

  async function handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payloadText = trimmed.slice(5).trim();
    if (!payloadText || payloadText === "[DONE]") return;
    let event;
    try {
      event = JSON.parse(payloadText);
    } catch {
      return;
    }
    const type = String(event.type || "");

    if (type === "response.created") {
      const createdModel = String(event.response?.model || "");
      if (createdModel && !announcedModel) announcedModel = createdModel;
      return;
    }
    if (type === "response.output_text.delta") {
      const text = String(event.delta || "");
      if (text) emitDelta({ content: text });
      return;
    }
    if (
      type === "response.reasoning_summary_text.delta" ||
      type === "response.reasoning_text.delta"
    ) {
      const text = String(event.delta || "");
      if (text) emitDelta({ reasoning_content: text });
      return;
    }
    if (type === "response.output_item.done") {
      // Completed items forward tool calls only: assistant text and reasoning
      // already streamed through their own delta events, and re-emitting the
      // finished item would duplicate every character the client received.
      // (Verified against zen: output_item.done follows the full
      // output_text.delta sequence with the complete message.)
      const delta = responsesItemToDelta(event.item);
      if (delta?.toolCall) emitDelta({ tool_calls: [delta.toolCall] });
      return;
    }
    if (
      type === "response.failed" ||
      type === "response.incomplete" ||
      type === "error"
    ) {
      const message =
        event.response?.error?.message ||
        event.error?.message ||
        (typeof event.error === "string" ? event.error : "") ||
        "Responses upstream error";
      emitPayload({
        error: { message: String(message), type: "responses_error" },
      });
      return;
    }
    if (type === "response.completed") {
      usageRaw = Math.max(usageRaw, responsesUsageTotal(event.response?.usage));
      const chunk = emptyChunk();
      if (announcedModel) chunk.model = announcedModel;
      else if (model) chunk.model = model;
      chunk.choices[0].delta = {};
      // OpenAI puts the terminal reason on the choice, not in the delta.
      chunk.choices[0].finish_reason = responsesStatusToFinishReason(
        event.response?.status,
      );
      chunk.usage = { total_tokens: usageRaw };
      emitPayload(chunk);
      return;
    }
    // response.in_progress / output_item.added / content_part.* etc. are ignored.
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) await handleLine(line);
  }
  if (buffer.trim()) await handleLine(buffer);
  return usageRaw;
}

/**
 * One-shot (non-streaming) Responses API JSON → Chat Completions response.
 */
export function responsesToChatCompletion(
  responsePayload,
  { requestedModel = "" } = {},
) {
  const output = Array.isArray(responsePayload?.output)
    ? responsePayload.output
    : [];
  let text = "";
  const toolCalls = [];
  for (const item of output) {
    const delta = responsesItemToDelta(item);
    if (!delta) continue;
    if (delta.content) text += (text ? "" : "") + delta.content;
    if (delta.toolCall) {
      toolCalls.push({
        id: delta.toolCall.id,
        type: "function",
        function: delta.toolCall.function,
      });
    }
  }
  const usageRaw = responsesUsageTotal(responsePayload?.usage);
  return {
    id: `chatcmpl-responses-${Date.now()}`,
    object: "chat.completion",
    model: String(responsePayload?.model || requestedModel),
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length
          ? "tool_calls"
          : responsesStatusToFinishReason(responsePayload?.status),
      },
    ],
    usage: { total_tokens: usageRaw },
  };
}
