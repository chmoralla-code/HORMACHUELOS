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
    msiSha256: row.msi_sha256 || "",
    exeSha256: row.exe_sha256 || "",
    forceUpdate: Boolean(row.force_update),
    isLatest: Boolean(row.is_latest),
    publishedAt: row.published_at,
  };
}

const BUILTIN_RELEASE_VERSION = "0.1.67";
const BUILTIN_MSI_SHA256 = "d9c3ac278f05c2ac83519666653bbe8d81d7e8a8c6b45dc01a64f902db362853";
const BUILTIN_EXE_SHA256 = "87a8e7519d2b5e0dcd1b9388ae85ab31dd0a1687272523b36fee3acd11b736b4";
const BUILTIN_RELEASE_NOTES = "Project list cleanup: remove any remembered project with a focused row action and clear confirmation. Removing a project only forgets its shortcut—its folder, files, Git history, and saved sessions stay untouched. Active projects switch safely, running-agent projects are protected, and removals persist after restart.";

const BUILTIN_FORCE_UPDATE = true;
const GITHUB_RELEASES_BASE = "https://github.com/chmoralla-code/HORMACHUELOS/releases/download";

/**
 * A deployment-bundled release keeps the download/update path available even
 * when the release database cannot yet be updated from the publishing machine.
 * A database release with the same or newer version always remains authoritative.
 */
export function builtinLatestRelease() {
  // This release is bundled with the website as a verified fallback. Normal
  // admin-published releases still win at the same version. GitHub Release
  // assets keep the fallback independently downloadable when Storage is
  // temporarily unavailable during a release.
  const downloadBase = `${GITHUB_RELEASES_BASE}/v${BUILTIN_RELEASE_VERSION}`;
  return {
    id: `builtin-${BUILTIN_RELEASE_VERSION}`,
    version: BUILTIN_RELEASE_VERSION,
    title: `Hormachuelos ${BUILTIN_RELEASE_VERSION}`,
    whatsNew: BUILTIN_RELEASE_NOTES,
    msiUrl: `${downloadBase}/Hormachuelos_${BUILTIN_RELEASE_VERSION}_x64_en-US.msi`,
    exeUrl: `${downloadBase}/Hormachuelos_${BUILTIN_RELEASE_VERSION}_x64-setup.exe`,
    msiSha256: BUILTIN_MSI_SHA256,
    exeSha256: BUILTIN_EXE_SHA256,
    forceUpdate: BUILTIN_FORCE_UPDATE,
    isLatest: true,
    publishedAt: "2026-08-02T00:00:00.000Z",
  };
}

export function effectiveLatestRelease(row) {
  const databaseRelease = publicRelease(row);
  const bundledRelease = builtinLatestRelease();
  return databaseRelease && cmpSemver(databaseRelease.version, bundledRelease.version) >= 0
    ? databaseRelease
    : bundledRelease;
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
  return effectiveLatestRelease(await getLatestRelease());
}

export async function checkUpdate(currentVersion) {
  const latest = effectiveLatestRelease(await getLatestRelease());
  const outdated = cmpSemver(latest.version, currentVersion) > 0;
  return {
    updateAvailable: outdated,
    forceUpdate: outdated && Boolean(latest.forceUpdate),
    latest,
    currentVersion: String(currentVersion || ""),
  };
}

export async function adminListReleases() {
  return (await listReleases()).map(publicRelease);
}

export async function adminPublishRelease(body) {
  const version = String(body.version || "").trim().replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
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
  const msiSha256 = String(body.msiSha256 || body.msi_sha256 || "").trim().toLowerCase();
  const exeSha256 = String(body.exeSha256 || body.exe_sha256 || "").trim().toLowerCase();
  const validSha256 = (value) => /^[a-f0-9]{64}$/.test(value);
  if ((msiUrl && !validSha256(msiSha256)) || (exeUrl && !validSha256(exeSha256))) {
    throw Object.assign(new Error("Every installer URL requires a valid SHA-256 checksum."), {
      status: 400,
    });
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
    msi_sha256: msiUrl ? msiSha256 : null,
    exe_sha256: exeUrl ? exeSha256 : null,
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
