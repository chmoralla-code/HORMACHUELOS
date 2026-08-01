import assert from "node:assert/strict";
import test from "node:test";

import {
  isUsablePaidLicense,
  shouldUseHostedFallback,
} from "../api/v1/[...path].js";

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
