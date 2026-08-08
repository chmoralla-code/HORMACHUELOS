import assert from "node:assert/strict";
import test from "node:test";

import {
  isUsablePaidLicense,
  shouldUseHostedFallback,
} from "../api/v1/[...path].js";
import hostedApiHandler from "../api/v1/[...path].js";
import { encryptHostedModelCredential } from "../api/_lib/secret-box.js";
import {
  activeAllHostedModelRoutes,
  invalidateHostedModelRouteCache,
  PROVIDER_PROFILE_ALIAS,
  publicHostedProviderCatalogFromRoutes,
} from "../api/_lib/hosted-model-configs.js";

test("an active paid plan is eligible for a signed-in Hormachuelos route", () => {
  const now = Date.parse("2026-08-01T00:00:00.000Z");
  const currentPro = {
    plan: "pro",
    active: true,
    expires_at: "2026-08-30T00:00:00.000Z",
  };

  assert.equal(isUsablePaidLicense(currentPro, now), true);
  assert.equal(isUsablePaidLicense({ ...currentPro, plan: "hormachuelos_free" }, now), false);
  assert.equal(isUsablePaidLicense({ ...currentPro, active: false }, now), false);
  assert.equal(
    isUsablePaidLicense({ ...currentPro, expires_at: "2026-07-31T23:59:59.000Z" }, now),
    false,
  );
});

test("a payment-required V2 upstream response activates the secure fallback", () => {
  assert.equal(shouldUseHostedFallback({ ok: false, status: 402 }, ""), true);
  assert.equal(shouldUseHostedFallback({ ok: false, status: 429 }, ""), false);
  assert.equal(shouldUseHostedFallback({ ok: true, status: 200 }, ""), false);
});

test("an authenticated catalog exposes custom aliases without upstream secrets", async () => {
  const previous = new Map([
    ["SUPABASE_URL", process.env.SUPABASE_URL],
    ["SUPABASE_SERVICE_ROLE_KEY", process.env.SUPABASE_SERVICE_ROLE_KEY],
    ["HORMACHUELOS_MODEL_CONFIG_KEY", process.env.HORMACHUELOS_MODEL_CONFIG_KEY],
  ]);
  const originalFetch = globalThis.fetch;
  process.env.SUPABASE_URL = "https://supabase.example";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
  process.env.HORMACHUELOS_MODEL_CONFIG_KEY = "test-catalog-encryption-key";
  invalidateHostedModelRouteCache();

  const ciphertext = encryptHostedModelCredential("test-only-upstream-key");
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes("/sessions?")) {
      return Response.json([{ account_id: "account-1", expires_at: "2099-01-01T00:00:00.000Z" }]);
    }
    if (target.includes("/accounts?")) {
      return Response.json([{
        id: "account-1",
        email: "catalog@example.test",
        email_verified: true,
        license_key: "HORMA-CATALOG-TEST",
      }]);
    }
    if (target.includes("/licenses?")) {
      return Response.json([{
        id: "license-1",
        key: "HORMA-CATALOG-TEST",
        email: "catalog@example.test",
        plan: "pro",
        active: true,
        expires_at: "2099-01-01T00:00:00.000Z",
        token_budget: 1_000_000,
        tokens_used: 0,
      }]);
    }
    if (target.includes("/hosted_model_configs?")) {
      return Response.json([{
        id: "route-1",
        provider_id: "my-neuralwatt",
        alias: "deepseek-v4-flash",
        display_name: "DeepSeek V4 Flash",
        upstream_model: "private-upstream-model",
        base_url: "https://provider.example/v1",
        api_key_ciphertext: ciphertext,
        active: true,
      }]);
    }
    throw new Error(`Unexpected Supabase request: ${target}`);
  };

  const headers = {};
  let payloadText = "";
  const response = {
    statusCode: 200,
    setHeader(name, value) { headers[name] = value; },
    end(value = "") { payloadText = String(value); },
  };
  try {
    await hostedApiHandler({
      method: "GET",
      query: { path: ["catalog"] },
      headers: {
        authorization: "Bearer HORMA-CATALOG-TEST",
        "x-horma-session": "session-test-token",
      },
      url: "/api/v1/catalog",
    }, response);
    assert.equal(response.statusCode, 200);
    assert.match(headers["Content-Type"], /^application\/json/i);
    const payload = JSON.parse(payloadText);
    assert.deepEqual(payload.data, [{
      id: "my-neuralwatt",
      label: "My Neuralwatt",
      models: [{ id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" }],
    }]);
    const encoded = JSON.stringify(payload);
    assert.equal(encoded.includes("test-only-upstream-key"), false);
    assert.equal(encoded.includes("private-upstream-model"), false);
    assert.equal(encoded.includes("provider.example"), false);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of previous) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
    invalidateHostedModelRouteCache();
  }
});

test("provider defaults serve model aliases without exposing the provider key", async () => {
  const previous = new Map([
    ["SUPABASE_URL", process.env.SUPABASE_URL],
    ["SUPABASE_SERVICE_ROLE_KEY", process.env.SUPABASE_SERVICE_ROLE_KEY],
    ["HORMACHUELOS_MODEL_CONFIG_KEY", process.env.HORMACHUELOS_MODEL_CONFIG_KEY],
  ]);
  const originalFetch = globalThis.fetch;
  process.env.SUPABASE_URL = "https://supabase.example";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
  process.env.HORMACHUELOS_MODEL_CONFIG_KEY = "test-provider-profile-encryption-key";
  invalidateHostedModelRouteCache();

  const providerCipher = encryptHostedModelCredential("test-only-provider-default-key");
  const modelCipher = encryptHostedModelCredential("test-only-route-override-key");
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes("/hosted_model_configs?")) {
      return Response.json([
        {
          id: "profile-1",
          provider_id: "my-neuralwatt",
          alias: PROVIDER_PROFILE_ALIAS,
          display_name: "NeuralWatt Studio",
          upstream_model: PROVIDER_PROFILE_ALIAS,
          base_url: "https://provider.example/v1",
          api_key_ciphertext: providerCipher,
          active: true,
        },
        {
          id: "model-1",
          provider_id: "my-neuralwatt",
          alias: "flash",
          display_name: "Flash",
          upstream_model: "vendor/flash",
          base_url: "",
          api_key_ciphertext: "",
          active: true,
        },
        {
          id: "model-2",
          provider_id: "my-neuralwatt",
          alias: "precise",
          display_name: "Precise",
          upstream_model: "vendor/precise",
          base_url: "https://override.example/v1",
          api_key_ciphertext: modelCipher,
          active: true,
        },
      ]);
    }
    throw new Error(`Unexpected Supabase request: ${target}`);
  };

  try {
    const routes = await activeAllHostedModelRoutes();
    assert.equal(routes.length, 2);
    const flash = routes.find((route) => route.alias === "flash");
    const precise = routes.find((route) => route.alias === "precise");
    assert.equal(flash.baseUrl, "https://provider.example/v1");
    assert.equal(flash.apiKey, "test-only-provider-default-key");
    assert.equal(precise.baseUrl, "https://override.example/v1");
    assert.equal(precise.apiKey, "test-only-route-override-key");
    const catalog = publicHostedProviderCatalogFromRoutes(routes);
    assert.deepEqual(catalog, [{
      id: "my-neuralwatt",
      label: "NeuralWatt Studio",
      models: [
        { id: "flash", label: "Flash" },
        { id: "precise", label: "Precise" },
      ],
    }]);
    const encoded = JSON.stringify(catalog);
    assert.equal(encoded.includes("test-only-provider-default-key"), false);
    assert.equal(encoded.includes("test-only-route-override-key"), false);
    assert.equal(encoded.includes("provider.example"), false);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of previous) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
    invalidateHostedModelRouteCache();
  }
});
