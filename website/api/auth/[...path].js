import { corsHeaders, json, readJson, bearerToken } from "../_lib/http.js";
import { deleteAccount, getAccountByEmail, supabaseConfigured } from "../_lib/supabase.js";
import {
  createAccount,
  createSession,
  loginAccount,
  logoutToken,
  accountFromRequest,
  completeDeviceLink,
  ordersFor,
  patchAccountProfile,
  pollDeviceLink,
  publicAccount,
  recordOrder,
  startDeviceLink,
  startEmailVerification,
  verifyEmailCode,
} from "../_lib/auth.js";
import { resendConfigured } from "../_lib/resend.js";

function actionOf(req) {
  const q = req.query?.path;
  if (Array.isArray(q) && q.length) return q.map(String).join("/").toLowerCase();
  if (typeof q === "string" && q) return q.toLowerCase();
  const url = String(req.url || "");
  const m = url.match(/\/api\/auth\/(.+?)(?:\?|$)/i);
  return m ? m[1].replace(/\/+$/, "").toLowerCase() : "";
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    for (const [k, v] of Object.entries(corsHeaders(req))) res.setHeader(k, v);
    return res.end();
  }
  if (!supabaseConfigured()) return json(res, 503, { error: "Auth service not configured" }, req);

  const action = actionOf(req);

  try {
    if (action === "signup" && req.method === "POST") {
      if (!resendConfigured()) {
        return json(res, 503, { error: "Email verification is not configured (RESEND_API_KEY)." }, req);
      }
      let createdId = null;
      try {
        const body = await readJson(req);
        const account = await createAccount({
          email: body.email,
          password: body.password,
          name: body.name,
        });
        createdId = account.id;
        const verification = await startEmailVerification(account);
        return json(
          res,
          201,
          {
            ok: true,
            needsVerification: true,
            email: verification.email,
            expiresAt: verification.expiresAt,
            user: publicAccount(account),
            message: "Check your email for a verification code from HORMACHUELOS.",
          },
          req,
        );
      } catch (e) {
        if (createdId) {
          try {
            await deleteAccount(createdId);
          } catch {
            /* ignore */
          }
        }
        const payload = { error: String(e.message || e) };
        if (e.code) payload.code = e.code;
        if (e.email) payload.email = e.email;
        return json(res, e.status || 500, payload, req);
      }
    }

    if (action === "login" && req.method === "POST") {
      const body = await readJson(req);
      try {
        const account = await loginAccount(body.email, body.password);
        const session = await createSession(account.id);
        return json(
          res,
          200,
          {
            ok: true,
            token: session.token,
            expiresAt: session.expiresAt,
            user: publicAccount(account),
          },
          req,
        );
      } catch (e) {
        const payload = { error: String(e.message || e) };
        if (e.code) payload.code = e.code;
        if (e.email) payload.email = e.email;
        return json(res, e.status || 500, payload, req);
      }
    }

    if (action === "verify" && req.method === "POST") {
      const body = await readJson(req);
      const account = await verifyEmailCode(body.email, body.code);
      const session = await createSession(account.id);
      return json(
        res,
        200,
        {
          ok: true,
          token: session.token,
          expiresAt: session.expiresAt,
          user: publicAccount(account),
          message: "Email verified. Welcome to Hormachuelos.",
        },
        req,
      );
    }

    if (action === "resend-verification" && req.method === "POST") {
      if (!resendConfigured()) {
        return json(res, 503, { error: "Verification service not configured" }, req);
      }
      const body = await readJson(req);
      const email = String(body.email || "").trim().toLowerCase();
      const account = await getAccountByEmail(email);
      if (!account) {
        return json(res, 200, { ok: true, message: "If that email is registered, a code was sent." }, req);
      }
      if (account.email_verified) {
        return json(res, 200, { ok: true, message: "Email is already verified. You can log in." }, req);
      }
      const verification = await startEmailVerification(account);
      return json(
        res,
        200,
        {
          ok: true,
          email: verification.email,
          expiresAt: verification.expiresAt,
          message: "New verification code sent from HORMACHUELOS.",
        },
        req,
      );
    }

    if (action === "logout" && req.method === "POST") {
      await logoutToken(bearerToken(req));
      return json(res, 200, { ok: true }, req);
    }

    if ((action === "device/start" || action === "device-start") && req.method === "POST") {
      const link = await startDeviceLink();
      return json(res, 200, { ok: true, ...link }, req);
    }

    if ((action === "device/complete" || action === "device-complete") && req.method === "POST") {
      const account = await accountFromRequest(req);
      if (!account) return json(res, 401, { error: "Log in on the website first." }, req);
      if (!account.email_verified) {
        return json(res, 403, { error: "Verify your email before linking the desktop app." }, req);
      }
      const body = await readJson(req);
      const result = await completeDeviceLink(body.code || body.userCode, account);
      return json(
        res,
        200,
        {
          ok: true,
          ...result,
          message: "Desktop app linked. Return to Hormachuelos — you are signed in.",
          user: publicAccount(account),
        },
        req,
      );
    }

    if ((action === "device/poll" || action === "device-poll") && req.method === "POST") {
      const body = await readJson(req);
      const result = await pollDeviceLink(body.deviceCode);
      return json(res, 200, { ok: true, ...result }, req);
    }

    if (action === "me") {
      const account = await accountFromRequest(req);
      if (!account) return json(res, 401, { error: "Not signed in" }, req);

      if (req.method === "GET") {
        const orders = await ordersFor(account.id);
        return json(
          res,
          200,
          {
            ok: true,
            user: publicAccount(account),
            orders: orders.map((o) => ({
              id: o.id,
              email: o.email,
              planId: o.plan_id,
              planName: o.plan_name,
              period: o.period,
              amount: o.amount_php,
              method: o.method,
              licenseKey: o.license_key,
              demo: o.demo,
              at: o.created_at ? new Date(o.created_at).getTime() : Date.now(),
            })),
          },
          req,
        );
      }

      if (req.method === "PATCH") {
        const body = await readJson(req);
        if (body.order) await recordOrder(account, body.order);
        const updated = await patchAccountProfile(account.id, {
          name: body.name,
          plan: body.plan,
          period: body.period,
          credits: body.credits,
          licenseKey: body.licenseKey,
        });
        return json(res, 200, { ok: true, user: publicAccount(updated || account) }, req);
      }
    }

    return json(res, 404, { error: `Unknown auth action: ${action || "(empty)"}` }, req);
  } catch (e) {
    return json(res, e.status || 500, { error: String(e.message || e) }, req);
  }
}
