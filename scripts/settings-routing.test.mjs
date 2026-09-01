import test from "node:test";
import assert from "node:assert/strict";

import { hostedCatalogDefaultBaseUrl } from "../src/provider-routing.ts";

test("a hosted catalog entry never replaces a built-in BYOK endpoint", () => {
  assert.equal(
    hostedCatalogDefaultBaseUrl(
      "https://openrouter.ai/api/v1",
      "https://hormachuelos.vercel.app/api/v1",
    ),
    "https://openrouter.ai/api/v1",
  );
  assert.equal(
    hostedCatalogDefaultBaseUrl("", "https://hormachuelos.vercel.app/api/v1"),
    "https://hormachuelos.vercel.app/api/v1",
  );
});
