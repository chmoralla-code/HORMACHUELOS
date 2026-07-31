import { corsHeaders, json, readJson } from "./_lib/http.js";
import { supabaseConfigured } from "./_lib/supabase.js";
import { checkUpdate, latestReleasePublic } from "./_lib/releases.js";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    for (const [k, v] of Object.entries(corsHeaders(req))) res.setHeader(k, v);
    return res.end();
  }
  if (!supabaseConfigured()) {
    return json(res, 503, { error: "Update service not configured" }, req);
  }

  try {
    if (req.method === "GET") {
      const url = new URL(req.url, "http://localhost");
      const current = url.searchParams.get("current") || url.searchParams.get("version") || "";
      if (current) {
        const check = await checkUpdate(current);
        return json(res, 200, { ok: true, ...check }, req);
      }
      const latest = await latestReleasePublic();
      return json(res, 200, { ok: true, latest }, req);
    }

    if (req.method === "POST") {
      const body = await readJson(req);
      const check = await checkUpdate(body.current || body.version || "");
      return json(res, 200, { ok: true, ...check }, req);
    }

    return json(res, 405, { error: "Method not allowed" }, req);
  } catch (e) {
    return json(res, e.status || 500, { error: String(e.message || e) }, req);
  }
}
