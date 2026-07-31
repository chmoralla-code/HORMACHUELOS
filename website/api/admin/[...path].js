import { corsHeaders, json, readJson } from "../_lib/http.js";
import { supabaseConfigured } from "../_lib/supabase.js";
import {
  adminFromRequest,
  checkAdminCredentials,
  issueAdminToken,
  listAdminUsers,
  updateAdminUser,
} from "../_lib/admin.js";
import {
  adminListReleases,
  adminPublishRelease,
  adminSetForceUpdate,
} from "../_lib/releases.js";

function actionOf(req) {
  const q = req.query?.path;
  if (Array.isArray(q) && q.length) return String(q[0]).toLowerCase();
  if (typeof q === "string" && q) return q.toLowerCase();
  const url = String(req.url || "");
  const m = url.match(/\/api\/admin\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : "";
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    for (const [k, v] of Object.entries(corsHeaders(req))) res.setHeader(k, v);
    return res.end();
  }

  const action = actionOf(req);

  try {
    if (action === "login" && req.method === "POST") {
      const body = await readJson(req);
      if (!checkAdminCredentials(body.username, body.password)) {
        return json(res, 401, { error: "Invalid admin username or password." }, req);
      }
      return json(
        res,
        200,
        {
          ok: true,
          token: issueAdminToken(),
          user: { role: "admin", username: String(body.username || "admin").trim() },
        },
        req,
      );
    }

    if (action === "users" || action === "releases") {
      if (!supabaseConfigured()) {
        return json(res, 503, { error: "Admin service not configured" }, req);
      }
      if (!adminFromRequest(req)) return json(res, 401, { error: "Admin login required" }, req);
    }

    if (action === "users") {
      if (req.method === "GET") {
        const users = await listAdminUsers();
        return json(res, 200, { ok: true, users }, req);
      }

      if (req.method === "PATCH") {
        const body = await readJson(req);
        const id = body.id || body.userId;
        if (!id) return json(res, 400, { error: "Missing user id" }, req);
        const user = await updateAdminUser(id, {
          name: body.name,
          plan: body.plan,
          period: body.period,
          credits: body.credits,
          tokenBudget: body.tokenBudget,
          tokensUsed: body.tokensUsed,
          expiresAt: body.expiresAt,
          licenseActive: body.licenseActive,
        });
        return json(res, 200, { ok: true, user }, req);
      }
    }

    if (action === "releases") {
      if (req.method === "GET") {
        const releases = await adminListReleases();
        return json(res, 200, { ok: true, releases }, req);
      }
      if (req.method === "POST") {
        const body = await readJson(req);
        const release = await adminPublishRelease(body);
        return json(res, 201, { ok: true, release }, req);
      }
      if (req.method === "PATCH") {
        const body = await readJson(req);
        if (!body.id) return json(res, 400, { error: "Missing release id" }, req);
        if (body.forceUpdate !== undefined || body.force_update !== undefined) {
          const release = await adminSetForceUpdate(
            body.id,
            body.forceUpdate ?? body.force_update,
          );
          return json(res, 200, { ok: true, release }, req);
        }
        const release = await adminPublishRelease({ ...body, version: body.version });
        return json(res, 200, { ok: true, release }, req);
      }
    }

    return json(res, 404, { error: `Unknown admin action: ${action || "(empty)"}` }, req);
  } catch (e) {
    return json(res, e.status || 500, { error: String(e.message || e) }, req);
  }
}
