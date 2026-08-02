import { randomUUID } from "node:crypto";
import { corsHeaders, json, readJson, bearerToken } from "../_lib/http.js";
import {
  getLicenseByKey,
  insertLicense,
  supabaseConfigured,
  updateLicense,
} from "../_lib/supabase.js";
import { licensePrefix, normalizePlan, planBudget } from "../_lib/plans.js";

function actionOf(req) {
  const q = req.query?.path;
  if (Array.isArray(q) && q.length) return String(q[0]).toLowerCase();
  if (typeof q === "string" && q) return q.toLowerCase();
  const url = String(req.url || "");
  const m = url.match(/\/api\/license\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : "";
}

function issueSecretOk(req) {
  const expected = process.env.LICENSE_ISSUE_SECRET || "";
  // License issuance is an internal server action. Never leave a public
  // fallback that allows a browser to mint a paid license without payment.
  if (!expected) return false;
  const header = req.headers["x-horma-issue-secret"] || "";
  return header === expected;
}

function toStatus(row) {
  // Pay-as-you-go paid plans are gated by usage wallet only (no calendar expiry).
  const active = Boolean(row.active);
  const budget = Number(row.token_budget) || planBudget(row.plan);
  const used = Number(row.tokens_used) || 0;
  let message = active
    ? `${row.plan} plan active - hosted models via Hormachuelos server.`
    : "License inactive.";
  if (active && used >= budget) {
    message = "Hosted credits exhausted. Top up or use your own provider key.";
  }
  return {
    ok: active,
    plan: row.plan,
    active,
    expiresAt: "",
    email: row.email || "",
    tokenBudget: budget,
    tokensUsed: used,
    licenseKey: row.key,
    topUpUrl: "https://hormachuelos.vercel.app/#/pricing",
    message,
    hosted: true,
  };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    for (const [k, v] of Object.entries(corsHeaders(req))) res.setHeader(k, v);
    return res.end();
  }
  if (!supabaseConfigured()) {
    return json(res, 503, { error: "License service not configured" }, req);
  }

  const action = actionOf(req);

  try {
    if (action === "issue" && req.method === "POST") {
      const body = await readJson(req);
      if (!issueSecretOk(req)) return json(res, 401, { error: "Unauthorized" }, req);
      const plan = normalizePlan(body.planId || body.plan || "starter");
      const email = String(body.email || "").trim().toLowerCase();
      const prefix = licensePrefix(plan);
      const key = `${prefix}-${randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
      // Far-future placeholder — pay-as-you-go ignores calendar expiry.
      const expires = new Date("2099-12-31T00:00:00.000Z");
      const budget = planBudget(plan);
      const row = await insertLicense({
        key,
        plan,
        email: email || null,
        token_budget: budget,
        tokens_used: 0,
        active: true,
        expires_at: expires.toISOString(),
        meta: {
          source: body.source || "website",
          paymentId: body.paymentId || null,
          amountPhp: body.amountPhp ?? null,
          method: body.method || null,
        },
      });
      return json(
        res,
        200,
        {
          ok: true,
          licenseKey: row.key,
          plan: row.plan,
          email: row.email,
          tokenBudget: Number(row.token_budget),
          tokensUsed: Number(row.tokens_used),
          expiresAt: "",
          active: row.active,
          message: `${plan} plan issued. Paste this key in Hormachuelos > Settings.`,
        },
        req,
      );
    }

    if (action === "activate" && (req.method === "POST" || req.method === "GET")) {
      let key = bearerToken(req);
      if (req.method === "POST") {
        const body = await readJson(req);
        key = String(body.key || body.licenseKey || key || "").trim();
      }
      if (!key) return json(res, 400, { error: "Missing license key" }, req);
      const row = await getLicenseByKey(key);
      if (!row) {
        return json(res, 404, { error: "Unknown license key", ok: false, active: false }, req);
      }
      return json(res, 200, toStatus(row), req);
    }

    return json(res, 404, { error: `Unknown license action: ${action || "(empty)"}` }, req);
  } catch (e) {
    return json(res, 500, { error: String(e.message || e) }, req);
  }
}
