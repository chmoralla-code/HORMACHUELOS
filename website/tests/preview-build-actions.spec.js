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

test("Add tab offers a persistent native Browser with search and navigation controls", async ({ page }) => {
  await page.goto(`${APP}/preview-harness.html`, { waitUntil: "networkidle" });

  await page.getByRole("button", { name: "Add tab" }).click();
  const launcher = page.getByRole("menu", { name: "Add tab" });
  await expect(launcher).toBeVisible();
  await expect(launcher.getByRole("menuitem", { name: /Project preview/ })).toBeVisible();
  await expect(launcher.getByRole("menuitem", { name: /Browser/ })).toContainText(
    "Google or visit YouTube, Facebook",
  );
  await page.screenshot({ path: path.join(OUT, "preview-add-browser-tab-menu.png"), fullPage: true });

  await launcher.getByRole("menuitem", { name: /Browser/ }).click();
  const browserTab = page.locator(".site-preview-tab.is-browser");
  await expect(browserTab).toHaveClass(/is-active/);
  await expect(page.locator(".site-preview")).toHaveClass(/is-browser-tab/);
  await expect(page.getByRole("button", { name: "Google home" })).toBeVisible();
  const address = page.getByRole("textbox", { name: "Preview path" });
  await expect(address).toHaveAttribute("placeholder", /Search Google/);

  await expect.poll(async () => page.evaluate(() =>
    window.__previewBrowserCalls.filter((call) => call.command === "create").length,
  )).toBe(1);
  const created = await page.evaluate(() =>
    window.__previewBrowserCalls.find((call) => call.command === "create"),
  );
  expect(created.url).toBe("https://www.google.com/");
  expect(created.visible).toBe(true);
  expect(created.bounds.width).toBeGreaterThan(100);
  expect(created.bounds.height).toBeGreaterThan(100);

  await address.fill("hormachuelos ai browser");
  await address.press("Enter");
  await expect.poll(async () => page.evaluate(() =>
    window.__previewBrowserCalls.some((call) =>
      call.command === "navigate" && call.url === "https://www.google.com/search?q=hormachuelos%20ai%20browser"
    ),
  )).toBe(true);
  await address.fill("youtube.com");
  await address.press("Enter");
  await address.fill("facebook.com");
  await address.press("Enter");
  await expect.poll(async () => page.evaluate(() => {
    const urls = window.__previewBrowserCalls
      .filter((call) => call.command === "navigate")
      .map((call) => call.url);
    return urls.includes("https://youtube.com/") && urls.includes("https://facebook.com/");
  })).toBe(true);
  const directSites = await page.evaluate(() => window.__previewBrowserCalls
    .filter((call) => call.command === "navigate")
    .map((call) => call.url));
  expect(directSites).toContain("https://youtube.com/");
  expect(directSites).toContain("https://facebook.com/");
  await expect(page.getByRole("button", { name: "Back" })).toBeEnabled();
  await page.getByRole("button", { name: "Back" }).click();
  await page.evaluate(() => {
    const label = window.__previewBrowserCalls.find((call) => call.command === "create").label;
    window.__previewBrowserListener?.({
      label,
      kind: "ready",
      url: "https://youtube.com/",
      title: "YouTube",
    });
  });
  await expect(page.getByRole("button", { name: "Forward" })).toBeEnabled();
  await page.getByRole("button", { name: "Forward" }).click();
  await page.getByRole("button", { name: "Reload preview" }).click();

  await page.locator(".site-preview-tab:not(.is-browser)").click();
  await expect(page.locator(".site-preview")).not.toHaveClass(/is-browser-tab/);
  await expect.poll(async () => page.evaluate(() =>
    window.__previewBrowserCalls.some((call) => call.command === "bounds" && call.visible === false),
  )).toBe(true);
  await browserTab.click();
  await expect(page.locator(".site-preview")).toHaveClass(/is-browser-tab/);
  await page.screenshot({ path: path.join(OUT, "preview-native-browser-tab.png"), fullPage: true });

  await browserTab.locator(".site-preview-tab-close").click();
  await expect(browserTab).toHaveCount(0);
  await expect.poll(async () => page.evaluate(() =>
    window.__previewBrowserCalls.some((call) => call.command === "close"),
  )).toBe(true);
});

test("Browser tabs survive repeated long-session restores without leaking native surfaces", async ({ page }) => {
  await page.goto(`${APP}/preview-harness.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Add tab" }).click();
  await page.getByRole("menuitem", { name: /Browser/ }).click();
  const address = page.getByRole("textbox", { name: "Preview path" });
  await address.fill("youtube.com");
  await address.press("Enter");
  await expect.poll(async () => page.evaluate(() =>
    window.__preview.captureSessionState()?.tabs.some((tab) =>
      tab.kind === "browser" && tab.entryPath === "https://youtube.com/"
    ),
  )).toBe(true);

  const saved = await page.evaluate(() => window.__preview.captureSessionState());
  expect(saved.tabs.at(-1).kind).toBe("browser");
  expect(saved.activeTabIndex).toBe(saved.tabs.length - 1);
  for (let cycle = 0; cycle < 8; cycle += 1) {
    await page.evaluate(async (state) => window.__preview.restoreSessionState(state), saved);
  }

  await expect(page.locator(".site-preview-tab.is-browser")).toHaveCount(1);
  await expect(page.locator(".site-preview-tab.is-browser")).toHaveClass(/is-active/);
  const lifecycle = await page.evaluate(() => ({
    creates: window.__previewBrowserCalls.filter((call) => call.command === "create").length,
    closes: window.__previewBrowserCalls.filter((call) => call.command === "close").length,
    state: window.__preview.captureSessionState(),
  }));
  expect(lifecycle.creates).toBe(9);
  expect(lifecycle.closes).toBeGreaterThanOrEqual(8);
  expect(lifecycle.state.tabs.at(-1).entryPath).toBe("https://youtube.com/");
});

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
  const dispatchStarted = Date.now();
  await page.getByRole("button", { name: "Ask AI", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__previewPromptDispatches?.length || 0)).toBe(1);
  expect(Date.now() - dispatchStarted).toBeLessThan(1000);
  const prompts = await page.evaluate(() => window.__previewPrompts || []);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("specific feature shown in the attached screenshot");
  expect(prompts[0]).toContain("DOM selector: #target");
  expect(prompts[0]).toContain("DOM excerpt: <button id=\"target\">Preview target</button>");
  expect(prompts[0]).toContain("Ranked source candidates (open these first): index.html");
  expect(prompts[0]).toContain("Use the primary color.");
  expect(prompts[0].length).toBeLessThan(5000);
  const dispatches = await page.evaluate(() => window.__previewPromptDispatches || []);
  expect(dispatches[0].taskProfile).toBe("design_edit_fast");
  expect(dispatches[0].imagePath).toContain("design-feature-reference.png");
  await expect(page.locator(".site-preview-status")).toContainText("Fast Design edit");

  const incidentCandidates = await page.evaluate(() =>
    window.__rankDesignSourceCandidates(
      [
        "src/pages/dashboard.tsx",
        "app/pages/incident-reports/page.tsx",
        "src/components/IncidentReportTable.tsx",
        "node_modules/example/pages/incident-reports.tsx",
      ],
      "http://localhost:3000/pages/incident-reports",
    ),
  );
  expect(incidentCandidates[0]).toBe("app/pages/incident-reports/page.tsx");
  expect(incidentCandidates).not.toContain("node_modules/example/pages/incident-reports.tsx");
});

test("Source Lens is a separate mode with source hover and screenshot-only chat", async ({ page }) => {
  await page.route("https://asset.localhost/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: "" }),
  );
  await page.goto(`${APP}/preview-harness.html`, { waitUntil: "networkidle" });

  const design = page.getByRole("button", { name: "Design", exact: true });
  const sourceLens = page.getByRole("button", { name: "Toggle Source Lens" });
  await sourceLens.click();
  await expect(sourceLens).toHaveAttribute("aria-pressed", "true");
  await expect(design).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".site-preview-status")).toContainText("hover to identify code");

  const frame = page.frameLocator(".site-preview-frame");
  const target = frame.getByRole("button", { name: "Preview target" });
  await target.hover();
  const sourceHud = frame.locator(".horma-source-hud");
  await expect(sourceHud).toContainText("Frontend · src/components/PublishButton.tsx:42");
  await expect(sourceHud).toContainText("Style · src/styles/actions.css:18");
  await expect(sourceHud).toContainText("Backend · src/server/routes/publish.ts:27");

  await target.click();
  await expect(frame.locator(".horma-edit-chip")).toContainText("Edit this source");
  await page.getByRole("textbox", { name: "Describe the change" }).fill(
    "Make the button smaller and simpler.",
  );
  await page.getByRole("button", { name: "Ask AI", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__previewPromptDispatches?.length || 0)).toBe(1);

  const request = await page.evaluate(() => window.__previewPromptDispatches[0]);
  expect(request.visibleText).toBe("");
  expect(request.imagePath).toContain("design-feature-reference.png");
  expect(request.prompt).toContain("Resolved frontend source (exact): src/components/PublishButton.tsx:42:7");
  expect(request.prompt).toContain("Resolved style source (strong): src/styles/actions.css:18:1");
  expect(request.prompt).toContain("Resolved backend source (strong): src/server/routes/publish.ts:27:1");
  expect(request.prompt).toContain("do not broadly search the project");
  expect(request.prompt).toContain("Requested change: Make the button smaller and simpler.");

  const privateState = await page.evaluate((previewRequest) => {
    const probe = document.getElementById("chat-queue-probe");
    probe.style.display = "grid";
    probe.style.gridTemplateRows = "minmax(0, 1fr) auto";
    probe.style.height = "560px";
    const chat = document.getElementById("chat");
    chat.classList.add("chat");
    window.__chatQueueSends.length = 0;
    const dispatch = window.__chatQueueProbe.submitPreviewPrompt(previewRequest);
    const submission = window.__chatQueueSends.at(-1);
    window.__chatQueueProbe.startSession(submission.visibleText, submission.modelText);
    return { dispatch, submission, messages: window.__chatQueueProbe.getMessages() };
  }, request);
  expect(privateState.dispatch).toBe("sent");
  expect(privateState.submission.visibleText).toMatch(/^\[Attached image:/);
  expect(privateState.submission.visibleText).not.toContain("Requested change");
  expect(privateState.submission.modelText).toContain("Requested change: Make the button smaller");
  expect(privateState.messages[0].text).toMatch(/^\[Attached image:/);
  expect(privateState.messages[0].agentText).toContain("Resolved backend source");
  await expect(page.locator("#chat-queue-probe .msg.user .msg-attach-thumb")).toBeVisible();
  await expect(page.locator("#chat-queue-probe .msg.user .msg-body")).not.toContainText(
    "Make the button smaller",
  );
  await expect(page.locator("#chat-queue-probe .msg.user .msg-body")).not.toContainText(
    "src/server/routes/publish.ts",
  );
  await expect(page.locator(".site-preview-status")).toContainText("private source context");
});

test("chat shows a Down button when the user leaves the latest message", async ({ page }) => {
  await page.goto(`${APP}/preview-harness.html`, { waitUntil: "networkidle" });
  await page.evaluate(async () => {
    document.getElementById("preview-test-host").style.display = "none";
    const probe = document.getElementById("chat-queue-probe");
    probe.style.display = "grid";
    probe.style.gridTemplateRows = "minmax(0, 1fr) auto";
    probe.style.height = "620px";
    const chat = document.getElementById("chat");
    chat.classList.add("chat");
    chat.style.minHeight = "0";
    window.__chatQueueProbe.loadSession(Array.from({ length: 55 }, (_, index) => ({
      type: "user",
      text: `Long session message ${index + 1}: ${"details ".repeat(18)}`,
      at: Date.now() + index,
    })));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    chat.scrollTop = 0;
    chat.dispatchEvent(new Event("scroll"));
  });

  const down = page.getByRole("button", { name: "Jump to the latest message" });
  await expect(down).toBeVisible();
  await down.click();
  await expect.poll(() => page.evaluate(() => {
    const chat = document.getElementById("chat");
    return chat.scrollHeight - chat.scrollTop - chat.clientHeight;
  })).toBeLessThan(8);
  await expect(down).toBeHidden();
});

test("Source Lens resolves an exact target inside a live localhost preview", async ({ page }) => {
  await page.route("https://asset.localhost/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/plain", body: "" }),
  );
  await page.route("http://localhost:1421/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><style>body{margin:0}button{margin:92px 84px;width:128px;height:52px}</style><button>Publish</button>",
    }),
  );
  await page.goto(`${APP}/preview-harness.html`, { waitUntil: "networkidle" });
  const omnibox = page.getByRole("textbox", { name: "Preview path" });
  await omnibox.fill("http://localhost:1421/dashboard");
  await omnibox.press("Enter");
  await page.getByRole("button", { name: "Toggle Source Lens" }).click();

  const overlay = page.getByTestId("design-visual-overlay");
  const bounds = await overlay.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds.x + 120, bounds.y + 112);
  await expect(page.locator(".site-preview-source-hud")).toContainText(
    "Frontend · src/components/PublishButton.tsx:42",
  );
  const selected = page.getByTestId("design-feature-selection");
  await expect(selected).toHaveCSS("width", "128px");
  await expect(selected).toHaveCSS("height", "52px");

  await page.mouse.down();
  await page.mouse.up();
  await expect(page.locator(".site-preview-status")).toContainText("screenshot ready");
  const captures = await page.evaluate(() => window.__previewCaptureRequests || []);
  expect(captures.at(-1).width).toBe(128);
  expect(captures.at(-1).height).toBe(52);
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
  expect(prompts[0]).toContain("Ranked source candidates (open these first): src/pages/dashboard.tsx");
  expect(prompts[0]).toContain("Make this call to action more prominent.");
  expect(prompts[0]).not.toContain("visual target at approximately");
  const dispatches = await page.evaluate(() => window.__previewPromptDispatches || []);
  expect(dispatches[0].taskProfile).toBe("design_edit_fast");
  const captures = await page.evaluate(() => window.__previewCaptureRequests || []);
  expect(captures).toHaveLength(1);
  expect(captures[0].width).toBeGreaterThan(100);
  expect(captures[0].height).toBeGreaterThan(40);
  await expect(page.locator(".site-preview-status")).toContainText("Fast Design edit + screenshot sent");

  const fatal = consoleErrors.filter((entry) => !/favicon|vite|tauri/i.test(entry));
  expect(fatal, fatal.join("\n")).toEqual([]);
});

test("Design mode keeps broad redesign requests on the fuller bounded profile", async ({ page }) => {
  await page.route("https://asset.localhost/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/plain", body: "" }),
  );
  await page.goto(`${APP}/preview-harness.html`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Design", exact: true }).click();
  const target = page.frameLocator(".site-preview-frame").getByRole("button", { name: "Preview target" });
  await target.click();

  await page.getByRole("textbox", { name: "Describe the change" }).fill(
    "Redesign the entire website and refactor routing across all pages.",
  );
  await page.getByRole("button", { name: "Ask AI", exact: true }).click();

  const dispatches = await page.evaluate(() => window.__previewPromptDispatches || []);
  expect(dispatches).toHaveLength(1);
  expect(dispatches[0].taskProfile).toBe("design_edit");
  expect(dispatches[0].prompt).toContain("Keep inspection bounded to this selected feature");
  await expect(page.locator(".site-preview-status")).toContainText("Design change + screenshot sent");
});

test("a Design edit queued during another run retains its fast task profile", async ({ page }) => {
  await page.route("https://asset.localhost/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/plain", body: "" }),
  );
  await page.goto(`${APP}/preview-harness.html`, { waitUntil: "networkidle" });

  const result = await page.evaluate(async () => {
    window.__chatQueueProbe.setRunning(true);
    const dispatch = window.__chatQueueProbe.submitPreviewPrompt(
      "Apply the selected button color.",
      null,
      "design_edit_fast",
    );
    window.__chatQueueProbe.setRunning(false, { processQueue: true });
    await new Promise((resolve) => queueMicrotask(resolve));
    return { dispatch, sends: window.__chatQueueSends };
  });

  expect(result.dispatch).toBe("queued");
  expect(result.sends).toEqual([
    {
      modelText: "Apply the selected button color.",
      visibleText: "Apply the selected button color.",
      titleHint: "Apply the selected button color.",
      taskProfile: "design_edit_fast",
    },
  ]);
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
