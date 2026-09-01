import assert from "node:assert/strict";
import test from "node:test";

import {
  buildResponsesRequest,
  modelNeedsResponsesApi,
  relayResponsesStream,
  responsesToChatCompletion,
  responsesUsageTotal,
  upstreamApiMode,
} from "../api/_lib/responses-proxy.js";

function streamReader(chunks) {
  // Minimal ReadableStreamDefaultReader stand-in for relay tests.
  let index = 0;
  return {
    read: async () =>
      index < chunks.length
        ? { done: false, value: new TextEncoder().encode(chunks[index++]) }
        : { done: true, value: undefined },
  };
}

test("Muse Spark ids route to the Responses API on OpenCode Zen only", () => {
  assert.equal(modelNeedsResponsesApi("muse-spark-1.2-contributor-free"), true);
  assert.equal(modelNeedsResponsesApi("Muse-Spark-1.2-Free"), true);
  assert.equal(modelNeedsResponsesApi("deepseek-v4-flash-free"), false);
  assert.equal(modelNeedsResponsesApi(""), false);

  assert.equal(
    upstreamApiMode("https://opencode.ai/zen/v1", "muse-spark-1.2-contributor-free"),
    "responses",
  );
  assert.equal(upstreamApiMode("https://opencode.ai/zen/v1", "deepseek-v4-flash-free"), "chat");
  // Unknown hosts keep the plain chat-completions route.
  assert.equal(
    upstreamApiMode("https://api.example.com/v1", "muse-spark-1.2-contributor-free"),
    "chat",
  );
});

test("buildResponsesRequest maps tools, system text, and tool-loop history", () => {
  const body = buildResponsesRequest({
    model: "muse-spark-1.2-free",
    messages: [
      { role: "system", content: "Be concise." },
      { role: "user", content: "Make a game." },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            function: { name: "list_dir", arguments: '{"path":"."}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "src" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "list_dir",
          description: "List a directory",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
    maxTokens: 4096,
    temperature: 0.2,
    stream: true,
  });

  assert.equal(body.model, "muse-spark-1.2-free");
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.equal(body.instructions, "Be concise.");
  assert.equal(body.max_output_tokens, 4096);
  assert.equal(body.temperature, 0.2);
  assert.deepEqual(body.tools, [
    {
      type: "function",
      name: "list_dir",
      description: "List a directory",
      parameters: { type: "object", properties: {} },
    },
  ]);
  assert.deepEqual(body.input, [
    { type: "message", role: "user", content: "Make a game." },
    { type: "function_call", call_id: "call_1", name: "list_dir", arguments: '{"path":"."}' },
    { type: "function_call_output", call_id: "call_1", output: "src" },
  ]);
});

test("relayResponsesStream converts Responses SSE into chat-completion chunks", async () => {
  const sse = [
    'event: response.created',
    'data: {"type":"response.created","response":{"model":"muse-spark-1.2-free"}}',
    "",
    'data: {"type":"response.output_text.delta","delta":"Hi"}',
    "",
    'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_9","name":"write_file","arguments":"{\\"path\\":\\"a.ts\\"}"}}',
    "",
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const lines = [];
  const usage = await relayResponsesStream({
    reader: streamReader([sse]),
    model: "muse-spark-1.2-free",
    onSse: (line) => lines.push(line),
  });

  assert.equal(usage, 15);
  const chunks = lines.map((line) => JSON.parse(line.replace(/^data:\s*/, "").trim()));
  assert.equal(chunks[0].choices[0].delta.content, "Hi");
  assert.deepEqual(chunks[1].choices[0].delta.tool_calls, [
    {
      index: 0,
      id: "call_9",
      type: "function",
      function: { name: "write_file", arguments: '{"path":"a.ts"}' },
    },
  ]);
  const final = chunks[chunks.length - 1];
  assert.equal(final.choices[0].finish_reason, "stop");
  assert.equal(final.usage.total_tokens, 15);
});

test("relayResponsesStream surfaces upstream failures as error payloads", async () => {
  const lines = [];
  await relayResponsesStream({
    reader: streamReader(['data: {"type":"response.failed","response":{"error":{"message":"quota"}}}\n\n']),
    model: "muse-spark-1.2-free",
    onSse: (line) => lines.push(line),
  });
  const payload = JSON.parse(lines[0].replace(/^data:\s*/, "").trim());
  assert.equal(payload.error.type, "responses_error");
  assert.match(payload.error.message, /quota/);
});

test("responsesToChatCompletion builds a chat-completion from one-shot JSON", () => {
  const completion = responsesToChatCompletion(
    {
      model: "muse-spark-1.2-free",
      status: "completed",
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] },
        {
          type: "function_call",
          call_id: "call_2",
          name: "list_dir",
          arguments: '{"path":"."}',
        },
      ],
      usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
    },
    { requestedModel: "muse-spark-1.2-free" },
  );

  assert.equal(completion.object, "chat.completion");
  assert.equal(completion.choices[0].message.content, "Done.");
  assert.equal(completion.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(completion.choices[0].message.tool_calls, [
    { id: "call_2", type: "function", function: { name: "list_dir", arguments: '{"path":"."}' } },
  ]);
  assert.equal(responsesUsageTotal(completion.usage), 12);
});