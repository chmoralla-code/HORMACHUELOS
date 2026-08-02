import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import {
  consumeEmailVerification,
  deleteSessionsForTokenHash,
  getAccountByEmail,
  getAccountById,
  getDeviceLinkByDeviceCode,
  getDeviceLinkByUserCode,
  getLatestEmailVerification,
  getLicenseByEmail,
  getLicenseByKey,
  getSessionByTokenHash,
  insertAccount,
  insertDeviceLink,
  insertEmailVerification,
  insertOrder,
  insertSession,
  listOrdersForAccount,
  updateAccount,
  updateDeviceLink,
} from "./supabase.js";
import { planBudget } from "./plans.js";
import { sendVerificationEmail } from "./resend.js";

const SITE_URL = () => process.env.PUBLIC_SITE_URL || "https://hormachuelos.vercel.app";

const SESSION_DAYS = 30;

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  try {
    const [algo, salt, hash] = String(stored || "").split("$");
    if (algo !== "scrypt" || !salt || !hash) return false;
    const next = scryptSync(password, salt, 64);
    const prev = Buffer.from(hash, "hex");
    if (prev.length !== next.length) return false;
    return timingSafeEqual(prev, next);
  } catch {
    return false;
  }
}

export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function publicAccount(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name || "",
    plan: row.plan || null,
    period: row.period || null,
    credits: Number(row.credits) || 0,
    licenseKey: row.license_key || null,
    emailVerified: Boolean(row.email_verified),
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
  };
}

/** Account + live hosted plan usage (from linked license row). */
export async function publicAccountWithUsage(row) {
  const base = publicAccount(row);
  if (!base) return null;
  let license = null;
  if (base.licenseKey) license = await getLicenseByKey(base.licenseKey);
  if (!license) license = await getLicenseByEmail(base.email);
  if (!license) {
    return {
      ...base,
      plan: base.plan || "free",
      tokenBudget: 0,
      tokensUsed: 0,
      licenseActive: false,
      expiresAt: "",
      planRemainingPct: 100,
    };
  }
  const expired = new Date(license.expires_at).getTime() < Date.now();
  const active = Boolean(license.active) && !expired;
  const budget = Number(license.token_budget) || planBudget(license.plan);
  const used = Number(license.tokens_used) || 0;
  const remaining = Math.max(0, budget - used);
  const planRemainingPct =
    budget > 0 ? Math.max(0, Math.min(100, Math.round((remaining / budget) * 100))) : 0;
  return {
    ...base,
    plan: expired ? "expired" : license.plan || base.plan || "free",
    licenseKey: license.key || base.licenseKey,
    tokenBudget: budget,
    tokensUsed: used,
    licenseActive: active,
    expiresAt: String(license.expires_at || "").slice(0, 10),
    planRemainingPct,
  };
}

function makeVerifyCode() {
  // 6-digit code, avoids ambiguous leading zeros issues in some clients
  return String(Math.floor(100000 + Math.random() * 900000));
}

export async function createAccount({ email, password, name }) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) {
    throw Object.assign(new Error("Enter a valid email."), { status: 400 });
  }
  if (String(password || "").length < 6) {
    throw Object.assign(new Error("Password must be at least 6 characters."), { status: 400 });
  }
  const existing = await getAccountByEmail(normalized);
  if (existing) {
    if (!existing.email_verified) {
      throw Object.assign(
        new Error("Account pending verification. Check your email or resend the code."),
        { status: 409, code: "pending_verification", email: normalized },
      );
    }
    throw Object.assign(new Error("An account with that email already exists."), { status: 409 });
  }
  const row = await insertAccount({
    email: normalized,
    password_hash: hashPassword(password),
    name: String(name || "").trim() || normalized.split("@")[0],
    plan: null,
    period: null,
    credits: 0,
    email_verified: false,
  });
  return row;
}

export async function startEmailVerification(account) {
  const code = makeVerifyCode();
  const expires = new Date(Date.now() + 30 * 60 * 1000);
  await insertEmailVerification({
    account_id: account.id,
    email: account.email,
    code_hash: hashToken(code),
    expires_at: expires.toISOString(),
  });
  await sendVerificationEmail({
    to: account.email,
    name: account.name,
    code,
  });
  return { email: account.email, expiresAt: expires.toISOString() };
}

export async function verifyEmailCode(email, code) {
  const normalized = String(email || "").trim().toLowerCase();
  const account = await getAccountByEmail(normalized);
  if (!account) {
    throw Object.assign(new Error("Account not found."), { status: 404 });
  }
  if (account.email_verified) {
    return account;
  }
  const row = await getLatestEmailVerification(account.id);
  if (!row) {
    throw Object.assign(new Error("No verification code found. Request a new one."), { status: 400 });
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw Object.assign(new Error("Verification code expired. Request a new one."), { status: 400 });
  }
  const expect = hashToken(String(code || "").trim());
  if (expect !== row.code_hash) {
    throw Object.assign(new Error("Invalid verification code."), { status: 400 });
  }
  await consumeEmailVerification(row.id);
  return updateAccount(account.id, {
    email_verified: true,
    updated_at: new Date().toISOString(),
  });
}

export async function createSession(accountId) {
  const token = randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  await insertSession({
    account_id: accountId,
    token_hash: tokenHash,
    expires_at: expires.toISOString(),
  });
  return { token, expiresAt: expires.toISOString() };
}

export async function accountFromRequest(req) {
  const raw = (() => {
    const h = req.headers.authorization || req.headers.Authorization || "";
    const m = String(h).match(/^Bearer\s+(.+)$/i);
    const bearer = m ? m[1].trim() : "";
    // A desktop catalog request may carry a paid license in Authorization and
    // a website session in X-Horma-Session. Keep the normal bearer session
    // precedence, but use the explicit session header when Authorization is a
    // HORMA license rather than accidentally treating it as an account token.
    if (bearer && !bearer.toUpperCase().startsWith("HORMA-")) return bearer;
    return String(req.headers["x-horma-session"] || "").trim() || bearer;
  })();
  if (!raw || raw.toUpperCase().startsWith("HORMA-")) return null;
  const session = await getSessionByTokenHash(hashToken(raw));
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    await deleteSessionsForTokenHash(session.token_hash);
    return null;
  }
  const account = await getAccountById(session.account_id);
  return account || null;
}

export async function loginAccount(email, password) {
  const normalized = String(email || "").trim().toLowerCase();
  const account = await getAccountByEmail(normalized);
  if (!account || !verifyPassword(password, account.password_hash)) {
    throw Object.assign(new Error("Invalid email or password."), { status: 401 });
  }
  if (!account.email_verified) {
    throw Object.assign(
      new Error("Verify your email first. We sent a code from HORMACHUELOS."),
      { status: 403, code: "email_unverified", email: normalized },
    );
  }
  return account;
}

export async function logoutToken(token) {
  if (!token) return;
  await deleteSessionsForTokenHash(hashToken(token));
}

export async function patchAccountProfile(accountId, patch) {
  const body = { updated_at: new Date().toISOString() };
  if (patch.name != null) body.name = String(patch.name).trim();
  if (patch.plan != null) body.plan = patch.plan;
  if (patch.period != null) body.period = patch.period;
  if (patch.credits != null) body.credits = Number(patch.credits) || 0;
  if (patch.licenseKey != null) body.license_key = patch.licenseKey;
  return updateAccount(accountId, body);
}

export async function recordOrder(account, order) {
  const uuidLike =
    typeof order.id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(order.id);
  const row = {
    account_id: account?.id || null,
    email: order.email || account?.email || null,
    plan_id: order.planId,
    plan_name: order.planName,
    period: order.period,
    amount_php: Math.round(Number(order.amount) || 0),
    method: order.method,
    license_key: order.licenseKey,
    demo: order.demo !== false,
  };
  if (uuidLike) row.id = order.id;
  return insertOrder(row);
}

export async function ordersFor(accountId) {
  return listOrdersForAccount(accountId);
}

function makeUserCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
    if (i === 3) out += "-";
  }
  return out;
}

/** Desktop starts a pairing request; browser completes it after website login. */
export async function startDeviceLink() {
  const userCode = makeUserCode();
  const deviceCode = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 15 * 60 * 1000);
  await insertDeviceLink({
    user_code: userCode,
    device_code: deviceCode,
    status: "pending",
    expires_at: expires.toISOString(),
  });
  const verifyUrl = `${SITE_URL()}/#/login?desktop=1&dcode=${encodeURIComponent(userCode)}`;
  return {
    userCode,
    deviceCode,
    verifyUrl,
    expiresAt: expires.toISOString(),
    intervalSeconds: 2,
  };
}

export async function completeDeviceLink(userCode, account) {
  const code = String(userCode || "").trim().toUpperCase();
  const link = await getDeviceLinkByUserCode(code);
  if (!link) {
    throw Object.assign(new Error("Unknown or expired desktop code."), { status: 404 });
  }
  if (new Date(link.expires_at).getTime() < Date.now()) {
    await updateDeviceLink(link.id, { status: "expired" });
    throw Object.assign(new Error("Desktop code expired. Open Hormachuelos and try again."), {
      status: 410,
    });
  }
  // Always mint a fresh desktop session token — even if previously complete/claimed —
  // so an already-signed-in browser can re-link if the app missed the first poll.
  const session = await createSession(account.id);
  await updateDeviceLink(link.id, {
    status: "complete",
    account_id: account.id,
    session_token: session.token,
    session_token_hash: hashToken(session.token),
    completed_at: new Date().toISOString(),
  });
  return { ok: true, userCode: code, reissued: link.status !== "pending" };
}

/** Desktop polls until the website login finishes, then receives a one-time session token. */
export async function pollDeviceLink(deviceCode) {
  const link = await getDeviceLinkByDeviceCode(String(deviceCode || "").trim());
  if (!link) {
    throw Object.assign(new Error("Unknown device code."), { status: 404 });
  }
  if (
    new Date(link.expires_at).getTime() < Date.now() &&
    link.status !== "complete" &&
    link.status !== "claimed"
  ) {
    await updateDeviceLink(link.id, { status: "expired" });
    return { status: "expired" };
  }
  if (link.status === "pending") {
    return { status: "pending" };
  }
  if (link.status === "expired") {
    return { status: "expired" };
  }
  if (link.status === "complete") {
    const token = String(link.session_token || "");
    // Wait for website to (re)issue a token instead of handing back an empty claim.
    if (!token) {
      return { status: "pending" };
    }
    // One-time retrieve — clear plaintext token from DB.
    await updateDeviceLink(link.id, { session_token: null, status: "claimed" });
    let account = null;
    if (link.account_id) {
      account = await getAccountById(link.account_id);
    }
    return {
      status: "complete",
      token,
      user: await publicAccountWithUsage(account),
    };
  }
  if (link.status === "claimed") {
    // App missed the token — keep waiting so a website re-link can set status=complete again.
    return { status: "pending", waitingForRelink: true };
  }
  return { status: link.status || "pending" };
}
