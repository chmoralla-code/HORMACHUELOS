/** Plan budgets — keep in sync with src-tauri/src/license.rs */

export const PLAN_BUDGETS = {
  starter: 5_500_000,
  pro: 5_500_000,
  proplus: 13_750_000,
  max5: 27_500_000,
  max: 27_500_000,
  agency: 27_500_000,
  max10: 55_000_000,
  max20: 110_000_000,
};

export function normalizePlan(planId) {
  const id = String(planId || "starter").toLowerCase();
  if (id === "max" || id === "agency" || id === "ultra") return "max5";
  if (id === "pro+" || id === "pro_plus") return "proplus";
  if (id === "fifteen" || id === "15day" || id === "15-day") return "pro";
  return id;
}

export function planBudget(planId) {
  const plan = normalizePlan(planId);
  return PLAN_BUDGETS[plan] ?? PLAN_BUDGETS.starter;
}

export function licensePrefix(planId) {
  const plan = normalizePlan(planId);
  if (plan === "max20") return "HORMA-MAX20";
  if (plan === "max10") return "HORMA-MAX10";
  if (plan === "max5") return "HORMA-MAX";
  if (plan === "proplus") return "HORMA-PROPLUS";
  if (plan === "pro") return "HORMA-PRO";
  return "HORMA-STARTER";
}

export function billableTokens(provider, model, raw) {
  if (!raw || raw <= 0) return 0;
  const p = String(provider || "").toLowerCase();
  const m = String(model || "").toLowerCase();
  let weight = 1;
  if (p === "deepseek" && m.includes("flash")) weight = 0.1;
  else if (p === "deepseek") weight = 0.3;
  else if (p === "hormachuelos_free") weight = 0.1;
  else if (p === "ollama") weight = 0.05;
  else if (p === "openrouter" && (m.includes("free") || m.endsWith(":free"))) weight = 0.05;
  else if (p === "openrouter") weight = 0.45;
  else if (p === "glm" || p === "zhipu") weight = 0.35;
  else if (p === "gemini") weight = 0.4;
  else if (p === "anthropic") weight = 1.35;
  else if (p === "cursor" || p === "openai") weight = 1;
  else if (p === "pollinations") weight = 0.05;
  return Math.max(1, Math.ceil(raw * weight));
}
