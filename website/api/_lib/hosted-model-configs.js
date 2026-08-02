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
export const XAI_PROVIDER = "xai";

/**
 * Built-in provider ids that can be managed from the admin dashboard. They
 * are all forwarded through the OpenAI-compatible hosted proxy when an admin
 * route is configured for them. A custom provider alias uses the same safe
 * route format, so it never needs to be added to a desktop build first.
 */
export const BUILTIN_HOSTED_PROVIDERS = Object.freeze([
  HORMACHUELOS_FREE_PROVIDER,
  XAI_PROVIDER,
  "openai",
  "deepseek",
  "openrouter",
  "glm",
  "pollinations",
  "anthropic",
  "gemini",
]);

// Cursor uses its local SDK and Ollama is intentionally local-only. Neither
// can be safely represented as a server-side OpenAI-compatible route.
const LOCAL_ONLY_PROVIDERS = new Set(["cursor", "ollama"]);
const PROVIDER_ALIAS_RE = /^[a-z][a-z0-9_-]{0,48}$/;
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

export function isHostedProviderAlias(value) {
  const provider = String(value || "").trim().toLowerCase();
  return PROVIDER_ALIAS_RE.test(provider) && !LOCAL_ONLY_PROVIDERS.has(provider);
}

/** Normalize a built-in id or a new dashboard-created provider alias. */
export function normalizeHostedProviderAlias(value) {
  const provider = String(value || HORMACHUELOS_FREE_PROVIDER).trim().toLowerCase();
  if (!isHostedProviderAlias(provider)) {
    throw Object.assign(
      new Error(
        "Provider alias must use lowercase letters, numbers, dashes, or underscores (and cannot be cursor or ollama).",
      ),
      { status: 400 },
    );
  }
  return provider;
}

function normalizeProvider(value) {
  return normalizeHostedProviderAlias(value);
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

/** Friendly names are derived from the stable provider alias, not a secret. */
export function hostedProviderDisplayName(providerId) {
  const provider = String(providerId || "").trim().toLowerCase();
  const known = {
    [HORMACHUELOS_FREE_PROVIDER]: "HORMACHUELOS FREE",
    [XAI_PROVIDER]: "OpenAI · Grok",
    openai: "OpenAI",
    deepseek: "DeepSeek",
    openrouter: "OpenRouter",
    glm: "OpenCode",
    pollinations: "Pollinations",
    anthropic: "Anthropic",
    gemini: "Gemini",
  };
  if (known[provider]) return known[provider];
  return provider
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Hosted provider";
}

/** Options shown by the dashboard before it has any custom provider rows. */
export function hostedProviderOptions() {
  return BUILTIN_HOSTED_PROVIDERS.map((id) => ({ id, label: hostedProviderDisplayName(id) }));
}

export function invalidateHostedModelRouteCache() {
  routeCache = null;
  routeCacheAt = 0;
}

export async function adminListHostedModelConfigs() {
  const rows = await listHostedModelConfigs();
  return {
    credentialStorageReady: hostedModelCredentialStorageReady(),
    providerOptions: hostedProviderOptions(),
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
 * Load all decryptable, active model routes for the hosted proxy. This stays
 * server-side: `apiKey` is never returned from the admin API or public
 * catalog. A bad record fails closed while unrelated routes continue working.
 */
export async function activeAllHostedModelRoutes() {
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
  return routeCache;
}

/** Load active routes belonging to one built-in or custom provider alias. */
export async function activeHostedModelRoutes(providerId = HORMACHUELOS_FREE_PROVIDER) {
  const provider = normalizeProvider(providerId);
  return (await activeAllHostedModelRoutes()).filter((route) => route.providerId === provider);
}

/**
 * Public-safe catalog for the desktop picker. It intentionally omits upstream
 * model ids, base URLs, encrypted values, and API keys.
 */
export function publicHostedProviderCatalogFromRoutes(routes) {
  const grouped = new Map();
  for (const route of Array.isArray(routes) ? routes : []) {
    const current = grouped.get(route.providerId) || [];
    current.push(route);
    grouped.set(route.providerId, current);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => hostedProviderDisplayName(left).localeCompare(hostedProviderDisplayName(right)))
    .map(([id, routes]) => ({
      id,
      label: hostedProviderDisplayName(id),
      models: routes
        .slice()
        .sort((left, right) => left.displayName.localeCompare(right.displayName))
        .map((route) => ({ id: route.alias, label: route.displayName })),
    }));
}

export async function publicHostedProviderCatalog() {
  return publicHostedProviderCatalogFromRoutes(await activeAllHostedModelRoutes());
}
