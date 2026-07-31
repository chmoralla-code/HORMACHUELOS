const url = () => process.env.SUPABASE_URL || process.env.HORMACHUELOS_SUPABASE_URL || "";
const key = () =>
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.HORMACHUELOS_SERVICE_ROLE || "";

export function supabaseConfigured() {
  return Boolean(url() && key());
}

async function sb(path, { method = "GET", body, headers = {} } = {}) {
  const base = url().replace(/\/$/, "");
  if (!base || !key()) {
    throw new Error("Supabase is not configured on the server.");
  }
  const res = await fetch(`${base}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key(),
      Authorization: `Bearer ${key()}`,
      "Content-Type": "application/json",
      Prefer: headers.Prefer || "return=representation",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = typeof data === "object" && data?.message ? data.message : text || res.statusText;
    throw new Error(`Supabase ${res.status}: ${msg}`);
  }
  return data;
}

export async function insertLicense(row) {
  const rows = await sb("licenses", { method: "POST", body: row });
  return Array.isArray(rows) ? rows[0] : rows;
}

export async function getLicenseByKey(licenseKey) {
  const q = `licenses?key=eq.${encodeURIComponent(licenseKey)}&select=*&limit=1`;
  const rows = await sb(q);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export async function getLicenseByEmail(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return null;
  const q = `licenses?email=eq.${encodeURIComponent(normalized)}&select=*&order=created_at.desc&limit=1`;
  const rows = await sb(q);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export async function updateLicense(id, patch) {
  const rows = await sb(`licenses?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { ...patch, updated_at: new Date().toISOString() },
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

export async function insertUsageEvent(row) {
  await sb("usage_events", {
    method: "POST",
    body: row,
    headers: { Prefer: "return=minimal" },
  });
}

export async function getAccountByEmail(email) {
  const q = `accounts?email=eq.${encodeURIComponent(email)}&select=*&limit=1`;
  const rows = await sb(q);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export async function getAccountById(id) {
  const q = `accounts?id=eq.${encodeURIComponent(id)}&select=*&limit=1`;
  const rows = await sb(q);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export async function insertAccount(row) {
  const rows = await sb("accounts", { method: "POST", body: row });
  return Array.isArray(rows) ? rows[0] : rows;
}

export async function updateAccount(id, patch) {
  const rows = await sb(`accounts?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: patch,
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

export async function insertSession(row) {
  const rows = await sb("sessions", { method: "POST", body: row });
  return Array.isArray(rows) ? rows[0] : rows;
}

export async function getSessionByTokenHash(tokenHash) {
  const q = `sessions?token_hash=eq.${encodeURIComponent(tokenHash)}&select=*&limit=1`;
  const rows = await sb(q);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export async function deleteSessionsForTokenHash(tokenHash) {
  await sb(`sessions?token_hash=eq.${encodeURIComponent(tokenHash)}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
}

export async function insertOrder(row) {
  const rows = await sb("web_orders", { method: "POST", body: row });
  return Array.isArray(rows) ? rows[0] : rows;
}

export async function listOrdersForAccount(accountId) {
  const q = `web_orders?account_id=eq.${encodeURIComponent(accountId)}&select=*&order=created_at.desc&limit=20`;
  const rows = await sb(q);
  return Array.isArray(rows) ? rows : [];
}

export async function listAccounts() {
  const rows = await sb("accounts?select=*&order=created_at.desc&limit=500");
  return Array.isArray(rows) ? rows : [];
}

export async function listLicenses() {
  const rows = await sb("licenses?select=*&order=created_at.desc&limit=500");
  return Array.isArray(rows) ? rows : [];
}

export async function insertEmailVerification(row) {
  const rows = await sb("email_verifications", { method: "POST", body: row });
  return Array.isArray(rows) ? rows[0] : rows;
}

export async function getLatestEmailVerification(accountId) {
  const q = `email_verifications?account_id=eq.${encodeURIComponent(accountId)}&consumed_at=is.null&select=*&order=created_at.desc&limit=1`;
  const rows = await sb(q);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export async function consumeEmailVerification(id) {
  const rows = await sb(`email_verifications?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { consumed_at: new Date().toISOString() },
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

export async function deleteAccount(id) {
  await sb(`accounts?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
}

export async function insertDeviceLink(row) {
  const rows = await sb("device_links", { method: "POST", body: row });
  return Array.isArray(rows) ? rows[0] : rows;
}

export async function getDeviceLinkByUserCode(userCode) {
  const q = `device_links?user_code=eq.${encodeURIComponent(userCode)}&select=*&limit=1`;
  const rows = await sb(q);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export async function getDeviceLinkByDeviceCode(deviceCode) {
  const q = `device_links?device_code=eq.${encodeURIComponent(deviceCode)}&select=*&limit=1`;
  const rows = await sb(q);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export async function updateDeviceLink(id, patch) {
  const rows = await sb(`device_links?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: patch,
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

export async function listReleases() {
  const rows = await sb("app_releases?select=*&order=published_at.desc&limit=50");
  return Array.isArray(rows) ? rows : [];
}

export async function getLatestRelease() {
  const rows = await sb("app_releases?is_latest=eq.true&select=*&limit=1");
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export async function getReleaseByVersion(version) {
  const q = `app_releases?version=eq.${encodeURIComponent(version)}&select=*&limit=1`;
  const rows = await sb(q);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export async function clearLatestReleaseFlags() {
  await sb("app_releases?is_latest=eq.true", {
    method: "PATCH",
    body: { is_latest: false, updated_at: new Date().toISOString() },
    headers: { Prefer: "return=minimal" },
  });
}

export async function insertRelease(row) {
  const rows = await sb("app_releases", { method: "POST", body: row });
  return Array.isArray(rows) ? rows[0] : rows;
}

export async function updateRelease(id, patch) {
  const rows = await sb(`app_releases?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { ...patch, updated_at: new Date().toISOString() },
  });
  return Array.isArray(rows) ? rows[0] : rows;
}
