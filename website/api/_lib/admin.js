import { createHmac, timingSafeEqual } from "node:crypto";
import { planBudget, normalizePlan } from "./plans.js";
import {
  getAccountById,
  getLicenseByKey,
  insertLicense,
  listAccounts,
  listLicenses,
  resetAllLicenseUsage,
  resetLicenseUsageForAccount,
  updateAccount,
  updateLicense,
} from "./supabase.js";
import {
  accountAccessDbPatch,
  accountAccessFromRow,
  publicAccountAccess,
} from "./user-access.js";

const SESSION_HOURS = 12;

function adminUser() {
  return process.env.ADMIN_USERNAME || "admin";
}

function adminPass() {
  return process.env.ADMIN_PASSWORD || "admin123";
}

function adminSecret() {
  return (
    process.env.ADMIN_SESSION_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    "hormachuelos-admin-dev-secret"
  );
}

export function checkAdminCredentials(username, password) {
  const u = String(username || "").trim();
  const p = String(password || "");
  return u === adminUser() && p === adminPass();
}

export function issueAdminToken() {
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  const payload = Buffer.from(JSON.stringify({ role: "admin", exp }), "utf8").toString(
    "base64url",
  );
  const sig = createHmac("sha256", adminSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyAdminToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const expect = createHmac("sha256", adminSecret()).update(payload).digest("base64url");
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expect);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  } catch {
    return false;
  }
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (data.role !== "admin") return false;
    if (Number(data.exp) < Date.now()) return false;
    return true;
  } catch {
    return false;
  }
}

export function adminFromRequest(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1].trim() : String(req.headers["x-horma-admin"] || "").trim();
  return verifyAdminToken(token) ? token : null;
}

function mapUser(account, license) {
  // Website accounts.plan is what admin sets — keep that as the plan label.
  const plan = account.plan
    ? normalizePlan(account.plan)
    : license?.plan
      ? normalizePlan(license.plan)
      : null;
  const access = publicAccountAccess(accountAccessFromRow(account));
  return {
    id: account.id,
    email: account.email,
    name: account.name || "",
    plan,
    period: account.period || null,
    credits: Number(account.credits) || 0,
    licenseKey: account.license_key || license?.key || null,
    licenseId: license?.id || null,
    tokenBudget: license ? Number(license.token_budget) || 0 : 0,
    tokensUsed: license ? Number(license.tokens_used) || 0 : 0,
    licenseActive: license ? Boolean(license.active) : false,
    expiresAt: license?.expires_at ? String(license.expires_at).slice(0, 10) : "",
    createdAt: account.created_at,
    updatedAt: account.updated_at,
    restricted: access.restricted,
    allowedProviders: access.allowedProviders,
    allowedModels: access.allowedModels,
  };
}

export async function listAdminUsers() {
  const [accounts, licenses] = await Promise.all([listAccounts(), listLicenses()]);
  const byKey = new Map(licenses.map((l) => [l.key, l]));
  const byEmail = new Map();
  for (const l of licenses) {
    if (l.email) {
      const k = String(l.email).toLowerCase();
      if (!byEmail.has(k)) byEmail.set(k, l);
    }
  }
  const users = [];
  for (const a of accounts) {
    let lic =
      (a.license_key && byKey.get(a.license_key)) ||
      byEmail.get(String(a.email).toLowerCase()) ||
      null;
    // Keep license.plan aligned with the website account plan (admin source of truth).
    if (lic?.id && a.plan && normalizePlan(a.plan) !== normalizePlan(lic.plan || "")) {
      try {
        lic = await updateLicense(lic.id, { plan: normalizePlan(a.plan) });
        if (lic?.key) byKey.set(lic.key, lic);
      } catch {
        /* display account plan below even if heal fails */
      }
    }
    users.push(mapUser(a, lic));
  }
  return users;
}

export async function updateAdminUser(id, patch) {
  const accounts = await listAccounts();
  const account = accounts.find((a) => a.id === id);
  if (!account) {
    throw Object.assign(new Error("User not found"), { status: 404 });
  }

  let nextPlan = account.plan;
  if (patch.plan !== undefined) {
    const raw = String(patch.plan || "").trim().toLowerCase();
    nextPlan = !raw || raw === "free" || raw === "none" ? null : normalizePlan(raw);
  }

  const accountPatch = { updated_at: new Date().toISOString() };
  if (patch.name != null) accountPatch.name = String(patch.name).trim();
  if (patch.plan !== undefined) accountPatch.plan = nextPlan;
  if (patch.period !== undefined) accountPatch.period = patch.period || null;
  if (patch.credits !== undefined) accountPatch.credits = Math.max(0, Number(patch.credits) || 0);
  Object.assign(accountPatch, accountAccessDbPatch(patch));

  let license =
    (account.license_key && (await getLicenseByKey(account.license_key))) || null;

  const touchLicense =
    patch.tokenBudget !== undefined ||
    patch.tokensUsed !== undefined ||
    patch.expiresAt !== undefined ||
    patch.licenseActive !== undefined ||
    (patch.plan !== undefined && patch.plan !== null && patch.plan !== "" && patch.plan !== "free");

  if (touchLicense) {
    const planForLic = nextPlan || license?.plan || "pro";
    const budget =
      patch.tokenBudget !== undefined
        ? Math.max(0, Number(patch.tokenBudget) || 0)
        : license
          ? Number(license.token_budget) || planBudget(planForLic)
          : planBudget(planForLic);
    const used =
      patch.tokensUsed !== undefined
        ? Math.max(0, Number(patch.tokensUsed) || 0)
        : license
          ? Number(license.tokens_used) || 0
          : 0;
    const expiresAt = patch.expiresAt
      ? new Date(`${String(patch.expiresAt).slice(0, 10)}T23:59:59.000Z`).toISOString()
      : license?.expires_at || new Date(Date.now() + 30 * 86400000).toISOString();
    const active =
      patch.licenseActive !== undefined
        ? Boolean(patch.licenseActive)
        : license
          ? Boolean(license.active)
          : true;

    if (license) {
      license = await updateLicense(license.id, {
        plan: planForLic,
        token_budget: budget,
        tokens_used: used,
        expires_at: expiresAt,
        active,
        email: account.email,
      });
    } else {
      const { randomUUID } = await import("node:crypto");
      const prefix =
        planForLic === "max20"
          ? "HORMA-MAX20"
          : planForLic === "max10"
            ? "HORMA-MAX10"
            : planForLic === "max5"
              ? "HORMA-MAX"
              : planForLic === "proplus"
                ? "HORMA-PROPLUS"
                : planForLic === "starter"
                  ? "HORMA-STARTER"
                  : "HORMA-PRO";
      const key = `${prefix}-${randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
      license = await insertLicense({
        key,
        plan: planForLic,
        email: account.email,
        token_budget: budget,
        tokens_used: used,
        active,
        expires_at: expiresAt,
        meta: { source: "admin" },
      });
      accountPatch.license_key = key;
    }
  }

  const updated = await updateAccount(account.id, accountPatch);
  return mapUser(updated || { ...account, ...accountPatch }, license);
}

async function licenseForAccount(account) {
  return (
    (account.license_key && (await getLicenseByKey(account.license_key))) ||
    null
  );
}

export async function resetAdminUserUsage(id) {
  const account = await getAccountById(id);
  if (!account) {
    throw Object.assign(new Error("User not found"), { status: 404 });
  }
  const updatedLicenses = await resetLicenseUsageForAccount(account);
  const license =
    updatedLicenses.find((row) => row.key && row.key === account.license_key) ||
    updatedLicenses[0] ||
    (await licenseForAccount(account));
  return mapUser(account, license);
}

export async function resetAllAdminUsage() {
  const reset = await resetAllLicenseUsage();
  return { reset };
}
