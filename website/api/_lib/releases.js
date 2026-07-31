import {
  clearLatestReleaseFlags,
  getLatestRelease,
  getReleaseByVersion,
  insertRelease,
  listReleases,
  updateRelease,
} from "./supabase.js";

export function publicRelease(row) {
  if (!row) return null;
  return {
    id: row.id,
    version: row.version,
    title: row.title || `Hormachuelos ${row.version}`,
    whatsNew: row.whats_new || "",
    msiUrl: row.msi_url || "",
    exeUrl: row.exe_url || "",
    forceUpdate: Boolean(row.force_update),
    isLatest: Boolean(row.is_latest),
    publishedAt: row.published_at,
  };
}

/** Compare semver-ish strings. >0 if a>b, <0 if a<b, 0 if equal. */
export function cmpSemver(a, b) {
  const parse = (v) =>
    String(v || "0")
      .replace(/^v/i, "")
      .split(/[.+-]/)
      .map((p) => parseInt(p, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  const n = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

export async function latestReleasePublic() {
  return publicRelease(await getLatestRelease());
}

export async function checkUpdate(currentVersion) {
  const latest = await getLatestRelease();
  if (!latest) {
    return { updateAvailable: false, forceUpdate: false, latest: null, currentVersion };
  }
  const outdated = cmpSemver(latest.version, currentVersion) > 0;
  return {
    updateAvailable: outdated,
    forceUpdate: outdated && Boolean(latest.force_update),
    latest: publicRelease(latest),
    currentVersion: String(currentVersion || ""),
  };
}

export async function adminListReleases() {
  return (await listReleases()).map(publicRelease);
}

export async function adminPublishRelease(body) {
  const version = String(body.version || "").trim().replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw Object.assign(new Error("Version must look like 1.2.3"), { status: 400 });
  }
  const title = String(body.title || `Hormachuelos ${version}`).trim();
  const whatsNew = String(body.whatsNew || body.whats_new || "").trim();
  if (!whatsNew) {
    throw Object.assign(new Error("What's new is required."), { status: 400 });
  }
  const msiUrl = String(body.msiUrl || body.msi_url || "").trim();
  const exeUrl = String(body.exeUrl || body.exe_url || "").trim();
  if (!msiUrl && !exeUrl) {
    throw Object.assign(new Error("Provide at least one download URL (MSI or EXE)."), { status: 400 });
  }
  const forceUpdate = body.forceUpdate !== false && body.force_update !== false;
  const makeLatest = body.isLatest !== false && body.is_latest !== false;

  if (makeLatest) await clearLatestReleaseFlags();

  const existing = await getReleaseByVersion(version);
  const payload = {
    version,
    title,
    whats_new: whatsNew,
    msi_url: msiUrl || null,
    exe_url: exeUrl || null,
    force_update: forceUpdate,
    is_latest: makeLatest,
    published_at: new Date().toISOString(),
  };

  const row = existing
    ? await updateRelease(existing.id, payload)
    : await insertRelease(payload);

  return publicRelease(row);
}

export async function adminSetForceUpdate(id, forceUpdate) {
  const row = await updateRelease(id, { force_update: Boolean(forceUpdate) });
  return publicRelease(row);
}
