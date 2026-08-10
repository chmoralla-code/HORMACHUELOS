import { test, expect } from "@playwright/test";

const APP = "http://localhost:1420";

test.use({
  baseURL: APP,
  viewport: { width: 1280, height: 900 },
});

test("the in-app updater presents every secure installation stage and automatically restarts", async ({ page }) => {
  const consoleErrors = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.goto(`${APP}/update-harness.html`, { waitUntil: "networkidle" });
  await page.evaluate(() => {
    window.__manualInstallProgress = true;
  });

  await page.getByRole("button", { name: /Update available: v0\.1\.5/i }).click();
  const dialog = page.getByRole("dialog", { name: "Update available" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Install v0.1.5" })).toHaveCount(1);
  await expect(dialog.getByRole("button", { name: /Open|Run/i })).toHaveCount(0);
  await expect(dialog.locator(".update-preflight-item")).toHaveCount(2);
  await expect(dialog).toContainText("Local workspace protected");
  await expect(dialog).toContainText("SHA-256 verification");

  const overlay = page.locator(".update-dialog-overlay");
  await dialog.getByRole("button", { name: "Install v0.1.5" }).click();
  const progress = overlay.locator(".update-install-progress");
  const meter = progress.getByRole("progressbar", { name: "Update installation progress" });
  const steps = progress.locator(".update-install-step");

  await expect(overlay).toHaveClass(/is-installing/);
  await expect(overlay.getByRole("heading", { name: "Installing v0.1.5" })).toBeVisible();
  await expect(progress).toBeVisible();
  await expect(progress.locator(".update-install-status")).toHaveText("Securing your workspace…");
  await expect(steps).toHaveCount(4);
  await expect(steps).toHaveText(["1Download", "2Verify", "3Install", "4Relaunch"]);

  await page.evaluate(() => {
    window.__emitInstallProgress({
      phase: "downloading",
      percent: 46,
      message: "Downloading update",
    });
  });
  await expect(progress).toHaveAttribute("data-phase", "downloading");
  await expect(progress.locator(".update-install-status")).toHaveText("Downloading update 46%…");
  await expect(progress.locator(".update-install-percent")).toHaveText("46%");
  await expect(meter).toHaveAttribute("aria-valuenow", "46");
  await expect(steps.nth(0)).toHaveClass(/is-active/);

  await page.evaluate(() => {
    window.__emitInstallProgress({
      phase: "verifying",
      message: "Verifying the downloaded installer",
    });
  });
  await expect(progress).toHaveAttribute("data-phase", "verifying");
  await expect(progress.locator(".update-install-status")).toHaveText("Verifying secure package…");
  await expect(steps.nth(0)).toHaveClass(/is-complete/);
  await expect(steps.nth(1)).toHaveClass(/is-active/);

  await page.evaluate(() => {
    window.__emitInstallProgress({
      phase: "installing",
      message: "Waiting for Windows administrator approval",
    });
  });
  await expect(progress).toHaveAttribute("data-phase", "installing");
  await expect(progress.locator(".update-install-status")).toHaveText(
    "Approve the Windows administrator prompt…",
  );
  await expect(steps.nth(1)).toHaveClass(/is-complete/);
  await expect(steps.nth(2)).toHaveClass(/is-active/);

  await page.evaluate(() => window.__finishInstall());
  await expect(page.locator("body")).toHaveAttribute(
    "data-installed-url",
    "https://hormachuelos.vercel.app/downloads/Hormachuelos_0.1.5_x64_en-US.msi",
  );
  await expect(page.locator("body")).toHaveAttribute("data-installed-version", "0.1.5");
  await expect(page.locator("body")).toHaveAttribute(
    "data-installed-sha256",
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  );
  await expect(progress).toHaveAttribute("data-phase", "restarting");
  await expect(progress.locator(".update-install-status")).toHaveText("Relaunching Hormachuelos…");
  await expect(progress.locator(".update-install-percent")).toHaveText("100%");
  await expect(meter).toHaveAttribute("aria-valuenow", "100");
  await expect(steps.nth(2)).toHaveClass(/is-complete/);
  await expect(steps.nth(3)).toHaveClass(/is-active/);
  await expect(overlay).not.toContainText("Installer is ready");
  await expect(page.locator("body")).not.toHaveAttribute("data-opened-url", /.+/);

  const fatal = consoleErrors.filter((entry) => !/favicon|vite/i.test(entry));
  expect(fatal, fatal.join("\n")).toEqual([]);
});

test("the updater keeps the app open and explains a Windows approval failure", async ({ page }) => {
  await page.goto(`${APP}/update-harness.html`, { waitUntil: "networkidle" });
  await page.evaluate(() => {
    window.__installError = "Windows administrator approval was not granted.";
  });

  await page.getByRole("button", { name: /Update available: v0\.1\.5/i }).click();
  const dialog = page.getByRole("dialog", { name: "Update available" });
  const overlay = page.locator(".update-dialog-overlay");
  const install = dialog.getByRole("button", { name: "Install v0.1.5" });
  await install.click();

  const progress = overlay.locator(".update-install-progress");
  await expect(overlay.getByRole("heading", { name: "Update paused" })).toBeVisible();
  await expect(progress).toHaveClass(/is-error/);
  await expect(progress.locator(".update-install-status")).toHaveText(
    "Update failed: Windows administrator approval was not granted.",
  );
  await expect(progress).toContainText("Your current installation is untouched");
  await expect(overlay.getByRole("button", { name: "Try installation again" })).toBeEnabled();
  await expect(page.locator("body")).not.toHaveAttribute("data-installed-version", /.+/);
});
