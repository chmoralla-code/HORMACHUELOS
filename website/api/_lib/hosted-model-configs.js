import {
  deleteHostedModelConfig,
  getHostedModelConfigById,
  getHostedModelConfig,
  insertHostedModelConfig,
  listHostedModelConfigs,
  supabaseConfigured,
  updateHostedModelConfig,
} from "./supabase.js";
import {
  decryptHostedModelCredential,
  encryptHostedModelCredential,
  hostedModelCredentialStorageReady,
} from "./secret-box.js";

export const HORMACHUELOS_FREE_PROVIDER = "hormachuelos_free";

const ALLOWED_PROVIDERS = new Set([HORMACHUELOS_FREE_PROVIDER]);
const ALIAS_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/;
let routeCache = null;
let routeCacheAt = 0;
const CACHE_MS = 10_000;

function inputText(value, label, maxLength) {
  const text = String(value || "").trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
    throw Object.assign(new Error(`${label} is required and must be valid.`), { status: 400 });
  }
  return text;
}

function validHostedBaseUrl(value) {
  const raw = inputText(value, "Base URL", 400);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw Object.assign(new Error("Base URL must be a complete HTTPS URL."), { status: 400 });
  }
  const host = url.hostname.toLowerCase();
  const privateIpv4 =
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    host === "localhost" ||
    host === "::1" ||
    host.endsWith(".local") ||
    privateIpv4
  ) {
    throw Object.assign(new Error("Base URL must be a public HTTPS endpoint."), { status: 400 });
  }
  return url.toString().replace(/\/$/, "");
}

function normalizeProvider(value) {
  const provider = String(value || HORMACHUELOS_FREE_PROVIDER).trim().toLowerCase();
  if (!ALLOWED_PROVIDERS.has(provider)) {
    throw Object.assign(new Error("Unsupported hosted provider."), { status: 400 });
  }
  return provider;
}

function normalizeAlias(value) {
  const alias = String(value || "").trim().toLowerCase();
  if (!ALIAS_RE.test(alias)) {
    throw Object.assign(
      new Error("Model alias must use lowercase letters, numbers, dots, dashes, or underscores."),
      { status: 400 },
    );
  }
  return alias;
}

function normalizeConfig(body) {
  return {
    provider_id: normalizeProvider(body.providerId || body.provider_id),
    alias: normalizeAlias(body.alias),
    display_name: inputText(body.displayName || body.display_name, "Display name", 120),
    upstream_model: inputText(body.upstreamModel || body.upstream_model, "Upstream model", 200),
    base_url: validHostedBaseUrl(body.baseUrl || body.base_url),
    active: body.active !== false,
  };
}

/** Safe response shape for the admin UI: it deliberately never includes a credential. */
export function publicHostedModelConfig(row) {
  if (!row) return null;
  return {
    id: row.id,
    providerId: row.provider_id,
    alias: row.alias,
    displayName: row.display_name,
    upstreamModel: row.upstream_model,
    baseUrl: row.base_url,
    active: Boolean(row.active),
    keyConfigured: Boolean(String(row.api_key_ciphertext || "").trim()),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function invalidateHostedModelRouteCache() {
  routeCache = null;
  routeCacheAt = 0;
}

export async function adminListHostedModelConfigs() {
  const rows = await listHostedModelConfigs();
  return {
    credentialStorageReady: hostedModelCredentialStorageReady(),
    configs: rows.map(publicHostedModelConfig),
  };
}

export async function adminSaveHostedModelConfig(body) {
  const input = normalizeConfig(body || {});
  const id = String(body?.id || "").trim();
  const replaceCredential = Object.prototype.hasOwnProperty.call(body || {}, "apiKey") ||
    Object.prototype.hasOwnProperty.call(body || {}, "api_key");
  const clearCredential = body?.clearApiKey === true || body?.clear_api_key === true;
  const rawCredential = String(body?.apiKey ?? body?.api_key ?? "").trim();

  if (clearCredential && rawCredential) {
    throw Object.assign(new Error("Choose either a replacement key or clear the existing key."), {
      status: 400,
    });
  }
  if (replaceCredential && rawCredential.length > 4096) {
    throw Object.assign(new Error("API key is too long."), { status: 400 });
  }

  let existing = null;
  if (id) {
    existing = await getHostedModelConfigById(id);
    if (!existing) throw Object.assign(new Error("Hosted model configuration not found."), { status: 404 });
  } else {
    existing = await getHostedModelConfig(input.provider_id, input.alias);
  }

  const patch = { ...input };
  if (clearCredential) {
    patch.api_key_ciphertext = "";
  } else if (replaceCredential && rawCredential) {
    patch.api_key_ciphertext = encryptHostedModelCredential(rawCredential);
  }

  const saved = existing
    ? await updateHostedModelConfig(existing.id, patch)
    : await insertHostedModelConfig({ ...patch, api_key_ciphertext: patch.api_key_ciphertext || "" });
  invalidateHostedModelRouteCache();
  return publicHostedModelConfig(saved);
}

export async function adminDeleteHostedModelConfig(id) {
  const existing = await getHostedModelConfigById(String(id || "").trim());
  if (!existing) throw Object.assign(new Error("Hosted model configuration not found."), { status: 404 });
  await deleteHostedModelConfig(existing.id);
  invalidateHostedModelRouteCache();
}

/**
 * Load decryptable, active model routes for the hosted proxy.
 * This result stays server-side: `apiKey` is never passed through the admin API
 * or returned from `/api/v1/models`.
 */
export async function activeHostedModelRoutes(providerId = HORMACHUELOS_FREE_PROVIDER) {
  const provider = normalizeProvider(providerId);
  if (!supabaseConfigured()) return [];
  const now = Date.now();
  if (!routeCache || now - routeCacheAt > CACHE_MS) {
    const rows = await listHostedModelConfigs({ activeOnly: true });
    const routes = [];
    for (const row of rows) {
      try {
        const apiKey = decryptHostedModelCredential(row.api_key_ciphertext);
        if (!apiKey) continue;
        routes.push({
          id: row.id,
          providerId: row.provider_id,
          alias: row.alias,
          displayName: row.display_name,
          upstreamModel: row.upstream_model,
          baseUrl: row.base_url,
          apiKey,
        });
      } catch (error) {
        // Fail closed for one invalid row while keeping the remaining hosted
        // models available. Do not log the encrypted value or credential.
        console.error(`Hosted model config ${row.id} is unavailable: ${String(error?.message || error)}`);
      }
    }
    routeCache = routes;
    routeCacheAt = now;
  }
  return routeCache.filter((route) => route.providerId === provider);
}
