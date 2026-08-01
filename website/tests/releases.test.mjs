import assert from "node:assert/strict";
import test from "node:test";

import {
  builtinLatestRelease,
  effectiveLatestRelease,
} from "../api/_lib/releases.js";

test("bundled v0.1.8 release supersedes an older database release", () => {
  const release = effectiveLatestRelease({
    id: "database-v0.1.5",
    version: "0.1.5",
    title: "Hormachuelos 0.1.5",
    whats_new: "Older release",
    msi_url: "https://example.com/old.msi",
    exe_url: "https://example.com/old.exe",
    force_update: false,
    is_latest: true,
    published_at: "2026-07-31T00:00:00.000Z",
  });
  assert.equal(release.version, "0.1.8");
  assert.match(release.msiUrl, /\/downloads\/Hormachuelos_0\.1\.8_x64_en-US\.msi$/);
});

test("database releases remain authoritative at the same or newer version", () => {
  const release = effectiveLatestRelease({
    id: "database-v0.1.8",
    version: "0.1.8",
    title: "Admin release",
    whats_new: "Admin-managed notes",
    msi_url: "https://example.com/admin.msi",
    exe_url: "https://example.com/admin.exe",
    force_update: true,
    is_latest: true,
    published_at: "2026-08-01T15:00:00.000Z",
  });
  assert.equal(release.id, "database-v0.1.8");
  assert.equal(release.msiUrl, "https://example.com/admin.msi");
});

test("bundled release never exposes a credential", () => {
  const release = builtinLatestRelease();
  assert.equal(release.version, "0.1.8");
  assert.equal(JSON.stringify(release).includes("sk-"), false);
});
