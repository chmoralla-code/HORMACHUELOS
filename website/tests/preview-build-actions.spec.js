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

test("Design mode keeps exact element selection for project-file previews", async ({ page }) => {
  await page.route("https://asset.localhost/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/plain", body: "" }),
  );
  await page.goto(`${APP}/preview-harness.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Design", exact: true }).click();

  const target = page.frameLocator(".site-preview-frame").getByRole("button", { name: "Preview target" });
  await expect(target).toBeVisible();
  await target.click();
  await expect(page.locator("#site-preview-edit-tag")).toHaveText("button");

  const description = page.getByRole("textbox", { name: "Describe the change" });
  await description.fill("Use the primary color.");
  await page.getByRole("button", { name: "Ask AI", exact: true }).click();
  const prompts = await page.evaluate(() => window.__previewPrompts || []);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("specific feature shown in the attached screenshot");
  expect(prompts[0]).toContain("Use the primary color.");
});

test("Design mode outlines and captures a selected cross-origin live-preview feature", async ({ page }) => {
  const consoleErrors = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.route("https://asset.localhost/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/plain", body: "" }),
  );
  // A different localhost port is both accepted by the preview omnibox and
  // cross-origin relative to the Vite shell at :1420.
  await page.route("http://localhost:1421/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><title>Live preview</title>
        <style>
          body { margin: 0; font: 16px system-ui, sans-serif; background: #f7f9ff; }
          main { padding: 92px 84px; }
          button { padding: 16px 28px; border: 0; border-radius: 9px; background: #2d6cdf; color: white; font-weight: 700; }
        </style>
        <main><button>Publish</button></main>`,
    }),
  );

  await page.goto(`${APP}/preview-harness.html`, { waitUntil: "networkidle" });
  const omnibox = page.getByRole("textbox", { name: "Preview path" });
  await omnibox.fill("http://localhost:1421/dashboard");
  await omnibox.press("Enter");
  await expect(page.locator(".site-preview-frame")).toHaveAttribute(
    "src",
    "http://localhost:1421/dashboard",
  );

  await page.getByRole("button", { name: "Design", exact: true }).click();
  const selector = page.getByTestId("design-visual-overlay");
  await expect(selector).toBeVisible();
  await expect(page.locator(".site-preview-status")).toContainText("live preview is isolated");

  const box = await selector.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box.x + 76, box.y + 82);
  await page.mouse.down();
  await page.mouse.move(box.x + 218, box.y + 152, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("design-feature-selection")).toBeVisible();
  await expect(page.locator("#site-preview-edit-tag")).toHaveText("feature");
  await expect(page.locator(".site-preview-visual-design-hint")).toHaveCSS("opacity", "0");
  await expect(page.locator(".site-preview-status")).toContainText("visual reference ready");
  await page.screenshot({ path: path.join(OUT, "preview-design-live-feature-selection.png"), fullPage: true });

  const description = page.getByRole("textbox", { name: "Describe the change" });
  await description.fill("Make this call to action more prominent.");
  await page.getByRole("button", { name: "Ask AI", exact: true }).click();

  const prompts = await page.evaluate(() => window.__previewPrompts || []);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("specific feature shown in the attached screenshot");
  expect(prompts[0]).toContain("localhost:1421/dashboard");
  expect(prompts[0]).toContain("Make this call to action more prominent.");
  expect(prompts[0]).not.toContain("visual target at approximately");
  const captures = await page.evaluate(() => window.__previewCaptureRequests || []);
  expect(captures).toHaveLength(1);
  expect(captures[0].width).toBeGreaterThan(100);
  expect(captures[0].height).toBeGreaterThan(40);
  await expect(page.locator(".site-preview-status")).toContainText("Design change + screenshot sent");

  const fatal = consoleErrors.filter((entry) => !/favicon|vite|tauri/i.test(entry));
  expect(fatal, fatal.join("\n")).toEqual([]);
});

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
