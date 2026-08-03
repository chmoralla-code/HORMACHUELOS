/**
 * Preview build and publishing actions are deliberately tested outside the
 * native backend: this verifies that choosing an action makes one structured
 * prompt and hands it to the same dispatch callback used by the active chat
 * model.
 */
import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "test-results");
const APP = "http://localhost:1420";

test.use({
  baseURL: APP,
  viewport: { width: 1440, height: 900 },
});

test.beforeAll(() => fs.mkdirSync(OUT, { recursive: true }));

test("preview Build chooser and public website action dispatch structured prompts", async ({ page }) => {
  const consoleErrors = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  // The desktop application maps local project assets to this Tauri host. The
  // browser harness has no native asset server, so answer those fixture
  // requests locally instead of accepting connection failures as test noise.
  await page.route("https://asset.localhost/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/plain", body: "" }),
  );

  // Vite serves `src` as its root, so the harness is available directly at
  // `/preview-harness.html` rather than under `/src`.
  await page.goto(`${APP}/preview-harness.html`, { waitUntil: "networkidle" });
  await expect(page.locator(".site-preview")).toHaveClass(/is-open/);

  const buildToggle = page.getByRole("button", { name: "Choose build target" });
  await buildToggle.click();
  const buildMenu = page.getByRole("menu", { name: "Build target" });
  await expect(buildMenu).toBeVisible();
  await expect(buildMenu.getByRole("menuitem", { name: "Build Android APK" })).toBeVisible();
  await expect(buildMenu.getByRole("menuitem", { name: "Build desktop software" })).toBeVisible();
  await page.screenshot({ path: path.join(OUT, "preview-build-menu.png"), fullPage: true });

  await buildMenu.getByRole("menuitem", { name: "Build Android APK" }).click();
  await expect(buildMenu).toBeHidden();
  await expect(page.locator(".site-preview-status")).toContainText("Android APK build request sent");

  await buildToggle.click();
  await buildMenu.getByRole("menuitem", { name: "Build desktop software" }).click();
  await expect(buildMenu).toBeHidden();
  await expect(page.locator(".site-preview-status")).toContainText("Desktop software build request sent");

  const makePublic = page.getByRole("button", { name: "Make the website public" });
  await expect(makePublic).toBeVisible();
  await makePublic.click();
  await expect(page.locator(".site-preview-status")).toContainText("Website publication request sent");

  const prompts = await page.evaluate(() => window.__previewPrompts || []);
  expect(prompts).toHaveLength(3);
  expect(prompts[0]).toContain("Build a production-ready Android APK");
  expect(prompts[0]).toContain("Project root: C:\\preview-fixture");
  expect(prompts[0]).toContain("Preview entry: index.html");
  expect(prompts[0]).toContain("Do not ask me to type Continue.");
  expect(prompts[1]).toContain("Build a production-ready desktop software");
  expect(prompts[1]).toContain("desktop executable");
  expect(prompts[2]).toContain("production public website now");
  expect(prompts[2]).toContain("GitHub → Vercel → Supabase");
  expect(prompts[2]).toContain("secure in-app connection flow");
  expect(prompts[2]).toContain("Never ask for or print credentials in chat");
  expect(prompts[2]).toContain("Do not claim the website is public until the live URL has been verified");

  await page.screenshot({ path: path.join(OUT, "preview-build-actions.png"), fullPage: true });
  const fatal = consoleErrors.filter((entry) => !/favicon|vite|tauri/i.test(entry));
  expect(fatal, fatal.join("\n")).toEqual([]);
});
