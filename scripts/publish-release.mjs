#!/usr/bin/env node
/**
 * Build Hormachuelos installers, upload to Supabase Storage, and publish
 * a software update (What's new + optional force-update) on the website.
 *
 * Usage:
 *   npm run release -- 0.1.1 --notes "Bug fixes and improvements"
 *   npm run release -- 0.1.1 --notes-file notes.txt --force
 *   npm run release -- 0.1.1 --notes "..." --skip-build
 *
 * Env (required for upload/publish):
 *   SUPABASE_ACCESS_TOKEN  — Supabase personal access token (preferred)
 *   or SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *   ADMIN_USERNAME / ADMIN_PASSWORD — website admin (default admin / admin123)
 *
 * Optional:
 *   SITE_URL               — default https://hormachuelos.vercel.app
 *   SUPABASE_PROJECT_REF   — default mketkzycxmtvgdbwzsvh
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Local release credentials are deliberately ignored by Git.  Load them when
 * present so `npm run release` works from this checkout without echoing any
 * credential values, while explicit process environment values still win.
 */
function cleanEnvValue(value) {
  let result = String(value || "").trim();
  if (
    (result.startsWith('"') && result.endsWith('"')) ||
    (result.startsWith("'") && result.endsWith("'"))
  ) {
    result = result.slice(1, -1);
  }
  return result;
}

function loadLocalReleaseEnv(path) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const key = match[1];
    if (cleanEnvValue(process.env[key])) continue;
    const value = cleanEnvValue(match[2]);
    if (value) process.env[key] = value;
  }
}

loadLocalReleaseEnv(join(ROOT, "website", ".env.release"));

const SITE_URL = (process.env.SITE_URL || "https://hormachuelos.vercel.app").replace(/\/$/, "");
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || "mketkzycxmtvgdbwzsvh";
const ASSET_PUBLIC = `https://${PROJECT_REF}.supabase.co/storage/v1/object/public/public-assets`;
const BUCKET = "public-assets";

function die(msg) {
  console.error(`\nERROR: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {
    version: "",
    notes: "",
    notesFile: "",
    title: "",
    force: true,
    skipBuild: false,
    skipUpload: false,
    skipPublish: false,
  };
  const args = [...argv];
  while (args.length) {
    const a = args.shift();
    if (!a) break;
    if (a === "--notes" || a === "-n") out.notes = args.shift() || "";
    else if (a === "--notes-file") out.notesFile = args.shift() || "";
    else if (a === "--title" || a === "-t") out.title = args.shift() || "";
    else if (a === "--force") out.force = true;
    else if (a === "--no-force") out.force = false;
    else if (a === "--skip-build") out.skipBuild = true;
    else if (a === "--skip-upload") out.skipUpload = true;
    else if (a === "--skip-publish") out.skipPublish = true;
    else if (a === "--help" || a === "-h") {
      console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace("/**", "").trim());
      process.exit(0);
    } else if (!a.startsWith("-") && !out.version) out.version = a.replace(/^v/i, "");
    else die(`Unknown argument: ${a}`);
  }
  return out;
}

function run(cmd, args, opts = {}) {
  console.log(`\n> ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
    ...opts,
  });
  if (r.status !== 0) die(`Command failed (${r.status}): ${cmd}`);
}

function setJsonVersion(path, version) {
  const j = JSON.parse(readFileSync(path, "utf8"));
  j.version = version;
  writeFileSync(path, `${JSON.stringify(j, null, 2)}\n`);
  console.log(`updated ${path}`);
}

function setLockfileVersion(path, version) {
  if (!existsSync(path)) return;
  const lock = JSON.parse(readFileSync(path, "utf8"));
  lock.version = version;
  if (lock.packages?.[""]) lock.packages[""].version = version;
  writeFileSync(path, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`updated ${path}`);
}

function setCargoVersion(path, version) {
  let text = readFileSync(path, "utf8");
  if (!/^version\s*=\s*"/m.test(text)) die(`No version field in ${path}`);
  text = text.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`);
  writeFileSync(path, text);
  console.log(`updated ${path}`);
}

function bumpVersions(version, notes = "") {
  setJsonVersion(join(ROOT, "package.json"), version);
  setLockfileVersion(join(ROOT, "package-lock.json"), version);
  setJsonVersion(join(ROOT, "src-tauri", "tauri.conf.json"), version);
  setCargoVersion(join(ROOT, "src-tauri", "Cargo.toml"), version);
  const webPkg = join(ROOT, "website", "package.json");
  if (existsSync(webPkg)) setJsonVersion(webPkg, version);
  setLockfileVersion(join(ROOT, "website", "package-lock.json"), version);

  // Fallback download labels on the marketing site (API latest release is preferred).
  // Installers are hosted on Supabase Storage; the static /downloads files are
  // excluded from Vercel deploys, so the fallback URLs point at Storage.
  const appJs = join(ROOT, "website", "js", "app.js");
  if (existsSync(appJs)) {
    let src = readFileSync(appJs, "utf8");
    src = src.replace(
      /(const DESKTOP_DOWNLOADS = \{\s*version:\s*")[^"]+(")/,
      `$1${version}$2`,
    );
    src = src.replace(/Hormachuelos_\d+\.\d+\.\d+_x64_en-US\.msi/g, `Hormachuelos_${version}_x64_en-US.msi`);
    src = src.replace(/Hormachuelos_\d+\.\d+\.\d+_x64-setup\.exe/g, `Hormachuelos_${version}_x64-setup.exe`);
    writeFileSync(appJs, src);
    console.log(`updated ${appJs}`);
  }

  // Keep the website's no-database fallback aligned with the installers that
  // this release publishes. This makes the update and download paths work even
  // while the release database is temporarily unreachable.
  const releasesJs = join(ROOT, "website", "api", "_lib", "releases.js");
  if (existsSync(releasesJs)) {
    let src = readFileSync(releasesJs, "utf8");
    src = src.replace(
      /const BUILTIN_RELEASE_VERSION = "[^"]+";/,
      `const BUILTIN_RELEASE_VERSION = "${version}";`,
    );
    if (notes.trim()) {
      src = src.replace(
        /const BUILTIN_RELEASE_NOTES\s*=\s*"[^"]*";/,
        `const BUILTIN_RELEASE_NOTES = ${JSON.stringify(notes.trim())};`,
      );
    }
    writeFileSync(releasesJs, src);
    console.log(`updated ${releasesJs}`);
  }

  // The installers are intentionally excluded from ordinary deployments. Add
  // just this release's two files back so the bundled fallback URLs remain
  // usable as well as the primary Supabase download URLs.
  const vercelIgnore = join(ROOT, "website", ".vercelignore");
  if (existsSync(vercelIgnore)) {
    let src = readFileSync(vercelIgnore, "utf8");
    src = src.replace(
      /!downloads\/Hormachuelos_\d+\.\d+\.\d+_x64_en-US\.msi/g,
      `!downloads/Hormachuelos_${version}_x64_en-US.msi`,
    );
    src = src.replace(
      /!downloads\/Hormachuelos_\d+\.\d+\.\d+_x64-setup\.exe/g,
      `!downloads/Hormachuelos_${version}_x64-setup.exe`,
    );
    writeFileSync(vercelIgnore, src);
    console.log(`updated ${vercelIgnore}`);
  }
}

function installerPaths(version) {
  const msiName = `Hormachuelos_${version}_x64_en-US.msi`;
  const exeName = `Hormachuelos_${version}_x64-setup.exe`;
  const msi = join(ROOT, "src-tauri", "target", "release", "bundle", "msi", msiName);
  const exe = join(ROOT, "src-tauri", "target", "release", "bundle", "nsis", exeName);
  return { msiName, exeName, msi, exe };
}

function sha256File(path) {
  if (!existsSync(path)) die(`Missing installer: ${path}`);
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function updateBundledReleaseHashes(msiSha256, exeSha256) {
  const releasesJs = join(ROOT, "website", "api", "_lib", "releases.js");
  if (!existsSync(releasesJs)) return;
  let src = readFileSync(releasesJs, "utf8");
  src = src.replace(
    /const BUILTIN_MSI_SHA256 = "[a-f0-9]{64}";/,
    `const BUILTIN_MSI_SHA256 = "${msiSha256}";`,
  );
  src = src.replace(
    /const BUILTIN_EXE_SHA256 = "[a-f0-9]{64}";/,
    `const BUILTIN_EXE_SHA256 = "${exeSha256}";`,
  );
  writeFileSync(releasesJs, src);
  console.log(`updated installer checksums in ${releasesJs}`);
}

async function resolveServiceKey() {
  const configuredUrl = cleanEnvValue(
    process.env.SUPABASE_URL || process.env.HORMACHUELOS_SUPABASE_URL,
  ) || `https://${PROJECT_REF}.supabase.co`;
  const configuredService =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.HORMACHUELOS_SERVICE_ROLE;
  if (configuredService && configuredUrl) {
    return {
      url: configuredUrl.replace(/\/$/, ""),
      service: configuredService,
    };
  }
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) {
    die(
      "Set SUPABASE_ACCESS_TOKEN or the configured Supabase URL/service-role environment variables to upload installers.",
    );
  }
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/api-keys`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const keys = await res.json().catch(() => []);
  if (!res.ok) die(`Failed to fetch Supabase API keys (${res.status})`);
  const service = (Array.isArray(keys) ? keys : []).find((k) => k.name === "service_role")?.api_key;
  if (!service) die("service_role key not found for Supabase project");
  return { url: `https://${PROJECT_REF}.supabase.co`, service };
}

async function uploadFile(url, service, localPath, objectPath) {
  if (!existsSync(localPath)) die(`Missing installer: ${localPath}`);
  const bytes = readFileSync(localPath);
  const uri = `${url}/storage/v1/object/${BUCKET}/${objectPath}`;
  console.log(`Uploading ${objectPath} (${(bytes.length / 1024 / 1024).toFixed(1)} MB)...`);
  const res = await fetch(uri, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${service}`,
      apikey: service,
      "Content-Type": "application/octet-stream",
      "x-upsert": "true",
    },
    body: bytes,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    die(`Upload failed ${objectPath}: ${res.status} ${text}`);
  }
  console.log(`OK ${ASSET_PUBLIC}/${objectPath}`);
}

async function assertChecksumAwareReleaseApi() {
  const response = await fetch(`${SITE_URL}/api/update?current=0.0.0`, {
    headers: { Accept: "application/json" },
  });
  const body = await response.json().catch(() => ({}));
  const latest = body?.latest;
  const hasChecksumFields = latest
    && Object.prototype.hasOwnProperty.call(latest, "msiSha256")
    && Object.prototype.hasOwnProperty.call(latest, "exeSha256");
  if (!response.ok || !hasChecksumFields) {
    die(
      "The live website API does not support installer checksums yet. Deploy the checksum-aware API and apply the release checksum migration before publishing.",
    );
  }
}

async function publishRelease({
  version,
  title,
  notes,
  force,
  msiUrl,
  exeUrl,
  msiSha256,
  exeSha256,
}) {
  const username = process.env.ADMIN_USERNAME || "admin";
  const password = process.env.ADMIN_PASSWORD || "admin123";
  const login = await fetch(`${SITE_URL}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const loginBody = await login.json().catch(() => ({}));
  if (!login.ok) die(`Admin login failed: ${loginBody.error || login.status}`);

  const pub = await fetch(`${SITE_URL}/api/admin/releases`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${loginBody.token}`,
    },
    body: JSON.stringify({
      version,
      title: title || `Hormachuelos ${version}`,
      whatsNew: notes,
      msiUrl,
      exeUrl,
      msiSha256,
      exeSha256,
      forceUpdate: force,
      isLatest: true,
    }),
  });
  const pubBody = await pub.json().catch(() => ({}));
  if (!pub.ok) die(`Publish failed: ${pubBody.error || pub.status}`);
  const release = pubBody.release || {};
  if (
    String(release.msiSha256 || "").toLowerCase() !== msiSha256
    || String(release.exeSha256 || "").toLowerCase() !== exeSha256
  ) {
    die("The release API did not persist the installer checksums. The release is not safe to announce.");
  }
  console.log(`Published release v${version} (force=${force})`);
  console.log(`Update page: ${SITE_URL}/#/update`);
  return release;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!/^\d+\.\d+\.\d+$/.test(opts.version)) {
    die('Pass a version like: npm run release -- 0.1.1 --notes "What\'s new"');
  }
  if (opts.notesFile) {
    const p = opts.notesFile.startsWith("/") || /^[A-Za-z]:/.test(opts.notesFile)
      ? opts.notesFile
      : join(ROOT, opts.notesFile);
    opts.notes = readFileSync(p, "utf8").trim();
  }
  if (!opts.notes.trim()) {
    die("Provide --notes \"...\" or --notes-file path (What's new is required).");
  }

  console.log(`\nHormachuelos release → v${opts.version}`);
  console.log(`Force update: ${opts.force}`);
  console.log(`Site: ${SITE_URL}`);

  if (!opts.skipPublish) await assertChecksumAwareReleaseApi();

  bumpVersions(opts.version, opts.notes);

  if (!opts.skipBuild) {
    run("npm", ["run", "desktop:build"]);
  } else {
    console.log("Skipping build (--skip-build)");
  }

  const paths = installerPaths(opts.version);
  const msiSha256 = sha256File(paths.msi);
  const exeSha256 = sha256File(paths.exe);
  updateBundledReleaseHashes(msiSha256, exeSha256);
  const downloadsDir = join(ROOT, "website", "downloads");
  mkdirSync(downloadsDir, { recursive: true });
  if (existsSync(paths.msi)) copyFileSync(paths.msi, join(downloadsDir, paths.msiName));
  if (existsSync(paths.exe)) copyFileSync(paths.exe, join(downloadsDir, paths.exeName));

  const msiUrl = `${ASSET_PUBLIC}/downloads/${paths.msiName}`;
  const exeUrl = `${ASSET_PUBLIC}/downloads/${paths.exeName}`;

  if (!opts.skipUpload) {
    const { url, service } = await resolveServiceKey();
    await uploadFile(url, service, paths.msi, `downloads/${paths.msiName}`);
    await uploadFile(url, service, paths.exe, `downloads/${paths.exeName}`);
  } else {
    console.log("Skipping upload (--skip-upload)");
  }

  if (!opts.skipPublish) {
    await publishRelease({
      version: opts.version,
      title: opts.title,
      notes: opts.notes,
      force: opts.force,
      msiUrl,
      exeUrl,
      msiSha256,
      exeSha256,
    });
  } else {
    console.log("Skipping publish (--skip-publish)");
  }

  console.log("\nDone.");
}

main().catch((e) => die(String(e?.stack || e)));
