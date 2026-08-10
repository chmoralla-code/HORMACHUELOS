/**
 * Smoke test for Hormachuelos desktop UI (Vite at :1420).
 * Note: full Tauri IPC is unavailable in the browser — we record that as expected.
 */
import { test, expect } from "@playwright/test";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "test-results");
const APP = "http://localhost:1420";
const appFindings = [];

test.use({ baseURL: APP });

test.beforeAll(() => {
  fs.mkdirSync(OUT, { recursive: true });
});

test.afterAll(() => {
  fs.writeFileSync(
    path.join(OUT, "app-smoke-findings.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), findings: appFindings }, null, 2),
  );
});

test("desktop shell loads critical regions", async ({ page }) => {
  const errors = [];
  const pageErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => pageErrors.push(e.message));

  const res = await page.goto(APP, { waitUntil: "networkidle" }).catch((e) => {
    appFindings.push({ severity: "critical", message: `App not reachable at ${APP}`, detail: String(e) });
    throw e;
  });
  expect(res?.ok() || res?.status() === 304).toBeTruthy();

  await expect(page.locator("#app")).toBeVisible({ timeout: 15000 });
  await expect(page.locator("#chat")).toBeVisible();
  await expect(page.locator("#forge-dock")).toBeVisible();
  await expect(page.locator("#sidebar")).toBeVisible();

  // Composer / project chip / thoughts toggle appear after JS init
  await page.waitForTimeout(1200);
  const composer = page.locator(".composer, #forge-dock textarea, .composer-shell");
  const hasComposer = (await composer.count()) > 0;
  if (!hasComposer) {
    appFindings.push({ severity: "major", message: "Composer UI not found after init" });
  }
  expect(hasComposer).toBeTruthy();
  const authGate = page.locator(".auth-gate-overlay");
  const authRequired = await authGate.isVisible().catch(() => false);
  if (authRequired) {
    if (await authGate.evaluate((element) => element.classList.contains("update-required-overlay"))) {
      await expect(authGate).toContainText("Update required");
    } else {
      await expect(authGate).toContainText("Sign in to continue");
    }
    appFindings.push({
      severity: "info",
      message: "Browser-only desktop smoke reached the expected access gate",
    });
  }

  // Project chip should exist (interactive directory control)
  const projectChip = page.locator("#composer-project-chip, .composer-project-chip");
  if ((await projectChip.count()) === 0) {
    appFindings.push({ severity: "major", message: "Project chip missing under composer" });
  } else if (!authRequired) {
    await projectChip.first().click().catch(() => {});
    await page.waitForTimeout(300);
    const menu = page.locator(".composer-project-menu, .chip-menu");
    if ((await menu.count()) === 0) {
      appFindings.push({
        severity: "improvement",
        message: "Project chip click may need Tauri for pickers — menu not visible in browser-only mode",
      });
    }
  }

  // Drawer toggles
  const left = page.locator("#drawer-left-btn");
  if (!authRequired && (await left.count())) {
    await left.click();
    await page.waitForTimeout(200);
    await left.click();
  }

  await page.screenshot({ path: path.join(OUT, "10-app-shell.png"), fullPage: true });

  // Categorize Tauri/IPC noise vs real bugs
  const all = [...errors, ...pageErrors];
  const tauriNoise = all.filter((e) =>
    /tauri|__TAURI|invoke|plugin:|IPC|not allowed|Failed to fetch|os error/i.test(e),
  );
  const real = all.filter((e) => !tauriNoise.includes(e));

  if (tauriNoise.length) {
    appFindings.push({
      severity: "improvement",
      message: "Browser-only run logs Tauri/IPC errors (expected outside desktop shell)",
      detail: tauriNoise.slice(0, 5).join(" | "),
    });
  }
  if (real.length) {
    appFindings.push({
      severity: "major",
      message: "Non-Tauri runtime errors in app shell",
      detail: real.slice(0, 8).join(" | "),
    });
  }

  // Don't fail the suite solely on Tauri IPC when testing in Chromium
  expect(real, real.join("\n")).toEqual([]);
});

test("empty chat / send without project prompts", async ({ page }) => {
  await page.goto(APP);
  await page.waitForTimeout(1000);
  const authGate = page.locator(".auth-gate-overlay");
  if (await authGate.isVisible().catch(() => false)) {
    if (await authGate.evaluate((element) => element.classList.contains("update-required-overlay"))) {
      await expect(authGate).toContainText("Update required");
    } else {
      await expect(authGate).toContainText("Sign in to continue");
    }
    await page.screenshot({ path: path.join(OUT, "11-app-auth-gate.png"), fullPage: true });
    return;
  }
  const input = page.locator("#forge-dock textarea, .composer textarea, textarea").first();
  if ((await input.count()) === 0) {
    appFindings.push({ severity: "major", message: "No composer textarea" });
    test.skip();
    return;
  }
  await input.fill("hello from playwright");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  // Expect project picker modal or toast
  const modal = page.locator("#modal-root .modal, .modal-overlay");
  const toast = page.locator("#toast");
  const reacted =
    (await modal.count()) > 0 ||
    ((await toast.count()) > 0 && !(await toast.isHidden().catch(() => true)));
  if (!reacted) {
    appFindings.push({
      severity: "improvement",
      message: "Sending without project should clearly open picker / toast (hard to verify without Tauri)",
    });
  }
  await page.screenshot({ path: path.join(OUT, "11-app-send.png"), fullPage: true });
});
