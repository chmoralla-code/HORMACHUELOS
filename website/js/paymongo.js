/**
 * PayMongo GCash scaffold for Hormachuelos.
 *
 * Set window.HORMA_PAYMONGO = { publicKey, createSourceUrl, mode: "live"|"demo" }
 * when your backend is ready. Until then createCheckout() falls back to demo.
 *
 * Backend (next step): POST create Source / Payment Intent with secret key,
 * return checkout_url; webhook updates order + emails receipt + license key.
 */

const DEFAULT_CONFIG = {
  mode: "demo", // "demo" | "live"
  publicKey: "",
  /** Your server endpoint that creates a PayMongo source and returns { checkoutUrl, paymentId } */
  createSourceUrl: "/api/paymongo/create-source",
  successPath: "#/success",
};

function config() {
  return { ...DEFAULT_CONFIG, ...(window.HORMA_PAYMONGO || {}) };
}

export function isLivePayMongo() {
  const c = config();
  return c.mode === "live" && !!c.createSourceUrl && !!c.publicKey;
}

/** Map plan id → desktop license key prefix (offline fallback only). */
export function licenseKeyForPlan(planId) {
  const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
  if (planId === "max20") return `HORMA-MAX20-${suffix}`;
  if (planId === "max10") return `HORMA-MAX10-${suffix}`;
  if (planId === "max5" || planId === "max" || planId === "agency") return `HORMA-MAX-${suffix}`;
  if (planId === "pro") return `HORMA-PRO-${suffix}`;
  return `HORMA-STARTER-${suffix}`;
}

/** Issue a real server license (Supabase-backed) via the hosted API. */
export async function issueServerLicense({
  planId,
  email,
  amountPhp,
  method,
  paymentId,
  source = "website-demo",
}) {
  const res = await fetch("/api/license/issue", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      planId,
      email,
      amountPhp,
      method,
      paymentId,
      source,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.licenseKey) {
    throw new Error(data.error || `License issue failed (${res.status})`);
  }
  return data;
}

/**
 * Start GCash checkout.
 * @returns {Promise<{ demo: boolean, checkoutUrl?: string, paymentId?: string, licenseKey: string }>}
 */
export async function createCheckout({
  amountPhp,
  planId,
  planName,
  period,
  email,
  method = "GCash",
}) {
  const licenseKey = licenseKeyForPlan(planId);
  const c = config();

  if (!isLivePayMongo()) {
    const paymentId = `demo_${crypto.randomUUID()}`;
    try {
      const issued = await issueServerLicense({
        planId,
        email,
        amountPhp,
        method,
        paymentId,
        source: "website-demo",
      });
      return {
        demo: true,
        licenseKey: issued.licenseKey,
        paymentId,
        tokenBudget: issued.tokenBudget,
        message:
          "Demo checkout — no real charge. Hosted license issued. Paste the key into Hormachuelos → Settings.",
      };
    } catch (err) {
      // Offline / API down: still return a local key so UX isn't blocked.
      console.warn("Server license issue failed, using local fallback", err);
      return {
        demo: true,
        licenseKey,
        paymentId,
        message:
          "Demo checkout (offline fallback). Server license unavailable — activate may need retry.",
      };
    }
  }

  // Live path: your backend creates the PayMongo source / intent
  const res = await fetch(c.createSourceUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      amount: Math.round(Number(amountPhp) * 100), // centavos
      currency: "PHP",
      description: `Hormachuelos ${planName} (${period})`,
      email,
      planId,
      period,
      method: method.toLowerCase() === "maya" ? "paymaya" : "gcash",
      publicKey: c.publicKey,
      successUrl: `${location.origin}${location.pathname}${c.successPath}`,
      licenseKey,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `PayMongo create failed (${res.status})`);
  }

  const data = await res.json();
  if (!data.checkoutUrl) {
    throw new Error("PayMongo response missing checkoutUrl");
  }
  return {
    demo: false,
    checkoutUrl: data.checkoutUrl,
    paymentId: data.paymentId || data.id,
    licenseKey: data.licenseKey || licenseKey,
  };
}
