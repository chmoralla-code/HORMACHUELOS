import { corsHeaders, json, readJson, bearerToken } from "../_lib/http.js";
import {
  getLicenseByKey,
  insertUsageEvent,
  supabaseConfigured,
  updateLicense,
} from "../_lib/supabase.js";
import { billableTokens } from "../_lib/plans.js";
import { resolveUpstream } from "../_lib/providers.js";

export const config = {
  api: { bodyParser: false },
  maxDuration: 60,
};

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

async function handleModels(req, res) {
  if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" }, req);
  const licenseKey = bearerToken(req);
  if (!licenseKey) return json(res, 401, { error: "Missing license key" }, req);
  const license = await getLicenseByKey(licenseKey);
  if (!license?.active) return json(res, 403, { error: "Invalid license" }, req);

  const provider = String(req.headers["x-horma-provider"] || "openrouter").toLowerCase();
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

  const licenseKey = bearerToken(req);
  if (!licenseKey) {
    return json(res, 401, { error: "Missing license key (Authorization: Bearer HORMA-…)" }, req);
  }

  const license = await getLicenseByKey(licenseKey);
  if (!license || !license.active) {
    return json(res, 403, { error: "Invalid or inactive license" }, req);
  }
  if (new Date(license.expires_at).getTime() < Date.now()) {
    return json(res, 403, { error: "License expired" }, req);
  }
  const budget = Number(license.token_budget) || 0;
  const used = Number(license.tokens_used) || 0;
  if (budget > 0 && used >= budget) {
    return json(res, 402, { error: "Hosted credits exhausted" }, req);
  }

  const body = await readJson(req);
  const providerHint =
    req.headers["x-horma-provider"] || body.provider || body.horma_provider || "openrouter";
  const upstream = resolveUpstream(providerHint);
  if (upstream.error) return json(res, 400, { error: upstream.error }, req);

  const model = body.model || "deepseek/deepseek-chat";
  const stream = Boolean(body.stream);
  const forwardBody = { ...body, stream };
  delete forwardBody.provider;
  delete forwardBody.horma_provider;

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
      return json(res, 502, { error: "Upstream returned non-JSON", detail: text.slice(0, 400) }, req);
    }
    if (!upstreamRes.ok) return json(res, upstreamRes.status, data, req);
    const raw = extractUsage(data);
    await recordUsage(license, upstream.requested || upstream.provider, model, raw || 500);
    for (const [k, v] of Object.entries(corsHeaders(req))) res.setHeader(k, v);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("X-Horma-Tokens-Used", String(license.tokens_used));
    return res.end(JSON.stringify(data));
  }

  if (!upstreamRes.ok) {
    const text = await upstreamRes.text();
    return json(res, upstreamRes.status, { error: "Upstream error", detail: text.slice(0, 800) }, req);
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

  await recordUsage(license, upstream.requested || upstream.provider, model, usageRaw || 800);
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
