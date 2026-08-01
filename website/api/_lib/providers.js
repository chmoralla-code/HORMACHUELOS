/** Map Hormachuelos provider ids to OpenAI-compatible upstreams. */
import {
  activeHostedModelRoutes,
  HORMACHUELOS_FREE_PROVIDER,
} from "./hosted-model-configs.js";

const PROVIDERS = {
  openrouter: {
    base: "https://openrouter.ai/api/v1",
    env: ["OPENROUTER_API_KEY"],
    headers: {
      "HTTP-Referer": "https://hormachuelos.vercel.app",
      "X-Title": "Hormachuelos",
    },
  },
  deepseek: {
    base: "https://api.deepseek.com",
    env: ["DEEPSEEK_API_KEY"],
  },
  openai: {
    base: "https://api.openai.com/v1",
    env: ["OPENAI_API_KEY"],
  },
  glm: {
    base: "https://open.bigmodel.cn/api/paas/v4",
    env: ["GLM_API_KEY", "ZHIPU_API_KEY"],
  },
  pollinations: {
    base: "https://gen.pollinations.ai/v1",
    env: ["POLLINATIONS_API_KEY"],
    optionalKey: true,
  },
  // Backward-compatible route for installations published before managed
  // configurations. New HORMACHUELOS models use encrypted database rows or
  // their dedicated server-only environment credential during rollout.
  [HORMACHUELOS_FREE_PROVIDER]: {
    noFallback: true,
  },
};

const HORMACHUELOS_LEGACY_ROUTES = [
  {
    alias: "hormachuelos-v1",
    upstreamModel: "deepseek-v4-flash",
    baseUrl: "https://api.neuralwatt.com/v1",
    env: ["NEURALWATT_API_KEY"],
  },
  {
    alias: "hormachuelos-v2",
    upstreamModel: "deepseek-v4-flash",
    // OpenCode Go has its own OpenAI-compatible endpoint. Zen's standard
    // endpoint accepts a different entitlement, which is why V2 received a
    // rejected-model response when it was sent there.
    baseUrl: "https://opencode.ai/zen/go/v1",
    env: ["HORMACHUELOS_V2_API_KEY", "OPENCODE_GO_API_KEY"],
    // The newest OpenCode-hosted build can require a workspace-level China
    // region opt-in. Keep installed clients usable while that account setting
    // is unavailable by failing over server-side to the same model on
    // NeuralWatt. Credentials remain on the server for both routes.
    fallbacks: [
      {
        upstreamModel: "deepseek-v4-flash",
        baseUrl: "https://api.neuralwatt.com/v1",
        env: ["NEURALWATT_API_KEY"],
      },
    ],
  },
];

function firstEnvironmentValue(names) {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) return value;
  }
  return "";
}

function legacyHormachuelosUpstream() {
  const modelRoutes = HORMACHUELOS_LEGACY_ROUTES.flatMap((route) => {
    const fallbackRoutes = (route.fallbacks || []).flatMap((fallback) => {
      const apiKey = firstEnvironmentValue(fallback.env);
      return apiKey
        ? [{
            upstreamModel: fallback.upstreamModel,
            baseUrl: fallback.baseUrl,
            apiKey,
            headers: fallback.headers || {},
          }]
        : [];
    });
    const apiKey = firstEnvironmentValue(route.env);
    if (apiKey) {
      return [{
        alias: route.alias,
        upstreamModel: route.upstreamModel,
        baseUrl: route.baseUrl,
        apiKey,
        headers: route.headers || {},
        fallbackRoutes,
      }];
    }
    const [fallback, ...remainingFallbacks] = fallbackRoutes;
    return fallback
      ? [{
          alias: route.alias,
          ...fallback,
          fallbackRoutes: remainingFallbacks,
        }]
      : [];
  });
  if (!modelRoutes.length) {
    return { error: `Server missing API key for provider '${HORMACHUELOS_FREE_PROVIDER}'.` };
  }
  return {
    provider: HORMACHUELOS_FREE_PROVIDER,
    requested: HORMACHUELOS_FREE_PROVIDER,
    // Keep these fields for older callers; modelRoutes is authoritative because
    // each alias can use a different upstream and credential.
    base: modelRoutes[0].baseUrl,
    apiKey: modelRoutes[0].apiKey,
    headers: {},
    modelAliases: Object.fromEntries(
      modelRoutes.map((route) => [route.alias, route.upstreamModel]),
    ),
    modelRoutes,
    viaOpenRouter: false,
  };
}

function environmentUpstream(providerId) {
  const id = String(providerId || "openrouter").toLowerCase();
  if (id === HORMACHUELOS_FREE_PROVIDER) return legacyHormachuelosUpstream();
  if (id === "cursor" || id === "anthropic" || id === "gemini" || id === "google") {
    // Route premium vendors through OpenRouter when available (model ids must be OpenRouter-compatible).
    const or = environmentUpstream("openrouter");
    if (or.apiKey) {
      return { ...or, provider: "openrouter", requested: id, viaOpenRouter: true };
    }
    return {
      error: `${id} hosted access needs OPENROUTER_API_KEY (or use DeepSeek / OpenRouter in the app).`,
    };
  }
  const cfg = PROVIDERS[id];
  if (!cfg) return { error: `Unsupported hosted provider: ${id}` };

  let apiKey = "";
  for (const name of cfg.env) {
    if (process.env[name]) {
      apiKey = process.env[name];
      break;
    }
  }
  if (!apiKey && !cfg.optionalKey) {
    // Fallback: OpenRouter can serve many models if the direct key is missing.
    if (id !== "openrouter" && !cfg.noFallback) {
      const or = environmentUpstream("openrouter");
      if (or.apiKey) {
        return { ...or, provider: "openrouter", requested: id, viaOpenRouter: true };
      }
    }
    return { error: `Server missing API key for provider '${id}'.` };
  }
  return {
    provider: id,
    requested: id,
    base: cfg.base,
    apiKey: apiKey || "unused",
    headers: cfg.headers || {},
    modelAliases: cfg.modelAliases || null,
    viaOpenRouter: false,
  };
}

/**
 * Resolve the server-side route. HORMACHUELOS FREE aliases are read from the
 * encrypted admin-managed records first, then fall back safely for old builds.
 */
export async function resolveUpstream(providerId) {
  const id = String(providerId || "openrouter").toLowerCase();
  if (id !== HORMACHUELOS_FREE_PROVIDER) return environmentUpstream(id);

  const legacy = environmentUpstream(id);
  try {
    const managedRoutes = await activeHostedModelRoutes(id);
    if (!managedRoutes.length) return legacy;
    // Do not make an older v1 app disappear merely because a newer managed
    // alias was added. A configured managed row wins; the legacy v1 route
    // fills only aliases that do not yet have an admin-managed key.
    const routesByAlias = new Map(managedRoutes.map((route) => [route.alias, route]));
    if (!legacy.error) {
      const legacyRoutes = legacy.modelRoutes?.length
        ? legacy.modelRoutes
        : Object.entries(legacy.modelAliases || {}).map(([alias, upstreamModel]) => ({
            alias,
            upstreamModel,
            baseUrl: legacy.base,
            apiKey: legacy.apiKey,
          }));
      for (const route of legacyRoutes) {
        if (!routesByAlias.has(route.alias)) {
          routesByAlias.set(route.alias, route);
        } else if (route.fallbackRoutes?.length) {
          const managedRoute = routesByAlias.get(route.alias);
          const primaryIdentity = `${managedRoute.baseUrl}|${managedRoute.upstreamModel}`;
          const existingFallbacks = managedRoute.fallbackRoutes || [];
          const seen = new Set([
            primaryIdentity,
            ...existingFallbacks.map(
              (fallback) => `${fallback.baseUrl}|${fallback.upstreamModel}`,
            ),
          ]);
          const addedFallbacks = route.fallbackRoutes.filter((fallback) => {
            const identity = `${fallback.baseUrl}|${fallback.upstreamModel}`;
            if (seen.has(identity)) return false;
            seen.add(identity);
            return true;
          });
          routesByAlias.set(route.alias, {
            ...managedRoute,
            fallbackRoutes: [...existingFallbacks, ...addedFallbacks],
          });
        }
      }
    }
    const routes = [...routesByAlias.values()];
    if (routes.length) {
      return {
        provider: id,
        requested: id,
        base: "",
        apiKey: "",
        headers: {},
        modelAliases: Object.fromEntries(routes.map((route) => [route.alias, route.upstreamModel])),
        modelRoutes: routes,
        viaOpenRouter: false,
      };
    }
  } catch (error) {
    // A database migration may be pending during rollout. Keep the previous
    // environment-backed v1 route working rather than breaking old clients.
    console.warn(`Hosted model configuration unavailable; using legacy route: ${String(error?.message || error)}`);
  }
  return legacy;
}

/** Resolve a public model alias without exposing a shared credential to arbitrary model ids. */
export function resolveHostedModel(upstream, requestedModel) {
  const requested = String(requestedModel || "").trim();
  if (!requested) return { error: "A model is required." };

  const route = upstream?.modelRoutes?.find((candidate) => candidate.alias === requested);
  if (route) {
    return {
      requestedModel: requested,
      upstreamModel: route.upstreamModel,
      base: route.baseUrl,
      apiKey: route.apiKey,
      headers: route.headers || {},
      fallbackRoutes: route.fallbackRoutes || [],
    };
  }

  if (!upstream?.modelAliases && !upstream?.modelRoutes) {
    return { requestedModel: requested, upstreamModel: requested };
  }
  const upstreamModel = upstream.modelAliases?.[requested];
  if (!upstreamModel) {
    return { error: "This Hormachuelos model is not currently available." };
  }
  return {
    requestedModel: requested,
    upstreamModel,
    base: upstream.base,
    apiKey: upstream.apiKey,
    headers: upstream.headers || {},
  };
}

export async function hostedProvidersStatus() {
  const out = {};
  for (const id of Object.keys(PROVIDERS)) {
    const resolved = await resolveUpstream(id);
    out[id] = { ok: !resolved.error, viaOpenRouter: Boolean(resolved.viaOpenRouter) };
  }
  return out;
}
