#!/usr/bin/env node
/**
 * ONE-CLICK HORMACHUELOS UPDATE — pushes the latest changes to every client.
 *
 * What it does, in order:
 *   1. Pre-flight checks (cargo, npm, release credentials, live update API).
 *   2. Computes the next version (auto patch-bump, or pass one explicitly).
 *   3. Asks for "What's new" (Enter = auto-generated from recent commits).
 *   4. Builds the release installers (cargo tauri build) — takes a while.
 *   5. Uploads them to Supabase Storage.
 *   6. Publishes the release so the in-app Update button + old clients see it.
 *   7. Commits and pushes everything to GitHub.
 *   8. Verifies the live update API now serves the new version.
 *
 * Usage (from the AI-Forge folder):
 *   node scripts/push-update.mjs            auto patch bump (0.1.77 -> 0.1.78)
 *   node scripts/push-update.mjs 0.2.0      explicit version
 *   node scripts/push-update.mjs -- --no-force       optional update for clients
 *   node scripts/push-update.mjs -- --skip-build     reuse existing installers
 *
 * Extra flags are forwarded to publish-release.mjs.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import readline from "node:readline";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE_URL = "https://hormachuelos.vercel.app";
const IS_WIN = process.platform === "win32";

/** Run a real .exe (git/cargo) with visible output. No shell needed on Windows. */
function runExe(cmd, args) {
  return spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT });
}

/** npm is a .cmd shim on Windows, so it needs the shell. */
function runNpm(args) {
  return spawnSync("npm", args, { stdio: "inherit", shell: true, cwd: ROOT });
}

/** Run a tool and capture its output (no console echo). */
function quiet(cmd, args) {
  return spawnSync(cmd, args, { encoding: "utf8", shell: false, cwd: ROOT });
}

function print(text = "") {
  console.log(text);
}

/** Question helper that works both in the real console (double-clicked .bat)
 *  and with piped input (scripted runs). */
function createAsker() {
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return {
      ask: (question) => new Promise((resolve) => rl.question(question, resolve)),
      close: () => rl.close(),
    };
  }
  // Non-interactive: consume piped lines in order (never blocks, never races).
  const queued = (() => {
    try {
      const lines = readFileSync(0, "utf8").split(/\r?\n/);
      if (lines.length && lines[lines.length - 1] === "") lines.pop(); // trailing final newline
      return lines;
    } catch { return []; }
  })();
  let index = 0;
  let eof = false;
  return {
    ask: async (question) => {
      print(question);
      let answer = "";
      if (index < queued.length) answer = queued[index];
      else eof = true;
      index += 1;
      print(answer);
      return answer;
    },
    eofReached: () => eof,
    close: () => undefined,
  };
}

async function main() {
  print();
  print("=".repeat(64));
  print("  HORMACHUELOS — ONE-CLICK UPDATE RELEASE");
  print("=".repeat(64));

  // ---------- Pre-flight ----------
  const extraArgs = process.argv.slice(2);
  const explicitVersion = extraArgs.find((a) => /^\d+\.\d+\.\d+$/.test(a));
  const passthrough = extraArgs.filter((a) => a !== explicitVersion);

  if (!existsSync(join(ROOT, "package.json")) || !existsSync(join(ROOT, "scripts", "publish-release.mjs"))) {
    print("[X] Run this from the AI-Forge project folder.");
    process.exit(1);
  }
  if (quiet("cargo", ["--version"]).status !== 0) {
    print("[X] Rust/cargo not found in PATH — a release build is not possible.");
    process.exit(1);
  }

  const hasCreds = existsSync(join(ROOT, "website", ".env.release"))
    || Boolean(process.env.SUPABASE_ACCESS_TOKEN)
    || (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!hasCreds) {
    print("[!] No release credentials found (website/.env.release).");
    print("    Upload + publish will fail; only the local build will complete.");
  }

  const current = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  const next = explicitVersion || bumpPatch(current);

  // Git context
  const inRepo = quiet("git", ["rev-parse", "--is-inside-work-tree"]).status === 0;
  const branch = inRepo ? (quiet("git", ["branch", "--show-current"]).stdout || "").trim() : "";
  const hasRemote = inRepo && (quiet("git", ["remote"]).stdout || "").trim().length > 0;

  // Auto notes from recent commits
  let autoNotes = "* Bug fixes and improvements";
  if (inRepo) {
    try {
      const log = quiet("git", ["log", "--pretty=format:* %s", "-6"]).stdout;
      if (log && log.trim()) autoNotes = log.trim();
    } catch {
      /* keep default */
    }
  }

  // What clients currently receive
  let liveVersion = "?";
  let liveForce = false;
  try {
    const res = await fetch(`${SITE_URL}/api/update?current=0.0.0`, { headers: { Accept: "application/json" } });
    const body = await res.json().catch(() => ({}));
    liveVersion = body?.latest?.version || "?";
    liveForce = body?.forceUpdate === true;
  } catch {
    print("[!] Could not reach the update API right now (site may still be fine).");
  }

  print();
  print(`  Clients currently receive : v${liveVersion}${liveForce ? "  (forced)" : ""}`);
  print(`  This project version      : v${current}`);
  print(`  About to release          : v${next}`);
  print(`  Force update              : ${passthrough.includes("--no-force") ? "no - clients choose when to update" : "YES - old clients must update before agents run"}`);
  print(`  Site                      : ${SITE_URL}`);
  print();

  // ---------- Ask for notes ----------
  const prompt = createAsker();
  let notes = "";
  let proceed = false;
  {
    print(`What's new in v${next}? (Enter = auto-generate from recent commits)`);
    notes = (await prompt.ask("> ")).trim();
    if (!notes) {
      print();
      print("Generated What's new:");
      print(autoNotes);
      print();
      const ok = (await prompt.ask("Use these notes? [Y/n]: ")).trim().toLowerCase();
      if (ok === "n" || ok === "no") {
        notes = (await prompt.ask("Type the What's new notes (one line): ")).trim();
      } else {
        notes = autoNotes;
      }
    }
    if (!notes) notes = "* Bug fixes and improvements";
    print();
    print(`What's new:\n${notes}`);
    print();
    print(`Ready: build + upload + publish v${next} to ALL clients.`);
    const confirm = (await prompt.ask("Press ENTER to start now, or type n to cancel: ")).trim().toLowerCase();
    const eofConfirm = confirm === "" && prompt.eofReached();
    if (eofConfirm) print("[!] Input ended before confirmation - cancelled for safety.");
    proceed = confirm !== "n" && confirm !== "no" && !eofConfirm;
  }
  prompt.close();
  if (!proceed) {
    print("Cancelled. Nothing was built or published.");
    return;
  }

  // ---------- Run the release ----------
  const notesFile = join(os.tmpdir(), `hormachuelos-notes-${Date.now()}.txt`);
  writeFileSync(notesFile, notes, "utf8");
  print();
  print(`> npm run release -- ${next} --notes-file "${notesFile}"`);
  print("  (release build can take several minutes - keep this window open)");
  print();
  const release = runNpm(["run", "release", "--", next, "--notes-file", notesFile, ...passthrough]);
  try { rmSync(notesFile, { force: true }); } catch { /* ignore */ }

  if (release.status !== 0) {
    print();
    print("[X] Release failed. Fix the error above and run this file again.");
    print("    (The installers may already be built - the next run is much faster.)");
    process.exit(1);
  }

  // ---------- Commit + push ----------
  if (inRepo) {
    print();
    const doPush = ((await prompt.ask("Release published. Commit and push all changes to GitHub now? [Y/n]: "))
      .trim().toLowerCase()) || "y";
    if (doPush !== "n" && doPush !== "no") {
      runExe("git", ["add", "-A"]);
      if (quiet("git", ["diff", "--cached", "--quiet"]).status !== 0) {
        runExe("git", ["commit", "-m", `Release v${next}`]);
      } else {
        print("Nothing new to commit.");
      }
      if (hasRemote) {
        const pushArgs = branch && branch !== "HEAD"
          ? ["push", "-u", "origin", branch]
          : ["push"];
        const push = runExe("git", pushArgs);
        if (push.status !== 0) {
          print("[!] git push failed - the release IS live for clients, but GitHub is behind.");
        }
      }
    }
  }

  // ---------- Verify ----------
  print();
  let verified = false;
  try {
    const res = await fetch(`${SITE_URL}/api/update?current=0.0.0`, { headers: { Accept: "application/json" } });
    const body = await res.json().catch(() => ({}));
    verified = body?.latest?.version === next;
    if (verified) {
      print(`[OK] Clients now receive v${body.latest.version} (forceUpdate=${body.forceUpdate}).`);
    } else {
      print(`[!] Update API still serves "${body?.latest?.version}" - refresh in a moment or re-check the publish step.`);
    }
  } catch {
    print("[!] Could not verify the update API (network). Check the site manually.");
  }

  print();
  print("=".repeat(64));
  print(`  DONE - v${next} ${verified ? "is live for every installed client" : "processed"}`);
  print(`  Update page : ${SITE_URL}/#/update`);
  print(`  Old clients : open the app > Update button > install v${next}`);
  print("=".repeat(64));
  print();
}

let prompt;

function bumpPatch(version) {
  const parts = String(version || "0.0.0").split(".").map((n) => Number.parseInt(n, 10) || 0);
  parts[2] = (parts[2] || 0) + 1;
  return parts.join(".");
}

main().catch((error) => {
  print(`\n[X] Unexpected error: ${error?.message || error}`);
  process.exit(1);
});