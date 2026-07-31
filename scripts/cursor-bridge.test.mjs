import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPUTER_PAUSE_SENTINEL_ENV,
  boundedHistory,
  buildAgentPrompt,
  createComputerUseTools,
  helperEnvironment,
  isToolAllowed,
  resolveExecutionPolicy,
  resolveModelSelection,
  resolveSandboxOptions,
  sanitizeComputerToolArguments,
} from "./cursor-bridge.mjs";

test("model selections preserve the configured provider model id", () => {
  assert.equal(resolveModelSelection("default", "high"), undefined);
  assert.deepEqual(resolveModelSelection("grok-4.5", "max"), {
    id: "grok-4.5",
    params: [{ id: "effort", value: "high" }],
  });
  assert.equal(resolveModelSelection("gpt-5.6-sol", "medium").id, "gpt-5.6-sol");
});

test("execution policy maps restricted modes to SDK plan mode", () => {
  assert.deepEqual(resolveExecutionPolicy("plan"), {
    requestedMode: "plan",
    sdkMode: "plan",
    autoReview: false,
    readOnly: true,
  });
  assert.deepEqual(resolveExecutionPolicy("research"), {
    requestedMode: "research",
    sdkMode: "plan",
    autoReview: false,
    readOnly: true,
  });
  assert.equal(resolveExecutionPolicy("auto").autoReview, true);
  assert.equal(resolveExecutionPolicy("full").sdkMode, "agent");
  assert.equal(resolveExecutionPolicy("unexpected").readOnly, true);
});

test("sandbox is disabled because the bundled runtime lacks sandbox helpers", () => {
  assert.deepEqual(resolveSandboxOptions(), { enabled: false });
});

test("read-only modes fail closed for mutating and unknown tools", () => {
  const plan = resolveExecutionPolicy("plan");
  assert.equal(isToolAllowed(plan, "read"), true);
  assert.equal(isToolAllowed(plan, "grep"), true);
  assert.equal(isToolAllowed(plan, "write"), false);
  assert.equal(isToolAllowed(plan, "shell"), false);
  assert.equal(isToolAllowed(plan, "third_party_tool"), false);
  assert.equal(isToolAllowed(resolveExecutionPolicy("full"), "shell"), true);
});

test("fresh agents receive only bounded recent transcript context", () => {
  const history = Array.from({ length: 40 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `turn-${index}`,
  }));
  const bounded = boundedHistory(history);
  assert.equal(bounded.length, 24);
  assert.equal(bounded[0].content, "turn-16");
  assert.equal(bounded.at(-1).content, "turn-39");

  const prompt = buildAgentPrompt("Current request", bounded);
  assert.match(prompt, /turn-16/);
  assert.match(prompt, /turn-39/);
  assert.doesNotMatch(prompt, /turn-0\b/);
  assert.match(prompt, /Current request$/);
});

test("computer use keeps read-only modes observational and exposes fast game controls in full mode", () => {
  const req = {
    computerUseEnabled: true,
    computerHelperPath: "C:\\Program Files\\AI-Forge\\ai-forge.exe",
    computerSessionSecret: "test-session-secret-1234",
  };
  const protocol = { requestApproval: async () => false };

  const planTools = createComputerUseTools(req, resolveExecutionPolicy("plan"), protocol);
  assert.equal(typeof planTools.computer_observe.execute, "function");
  assert.equal(planTools.computer_click, undefined);
  assert.equal(planTools.computer_game_sequence, undefined);

  const fullTools = createComputerUseTools(req, resolveExecutionPolicy("full"), protocol);
  assert.equal(typeof fullTools.computer_click.execute, "function");
  assert.equal(typeof fullTools.computer_scroll.execute, "function");
  assert.equal(typeof fullTools.computer_game_sequence.execute, "function");
  assert.ok(fullTools.computer_click.inputSchema.required.includes("observation_token"));
  assert.ok(
    fullTools.computer_game_sequence.inputSchema.required.includes("observation_token"),
  );
  assert.equal(
    fullTools.computer_game_sequence.inputSchema.properties.steps.maxItems,
    128,
  );
  assert.equal(
    fullTools.computer_type_text.inputSchema.properties.text.maxLength,
    512,
  );
});

test("computer use redacts persisted text and forwards the emergency pause sentinel", () => {
  const persisted = sanitizeComputerToolArguments("computer_type_text", {
    window_id: "42",
    observation_token: "signed-secret-token",
    text: "private draft",
  });
  assert.equal(persisted.observation_token, "[fresh observation token]");
  assert.equal(persisted.text, "[13 characters]");
  assert.doesNotMatch(JSON.stringify(persisted), /private draft|signed-secret-token/);

  const previous = process.env[COMPUTER_PAUSE_SENTINEL_ENV];
  process.env[COMPUTER_PAUSE_SENTINEL_ENV] = "C:\\Temp\\ai-forge-paused";
  try {
    const env = helperEnvironment("session-secret-1234");
    assert.equal(env[COMPUTER_PAUSE_SENTINEL_ENV], "C:\\Temp\\ai-forge-paused");
    assert.equal(env.AI_FORGE_COMPUTER_SESSION, "session-secret-1234");
  } finally {
    if (previous === undefined) delete process.env[COMPUTER_PAUSE_SENTINEL_ENV];
    else process.env[COMPUTER_PAUSE_SENTINEL_ENV] = previous;
  }
});
