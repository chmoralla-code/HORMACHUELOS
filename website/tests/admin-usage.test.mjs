import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import adminHandler from "../api/admin/[...path].js";
import { issueAdminToken } from "../api/_lib/admin.js";

function jsonRequest({ method, action, token, body }) {
  const req = Readable.from([Buffer.from(JSON.stringify(body ?? {}))]);
  req.method = method;
  req.url = `/api/admin/${action}`;
  req.query = { path: [action] };
  req.headers = {
    authorization: token ? `Bearer ${token}` : "",
    "content-type": "application/json",
  };
  return req;
}

function jsonResponse() {
  const headers = {};
  let payloadText = "";
  return {
    statusCode: 200,
    headers,
    setHeader(name, value) {
      headers[name] = value;
    },
    end(value = "") {
      payloadText = String(value);
    },
    json() {
      return payloadText ? JSON.parse(payloadText) : {};
    },
  };
}

test("admin usage reset zeros matching licenses and can reset every used counter", async () => {
  const previous = new Map([
    ["SUPABASE_URL", process.env.SUPABASE_URL],
    ["SUPABASE_SERVICE_ROLE_KEY", process.env.SUPABASE_SERVICE_ROLE_KEY],
    ["ADMIN_SESSION_SECRET", process.env.ADMIN_SESSION_SECRET],
  ]);
  const originalFetch = globalThis.fetch;
  process.env.SUPABASE_URL = "https://supabase.example";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
  process.env.ADMIN_SESSION_SECRET = "test-admin-secret";

  const account = {
    id: "account-1",
    email: "usage@example.test",
    name: "Usage User",
    plan: "pro",
    period: null,
    credits: 0,
    license_key: "HORMA-PRO-USAGE",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
  };
  const paidLicense = {
    id: "license-paid",
    key: "HORMA-PRO-USAGE",
    email: "usage@example.test",
    plan: "pro",
    token_budget: 1_000_000,
    tokens_used: 880_000,
    active: true,
    expires_at: "2099-01-01T00:00:00.000Z",
  };
  const freeLicense = {
    id: "license-free",
    key: "HORMA-FREE-USAGE",
    email: "usage@example.test",
    plan: "hormachuelos_free",
    token_budget: 50_000,
    tokens_used: 12_000,
    active: true,
    expires_at: "2099-01-01T00:00:00.000Z",
  };
  const otherLicense = {
    id: "license-other",
    key: "HORMA-PRO-OTHER",
    email: "other@example.test",
    plan: "pro",
    token_budget: 1_000_000,
    tokens_used: 42,
    active: true,
    expires_at: "2099-01-01T00:00:00.000Z",
  };

  const patches = [];
  globalThis.fetch = async (url, opts = {}) => {
    const target = String(url);
    const method = String(opts.method || "GET").toUpperCase();
    if (target.includes("/accounts?") && method === "GET") {
      return Response.json([account]);
    }
    if (target.includes("/licenses?") && method === "PATCH") {
      const body = JSON.parse(String(opts.body || "{}"));
      patches.push({ target, body });
      assert.equal(body.tokens_used, 0);
      if (target.includes("key=eq.HORMA-PRO-USAGE")) {
        return Response.json([{ ...paidLicense, tokens_used: 0 }]);
      }
      if (target.includes("email=eq.usage%40example.test")) {
        return Response.json([
          { ...paidLicense, tokens_used: 0 },
          { ...freeLicense, tokens_used: 0 },
        ]);
      }
      if (target.includes("tokens_used=neq.0")) {
        return Response.json([
          { ...paidLicense, tokens_used: 0 },
          { ...freeLicense, tokens_used: 0 },
          { ...otherLicense, tokens_used: 0 },
        ]);
      }
      throw new Error(`Unexpected license patch: ${target}`);
    }
    throw new Error(`Unexpected Supabase request: ${method} ${target}`);
  };

  const token = issueAdminToken();
  try {
    const missing = jsonResponse();
    await adminHandler(
      jsonRequest({
        method: "POST",
        action: "users",
        token,
        body: { action: "reset-usage" },
      }),
      missing,
    );
    assert.equal(missing.statusCode, 400);

    const one = jsonResponse();
    await adminHandler(
      jsonRequest({
        method: "POST",
        action: "users",
        token,
        body: { action: "reset-usage", id: "account-1" },
      }),
      one,
    );
    assert.equal(one.statusCode, 200);
    const oneBody = one.json();
    assert.equal(oneBody.ok, true);
    assert.equal(oneBody.user.tokensUsed, 0);
    assert.equal(oneBody.user.email, "usage@example.test");
    assert.equal(
      patches.filter((item) => item.target.includes("key=eq.HORMA-PRO-USAGE")).length,
      1,
    );
    assert.equal(
      patches.filter((item) => item.target.includes("email=eq.usage%40example.test")).length,
      1,
    );

    const all = jsonResponse();
    await adminHandler(
      jsonRequest({
        method: "POST",
        action: "users",
        token,
        body: { action: "reset-all-usage" },
      }),
      all,
    );
    assert.equal(all.statusCode, 200);
    assert.deepEqual(all.json(), { ok: true, reset: 3 });
    assert.equal(patches.filter((item) => item.target.includes("tokens_used=neq.0")).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of previous) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("admin usage reset requires an admin session", async () => {
  const previous = new Map([
    ["SUPABASE_URL", process.env.SUPABASE_URL],
    ["SUPABASE_SERVICE_ROLE_KEY", process.env.SUPABASE_SERVICE_ROLE_KEY],
  ]);
  process.env.SUPABASE_URL = "https://supabase.example";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
  try {
    const res = jsonResponse();
    await adminHandler(
      jsonRequest({
        method: "POST",
        action: "users",
        body: { action: "reset-all-usage" },
      }),
      res,
    );
    assert.equal(res.statusCode, 401);
  } finally {
    for (const [name, value] of previous) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
