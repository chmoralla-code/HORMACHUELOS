/**
 * Per-account hosted provider / model allowlists.
 *
 * null / unrestricted → keep the normal plan-based catalog.
 * restricted → intersect catalog (and chat) with the admin allowlists.
 */

const PROVIDER_RE = /^[a-z][a-z0-9_-]{0,48}$/;
const MODEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._\/-]{0,100}$/;

function cleanProviderId(value) {
  const id = String(value || "").trim().toLowerCase();
  return PROVIDER_RE.test(id) ? id : "";
}

function cleanModelId(value) {
  const id = String(value || "").trim();
  if (id === "*") return "*";
  return MODEL_RE.test(id) ? id : "";
}

/**
 * Normalize DB / admin PATCH values into a stable public shape.
 * @returns {{ restricted: boolean, providers: string[] | null, models: Record<string, string[]> | null }}
 */
export function normalizeAccountAccess(input) {
  if (!input || typeof input !== "object") {
    return { restricted: false, providers: null, models: null };
  }

  const hasProviders =
    Object.prototype.hasOwnProperty.call(input, "allowedProviders") ||
    Object.prototype.hasOwnProperty.call(input, "allowed_providers") ||
    Object.prototype.hasOwnProperty.call(input, "providers");
  const hasModels =
    Object.prototype.hasOwnProperty.call(input, "allowedModels") ||
    Object.prototype.hasOwnProperty.call(input, "allowed_models") ||
    Object.prototype.hasOwnProperty.call(input, "models");

  const rawProviders =
    input.allowedProviders ?? input.allowed_providers ?? input.providers ?? null;
  const rawModels = input.allowedModels ?? input.allowed_models ?? input.models ?? null;

  // Explicit null from admin clears the restriction.
  if (hasProviders && rawProviders == null && (!hasModels || rawModels == null)) {
    return { restricted: false, providers: null, models: null };
  }

  if (rawProviders == null && rawModels == null && !hasProviders && !hasModels) {
    return { restricted: false, providers: null, models: null };
  }

  // Restriction is on whenever providers is an array (including empty).
  if (!Array.isArray(rawProviders)) {
    return { restricted: false, providers: null, models: null };
  }

  const providers = [];
  const seen = new Set();
  for (const candidate of rawProviders) {
    const id = cleanProviderId(candidate);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    providers.push(id);
  }

  let models = null;
  if (rawModels && typeof rawModels === "object" && !Array.isArray(rawModels)) {
    models = {};
    for (const [providerKey, list] of Object.entries(rawModels)) {
      const providerId = cleanProviderId(providerKey);
      if (!providerId || !seen.has(providerId)) continue;
      if (!Array.isArray(list)) continue;
      const aliases = [];
      const aliasSeen = new Set();
      for (const item of list) {
        const alias = cleanModelId(item);
        if (!alias || aliasSeen.has(alias)) continue;
        aliasSeen.add(alias);
        aliases.push(alias);
      }
      models[providerId] = aliases.includes("*") ? ["*"] : aliases;
    }
    if (!Object.keys(models).length) models = null;
  }

  return { restricted: true, providers, models };
}

/** Read allowlists from an accounts row. */
export function accountAccessFromRow(account) {
  if (!account) return { restricted: false, providers: null, models: null };
  return normalizeAccountAccess({
    allowedProviders: account.allowed_providers,
    allowedModels: account.allowed_models,
  });
}

/** Serialize for admin API responses. */
export function publicAccountAccess(access) {
  const normalized = normalizeAccountAccess(access);
  if (!normalized.restricted) {
    return { restricted: false, allowedProviders: null, allowedModels: null };
  }
  return {
    restricted: true,
    allowedProviders: normalized.providers,
    allowedModels: normalized.models,
  };
}

/** DB patch fields (or empty object when clearing / omitting). */
export function accountAccessDbPatch(patch) {
  if (!patch || typeof patch !== "object") return {};
  const hasProviders =
    Object.prototype.hasOwnProperty.call(patch, "allowedProviders") ||
    Object.prototype.hasOwnProperty.call(patch, "allowed_providers");
  const hasModels =
    Object.prototype.hasOwnProperty.call(patch, "allowedModels") ||
    Object.prototype.hasOwnProperty.call(patch, "allowed_models");
  if (!hasProviders && !hasModels) return {};

  const normalized = normalizeAccountAccess({
    allowedProviders: patch.allowedProviders ?? patch.allowed_providers,
    allowedModels: patch.allowedModels ?? patch.allowed_models,
  });

  if (!normalized.restricted) {
    return { allowed_providers: null, allowed_models: null };
  }
  return {
    allowed_providers: normalized.providers,
    allowed_models: normalized.models,
  };
}

function modelAllowSet(access, providerId) {
  if (!access?.restricted || !access.models) return null;
  const list = access.models[providerId];
  if (!Array.isArray(list)) return null;
  if (!list.length) return new Set();
  if (list.includes("*")) return "*";
  return new Set(list);
}

/**
 * Intersect a public catalog with the account allowlist.
 * Inactive/prohibited models are already absent from the public catalog.
 */
export function filterCatalogByAccountAccess(catalog, access) {
  const list = Array.isArray(catalog) ? catalog : [];
  if (!access?.restricted) return list;
  const allowedProviders = new Set(access.providers || []);
  return list
    .filter((provider) => allowedProviders.has(String(provider?.id || "").toLowerCase()))
    .map((provider) => {
      const providerId = String(provider.id || "").toLowerCase();
      const allow = modelAllowSet(access, providerId);
      const models = Array.isArray(provider.models) ? provider.models : [];
      if (!allow || allow === "*") return { ...provider, models: [...models] };
      return {
        ...provider,
        models: models.filter((model) => allow.has(String(model?.id || ""))),
      };
    })
    .filter((provider) => Array.isArray(provider.models) && provider.models.length > 0);
}

/** Providers used only as internal view_image helpers — never offered in the picker. */
const VISION_ASSIST_PROVIDERS = new Set(["commandcode"]);

/** @returns {string|null} error message when blocked */
export function accountAccessDeniedMessage(access, providerId, modelId, options = {}) {
  if (!access?.restricted) return null;
  const provider = cleanProviderId(providerId);
  // Command Code powers Hormachuelos Vision (view_image) for every chat model.
  // Admins restrict which providers appear in the picker — not this helper route.
  if (VISION_ASSIST_PROVIDERS.has(provider)) return null;
  if (options.visionAssist && (provider === "openrouter" || VISION_ASSIST_PROVIDERS.has(provider))) {
    return null;
  }
  if (!provider || !(access.providers || []).includes(provider)) {
    return "This AI provider is not enabled for your account.";
  }
  const allow = modelAllowSet(access, provider);
  if (!allow || allow === "*") return null;
  const model = cleanModelId(modelId);
  if (!model || !allow.has(model)) {
    return "This model is not enabled for your account.";
  }
  return null;
}
