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
  const q = `licenses?email=eq.${encodeURIComponent(normalized)}&plan=neq.hormachuelos_free&select=*&order=created_at.desc&limit=1`;
  const rows = await sb(q);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export async function getHormachuelosFreeLicenseByEmail(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return null;
  const q = `licenses?email=eq.${encodeURIComponent(normalized)}&plan=eq.hormachuelos_free&select=*&order=created_at.desc&limit=1`;
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

/** Server-only hosted-model routing records. Credentials remain encrypted in this table. */
export async function listHostedModelConfigs({ activeOnly = false } = {}) {
  const filter = activeOnly ? "&active=eq.true" : "";
  const rows = await sb(
    `hosted_model_configs?select=*&order=provider_id.asc,display_name.asc${filter}`,
  );
  return Array.isArray(rows) ? rows : [];
}

export async function getHostedModelConfig(providerId, alias) {
  const q =
    `hosted_model_configs?provider_id=eq.${encodeURIComponent(providerId)}` +
    `&alias=eq.${encodeURIComponent(alias)}&select=*&limit=1`;
  const rows = await sb(q);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export async function getHostedModelConfigById(id) {
  const rows = await sb(
    `hosted_model_configs?id=eq.${encodeURIComponent(id)}&select=*&limit=1`,
  );
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export async function insertHostedModelConfig(row) {
  const rows = await sb("hosted_model_configs", { method: "POST", body: row });
  return Array.isArray(rows) ? rows[0] : rows;
}

export async function updateHostedModelConfig(id, patch) {
  const rows = await sb(`hosted_model_configs?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { ...patch, updated_at: new Date().toISOString() },
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

export async function deleteHostedModelConfig(id) {
  await sb(`hosted_model_configs?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
}

// ─── Manual payment proof records (server-side only) ───────────────────────

export async function insertPaymentOrder(row) {
  const rows = await sb("payment_orders", { method: "POST", body: row });
  return Array.isArray(rows) ? rows[0] : rows;
}

export async function getPaymentOrderById(id) {
  const rows = await sb(
    `payment_orders?id=eq.${encodeURIComponent(id)}&select=*&limit=1`,
  );
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export async function getPaymentOrderForAccount(id, accountId) {
  const rows = await sb(
    `payment_orders?id=eq.${encodeURIComponent(id)}` +
      `&account_id=eq.${encodeURIComponent(accountId)}&select=*&limit=1`,
  );
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export async function listPaymentOrdersForAccount(accountId, { limit = 20 } = {}) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  const rows = await sb(
    `payment_orders?account_id=eq.${encodeURIComponent(accountId)}` +
      `&select=*&order=created_at.desc&limit=${safeLimit}`,
  );
  return Array.isArray(rows) ? rows : [];
}

export async function listPaymentOrders({ limit = 100 } = {}) {
  const safeLimit = Math.max(1, Math.min(250, Number(limit) || 100));
  const rows = await sb(`payment_orders?select=*&order=created_at.desc&limit=${safeLimit}`);
  return Array.isArray(rows) ? rows : [];
}

export async function getPaymentOrderByProofHash(hash) {
  const value = String(hash || "").trim();
  if (!value) return null;
  const rows = await sb(
    `payment_orders?proof_sha256=eq.${encodeURIComponent(value)}&select=*&limit=1`,
  );
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export async function getPaymentOrderByReferenceHash(hash) {
  const value = String(hash || "").trim();
  if (!value) return null;
  const rows = await sb(
    `payment_orders?receipt_reference_hash=eq.${encodeURIComponent(value)}&select=*&limit=1`,
  );
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export async function updatePaymentOrder(id, patch) {
  const rows = await sb(`payment_orders?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { ...patch, updated_at: new Date().toISOString() },
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

/**
 * Atomically move a payment request only when it is still in one of the
 * expected states. This avoids duplicate licenses when Telegram and the
 * auto-review worker act at the same time.
 */
export async function updatePaymentOrderIfStatus(id, statuses, patch) {
  const allowed = (Array.isArray(statuses) ? statuses : [statuses])
    .map((status) => String(status || "").trim())
    .filter((status) => /^[a-z_]+$/.test(status));
  if (!allowed.length) throw new Error("Expected payment status is required.");
  const rows = await sb(
    `payment_orders?id=eq.${encodeURIComponent(id)}&status=in.(${allowed.join(",")})`,
    {
      method: "PATCH",
      body: { ...patch, updated_at: new Date().toISOString() },
    },
  );
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

// ─── Supabase Storage helpers for private payment proofs ───────────────────

function storageBase() {
  const base = url().replace(/\/$/, "");
  if (!base || !key()) throw new Error("Supabase is not configured on the server.");
  return `${base}/storage/v1`;
}

function encodeStoragePath(bucket, objectPath) {
  const cleanBucket = String(bucket || "").trim();
  const cleanPath = String(objectPath || "")
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
  if (!/^[a-z0-9-]+$/i.test(cleanBucket) || !cleanPath) {
    throw new Error("Invalid storage object path.");
  }
  return `${encodeURIComponent(cleanBucket)}/${cleanPath}`;
}

async function storageJson(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`${storageBase()}/${path.replace(/^\//, "")}`, {
    method,
    headers: {
      apikey: key(),
      Authorization: `Bearer ${key()}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const message = typeof data === "object" && data?.message ? data.message : text || res.statusText;
    throw new Error(`Supabase Storage ${res.status}: ${message}`);
  }
  return data;
}

function storageUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Supabase Storage did not return a signed URL.");
  if (/^https:\/\//i.test(raw)) return raw;
  const site = url().replace(/\/$/, "");
  if (raw.startsWith("/storage/v1/")) return `${site}${raw}`;
  return `${storageBase()}${raw.startsWith("/") ? "" : "/"}${raw}`;
}

/** Create a short-lived, single-object upload URL. The client never receives a service key. */
export async function createPrivateUploadUrl(bucket, objectPath) {
  const data = await storageJson(`object/upload/sign/${encodeStoragePath(bucket, objectPath)}`, {
    method: "POST",
    body: { upsert: false },
  });
  // Storage has used both `url` and `signedUrl` in its REST/SDK responses.
  // Accept either so a Storage client upgrade cannot silently break checkout.
  const uploadUrl = data?.signedUrl || data?.signedURL || data?.url;
  return {
    uploadUrl: storageUrl(uploadUrl),
  };
}

/** Download a private proof only from a trusted server context. */
export async function downloadPrivateStorageObject(bucket, objectPath) {
  const res = await fetch(
    `${storageBase()}/object/authenticated/${encodeStoragePath(bucket, objectPath)}`,
    {
      headers: {
        apikey: key(),
        Authorization: `Bearer ${key()}`,
      },
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Supabase Storage ${res.status}: ${text || res.statusText}`);
  }
  return {
    bytes: Buffer.from(await res.arrayBuffer()),
    contentType: String(res.headers.get("content-type") || "").split(";")[0].trim(),
  };
}

/** Create a short-lived admin-only viewing URL for a private proof. */
export async function createPrivateDownloadUrl(bucket, objectPath, expiresIn = 600) {
  const ttl = Math.max(60, Math.min(3600, Number(expiresIn) || 600));
  const data = await storageJson(`object/sign/${encodeStoragePath(bucket, objectPath)}`, {
    method: "POST",
    body: { expiresIn: ttl },
  });
  return storageUrl(data?.signedURL || data?.signedUrl || data?.url);
}
