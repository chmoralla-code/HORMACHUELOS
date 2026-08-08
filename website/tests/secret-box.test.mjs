import assert from "node:assert/strict";
import test from "node:test";

import {
  decryptHostedModelCredential,
  encryptHostedModelCredential,
} from "../api/_lib/secret-box.js";
import {
  PROVIDER_PROFILE_ALIAS,
  normalizeHostedProviderAlias,
  publicHostedModelConfig,
  publicHostedProviderConfig,
  publicHostedProviderCatalogFromRoutes,
  isHostedProviderProfileRow,
} from "../api/_lib/hosted-model-configs.js";

test("hosted model credentials are encrypted at rest and decrypt only server-side", () => {
  const prior = process.env.HORMACHUELOS_MODEL_CONFIG_KEY;
  process.env.HORMACHUELOS_MODEL_CONFIG_KEY = "test-only-model-config-encryption-key";
  const plain = "test-only-upstream-key";
  try {
    const cipher = encryptHostedModelCredential(plain);
    assert.match(cipher, /^horma-secret-v1\./);
    assert.equal(cipher.includes(plain), false);
    assert.equal(decryptHostedModelCredential(cipher), plain);
  } finally {
    if (prior == null) delete process.env.HORMACHUELOS_MODEL_CONFIG_KEY;
    else process.env.HORMACHUELOS_MODEL_CONFIG_KEY = prior;
  }
});

test("admin model responses disclose configuration state but never a credential", () => {
  const raw = {
    id: "model-id",
    provider_id: "hormachuelos_free",
    alias: "hormachuelos-v2",
    display_name: "Hormachuelos v2",
    upstream_model: "deepseek-v4-flash",
    base_url: "https://opencode.ai/zen/v1",
    api_key_ciphertext: "horma-secret-v1.private-value",
    active: true,
  };
  const safe = publicHostedModelConfig(raw);
  assert.equal(safe.keyConfigured, true);
  assert.equal(JSON.stringify(safe).includes("private-value"), false);
  assert.equal(Object.hasOwn(safe, "apiKey"), false);
  assert.equal(Object.hasOwn(safe, "api_key_ciphertext"), false);
});

test("provider profiles keep encrypted keys write-only while exposing editable aliases", () => {
  const raw = {
    id: "provider-id",
    provider_id: "my-neuralwatt",
    alias: PROVIDER_PROFILE_ALIAS,
    display_name: "My NeuralWatt",
    base_url: "https://provider.example/v1",
    api_key_ciphertext: "horma-secret-v1.private-provider-value",
    active: true,
  };
  const safe = publicHostedProviderConfig(raw, { modelCount: 2 });
  assert.equal(isHostedProviderProfileRow(raw), true);
  assert.equal(safe.providerId, "my-neuralwatt");
  assert.equal(safe.displayName, "My NeuralWatt");
  assert.equal(safe.keyConfigured, true);
  assert.equal(safe.modelCount, 2);
  const encoded = JSON.stringify(safe);
  assert.equal(encoded.includes("private-provider-value"), false);
  assert.equal(Object.hasOwn(safe, "apiKey"), false);
  assert.equal(Object.hasOwn(safe, "api_key_ciphertext"), false);

  const builtInDraft = publicHostedProviderConfig(null, { providerId: "xai" });
  assert.deepEqual(builtInDraft, {
    id: null,
    providerId: "xai",
    displayName: "xAI",
    baseUrl: "https://api.x.ai/v1",
    active: true,
    keyConfigured: false,
    profileConfigured: false,
    modelCount: 0,
    createdAt: null,
    updatedAt: null,
  });
});

test("custom provider aliases are validated and the desktop catalog remains credential-free", () => {
  assert.equal(normalizeHostedProviderAlias("my-neuralwatt"), "my-neuralwatt");
  assert.throws(() => normalizeHostedProviderAlias("cursor"), /provider alias/i);

  const catalog = publicHostedProviderCatalogFromRoutes([
    {
      providerId: "my-neuralwatt",
      providerDisplayName: "NeuralWatt Studio",
      alias: "deepseek-v4-flash",
      displayName: "DeepSeek V4 Flash",
      upstreamModel: "vendor/private-upstream-id",
      baseUrl: "https://provider.example/v1",
      apiKey: "test-only-private-route-key",
    },
  ]);
  assert.deepEqual(catalog, [{
    id: "my-neuralwatt",
    label: "NeuralWatt Studio",
    models: [{ id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" }],
  }]);
  const encoded = JSON.stringify(catalog);
  assert.equal(encoded.includes("test-only-private-route-key"), false);
  assert.equal(encoded.includes("private-upstream-id"), false);
  assert.equal(encoded.includes("provider.example"), false);
});
