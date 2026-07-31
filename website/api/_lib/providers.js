/** Map Hormachuelos provider id → upstream OpenAI-compatible endpoint + env key. */

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
  hormachuelos_free: {
    base: "https://api.neuralwatt.com/v1",
    env: ["NEURALWATT_API_KEY"],
    noFallback: true,
    modelAliases: {
      "hormachuelos-v1": "deepseek-v4-flash",
    },
  },
};

export function resolveUpstream(providerId) {
  const id = String(providerId || "openrouter").toLowerCase();
  if (id === "cursor" || id === "anthropic" || id === "gemini" || id === "google") {
    // Route premium vendors through OpenRouter when available (model ids must be OpenRouter-compatible).
    const or = resolveUpstream("openrouter");
    if (or.apiKey) {
      return { ...or, provider: "openrouter", requested: id, viaOpenRouter: true };
    }
    return {
      error: `${id} hosted access needs OPENROUTER_API_KEY (or use DeepSeek / OpenRouter in the app).`,
    };
  }
  const cfg = PROVIDERS[id];
  if (!cfg) {
    return { error: `Unsupported hosted provider: ${id}` };
  }
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
      const or = resolveUpstream("openrouter");
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

/** Resolve a public model id without allowing shared credentials to access arbitrary models. */
export function resolveHostedModel(upstream, requestedModel) {
  const requested = String(requestedModel || "").trim();
  if (!upstream?.modelAliases) {
    return requested
      ? { requestedModel: requested, upstreamModel: requested }
      : { error: "A model is required." };
  }
  const upstreamModel = upstream.modelAliases[requested];
  if (!upstreamModel) {
    return { error: "HORMACHUELOS FREE only supports Hormachuelos v1." };
  }
  return { requestedModel: requested, upstreamModel };
}

export function hostedProvidersStatus() {
  const out = {};
  for (const id of Object.keys(PROVIDERS)) {
    const r = resolveUpstream(id);
    out[id] = { ok: !r.error, viaOpenRouter: Boolean(r.viaOpenRouter) };
  }
  return out;
}
