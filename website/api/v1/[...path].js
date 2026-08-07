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
import { resolveHostedModel, resolveUpstream, isCommandCodeUpstream, resolveHormachuelosV4Route, HORMACHUELOS_V4_ALIAS, HORMACHUELOS_V4_DISPLAY_NAME } from "../_lib/providers.js";
import { COMMANDCODE_PROVIDER, publicHostedProviderCatalog } from "../_lib/hosted-model-configs.js";
import {
  buildCommandCodeRequest,
  commandCodeGenerateUrl,
  commandCodeHeaders,
  relayCommandCodeStream,
} from "../_lib/commandcode-proxy.js";
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
  const available = [];
  for (const provider of catalog) {
    if (provider.id === COMMANDCODE_PROVIDER) continue;
    if (provider.id === HORMACHUELOS_FREE_PROVIDER) {
      if (!accountEntitlement && !paidAccess) continue;
      const models = Array.isArray(provider.models) ? [...provider.models] : [];
      if (!models.some((model) => model.id === HORMACHUELOS_V4_ALIAS)) {
        const v4 = await resolveHormachuelosV4Route();
        if (v4) {
          models.push({ id: HORMACHUELOS_V4_ALIAS, label: HORMACHUELOS_V4_DISPLAY_NAME });
        }
      }
      available.push({ ...provider, models });
      continue;
    }
    if (paidAccess) available.push(provider);
  }
  // Offline / empty managed catalog: still advertise FREE V4 when Command Code is configured.
  if (
    !available.some((provider) => provider.id === HORMACHUELOS_FREE_PROVIDER) &&
    (accountEntitlement || paidAccess)
  ) {
    const v4 = await resolveHormachuelosV4Route();
    if (v4) {
      available.unshift({
        id: HORMACHUELOS_FREE_PROVIDER,
        label: "HORMACHUELOS FREE",
        models: [{ id: HORMACHUELOS_V4_ALIAS, label: HORMACHUELOS_V4_DISPLAY_NAME }],
      });
    }
  }
  return json(res, 200, { object: "list", data: available }, req);
}

async function handleModels(req, res) {
  if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" }, req);
  const provider = String(req.headers["x-horma-provider"] || "openrouter").toLowerCase();
  if (provider === HORMACHUELOS_FREE_PROVIDER) {
    let freeLicense = await authenticatedFreeEntitlement(req);
    if (!freeLicense) {
      const licenseKey = bearerToken(req);
      const paid = licenseKey ? await getLicenseByKey(licenseKey) : null;
      if (!isUsablePaidLicense(paid)) {
        return json(res, 401, { error: "Sign in to use HORMACHUELOS FREE." }, req);
      }
      freeLicense = paid;
    }
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
    if (!license) {
      // Paid plan holders can use Hormachuelos aliases with their HORMA license key
      // (same Bearer used for other hosted providers) without a separate free meter.
      const licenseKey = bearerToken(req);
      const paid = licenseKey ? await getLicenseByKey(licenseKey) : null;
      if (!isUsablePaidLicense(paid)) {
        return json(res, 401, { error: "Sign in to use HORMACHUELOS FREE." }, req);
      }
      license = paid;
    }
  } else {
    // Paid providers normally require a HORMA- license key as Bearer. A
    // signed-in website account (device-link session) is also accepted for
    // hosted-managed providers: the account's linked license resolves the plan.
    let licenseKey = bearerToken(req);
    license = licenseKey ? await getLicenseByKey(licenseKey) : null;
    if (
      (!license || !license.active || license.plan === HORMACHUELOS_FREE_PROVIDER) &&
      providerHint === "commandcode"
    ) {
      const account = await accountFromRequest(req);
      if (account) {
        license = await authenticatedFreeEntitlement(req);
      }
    }
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
    return json(res, 402, {
      error: "Hosted credits exhausted",
      code: "usage_exhausted",
      blockedBy: "plan",
      tokenBudget: budget,
      tokensUsed: used,
    }, req);
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
    // Command Code is not OpenAI-compatible: translate the OpenAI-style body
    // into the /alpha/generate envelope and send the gateway's required
    // headers. Detect by upstream host so FREE aliases (Hormachuelos v4) can
    // reuse the existing Command Code credential without a second provider.
    const useCommandCode = isCommandCodeUpstream(route.baseUrl) || providerHint === "commandcode";
    if (useCommandCode) {
      const ccBody = buildCommandCodeRequest({
        model: route.upstreamModel,
        messages: forwardBody.messages,
        tools: forwardBody.tools,
        system: forwardBody.system,
        maxTokens: forwardBody.max_tokens || forwardBody.max_completion_tokens,
        temperature: forwardBody.temperature,
      });
      const response = await fetch(commandCodeGenerateUrl(route.baseUrl), {
        method: "POST",
        headers: commandCodeHeaders(route.apiKey),
        body: JSON.stringify(ccBody),
      });
      return {
        response,
        errorText: response.ok ? "" : await response.text(),
        route,
        isCommandCodeRoute: true,
      };
    }
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
      isCommandCodeRoute: false,
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
    // Command Code always streams NDJSON upstream; translate the streamed
    // events into a single OpenAI-style JSON response for non-stream clients.
    if (upstreamAttempt.isCommandCodeRoute) {
      if (!upstreamRes.ok) {
        return json(
          res,
          upstreamRes.status,
          { error: "Upstream error", detail: (upstreamAttempt.errorText || "").slice(0, 800) },
          req,
        );
      }
      let textOut = "";
      let usageRaw = 0;
      const toolCalls = [];
      await relayCommandCodeStream({
        reader: upstreamRes.body.getReader(),
        onSse: (line) => {
          try {
            const parsed = JSON.parse(line.replace(/^data: /, "").trim());
            const delta = parsed?.choices?.[0]?.delta;
            if (delta?.content) textOut += delta.content;
            if (Array.isArray(delta?.tool_calls)) {
              for (const tc of delta.tool_calls) {
                toolCalls.push({
                  id: tc.id || "call",
                  type: "function",
                  function: { name: tc.function?.name || "", arguments: tc.function?.arguments || "{}" },
                });
              }
            }
            const usage = parsed?.usage?.total_tokens;
            if (usage) usageRaw = Math.max(usageRaw, usage);
          } catch { /* ignore */ }
        },
      });
      const data = {
        id: `chatcmpl-horma-cc-${Date.now()}`,
        object: "chat.completion",
        model,
        choices: [{
          index: 0,
          message: { role: "assistant", content: textOut, tool_calls: toolCalls.length ? toolCalls : undefined },
          finish_reason: toolCalls.length ? "tool_calls" : "stop",
        }],
        usage: { total_tokens: usageRaw },
      };
      await recordUsage(license, providerHint, model, usageRaw || 500);
      for (const [k, v] of Object.entries(corsHeaders(req))) res.setHeader(k, v);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("X-Horma-Tokens-Used", String(license.tokens_used));
      return res.end(JSON.stringify(data));
    }
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

  // Command Code streams NDJSON events; translate them into OpenAI SSE so the
  // desktop client can consume the stream exactly like any other provider.
  if (upstreamAttempt.isCommandCodeRoute) {
    const usageRaw = await relayCommandCodeStream({
      reader: upstreamRes.body.getReader(),
      onSse: (line) => res.write(line),
    });
    await recordUsage(license, providerHint, model, usageRaw || 800);
    return res.end();
  }

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
