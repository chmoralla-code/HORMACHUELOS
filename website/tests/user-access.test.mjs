import assert from "node:assert/strict";
import {
  accountAccessDeniedMessage,
  accountAccessFromRow,
  filterCatalogByAccountAccess,
  normalizeAccountAccess,
} from "../api/_lib/user-access.js";

const catalog = [
  {
    id: "hormachuelos_free",
    label: "HORMACHUELOS FREE",
    models: [
      { id: "hormachuelos-v1", label: "v1" },
      { id: "hormachuelos-v4", label: "v4" },
    ],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    models: [{ id: "deepseek-chat", label: "Chat" }],
  },
];

{
  const open = normalizeAccountAccess({ allowedProviders: null, allowedModels: null });
  assert.equal(open.restricted, false);
  assert.deepEqual(filterCatalogByAccountAccess(catalog, open), catalog);
}

{
  const access = normalizeAccountAccess({
    allowedProviders: ["hormachuelos_free", "deepseek"],
    allowedModels: { hormachuelos_free: ["hormachuelos-v1"], deepseek: ["*"] },
  });
  assert.equal(access.restricted, true);
  const filtered = filterCatalogByAccountAccess(catalog, access);
  assert.deepEqual(
    filtered.map((provider) => [provider.id, provider.models.map((model) => model.id)]),
    [
      ["hormachuelos_free", ["hormachuelos-v1"]],
      ["deepseek", ["deepseek-chat"]],
    ],
  );
  assert.equal(accountAccessDeniedMessage(access, "openrouter", "any"), "This AI provider is not enabled for your account.");
  assert.equal(accountAccessDeniedMessage(access, "hormachuelos_free", "hormachuelos-v4"), "This model is not enabled for your account.");
  assert.equal(accountAccessDeniedMessage(access, "hormachuelos_free", "hormachuelos-v1"), null);
}

{
  const fromRow = accountAccessFromRow({
    allowed_providers: ["deepseek"],
    allowed_models: { deepseek: [] },
  });
  assert.equal(fromRow.restricted, true);
  assert.deepEqual(filterCatalogByAccountAccess(catalog, fromRow), []);
}

console.log("user-access.test.mjs ok");
