import { randomBytes } from "node:crypto";
import { corsHeaders, json, readJson, bearerToken } from "../_lib/http.js";
import {
  getLicenseByKey,
  getHormachuelosFreeLicenseByEmail,
  insertLicense,
  insertUsageEvent,
  supabaseConfigured,
  updateLicense,
} from "../_lib/supabase.js";
import { billableTokens } from "../_lib/plans.js";
import { resolveHostedModel, resolveUpstream } from "../_lib/providers.js";
import { accountFromRequest } from "../_lib/auth.js";

export const config = {
  api: { bodyParser: false },
  maxDuration: 60,
};

const HORMACHUELOS_FREE_PROVIDER = "hormachuelos_free";
const HORMACHUELOS_FREE_MODEL = "hormachuelos-v1";
const HORMACHUELOS_FREE_BUDGET = 100_000;
const HORMACHUELOS_FREE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

function pathParts(req) {
  const q = req.query?.path;
  if (Array.isArray(q)) return q.map((p) => String(p).toLowerCase());
  if (typeof q === "string" && q) return [q.toLowerCase()];
  const url = String(req.url || "");
  const m = url.match(/\/api\/v1\/(.+?)(?:\?|$)/i);
  if (!m) return [];
  return m[1].split("/").filter(Boolean).map((p) => p.toLowerCase());
}

function extractUsage(payload) {
  const u = payload?.usage;
  if (!u) return 0;
  const prompt = Number(u.prompt_tokens || u.input_tokens || 0);
  const completion = Number(u.completion_tokens || u.output_tokens || 0);
  const total = Number(u.total_tokens || 0);
  return total || prompt + completion || 0;
}

async function recordUsage(license, provider, model, raw) {
  const billable = billableTokens(provider, model, raw);
  if (billable <= 0) return;
  const used = Number(license.tokens_used || 0) + billable;
  await updateLicense(license.id, { tokens_used: used });
  await insertUsageEvent({
    license_id: license.id,
    provider,
    model,
    raw_tokens: raw,
    billable_tokens: billable,
  });
  license.tokens_used = used;
}

async function freeEntitlementFor(account) {
  let license = await getHormachuelosFreeLicenseByEmail(account.email);
  const expiresAt = new Date(Date.now() + HORMACHUELOS_FREE_PERIOD_MS).toISOString();
  if (!license) {
    license = await insertLicense({
      key: `HORMA-FREE-METER-${randomBytes(24).toString("hex").toUpperCase()}`,
      plan: HORMACHUELOS_FREE_PROVIDER,
      email: String(account.email || "").trim().toLowerCase(),
      token_budget: HORMACHUELOS_FREE_BUDGET,
      tokens_used: 0,
      active: true,
      expires_at: expiresAt,
      meta: { account_id: account.id, purpose: HORMACHUELOS_FREE_PROVIDER },
    });
  } else if (!license.active || new Date(license.expires_at).getTime() < Date.now()) {
    license = await updateLicense(license.id, {
      token_budget: HORMACHUELOS_FREE_BUDGET,
      tokens_used: 0,
      active: true,
      expires_at: expiresAt,
    });
  }
  return license;
}

async function authenticatedFreeEntitlement(req) {
  const account = await accountFromRequest(req);
  if (!account?.email_verified) return null;
  return freeEntitlementFor(account);
}

async function handleModels(req, res) {
  if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" }, req);
  const provider = String(req.headers["x-horma-provider"] || "openrouter").toLowerCase();
  if (provider === HORMACHUELOS_FREE_PROVIDER) {
    const freeLicense = await authenticatedFreeEntitlement(req);
    if (!freeLicense) return json(res, 401, { error: "Sign in to use HORMACHUELOS FREE." }, req);
    return json(res, 200, {
      object: "list",
      data: [{ id: HORMACHUELOS_FREE_MODEL, object: "model", owned_by: "hormachuelos" }],
    }, req);
  }
  const licenseKey = bearerToken(req);
  if (!licenseKey) return json(res, 401, { error: "Missing license key" }, req);
  const license = await getLicenseByKey(licenseKey);
  if (!license?.active) return json(res, 403, { error: "Invalid license" }, req);

  const upstream = resolveUpstream(provider);
  if (upstream.error) return json(res, 400, { error: upstream.error }, req);

  const upstreamRes = await fetch(`${upstream.base}/models`, {
    headers: {
      Authorization: `Bearer ${upstream.apiKey}`,
      ...upstream.headers,
    },
  });
  const text = await upstreamRes.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return json(res, 502, { error: "Bad upstream models response" }, req);
  }
  for (const [k, v] of Object.entries(corsHeaders(req))) res.setHeader(k, v);
  res.statusCode = upstreamRes.status;
  res.setHeader("Content-Type", "application/json");
  return res.end(JSON.stringify(data));
}

async function handleChat(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" }, req);

  const body = await readJson(req);
  const providerHint = String(
    req.headers["x-horma-provider"] || body.provider || body.horma_provider || "openrouter",
  ).toLowerCase();
  const isHormachuelosFree = providerHint === HORMACHUELOS_FREE_PROVIDER;

  let license;
  if (isHormachuelosFree) {
    license = await authenticatedFreeEntitlement(req);
    if (!license) return json(res, 401, { error: "Sign in to use HORMACHUELOS FREE." }, req);
  } else {
    const licenseKey = bearerToken(req);
    if (!licenseKey) {
      return json(res, 401, { error: "Missing license key (Authorization: Bearer HORMA-…)" }, req);
    }
    license = await getLicenseByKey(licenseKey);
    if (
      !license ||
      !license.active ||
      license.plan === HORMACHUELOS_FREE_PROVIDER
    ) {
      return json(res, 403, { error: "Invalid or inactive license" }, req);
    }
  }
  if (new Date(license.expires_at).getTime() < Date.now()) {
    return json(res, 403, { error: "License expired" }, req);
  }
  const budget = Number(license.token_budget) || 0;
  const used = Number(license.tokens_used) || 0;
  if (budget > 0 && used >= budget) {
    return json(res, 402, { error: "Hosted credits exhausted" }, req);
  }

  const upstream = resolveUpstream(providerHint);
  if (upstream.error) {
    return json(
      res,
      isHormachuelosFree ? 503 : 400,
      isHormachuelosFree
        ? { error: "HORMACHUELOS FREE is temporarily unavailable." }
        : { error: upstream.error },
      req,
    );
  }

  const requestedModel = body.model || (isHormachuelosFree ? HORMACHUELOS_FREE_MODEL : "deepseek/deepseek-chat");
  const modelResolution = resolveHostedModel(upstream, requestedModel);
  if (modelResolution.error) return json(res, 400, { error: modelResolution.error }, req);
  const model = modelResolution.requestedModel;
  const stream = Boolean(body.stream);
  const forwardBody = { ...body, model: modelResolution.upstreamModel, stream };
  delete forwardBody.provider;
  delete forwardBody.horma_provider;
  if (isHormachuelosFree) {
    const requestedMax = Number(body.max_tokens || body.max_completion_tokens || 8192);
    forwardBody.max_tokens = Math.max(1, Math.min(8192, Number.isFinite(requestedMax) ? requestedMax : 8192));
    delete forwardBody.max_completion_tokens;
  }

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${upstream.apiKey}`,
    ...upstream.headers,
  };

  const upstreamRes = await fetch(`${upstream.base}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(forwardBody),
  });

  if (!stream) {
    const text = await upstreamRes.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return json(
        res,
        502,
        isHormachuelosFree
          ? { error: "HORMACHUELOS FREE is temporarily unavailable." }
          : { error: "Upstream returned non-JSON", detail: text.slice(0, 400) },
        req,
      );
    }
    if (!upstreamRes.ok) {
      return json(
        res,
        isHormachuelosFree && upstreamRes.status !== 429 ? 502 : upstreamRes.status,
        isHormachuelosFree ? { error: "HORMACHUELOS FREE is temporarily unavailable." } : data,
        req,
      );
    }
    if (isHormachuelosFree && data && typeof data === "object") data.model = model;
    const raw = extractUsage(data);
    await recordUsage(license, providerHint, model, raw || 500);
    for (const [k, v] of Object.entries(corsHeaders(req))) res.setHeader(k, v);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("X-Horma-Tokens-Used", String(license.tokens_used));
    return res.end(JSON.stringify(data));
  }

  if (!upstreamRes.ok) {
    const text = await upstreamRes.text();
    return json(
      res,
      isHormachuelosFree && upstreamRes.status !== 429 ? 502 : upstreamRes.status,
      isHormachuelosFree
        ? { error: "HORMACHUELOS FREE is temporarily unavailable." }
        : { error: "Upstream error", detail: text.slice(0, 800) },
      req,
    );
  }

  for (const [k, v] of Object.entries(corsHeaders(req))) res.setHeader(k, v);
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const reader = upstreamRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usageRaw = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    buffer += chunk;
    res.write(chunk);

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload);
        const u = extractUsage(parsed);
        if (u > usageRaw) usageRaw = u;
      } catch {
        /* ignore */
      }
    }
  }

  await recordUsage(license, providerHint, model, usageRaw || 800);
  return res.end();
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    for (const [k, v] of Object.entries(corsHeaders(req))) res.setHeader(k, v);
    return res.end();
  }
  if (!supabaseConfigured()) {
    return json(res, 503, { error: "Hosted API not configured" }, req);
  }

  try {
    const parts = pathParts(req);
    const joined = parts.join("/");
    if (joined === "models" || parts[0] === "models") return handleModels(req, res);
    if (joined === "chat/completions" || (parts[0] === "chat" && parts[1] === "completions")) {
      return handleChat(req, res);
    }
    return json(res, 404, { error: `Unknown v1 route: ${joined || "(empty)"}` }, req);
  } catch (e) {
    return json(res, e.status || 500, { error: String(e.message || e) }, req);
  }
}
