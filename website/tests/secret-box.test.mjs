import assert from "node:assert/strict";
import test from "node:test";

import {
  decryptHostedModelCredential,
  encryptHostedModelCredential,
} from "../api/_lib/secret-box.js";
import { publicHostedModelConfig } from "../api/_lib/hosted-model-configs.js";

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
