import { test, expect } from "@playwright/test";

const APP = "http://localhost:1420";

test.use({
  baseURL: APP,
  viewport: { width: 1280, height: 900 },
});

test("the in-app updater downloads once and automatically restarts", async ({ page }) => {
  const consoleErrors = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.goto(`${APP}/update-harness.html`, { waitUntil: "networkidle" });

  await page.getByRole("button", { name: /Update available: v0\.1\.5/i }).click();
  const dialog = page.getByRole("dialog", { name: "Update available" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Download v0.1.5 and restart" })).toHaveCount(1);
  await expect(dialog.getByRole("button", { name: /Install|Open|Run/i })).toHaveCount(0);

  await dialog.getByRole("button", { name: "Download v0.1.5 and restart" }).click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-installed-url",
    "https://hormachuelos.vercel.app/downloads/Hormachuelos_0.1.5_x64_en-US.msi",
  );
  await expect(page.locator("body")).toHaveAttribute("data-installed-version", "0.1.5");
  await expect(page.locator("body")).toHaveAttribute(
    "data-installed-sha256",
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  );
  await expect(dialog.locator(".update-install-status")).toHaveText("Restarting Hormachuelos…");
  await expect(dialog).not.toContainText("Installer is ready");
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
  const install = dialog.getByRole("button", { name: "Download v0.1.5 and restart" });
  await install.click();

  await expect(dialog.locator(".update-install-status")).toHaveText(
    "Update failed: Windows administrator approval was not granted.",
  );
  await expect(install).toBeEnabled();
  await expect(page.locator("body")).not.toHaveAttribute("data-installed-version", /.+/);
});
