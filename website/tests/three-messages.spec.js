/**
 * Send 3 chat messages through Hormachuelos UI with a Tauri IPC mock
 * that simulates agent replies (real LLM not required).
 */
import { test, expect } from "@playwright/test";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "test-results");
const APP = "http://localhost:1420";

const MESSAGES = [
  "Hello — this is message one. What can you do?",
  "Message two: list the files in this project briefly.",
  "Message three: reply with a short goodbye.",
];

test.use({
  baseURL: APP,
  viewport: { width: 1400, height: 900 },
});

test.beforeAll(() => {
  fs.mkdirSync(OUT, { recursive: true });
});

/** Install Tauri mock before any page script runs. */
async function installMock(page) {
  await page.addInitScript(() => {
    const callbacks = new Map();
    const eventHandlers = new Map(); // event -> callback ids
    let projectRoot = null;
    const quickSessionRoot = "C:\\\\Users\\\\Cyrhiel\\\\AppData\\\\Local\\\\AI-Forge\\\\Quick Sessions";

    const settings = {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      base_url: "https://api.deepseek.com",
      max_iterations: 10,
      command_timeout_secs: 60,
      auto_approve: true,
      permission_mode: "auto",
      flavour_enabled: true,
    };

    const defaultLicense = {
      plan: "pro",
      active: true,
      hosted: true,
      licenseKey: "HORMA-MOCK-PLAN",
      tokenBudget: 1_000_000,
      tokensUsed: 10_000,
      blockedBy: "",
      topUpUrl: "https://hormachuelos.vercel.app/#/pricing",
      message: "Pro plan active.",
    };
    function licenseSnapshot() {
      return { ...defaultLicense, ...(window.__HORMA_LICENSE_FIXTURE__ || {}) };
    }

    let tree = {
      nodes: [
        {
          name: "src",
          path: "src",
          isDir: true,
          size: 0,
          modifiedMs: Date.now(),
          truncated: false,
          children: [
            {
              name: "main.ts",
              path: "src/main.ts",
              isDir: false,
              size: 100,
              modifiedMs: Date.now(),
              truncated: false,
              children: [],
            },
          ],
        },
        {
          name: "README.md",
          path: "README.md",
          isDir: false,
          size: 50,
          modifiedMs: Date.now(),
          truncated: false,
          children: [],
        },
      ],
      truncated: false,
    };

    function removeTreeFile(nodes, target) {
      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        if (!node.isDir && node.path === target) {
          nodes.splice(index, 1);
          return true;
        }
        if (node.isDir && removeTreeFile(node.children || [], target)) return true;
      }
      return false;
    }

    function countTreeEntries(nodes) {
      return nodes.reduce(
        (count, node) => count + 1 + (node.isDir ? countTreeEntries(node.children || []) : 0),
        0,
      );
    }

    function emit(event, payload) {
      const ids = eventHandlers.get(event) || [];
      for (const id of ids) {
        const cb = callbacks.get(id);
        if (cb) {
          try {
            cb({ event, id: 1, payload });
          } catch (e) {
            console.error("mock emit error", e);
          }
        }
      }
    }

    async function simulateAgent(prompt, sessionId) {
      const reply =
        `**Mock agent reply**\n\nYou said: “${prompt}”\n\n` +
        `Session \`${sessionId?.slice?.(0, 8) || "sess"}\` · OK`;

      emit("agent", {
        kind: "start",
        session_id: sessionId,
        payload: { prompt, permission_mode: settings.permission_mode },
      });
      await delay(40);
      emit("agent", {
        kind: "thinking",
        session_id: sessionId,
        payload: { iteration: 1 },
      });
      await delay(30);
      emit("agent", {
        kind: "reasoning",
        session_id: sessionId,
        payload: { text: "Considering the user message…", iteration: 1 },
      });
      await delay(40);
      if (settings.permission_mode === "multi_agent") {
        const parallelTools = [
          { id: "multi-list", name: "list_dir", arguments: { path: "." } },
          { id: "multi-read", name: "read_file", arguments: { path: "package.json" } },
          { id: "multi-grep", name: "grep", arguments: { pattern: "scripts", path: "package.json" } },
        ];
        emit("agent", {
          kind: "multi_agent_batch",
          session_id: sessionId,
          payload: { tools: parallelTools },
        });
        await delay(12);
        for (const tool of parallelTools) {
          emit("agent", { kind: "tool_call", session_id: sessionId, payload: tool });
        }
        await delay(12);
        for (const tool of parallelTools) {
          const failed = window.__HORMA_MULTI_AGENT_FAILURE__ && tool.id === "multi-read";
          emit("agent", {
            kind: "tool_result",
            session_id: sessionId,
            payload: {
              id: tool.id,
              name: tool.name,
              ok: !failed,
              content: failed ? "Error: simulated inspection failure" : "Mock inspection complete",
            },
          });
        }
      }
      if (window.__HORMA_DEV_SERVER_FIXTURE__) {
        const localServer = {
          id: "local-preview",
          name: "start_dev_server",
          arguments: { command: "npm run dev -- --host 127.0.0.1", port: 5173 },
        };
        emit("agent", { kind: "tool_call", session_id: sessionId, payload: localServer });
        await delay(45);
        emit("agent", {
          kind: "tool_result",
          session_id: sessionId,
          payload: {
            id: localServer.id,
            name: localServer.name,
            ok: true,
            content: "Started local development server in background (PID 4242). Preview: http://127.0.0.1:5173.",
          },
        });
      }
      // stream text in two chunks
      const mid = Math.ceil(reply.length / 2);
      emit("agent", {
        kind: "text",
        session_id: sessionId,
        payload: { text: reply.slice(0, mid) },
      });
      await delay(50);
      emit("agent", {
        kind: "text",
        session_id: sessionId,
        payload: { text: reply.slice(mid) },
      });
      await delay(40);
      emit("agent", {
        kind: "usage",
        session_id: sessionId,
        payload: { iteration: 1, turn_tokens: 120, total_tokens: 120 },
      });
      emit("agent", {
        kind: "done",
        session_id: sessionId,
        payload: {
          summary: "Mock complete",
          title: "ok",
          description: "",
          files: [],
          tech: [],
          features: [],
          total_tokens: 120,
        },
      });
      emit("agent", {
        kind: "end",
        session_id: sessionId,
        payload: { reason: "completed", iteration: 1, total_tokens: 120 },
      });
    }

    function delay(ms) {
      return new Promise((r) => setTimeout(r, ms));
    }

    window.__TAURI_INTERNALS__ = {
      invoke: async (cmd, args = {}) => {
        switch (cmd) {
          case "plugin:event|listen": {
            const id = args.handler;
            if (!eventHandlers.has(args.event)) eventHandlers.set(args.event, []);
            eventHandlers.get(args.event).push(id);
            return 1;
          }
          case "plugin:event|unlisten":
            return null;
          case "list_recent_projects":
            if (Array.isArray(window.__HORMA_RECENT_PROJECTS_FIXTURE__)) {
              return window.__HORMA_RECENT_PROJECTS_FIXTURE__;
            }
            return projectRoot ? [projectRoot] : ["C:\\\\Users\\\\Cyrhiel\\\\Documents\\\\INVENTIONS\\\\AI-Forge"];
          case "get_project_root":
            return projectRoot;
          case "set_project_root": {
            const remaps = window.__HORMA_PROJECT_ROOT_REMAP__ || {};
            projectRoot = remaps[args.path] || args.path;
            return null;
          }
          case "create_project_dir":
            projectRoot = args.path;
            return null;
          case "ensure_quick_session_workspace":
            projectRoot = quickSessionRoot;
            window.__HORMA_QUICK_SESSION_ROOT__ = projectRoot;
            return projectRoot;
          case "app_version":
            return "0.1.5";
          case "get_website_session":
            return "message-test-session";
          case "get_license_status":
          case "apply_license_key":
            return licenseSnapshot();
          case "get_settings":
            return { ...settings };
          case "save_settings":
            Object.assign(settings, args.settings || {});
            window.__HORMA_SAVED_SETTINGS__ = { ...settings };
            return null;
          case "has_api_key":
            return true;
          case "list_provider_models":
            return [settings.model, "deepseek-v4-pro"];
          case "list_project_files":
            return tree;
          case "read_project_file":
            return {
              path: args.relativePath,
              content: "// mock file\n",
              size: 14,
              language: "ts",
            };
          case "delete_project_file": {
            const relativePath = String(args.relativePath || "");
            if (!removeTreeFile(tree.nodes, relativePath)) {
              throw new Error(`Project file not found: ${relativePath}`);
            }
            window.__HORMA_LAST_DELETED_PROJECT_FILE__ = relativePath;
            return null;
          }
          case "clear_project_files": {
            const removed = countTreeEntries(tree.nodes);
            tree = { nodes: [], truncated: false };
            window.__HORMA_CLEARED_PROJECT_FILE_COUNT__ = removed;
            return removed;
          }
          case "plugin:dialog|open":
            if (args.options?.title === "Attach images") {
              window.__HORMA_LAST_DIALOG_OPTIONS__ = args.options;
              return Array.isArray(window.__HORMA_IMAGE_PICKER_FIXTURE__)
                ? window.__HORMA_IMAGE_PICKER_FIXTURE__
                : null;
            }
            if (args.options?.title === "Attach videos") {
              window.__HORMA_LAST_DIALOG_OPTIONS__ = args.options;
              return Array.isArray(window.__HORMA_VIDEO_PICKER_FIXTURE__)
                ? window.__HORMA_VIDEO_PICKER_FIXTURE__
                : null;
            }
            return null;
          case "import_image_path":
            return String(args.path || "");
          case "import_video_path":
            return String(args.path || "");
          case "agent_run":
            window.__HORMA_LAST_AGENT_PROMPT__ = args.prompt;
            window.__HORMA_LAST_USER_REQUEST__ = args.userRequest;
            window.__HORMA_LAST_AGENT_PROJECT_ROOT__ = args.projectRoot;
            await simulateAgent(args.prompt, args.sessionId);
            return null;
          case "agent_stop":
            return null;
          case "open_project_in_explorer":
            return null;
          case "test_provider_connection":
            return { ok: true, latencyMs: 12, errorCode: null, message: "ok" };
          default:
            console.warn("[mock] unhandled invoke", cmd, args);
            return null;
        }
      },
      transformCallback(callback, once = false) {
        const id = crypto.getRandomValues(new Uint32Array(1))[0];
        callbacks.set(id, (data) => {
          if (once) callbacks.delete(id);
          return callback && callback(data);
        });
        return id;
      },
      unregisterCallback(id) {
        callbacks.delete(id);
      },
      runCallback(id, data) {
        const callback = callbacks.get(id);
        if (callback) callback(data);
      },
      convertFileSrc(p) {
        return p;
      },
      metadata: { current: "0.1.0" },
    };

    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener(_event, id) {
        callbacks.delete(id);
      },
    };

    // Mark for tests
    window.__HORMA_MOCK__ = true;
  });
}

async function openProjectViaUI(page) {
  // Prefer clicking project chip → Change project, or sidebar open
  // With recent projects restored, may already have a project.
  await page.waitForTimeout(800);

  const chip = page.locator("#composer-project-chip");
  if (await chip.count()) {
    const label = await chip.innerText();
    if (/select project/i.test(label) || (await chip.evaluate((el) => el.classList.contains("is-empty")))) {
      // Force set via evaluate using mock path by opening picker is hard — set through internal if needed
      // Click Open Project from sidebar if present
      const openBtn = page.getByRole("button", { name: /open project/i });
      if (await openBtn.count()) {
        await openBtn.click();
        await page.waitForTimeout(300);
        // Fill project picker
        const parent = page.locator("#project-parent");
        if (await parent.count()) {
          await parent.fill("C:\\Users\\Cyrhiel\\Documents\\INVENTIONS\\AI-Forge");
          await page.getByRole("button", { name: /open project/i }).last().click();
          await page.waitForTimeout(500);
        }
      }
    }
  }

  // Ensure project ready: if still empty, inject set_project_root through UI flow
  const stillEmpty = await chip.evaluate((el) => el.classList.contains("is-empty")).catch(() => true);
  if (stillEmpty) {
    // list_recent should auto-select on init — reload with recent set
    // Fallback: open new project picker from need-project
  }
}

async function sendMessage(page, text) {
  const input = page.locator("#forge-prompt, .composer-input, textarea").first();
  await expect(input).toBeVisible({ timeout: 10000 });
  await input.click();
  await input.fill(text);
  // Prefer send button to avoid flaky Enter
  const send = page.getByRole("button", { name: "Send message", exact: true });
  await send.click();
}

test("legacy burst blocks cannot lock a healthy plan wallet", async ({ page }) => {
  await page.addInitScript(() => {
    // Simulates a license.json left by an older desktop release: its legacy
    // 4-hour marker says blocked and its cached counter says empty, even
    // though the signed-in account's real wallet still has 90% remaining.
    window.__HORMA_LICENSE_FIXTURE__ = {
      tokenBudget: 1_000_000,
      tokensUsed: 1_000_000,
      blockedBy: "4h",
      window4hUsed: 1_000_000,
      window4hBudget: 200_000,
      windowWeekUsed: 1_000_000,
      windowWeekBudget: 500_000,
    };
  });
  await installMock(page);
  await page.route("https://hormachuelos.vercel.app/api/update?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ updateAvailable: false, forceUpdate: false, currentVersion: "0.1.5", latest: null }),
    }),
  );
  await page.route("https://hormachuelos.vercel.app/api/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        user: {
          email: "usage-test@example.com",
          plan: "pro",
          licenseActive: true,
          licenseKey: "HORMA-MOCK-PLAN",
          tokenBudget: 1_000_000,
          tokensUsed: 100_000,
        },
      }),
    }),
  );

  await page.goto(APP, { waitUntil: "networkidle" });
  await openProjectViaUI(page);

  const input = page.locator("#forge-prompt, .composer-input, textarea").first();
  await expect(input).toBeEnabled({ timeout: 15000 });
  await expect(page.locator(".composer.usage-exhausted, #forge-dock.usage-exhausted")).toHaveCount(0);
  await expect(page.locator("[data-sub-meta]")).toContainText("90% usage remaining");

  await sendMessage(page, "Confirm the healthy wallet can still send this message.");
  await expect(page.locator("#chat")).toContainText("Mock agent reply", { timeout: 10000 });
});

test("repairs an accidentally empty child workspace before the AI starts", async ({ page }) => {
  const requestedPath = String.raw`\\?\C:\fixtures\CRISPY KING DESIGN 2\KRESPE KING`;
  const normalizedRequestedPath = String.raw`C:\fixtures\CRISPY KING DESIGN 2\KRESPE KING`;
  const resolvedPath = String.raw`C:\fixtures\CRISPY KING DESIGN 2`;
  await page.addInitScript(
    ({ requestedPath, normalizedRequestedPath, resolvedPath }) => {
      window.__HORMA_RECENT_PROJECTS_FIXTURE__ = [requestedPath];
      window.__HORMA_PROJECT_ROOT_REMAP__ = {
        [requestedPath]: resolvedPath,
        [normalizedRequestedPath]: resolvedPath,
      };
      localStorage.setItem("ai-forge:active-project-workspace", requestedPath);
      localStorage.setItem(
        "ai-forge:project-workspaces",
        JSON.stringify([
          { path: requestedPath, name: "KRESPE KING", addedAt: 1, lastOpenedAt: 1 },
        ]),
      );
      localStorage.setItem(
        "ai-forge:sessions",
        JSON.stringify([
          {
            id: "root-repair-session",
            title: "Existing project context",
            projectId: requestedPath,
            messages: [{ type: "assistant", text: "Existing project context", at: 1 }],
            createdAt: 1,
            preview: {
              version: 1,
              projectRoot: requestedPath,
              tabs: [],
              activeTabIndex: 0,
              designMode: false,
              androidMode: false,
              softwareMode: false,
            },
          },
        ]),
      );
      localStorage.setItem("ai-forge:project-usage", JSON.stringify({ [requestedPath]: 42 }));
    },
    { requestedPath, normalizedRequestedPath, resolvedPath },
  );
  await installMock(page);
  await page.route("https://hormachuelos.vercel.app/api/update?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ updateAvailable: false, forceUpdate: false, currentVersion: "0.1.5", latest: null }),
    }),
  );
  await page.route("https://hormachuelos.vercel.app/api/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, user: { email: "root-repair@example.com", plan: "pro" } }),
    }),
  );

  await page.goto(APP, { waitUntil: "networkidle" });
  await expect(page.locator("#chat")).toContainText("Existing project context");
  const projectWorkspaces = page.locator(".sb-project-workspace:not(.sb-quick-session)");
  await expect(projectWorkspaces).toContainText("CRISPY KING DESIGN 2");
  await expect(projectWorkspaces).not.toContainText("KRESPE KING");

  await sendMessage(page, "Read the active project files.");
  await expect
    .poll(() => page.evaluate(() => window.__HORMA_LAST_AGENT_PROJECT_ROOT__))
    .toBe(resolvedPath);

  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem("ai-forge:sessions") || "[]"));
  const session = persisted.find((entry) => entry.id === "root-repair-session");
  expect(session.projectId).toBe(resolvedPath);
  expect(session.preview).toBeUndefined();
  const usage = await page.evaluate(() => JSON.parse(localStorage.getItem("ai-forge:project-usage") || "{}"));
  expect(usage[resolvedPath]).toBe(42);
  expect(usage[requestedPath]).toBeUndefined();
});

test("creates and uses a Quick session without asking for a folder", async ({ page }) => {
  const consoleErrors = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.addInitScript(() => {
    window.__HORMA_RECENT_PROJECTS_FIXTURE__ = [];
  });
  await installMock(page);
  await page.route("https://hormachuelos.vercel.app/api/update?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ updateAvailable: false, forceUpdate: false, currentVersion: "0.1.5", latest: null }),
    }),
  );
  await page.route("https://hormachuelos.vercel.app/api/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, user: { email: "quick-session@example.com", plan: "pro" } }),
    }),
  );

  await page.goto(APP, { waitUntil: "networkidle" });
  const quickWorkspace = page.getByRole("button", { name: /quick sessions/i });
  await expect(quickWorkspace).toBeVisible();
  await expect(quickWorkspace).toContainText("No folder needed");
  await expect(page.locator("#project-parent")).toHaveCount(0);

  await page.getByRole("button", { name: "New session", exact: true }).click();
  await expect(page.locator(".sb-session-item")).toHaveCount(1);
  await expect(page.locator(".sb-session-item")).toContainText("New session");
  await expect(page.locator("#project-parent")).toHaveCount(0);

  const input = page.locator("#forge-prompt, .composer-input, textarea").first();
  await expect(input).toBeEnabled();
  await sendMessage(page, "Reply from a folder-free Quick session.");
  await expect(page.locator("#chat")).toContainText("Mock agent reply", { timeout: 10000 });
  const agentRoot = await page.evaluate(() => window.__HORMA_LAST_AGENT_PROJECT_ROOT__);
  expect(agentRoot).toContain("Quick Sessions");

  const fatal = consoleErrors.filter((entry) => !/favicon|vite|tauri/i.test(entry));
  expect(fatal, fatal.join("\n")).toEqual([]);
});

test("Flavour memory is visible in chat controls and can be disabled", async ({ page }) => {
  await installMock(page);
  await page.route("https://hormachuelos.vercel.app/api/update?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ updateAvailable: false, forceUpdate: false, currentVersion: "0.1.5", latest: null }),
    }),
  );
  await page.route("https://hormachuelos.vercel.app/api/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, user: { email: "flavour-test@example.com", plan: "pro" } }),
    }),
  );

  await page.goto(APP, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Add modes and attachments" }).click();
  const flavour = page.getByRole("menuitem", { name: "Flavour memory — On" });
  await expect(flavour).toBeVisible();
  await flavour.click();
  await expect
    .poll(() => page.evaluate(() => window.__HORMA_SAVED_SETTINGS__?.flavour_enabled))
    .toBe(false);

  await page.getByRole("button", { name: "Add modes and attachments" }).click();
  await expect(page.getByRole("menuitem", { name: "Flavour memory — Off" })).toBeVisible();
});

test("send three messages and get mock agent replies", async ({ page }) => {
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push("page:" + e.message));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });

  await installMock(page);
  await page.route("https://hormachuelos.vercel.app/api/update?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        updateAvailable: false,
        forceUpdate: false,
        currentVersion: "0.1.5",
        latest: null,
      }),
    }),
  );
  await page.route("https://hormachuelos.vercel.app/api/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        user: { email: "message-test@example.com", plan: "free" },
      }),
    }),
  );
  await page.goto(APP, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  // Shell must be up
  await expect(page.locator("#app")).toBeVisible();
  await expect(page.locator("#forge-dock")).toBeVisible();
  await expect(page.locator("#forge-prompt, .composer-input")).toBeVisible();

  await page.screenshot({ path: path.join(OUT, "msg-00-ready.png"), fullPage: true });

  // Open / confirm project
  await openProjectViaUI(page);

  // If project chip still empty, use Open Project modal path
  const chipText = await page.locator("#composer-project-chip").innerText().catch(() => "");
  if (/select project/i.test(chipText) || !chipText.trim()) {
    // Sidebar open project
    const open = page.locator("button", { hasText: /open project/i }).first();
    if (await open.count()) {
      await open.click();
    } else {
      // try need-project by sending — may open picker
      await sendMessage(page, "warmup");
      await page.waitForTimeout(400);
    }
    const parent = page.locator("#project-parent");
    if (await parent.isVisible().catch(() => false)) {
      await parent.fill("C:\\Users\\Cyrhiel\\Documents\\INVENTIONS\\AI-Forge");
      await page.locator(".modal-foot .btn.primary, .modal-foot button").last().click();
      await page.waitForTimeout(600);
    }
  }

  // Clear chat if warmup left junk — new session button
  const newSession = page.locator('button[title="New session"], .chip-icon, button[aria-label="New session"]').first();
  if (await newSession.count()) {
    await newSession.click().catch(() => {});
    await page.waitForTimeout(300);
  }

  const results = [];

  for (let i = 0; i < MESSAGES.length; i++) {
    const msg = MESSAGES[i];
    const n = i + 1;

    // Wait until not running
    await page.waitForFunction(
      () => {
        const btn = document.querySelector(".send-btn:not(.stop-btn)");
        return btn && btn.getAttribute("aria-label") === "Send message" && !btn.disabled;
      },
      { timeout: 15000 },
    ).catch(() => {});

    await sendMessage(page, msg);

    // User bubble should appear
    await expect(page.locator("#chat")).toContainText(msg.slice(0, 24), { timeout: 8000 });

    // Wait for mock agent text
    await expect(page.locator("#chat")).toContainText("Mock agent reply", { timeout: 10000 });
    await expect(page.locator("#chat")).toContainText(msg.slice(0, 20), { timeout: 5000 });
    // Flavour receives the user's clean request separately from the hidden
    // project mission wrapper used by the provider prompt.
    await expect.poll(() => page.evaluate(() => window.__HORMA_LAST_USER_REQUEST__)).toBe(msg);

    // Wait for run to finish (send button not in stop mode)
    await page.waitForTimeout(400);
    await page.waitForFunction(
      () => {
        const btn = document.querySelector(".send-btn:not(.stop-btn)");
        return btn && btn.getAttribute("aria-label") === "Send message";
      },
      { timeout: 15000 },
    ).catch(() => {});

    await page.screenshot({
      path: path.join(OUT, `msg-0${n}-after.png`),
      fullPage: true,
    });

    const chatText = await page.locator("#chat").innerText();
    const userOk = chatText.includes(msg.slice(0, 20));
    const aiOk = /Mock agent reply/i.test(chatText);
    results.push({ n, msg, userOk, aiOk });
  }

  // All three user messages should still be in the transcript
  const finalChat = await page.locator("#chat").innerText();
  for (const msg of MESSAGES) {
    expect(finalChat, `missing user message: ${msg}`).toContain(msg.slice(0, 24));
  }

  // Count mock replies (at least 3)
  const replyCount = (finalChat.match(/Mock agent reply/gi) || []).length;
  expect(replyCount, `expected ≥3 AI replies, got ${replyCount}`).toBeGreaterThanOrEqual(3);

  await page.screenshot({ path: path.join(OUT, "msg-final-three.png"), fullPage: true });

  const report = {
    generatedAt: new Date().toISOString(),
    messages: MESSAGES,
    results,
    replyCount,
    consoleErrors: consoleErrors.filter((e) => !/unhandled invoke|mock/i.test(e)).slice(0, 15),
  };
  fs.writeFileSync(path.join(OUT, "three-messages-report.json"), JSON.stringify(report, null, 2));

  // Soft note real errors
  const fatal = consoleErrors.filter(
    (e) => !/unhandled invoke|Failed to load|favicon|vite/i.test(e) && !/mock/i.test(e),
  );
  expect(fatal, fatal.join("\n")).toEqual([]);
});

test("project files can be deleted one at a time or cleared with confirmation", async ({ page }) => {
  await installMock(page);
  await page.route("https://hormachuelos.vercel.app/api/update?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ updateAvailable: false, forceUpdate: false, currentVersion: "0.1.5", latest: null }),
    }),
  );
  await page.route("https://hormachuelos.vercel.app/api/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, user: { email: "file-actions@example.com", plan: "pro" } }),
    }),
  );

  await page.goto(APP, { waitUntil: "networkidle" });
  await openProjectViaUI(page);

  const tree = page.locator(".project-tree");
  await tree.locator('.tree-item.directory[title="src"]').click();
  await expect(tree).toContainText("main.ts");
  await expect(tree).toContainText("README.md");
  await expect(page.locator(".project-file-count")).toContainText("2 files");

  await page.getByRole("button", { name: "Delete src/main.ts" }).click();
  const deleteDialog = page.getByRole("alertdialog");
  await expect(deleteDialog).toContainText("Delete this project file?");
  await expect(deleteDialog).toContainText("src/main.ts");
  await deleteDialog.getByRole("button", { name: "Delete file" }).click();

  await expect(tree).not.toContainText("main.ts");
  await expect(page.locator(".project-file-notice")).toContainText("Deleted src/main.ts.");
  expect(await page.evaluate(() => window.__HORMA_LAST_DELETED_PROJECT_FILE__)).toBe("src/main.ts");
  await expect(page.locator(".project-file-count")).toContainText("1 file");

  await page.getByRole("button", { name: "Clear all project files" }).click();
  const clearDialog = page.getByRole("alertdialog");
  await expect(clearDialog).toContainText("Clear all project files?");
  await expect(clearDialog).toContainText(".git history stay");
  await clearDialog.getByRole("button", { name: "Clear files" }).click();

  await expect(tree).toContainText("This project is empty.");
  await expect(page.locator(".project-file-count")).toContainText("0 files");
  expect(await page.evaluate(() => window.__HORMA_CLEARED_PROJECT_FILE_COUNT__)).toBe(2);
});

test("attaches every image selected together or pasted from Explorer", async ({ page }) => {
  await page.addInitScript(() => {
    window.__HORMA_IMAGE_PICKER_FIXTURE__ = [
      "C:\\fixtures\\selected-one.png",
      "C:\\fixtures\\selected-two.png",
    ];
  });
  await installMock(page);
  await page.route("https://hormachuelos.vercel.app/api/update?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ updateAvailable: false, forceUpdate: false, currentVersion: "0.1.5", latest: null }),
    }),
  );
  await page.route("https://hormachuelos.vercel.app/api/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, user: { email: "images@example.com", plan: "free" } }),
    }),
  );
  await page.goto(APP, { waitUntil: "networkidle" });
  await openProjectViaUI(page);

  const input = page.locator("#forge-prompt, .composer-input, textarea").first();
  await expect(input).toBeEnabled({ timeout: 15000 });

  await page.getByRole("button", { name: "Add modes and attachments" }).click();
  await page.getByRole("menuitem", { name: "Image", exact: true }).click();
  await expect(page.locator(".composer-attach-chip")).toHaveCount(2);
  expect(await page.evaluate(() => window.__HORMA_LAST_DIALOG_OPTIONS__?.multiple)).toBe(true);

  await sendMessage(page, "Compare both selected images.");
  await expect
    .poll(() => page.evaluate(() => String(window.__HORMA_LAST_AGENT_PROMPT__ || "")))
    .toContain("selected-two.png");

  await page.waitForFunction(
    () => document.querySelector(".send-btn:not(.stop-btn)")?.getAttribute("aria-label") === "Send message",
    { timeout: 10000 },
  );
  await page.evaluate(() => {
    const input = document.querySelector("#forge-prompt");
    if (!(input instanceof HTMLTextAreaElement)) throw new Error("Composer input not found");
    const clipboard = new DataTransfer();
    clipboard.setData(
      "text/uri-list",
      "file:///C:/fixtures/pasted-one.png\r\nfile:///C:/fixtures/pasted-two.png",
    );
    input.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }),
    );
  });
  await expect(page.locator(".composer-attach-chip")).toHaveCount(2);

  await sendMessage(page, "Compare both Explorer-pasted images.");
  await expect
    .poll(() => page.evaluate(() => String(window.__HORMA_LAST_AGENT_PROMPT__ || "")))
    .toContain("pasted-two.png");
  const prompt = await page.evaluate(() => String(window.__HORMA_LAST_AGENT_PROMPT__ || ""));
  expect(prompt.match(/\[Attached image:/g) || []).toHaveLength(2);
});

test("video picker attaches video chips before frame sampling", async ({ page }) => {
  await page.addInitScript(() => {
    window.__HORMA_VIDEO_PICKER_FIXTURE__ = [
      "C:\\fixtures\\demo-one.mp4",
      "C:\\fixtures\\demo-two.webm",
    ];
  });
  await installMock(page);
  await page.route("https://hormachuelos.vercel.app/api/update?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ updateAvailable: false, forceUpdate: false, currentVersion: "0.1.5", latest: null }),
    }),
  );
  await page.route("https://hormachuelos.vercel.app/api/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, user: { email: "videos@example.com", plan: "pro" } }),
    }),
  );
  await page.goto(APP, { waitUntil: "networkidle" });
  await openProjectViaUI(page);

  await page.getByRole("button", { name: "Add modes and attachments" }).click();
  await page.getByRole("menuitem", { name: "Video", exact: true }).click();
  await expect(page.locator(".composer-attach-video")).toHaveCount(2);
  await expect(page.locator(".composer-attach-video").first()).toContainText("demo-one.mp4");
  expect(await page.evaluate(() => window.__HORMA_LAST_DIALOG_OPTIONS__?.title)).toBe("Attach videos");
  expect(await page.evaluate(() => window.__HORMA_LAST_DIALOG_OPTIONS__?.multiple)).toBe(true);
});

test("pastes every copied video from Explorer into the composer", async ({ page }) => {
  await installMock(page);
  await page.route("https://hormachuelos.vercel.app/api/update?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ updateAvailable: false, forceUpdate: false, currentVersion: "0.1.5", latest: null }),
    }),
  );
  await page.route("https://hormachuelos.vercel.app/api/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, user: { email: "copied-videos@example.com", plan: "pro" } }),
    }),
  );
  await page.goto(APP, { waitUntil: "networkidle" });
  await openProjectViaUI(page);

  await page.evaluate(() => {
    const input = document.querySelector("#forge-prompt");
    if (!(input instanceof HTMLTextAreaElement)) throw new Error("Composer input not found");
    const clipboard = new DataTransfer();
    clipboard.setData(
      "text/uri-list",
      "file:///C:/fixtures/copied-demo-one.mp4\r\nfile:///C:/fixtures/copied-demo-two.webm",
    );
    input.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }),
    );
  });

  await expect(page.locator(".composer-attach-video")).toHaveCount(2);
  await expect(page.locator(".composer-attach-video").first()).toContainText("copied-demo-one.mp4");
  await expect(page.locator(".composer-attach-video").last()).toContainText("copied-demo-two.webm");
});

test("local preview launch completes instead of remaining as a running shell command", async ({ page }) => {
  await page.addInitScript(() => {
    window.__HORMA_DEV_SERVER_FIXTURE__ = true;
  });
  await installMock(page);
  await page.route("https://hormachuelos.vercel.app/api/update?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ updateAvailable: false, forceUpdate: false, currentVersion: "0.1.5", latest: null }),
    }),
  );
  await page.route("https://hormachuelos.vercel.app/api/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, user: { email: "preview-launch@example.com", plan: "pro" } }),
    }),
  );

  await page.goto(APP, { waitUntil: "networkidle" });
  await openProjectViaUI(page);
  await sendMessage(page, "Start the local preview and continue working.");

  const previewTool = page.locator('.tool-name[data-tool="start_dev_server"]');
  await expect(previewTool).toContainText("Local preview", { timeout: 10000 });
  await expect(previewTool).toContainText(/Ran|Done/);
  await expect(page.locator("#chat")).toContainText("Mock agent reply");
  await page.waitForFunction(
    () => document.querySelector(".send-btn:not(.stop-btn)")?.getAttribute("aria-label") === "Send message",
    { timeout: 10000 },
  );
});

test("Multi-Agent mode saves Ship-level access and renders parallel tool roles", async ({ page }) => {
  await installMock(page);
  await page.route("https://hormachuelos.vercel.app/api/update?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ updateAvailable: false, forceUpdate: false, currentVersion: "0.1.5", latest: null }),
    }),
  );
  await page.route("https://hormachuelos.vercel.app/api/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, user: { email: "multi@example.com", plan: "pro" } }),
    }),
  );
  await page.goto(APP, { waitUntil: "networkidle" });
  await openProjectViaUI(page);

  await page.getByRole("button", { name: "Mode: Auto" }).click();
  await page.getByRole("option", { name: /multi-agent/i }).click();
  await expect(page.locator(".chip-mode-multi-agent")).toBeVisible();

  await sendMessage(page, "Inspect the project quickly with multiple agents.");
  const swarm = page.locator(".multi-agent-batch");
  await expect(swarm).toBeVisible();
  await expect(swarm).toContainText("Multi-Agent");
  await expect(swarm).toContainText("Reading package.json");
  await expect(swarm).toContainText("Mapping");
  await expect(swarm).toContainText("Searching for scripts");
  await expect(page.locator(".multi-agent-tool.done")).toHaveCount(3);
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem("ai-forge:sessions") || "[]"));
  const multiAgentSession = persisted.find((session) =>
    session.messages?.some((message) => message.type === "multi_agent_batch"),
  );
  expect(multiAgentSession?.messages.some((message) => message.type === "run_start" && message.permissionMode === "multi_agent")).toBe(true);
});

test("Multi-Agent activity chrome survives switching projects and returning", async ({ page }) => {
  const multiProject = String.raw`C:\fixtures\Rainbow Workspace`;
  const otherProject = String.raw`C:\fixtures\Plain Workspace`;
  await page.addInitScript(
    ({ multiProject, otherProject }) => {
      const multiTools = [
        { id: "saved-list", name: "list_dir", arguments: { path: "." } },
        { id: "saved-read", name: "read_file", arguments: { path: "package.json" } },
        { id: "saved-grep", name: "grep", arguments: { pattern: "scripts", path: "package.json" } },
      ];
      window.__HORMA_RECENT_PROJECTS_FIXTURE__ = [multiProject, otherProject];
      localStorage.setItem("ai-forge:active-project-workspace", multiProject);
      localStorage.setItem(
        "ai-forge:project-workspaces",
        JSON.stringify([
          { path: multiProject, name: "Rainbow Workspace", addedAt: 1, lastOpenedAt: 2 },
          { path: otherProject, name: "Plain Workspace", addedAt: 1, lastOpenedAt: 1 },
        ]),
      );
      localStorage.setItem(
        "ai-forge:sessions",
        JSON.stringify([
          {
            id: "saved-multi-agent-session",
            title: "Parallel inspection",
            projectId: multiProject,
            createdAt: 2,
            messages: [
              { type: "user", text: "Inspect this workspace in parallel.", at: 1 },
              { type: "run_start", permissionMode: "multi_agent", at: 2 },
              { type: "thinking", iteration: 1, text: "Planning parallel inspection.", at: 3 },
              { type: "multi_agent_batch", tools: multiTools, at: 4 },
              ...multiTools.flatMap((tool, index) => [
                { type: "tool_call", ...tool, at: 5 + index },
                {
                  type: "tool_result",
                  id: tool.id,
                  name: tool.name,
                  ok: true,
                  content: "Saved inspection complete",
                  at: 8 + index,
                },
              ]),
              {
                type: "done",
                summary: "Parallel inspection complete",
                title: "Inspection complete",
                description: "",
                files: [],
                tech: [],
                features: [],
                at: 12,
              },
            ],
          },
          {
            id: "other-project-session",
            title: "Other project",
            projectId: otherProject,
            createdAt: 1,
            messages: [{ type: "assistant", text: "Plain project transcript", at: 1 }],
          },
        ]),
      );
    },
    { multiProject, otherProject },
  );
  await installMock(page);
  await page.route("https://hormachuelos.vercel.app/api/update?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ updateAvailable: false, forceUpdate: false, currentVersion: "0.1.5", latest: null }),
    }),
  );
  await page.route("https://hormachuelos.vercel.app/api/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, user: { email: "switch-multi@example.com", plan: "pro" } }),
    }),
  );

  await page.goto(APP, { waitUntil: "networkidle" });
  const swarm = page.locator(".multi-agent-batch");
  await expect(swarm).toHaveCount(1);
  await expect(page.locator("#chat")).toHaveClass(/chat-multi-agent/);
  await expect(swarm.locator(".multi-agent-tool.done")).toHaveCount(3);
  await expect(swarm.locator(".multi-agent-live")).toHaveText("DONE");

  await page.locator(".sb-project-workspace", { hasText: "Plain Workspace" }).click();
  await expect(page.locator("#chat")).toContainText("Plain project transcript");
  await expect(page.locator("#chat")).not.toHaveClass(/chat-multi-agent/);
  await expect(swarm).toHaveCount(0);

  await page.locator(".sb-project-workspace", { hasText: "Rainbow Workspace" }).click();
  await expect(swarm).toHaveCount(1);
  await expect(page.locator("#chat")).toHaveClass(/chat-multi-agent/);
  await expect(swarm.locator(".multi-agent-tool.done")).toHaveCount(3);
  await expect(swarm.locator(".multi-agent-live")).toHaveText("DONE");
  const orbit = await swarm.evaluate((batch) => getComputedStyle(batch, "::before").animationName);
  expect(orbit).toContain("multiAgentSpectrumOrbit");
});

test("Multi-Agent mode marks a failed spawned tool as needing attention", async ({ page }) => {
  await installMock(page);
  await page.route("https://hormachuelos.vercel.app/api/update?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ updateAvailable: false, forceUpdate: false, currentVersion: "0.1.5", latest: null }),
    }),
  );
  await page.route("https://hormachuelos.vercel.app/api/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, user: { email: "multi-failure@example.com", plan: "pro" } }),
    }),
  );
  await page.goto(APP, { waitUntil: "networkidle" });
  await openProjectViaUI(page);

  await page.getByRole("button", { name: "Mode: Auto" }).click();
  await page.getByRole("option", { name: /multi-agent/i }).click();
  await page.evaluate(() => {
    window.__HORMA_MULTI_AGENT_FAILURE__ = true;
  });

  await sendMessage(page, "Inspect the project and show a failure state.");
  const swarm = page.locator(".multi-agent-batch");
  await expect(swarm).toHaveClass(/needs-attention/);
  await expect(swarm.locator(".multi-agent-live")).toHaveText("NEEDS ATTENTION");
  await expect(swarm.locator(".multi-agent-tool.failed")).toHaveCount(1);
  await expect(page.locator(".tool-batch-label")).toContainText("agent needs attention");
});
