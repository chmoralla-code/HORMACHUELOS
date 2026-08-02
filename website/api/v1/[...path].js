import { randomBytes } from "node:crypto";
import { corsHeaders, json, readJson, bearerToken } from "../_lib/http.js";
import {
  getLicenseByKey,
  getLicenseByEmail,
  getHormachuelosFreeLicenseByEmail,
  insertLicense,
  insertUsageEvent,
  supabaseConfigured,
  updateLicense,
} from "../_lib/supabase.js";
import { billableTokens } from "../_lib/plans.js";
import { resolveHostedModel, resolveUpstream } from "../_lib/providers.js";
import { publicHostedProviderCatalog } from "../_lib/hosted-model-configs.js";
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

function logHostedUpstreamError({ provider, model, response, text }) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const error = parsed?.error;
  const rawMessage =
    (typeof error === "string" ? error : error?.message) ||
    parsed?.message ||
    (typeof text === "string" ? text : "");
  const message = String(rawMessage)
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 300);
  console.warn("Hosted upstream request failed", {
    provider,
    model,
    status: response.status,
    code: typeof error === "object" ? error?.code || "" : parsed?.code || "",
    type: typeof error === "object" ? error?.type || "" : parsed?.type || "",
    message,
  });
}

function hostedUpstreamErrorType(text) {
  try {
    const parsed = JSON.parse(text);
    return String(parsed?.error?.type || parsed?.type || "");
  } catch {
    return "";
  }
}

export function shouldUseHostedFallback(response, text) {
  if (!response || response.ok || response.status === 429) return false;
  if (hostedUpstreamErrorType(text).toLowerCase() === "regionerror") return true;
  return response.status === 401 ||
    response.status === 402 ||
    response.status === 403 ||
    response.status === 404 ||
    response.status === 408 ||
    response.status >= 500;
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

/** A signed-in paid account must consume the same meter the desktop displays. */
export function isUsablePaidLicense(license, now = Date.now()) {
  if (!license || !license.active || license.plan === HORMACHUELOS_FREE_PROVIDER) return false;
  const expiresAt = new Date(license.expires_at).getTime();
  return Number.isFinite(expiresAt) && expiresAt >= now;
}

async function authenticatedFreeEntitlement(req) {
  const account = await accountFromRequest(req);
  if (!account?.email_verified) return null;
  // HORMACHUELOS aliases authenticate with a session token. Prefer the linked
  // paid license (or the account's current paid license) so its reported
  // balance and the server-side meter cannot drift apart. The dedicated free
  // allowance remains available only when there is no usable paid plan.
  let paidLicense = null;
  if (account.license_key) paidLicense = await getLicenseByKey(account.license_key);
  if (!isUsablePaidLicense(paidLicense)) {
    paidLicense = await getLicenseByEmail(account.email);
  }
  if (isUsablePaidLicense(paidLicense)) return paidLicense;
  return freeEntitlementFor(account);
}

/**
 * Return the provider/model aliases that this desktop installation may use.
 * This is intentionally a catalog only: it never contains upstream model ids,
 * base URLs, or any server credential. HORMACHUELOS FREE aliases use the
 * signed-in account path; all other managed provider aliases require a paid
 * Hormachuelos license just like the existing hosted proxy.
 */
async function handleCatalog(req, res) {
  if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" }, req);

  const accountEntitlement = await authenticatedFreeEntitlement(req);
  const licenseKey = bearerToken(req);
  const bearerLicense = licenseKey ? await getLicenseByKey(licenseKey) : null;
  const paidAccess = isUsablePaidLicense(accountEntitlement) || isUsablePaidLicense(bearerLicense);

  if (!accountEntitlement && !paidAccess) {
    return json(res, 401, { error: "Sign in or activate a hosted plan to load model aliases." }, req);
  }

  const catalog = await publicHostedProviderCatalog();
  const available = catalog.filter((provider) =>
    provider.id === HORMACHUELOS_FREE_PROVIDER ? Boolean(accountEntitlement) : paidAccess,
  );
  return json(res, 200, { object: "list", data: available }, req);
}

async function handleModels(req, res) {
  if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" }, req);
  const provider = String(req.headers["x-horma-provider"] || "openrouter").toLowerCase();
  if (provider === HORMACHUELOS_FREE_PROVIDER) {
    const freeLicense = await authenticatedFreeEntitlement(req);
    if (!freeLicense) return json(res, 401, { error: "Sign in to use HORMACHUELOS FREE." }, req);
    const upstream = await resolveUpstream(provider);
    if (upstream.error) {
      return json(res, 503, { error: "HORMACHUELOS FREE is temporarily unavailable." }, req);
    }
    const modelIds = upstream.modelRoutes?.length
      ? upstream.modelRoutes.map((route) => route.alias)
      : Object.keys(upstream.modelAliases || {});
    return json(res, 200, {
      object: "list",
      data: modelIds.map((id) => ({ id, object: "model", owned_by: "hormachuelos" })),
    }, req);
  }
  const licenseKey = bearerToken(req);
  if (!licenseKey) return json(res, 401, { error: "Missing license key" }, req);
  const license = await getLicenseByKey(licenseKey);
  if (!license?.active) return json(res, 403, { error: "Invalid license" }, req);

  const upstream = await resolveUpstream(provider);
  if (upstream.error) return json(res, 400, { error: upstream.error }, req);

  // Managed providers deliberately expose only their configured aliases.
  // Do not proxy the upstream /models catalogue: it could reveal models that
  // the desktop is intentionally not permitted to invoke using a shared key.
  const configuredModelIds = upstream.modelRoutes?.length
    ? upstream.modelRoutes.map((route) => route.alias)
    : Object.keys(upstream.modelAliases || {});
  if (configuredModelIds.length) {
    return json(res, 200, {
      object: "list",
      data: configuredModelIds.map((id) => ({ id, object: "model", owned_by: provider })),
    }, req);
  }

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
  // Paid plans are pay-as-you-go (usage wallet). Free entitlement still has its own period check above.
  const budget = Number(license.token_budget) || 0;
  const used = Number(license.tokens_used) || 0;
  if (budget > 0 && used >= budget) {
    return json(res, 402, { error: "Hosted credits exhausted" }, req);
  }

  const upstream = await resolveUpstream(providerHint);
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

  async function requestUpstream(route) {
    const routeBody = { ...forwardBody, model: route.upstreamModel };
    const response = await fetch(`${route.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${route.apiKey}`,
        ...upstream.headers,
        ...route.headers,
      },
      body: JSON.stringify(routeBody),
    });
    return {
      response,
      errorText: response.ok ? "" : await response.text(),
      route,
    };
  }

  const primaryRoute = {
    upstreamModel: modelResolution.upstreamModel,
    baseUrl: modelResolution.base || upstream.base,
    apiKey: modelResolution.apiKey || upstream.apiKey,
    headers: modelResolution.headers || {},
  };
  let upstreamAttempt = await requestUpstream(primaryRoute);
  if (
    isHormachuelosFree &&
    shouldUseHostedFallback(upstreamAttempt.response, upstreamAttempt.errorText)
  ) {
    for (const fallbackRoute of modelResolution.fallbackRoutes || []) {
      logHostedUpstreamError({
        provider: providerHint,
        model,
        response: upstreamAttempt.response,
        text: upstreamAttempt.errorText,
      });
      console.warn("Hosted upstream fallback activated", {
        provider: providerHint,
        model,
        status: upstreamAttempt.response.status,
        fallbackHost: new URL(fallbackRoute.baseUrl).hostname,
      });
      upstreamAttempt = await requestUpstream(fallbackRoute);
      if (upstreamAttempt.response.ok || upstreamAttempt.response.status === 429) break;
    }
  }

  const upstreamRes = upstreamAttempt.response;

  if (!stream) {
    const text = upstreamRes.ok ? await upstreamRes.text() : upstreamAttempt.errorText;
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
      if (isHormachuelosFree) {
        logHostedUpstreamError({
          provider: providerHint,
          model,
          response: upstreamRes,
          text,
        });
      }
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
    const text = upstreamAttempt.errorText;
    if (isHormachuelosFree) {
      logHostedUpstreamError({
        provider: providerHint,
        model,
        response: upstreamRes,
        text,
      });
    }
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
    if (joined === "catalog" || parts[0] === "catalog") return handleCatalog(req, res);
    if (joined === "models" || parts[0] === "models") return handleModels(req, res);
    if (joined === "chat/completions" || (parts[0] === "chat" && parts[1] === "completions")) {
      return handleChat(req, res);
    }
    return json(res, 404, { error: `Unknown v1 route: ${joined || "(empty)"}` }, req);
  } catch (e) {
    return json(res, e.status || 500, { error: String(e.message || e) }, req);
  }
}
