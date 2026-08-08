import assert from "node:assert/strict";
import test from "node:test";

import { billableTokens } from "../api/_lib/plans.js";
import {
  hostedProvidersStatus,
  isCommandCodeUpstream,
  resolveHostedModel,
  resolveUpstream,
} from "../api/_lib/providers.js";
import { invalidateHostedModelRouteCache } from "../api/_lib/hosted-model-configs.js";

const MANAGED_CONFIG_ENV = [
  "SUPABASE_URL",
  "HORMACHUELOS_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "HORMACHUELOS_SERVICE_ROLE",
];

function disableManagedConfigsForTest() {
  const previous = new Map(MANAGED_CONFIG_ENV.map((name) => [name, process.env[name]]));
  for (const name of MANAGED_CONFIG_ENV) delete process.env[name];
  invalidateHostedModelRouteCache();
  return () => {
    for (const [name, value] of previous) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
    invalidateHostedModelRouteCache();
  };
}

test("HORMACHUELOS FREE pins the public alias to the NeuralWatt model", async () => {
  const restoreManaged = disableManagedConfigsForTest();
  const priorNeuralWatt = process.env.NEURALWATT_API_KEY;
  const priorV2 = process.env.HORMACHUELOS_V2_API_KEY;
  const priorOpenCodeGo = process.env.OPENCODE_GO_API_KEY;
  process.env.NEURALWATT_API_KEY = "test-only-neuralwatt-key";
  delete process.env.HORMACHUELOS_V2_API_KEY;
  delete process.env.OPENCODE_GO_API_KEY;
  try {
    const upstream = await resolveUpstream("hormachuelos_free");
    assert.equal(upstream.provider, "hormachuelos_free");
    assert.equal(upstream.base, "https://api.neuralwatt.com/v1");

    const model = resolveHostedModel(upstream, "hormachuelos-v1");
    assert.equal(model.requestedModel, "hormachuelos-v1");
    assert.equal(model.upstreamModel, "deepseek-v4-flash");
    assert.equal(model.base, "https://api.neuralwatt.com/v1");
    assert.equal(model.apiKey, process.env.NEURALWATT_API_KEY);
    assert.match(resolveHostedModel(upstream, "another-model").error, /not currently available/i);
    assert.equal(billableTokens("hormachuelos_free", "hormachuelos-v1", 1_000), 61);

    const status = (await hostedProvidersStatus()).hormachuelos_free;
    assert.deepEqual(status, { ok: true, viaOpenRouter: false });
    assert.equal(JSON.stringify(status).includes(process.env.NEURALWATT_API_KEY), false);
  } finally {
    if (priorNeuralWatt == null) delete process.env.NEURALWATT_API_KEY;
    else process.env.NEURALWATT_API_KEY = priorNeuralWatt;
    if (priorV2 == null) delete process.env.HORMACHUELOS_V2_API_KEY;
    else process.env.HORMACHUELOS_V2_API_KEY = priorV2;
    if (priorOpenCodeGo == null) delete process.env.OPENCODE_GO_API_KEY;
    else process.env.OPENCODE_GO_API_KEY = priorOpenCodeGo;
    restoreManaged();
  }
});

test("HORMACHUELOS FREE never falls back to another provider", async () => {
  const restoreManaged = disableManagedConfigsForTest();
  const priorNeuralWatt = process.env.NEURALWATT_API_KEY;
  const priorV2 = process.env.HORMACHUELOS_V2_API_KEY;
  const priorOpenCodeGo = process.env.OPENCODE_GO_API_KEY;
  const priorV3 = process.env.HORMACHUELOS_V3_API_KEY;
  const priorDeepSeek = process.env.DEEPSEEK_API_KEY;
  const priorOpenRouter = process.env.OPENROUTER_API_KEY;
  const priorCommandCode = process.env.COMMANDCODE_API_KEY;
  delete process.env.NEURALWATT_API_KEY;
  delete process.env.HORMACHUELOS_V2_API_KEY;
  delete process.env.OPENCODE_GO_API_KEY;
  delete process.env.HORMACHUELOS_V3_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.COMMANDCODE_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-only-openrouter-key";
  try {
    const upstream = await resolveUpstream("hormachuelos_free");
    assert.match(upstream.error, /missing API key/i);
    assert.equal(upstream.viaOpenRouter, undefined);
  } finally {
    if (priorNeuralWatt == null) delete process.env.NEURALWATT_API_KEY;
    else process.env.NEURALWATT_API_KEY = priorNeuralWatt;
    if (priorV2 == null) delete process.env.HORMACHUELOS_V2_API_KEY;
    else process.env.HORMACHUELOS_V2_API_KEY = priorV2;
    if (priorOpenCodeGo == null) delete process.env.OPENCODE_GO_API_KEY;
    else process.env.OPENCODE_GO_API_KEY = priorOpenCodeGo;
    if (priorV3 == null) delete process.env.HORMACHUELOS_V3_API_KEY;
    else process.env.HORMACHUELOS_V3_API_KEY = priorV3;
    if (priorDeepSeek == null) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = priorDeepSeek;
    if (priorOpenRouter == null) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = priorOpenRouter;
    if (priorCommandCode == null) delete process.env.COMMANDCODE_API_KEY;
    else process.env.COMMANDCODE_API_KEY = priorCommandCode;
    restoreManaged();
  }
});

test("licensed xAI route pins the public alias to Grok 4.5", async () => {
  const restoreManaged = disableManagedConfigsForTest();
  const priorXai = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = "xai-test-only-hosted-key";
  try {
    const upstream = await resolveUpstream("xai");
    assert.equal(upstream.provider, "xai");
    assert.equal(upstream.base, "https://api.x.ai/v1");

    const model = resolveHostedModel(upstream, "grok-4.5");
    assert.equal(model.requestedModel, "grok-4.5");
    assert.equal(model.upstreamModel, "grok-4.5");
    assert.equal(model.base, "https://api.x.ai/v1");
    assert.equal(model.apiKey, process.env.XAI_API_KEY);
    assert.match(resolveHostedModel(upstream, "another-model").error, /not currently available/i);

    const status = (await hostedProvidersStatus()).xai;
    assert.deepEqual(status, { ok: true, viaOpenRouter: false });
    assert.equal(JSON.stringify(status).includes(process.env.XAI_API_KEY), false);
  } finally {
    if (priorXai == null) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = priorXai;
    restoreManaged();
  }
});

test("HORMACHUELOS V2 uses the dedicated OpenCode Go route", async () => {
  const restoreManaged = disableManagedConfigsForTest();
  const priorNeuralWatt = process.env.NEURALWATT_API_KEY;
  const priorV2 = process.env.HORMACHUELOS_V2_API_KEY;
  const priorOpenCodeGo = process.env.OPENCODE_GO_API_KEY;
  process.env.NEURALWATT_API_KEY = "test-only-neuralwatt-fallback-key";
  process.env.HORMACHUELOS_V2_API_KEY = "test-only-opencode-go-key";
  delete process.env.OPENCODE_GO_API_KEY;
  try {
    const upstream = await resolveUpstream("hormachuelos_free");
    const model = resolveHostedModel(upstream, "hormachuelos-v2");
    assert.equal(model.requestedModel, "hormachuelos-v2");
    assert.equal(model.upstreamModel, "deepseek-v4-flash");
    assert.equal(model.base, "https://opencode.ai/zen/go/v1");
    assert.equal(model.apiKey, process.env.HORMACHUELOS_V2_API_KEY);
    assert.equal(model.fallbackRoutes.length, 1);
    assert.equal(model.fallbackRoutes[0].upstreamModel, "deepseek-v4-flash");
    assert.equal(model.fallbackRoutes[0].baseUrl, "https://api.neuralwatt.com/v1");
    assert.equal(model.fallbackRoutes[0].apiKey, process.env.NEURALWATT_API_KEY);
    const status = (await hostedProvidersStatus()).hormachuelos_free;
    assert.deepEqual(status, { ok: true, viaOpenRouter: false });
    assert.equal(JSON.stringify(status).includes(process.env.HORMACHUELOS_V2_API_KEY), false);
  } finally {
    if (priorNeuralWatt == null) delete process.env.NEURALWATT_API_KEY;
    else process.env.NEURALWATT_API_KEY = priorNeuralWatt;
    if (priorV2 == null) delete process.env.HORMACHUELOS_V2_API_KEY;
    else process.env.HORMACHUELOS_V2_API_KEY = priorV2;
    if (priorOpenCodeGo == null) delete process.env.OPENCODE_GO_API_KEY;
    else process.env.OPENCODE_GO_API_KEY = priorOpenCodeGo;
    restoreManaged();
  }
});

test("managed HORMACHUELOS aliases route each model with its own server-only key", () => {
  const upstream = {
    modelRoutes: [
      {
        alias: "hormachuelos-v2",
        upstreamModel: "deepseek-v4-flash",
        baseUrl: "https://opencode.ai/zen/go/v1",
        apiKey: "test-only-managed-key",
      },
    ],
  };
  const route = resolveHostedModel(upstream, "hormachuelos-v2");
  assert.equal(route.requestedModel, "hormachuelos-v2");
  assert.equal(route.upstreamModel, "deepseek-v4-flash");
  assert.equal(route.base, "https://opencode.ai/zen/go/v1");
  assert.equal(route.apiKey, "test-only-managed-key");
  assert.match(resolveHostedModel(upstream, "deepseek-v4-flash").error, /not currently available/i);
});

test("Hormachuelos v4 reuses the Command Code API key under FREE", async () => {
  const restoreManaged = disableManagedConfigsForTest();
  const priorNeuralWatt = process.env.NEURALWATT_API_KEY;
  const priorCommandCode = process.env.COMMANDCODE_API_KEY;
  process.env.NEURALWATT_API_KEY = "test-only-neuralwatt-key";
  process.env.COMMANDCODE_API_KEY = "test-only-commandcode-key";
  try {
    assert.equal(isCommandCodeUpstream("https://api.commandcode.ai"), true);
    assert.equal(isCommandCodeUpstream("https://api.deepseek.com"), false);

    const upstream = await resolveUpstream("hormachuelos_free");
    const model = resolveHostedModel(upstream, "hormachuelos-v4");
    assert.equal(model.requestedModel, "hormachuelos-v4");
    assert.equal(model.upstreamModel, "deepseek/deepseek-v4-flash");
    assert.equal(model.base, "https://api.commandcode.ai");
    assert.equal(model.apiKey, process.env.COMMANDCODE_API_KEY);
  } finally {
    if (priorNeuralWatt == null) delete process.env.NEURALWATT_API_KEY;
    else process.env.NEURALWATT_API_KEY = priorNeuralWatt;
    if (priorCommandCode == null) delete process.env.COMMANDCODE_API_KEY;
    else process.env.COMMANDCODE_API_KEY = priorCommandCode;
    restoreManaged();
  }
});
