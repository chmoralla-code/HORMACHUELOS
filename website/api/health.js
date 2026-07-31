import { corsHeaders, json } from "./_lib/http.js";
import { supabaseConfigured } from "./_lib/supabase.js";
import { hostedProvidersStatus } from "./_lib/providers.js";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    for (const [k, v] of Object.entries(corsHeaders(req))) res.setHeader(k, v);
    return res.end();
  }
  return json(res, 200, {
    ok: true,
    service: "hormachuelos-hosted",
    supabase: supabaseConfigured(),
    providers: hostedProvidersStatus(),
  }, req);
}
