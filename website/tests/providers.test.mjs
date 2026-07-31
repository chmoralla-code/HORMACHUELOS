import assert from "node:assert/strict";
import test from "node:test";

import { billableTokens } from "../api/_lib/plans.js";
import {
  hostedProvidersStatus,
  resolveHostedModel,
  resolveUpstream,
} from "../api/_lib/providers.js";

test("HORMACHUELOS FREE pins the public alias to the NeuralWatt model", () => {
  process.env.NEURALWATT_API_KEY = "test-only-neuralwatt-key";
  try {
    const upstream = resolveUpstream("hormachuelos_free");
    assert.equal(upstream.provider, "hormachuelos_free");
    assert.equal(upstream.base, "https://api.neuralwatt.com/v1");

    assert.deepEqual(resolveHostedModel(upstream, "hormachuelos-v1"), {
      requestedModel: "hormachuelos-v1",
      upstreamModel: "deepseek-v4-flash",
    });
    assert.match(resolveHostedModel(upstream, "another-model").error, /only supports/i);
    assert.equal(billableTokens("hormachuelos_free", "hormachuelos-v1", 1_000), 100);

    const status = hostedProvidersStatus().hormachuelos_free;
    assert.deepEqual(status, { ok: true, viaOpenRouter: false });
    assert.equal(JSON.stringify(status).includes(process.env.NEURALWATT_API_KEY), false);
  } finally {
    delete process.env.NEURALWATT_API_KEY;
  }
});

test("HORMACHUELOS FREE never falls back to another provider", () => {
  const priorNeuralWatt = process.env.NEURALWATT_API_KEY;
  const priorOpenRouter = process.env.OPENROUTER_API_KEY;
  delete process.env.NEURALWATT_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-only-openrouter-key";
  try {
    const upstream = resolveUpstream("hormachuelos_free");
    assert.match(upstream.error, /missing API key/i);
    assert.equal(upstream.viaOpenRouter, undefined);
  } finally {
    if (priorNeuralWatt == null) delete process.env.NEURALWATT_API_KEY;
    else process.env.NEURALWATT_API_KEY = priorNeuralWatt;
    if (priorOpenRouter == null) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = priorOpenRouter;
  }
});
