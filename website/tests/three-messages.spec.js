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

    const settings = {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      base_url: "https://api.deepseek.com",
      max_iterations: 10,
      command_timeout_secs: 60,
      auto_approve: true,
      permission_mode: "auto",
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

    const tree = {
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

      emit("agent", { kind: "start", session_id: sessionId, payload: { prompt } });
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
            return projectRoot ? [projectRoot] : ["C:\\\\Users\\\\Cyrhiel\\\\Documents\\\\INVENTIONS\\\\AI-Forge"];
          case "get_project_root":
            return projectRoot;
          case "set_project_root":
            projectRoot = args.path;
            return null;
          case "create_project_dir":
            projectRoot = args.path;
            return null;
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
          case "plugin:dialog|open":
            if (args.options?.title === "Attach images") {
              window.__HORMA_LAST_DIALOG_OPTIONS__ = args.options;
              return Array.isArray(window.__HORMA_IMAGE_PICKER_FIXTURE__)
                ? window.__HORMA_IMAGE_PICKER_FIXTURE__
                : null;
            }
            return null;
          case "import_image_path":
            return String(args.path || "");
          case "agent_run":
            window.__HORMA_LAST_AGENT_PROMPT__ = args.prompt;
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
