/**
 * Regression coverage for a long HORMACHUELOS task in the desktop shell.
 *
 * The browser cannot call the native Tauri backend, so this deliberately
 * simulates the public agent-event contract that the real provider/agent loop
 * emits. The Rust tests cover the host recovery decision; this test verifies
 * that the visible session stays active until the final verified completion
 * rather than asking the client to press Continue.
 */
import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "test-results");
const APP = "http://localhost:1420";
const PROJECT_ROOT = "C:\\Users\\Cyrhiel\\Documents\\INVENTIONS\\AI-Forge";

test.use({
  baseURL: APP,
  viewport: { width: 1400, height: 900 },
});

test.beforeAll(() => fs.mkdirSync(OUT, { recursive: true }));

async function installHormachuelosLongRunMock(page) {
  await page.addInitScript(({ projectRoot }) => {
    const callbacks = new Map();
    const listeners = new Map();
    const settings = {
      provider: "hormachuelos_free",
      model: "hormachuelos-v1",
      base_url: "https://hormachuelos.vercel.app/api/v1",
      max_iterations: 0,
      command_timeout_secs: 120,
      auto_approve: true,
      permission_mode: "auto",
      capability_mode: "thinking",
      taglish: false,
      computer_use_enabled: false,
      smart_agent_enabled: true,
      model_effort: "high",
    };
    const tree = {
      nodes: [{
        name: "src",
        path: "src",
        isDir: true,
        size: 0,
        modifiedMs: Date.now(),
        truncated: false,
        children: [{
          name: "main.ts",
          path: "src/main.ts",
          isDir: false,
          size: 512,
          modifiedMs: Date.now(),
          truncated: false,
          children: [],
        }],
      }],
      truncated: false,
    };
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const emit = (event, payload) => {
      const ids = listeners.get(event) || [];
      for (const id of ids) {
        const callback = callbacks.get(id);
        if (callback) callback({ event, id: 1, payload });
      }
    };

    window.__HORMA_LONG_RUNS__ = 0;
    window.__HORMA_LONG_EVENTS__ = [];

    async function simulateLongTask(prompt, sessionId) {
      window.__HORMA_LONG_RUNS__ += 1;
      const trace = window.__HORMA_LONG_EVENTS__;
      const event = (kind, payload) => {
        trace.push(kind === "end" ? `end:${payload.reason}` : kind);
        emit("agent", { kind, session_id: sessionId, payload });
      };

      event("start", { prompt, provider: "HORMACHUELOS FREE", model: settings.model, permission_mode: "auto" });
      event("task_plan", {
        title: "Smart Agent",
        summary: "Keeping this long Hormachuelos task focused, verified, and moving.",
        active_step: 0,
        status: "working",
        steps: [
          { id: "scope", label: "Understand the request", state: "active" },
          { id: "inspect", label: "Inspect the workspace", state: "pending" },
          { id: "implement", label: "Implement the requested work", state: "pending" },
          { id: "validate", label: "Validate the result", state: "pending" },
          { id: "deliver", label: "Deliver the result", state: "pending" },
        ],
      });

      // Fifteen tool rounds model a genuinely long hosted task. Fourteen
      // interrupted-stream recoveries deliberately exceed the legacy
      // twelve-recovery ceiling. Each recovery follows concrete tool work;
      // the host must keep the one task alive instead of producing an `end`
      // event or waiting for the client to type Continue.
      const totalWorkRounds = 15;
      for (let round = 0; round < totalWorkRounds; round += 1) {
        event("thinking", { iteration: round });
        const step = round < 2 ? 1 : round < totalWorkRounds - 2 ? 2 : 3;
        event("task_progress", {
          step,
          phase: ["scope", "inspect", "implement", "validate", "deliver"][step],
          status: "active",
          completed_before: step,
          detail: step === 3 ? "Running a focused validation check..." : "Applying the requested changes...",
        });
        const id = `long-task-${round}`;
        event("tool_call", {
          id,
          name: round < 2 ? "read_file" : round < totalWorkRounds - 2 ? "write_file" : "run_command",
          arguments: round < 2 ? { path: "src/main.ts" } : round < totalWorkRounds - 2
            ? { path: `src/feature-${round}.ts`, content: "// simulated" }
            : { command: "npm run check" },
        });
        event("tool_result", { id, name: round < 2 ? "read_file" : round < totalWorkRounds - 2 ? "write_file" : "run_command", ok: true, content: "ok" });
        if (round < totalWorkRounds - 1) {
          event("reasoning", {
            iteration: round,
            text: "Hosted stream was interrupted; continuing the same task from the latest workspace state...",
          });
        }
        await delay(12);
      }

      event("task_progress", {
        step: 4,
        phase: "deliver",
        status: "completed",
        complete_all: true,
        detail: "Task complete and ready to deliver.",
      });
      event("text", { text: "Long-session Hormachuelos task complete." });
      event("done", {
        summary: "Long-session Hormachuelos task complete.",
        title: "Long task verified",
        description: "The hosted task completed after recovery rounds.",
        files: ["src/main.ts"],
        tech: ["TypeScript"],
        features: ["automatic recovery"],
        total_tokens: 1200,
      });
      event("end", { reason: "completed", iteration: totalWorkRounds, total_tokens: 1200 });
    }

    window.__TAURI_INTERNALS__ = {
      invoke: async (cmd, args = {}) => {
        switch (cmd) {
          case "plugin:event|listen": {
            const id = args.handler;
            const entries = listeners.get(args.event) || [];
            entries.push(id);
            listeners.set(args.event, entries);
            return 1;
          }
          case "plugin:event|unlisten":
            return null;
          case "get_project_root":
            return projectRoot;
          case "set_project_root":
            return null;
          case "list_recent_projects":
            return [projectRoot];
          case "app_version":
            return "0.1.27";
          case "get_website_session":
            return "mock-signed-in-hormachuelos-session";
          case "get_settings":
            return { ...settings };
          case "save_settings":
            Object.assign(settings, args.settings || {});
            return null;
          case "has_api_key":
            return true;
          case "list_provider_models":
            return ["hormachuelos-v1", "hormachuelos-v2"];
          case "list_project_files":
            return tree;
          case "read_project_file":
            return { path: args.relativePath, content: "// simulated\n", size: 13, language: "ts" };
          case "agent_run":
            await simulateLongTask(args.prompt, args.sessionId);
            return null;
          case "agent_stop":
          case "open_project_in_explorer":
            return null;
          case "test_provider_connection":
            return { ok: true, latencyMs: 20, errorCode: null, message: "HORMACHUELOS FREE mock connected" };
          default:
            return null;
        }
      },
      transformCallback(callback, once = false) {
        const id = crypto.getRandomValues(new Uint32Array(1))[0];
        callbacks.set(id, (data) => {
          if (once) callbacks.delete(id);
          return callback?.(data);
        });
        return id;
      },
      unregisterCallback(id) { callbacks.delete(id); },
      runCallback(id, data) { callbacks.get(id)?.(data); },
      convertFileSrc(value) { return value; },
      metadata: { current: "0.1.27" },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener(_event, id) { callbacks.delete(id); },
    };
  }, { projectRoot: PROJECT_ROOT });
}

test("long HORMACHUELOS task recovers without a manual Continue message", async ({ page }) => {
  const consoleErrors = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await installHormachuelosLongRunMock(page);
  await page.route("https://hormachuelos.vercel.app/api/update?*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ updateAvailable: false, forceUpdate: false, currentVersion: "0.1.27", latest: null }),
  }));
  await page.route("https://hormachuelos.vercel.app/api/auth/me", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, user: { email: "long-session@example.com", plan: "pro" } }),
  }));

  await page.goto(APP, { waitUntil: "networkidle" });
  await expect(page.locator("#app")).toBeVisible();
  const input = page.locator("#forge-prompt, .composer-input, textarea").first();
  await expect(input).toBeVisible();

  const prompt = "Build a multi-page website and keep working until the full project is validated.";
  await input.fill(prompt);
  await page.getByRole("button", { name: "Send message", exact: true }).click();

  await expect(page.locator("#chat")).toContainText(prompt.slice(0, 32));
  await expect(page.locator("#smart-agent-status")).toBeVisible();
  await expect(page.locator("#smart-agent-status")).toContainText("Smart Agent");
  await expect(page.locator("#chat")).toContainText("Long-session Hormachuelos task complete.", { timeout: 30000 });
  await expect(page.locator("#smart-agent-status")).toContainText("Verified");
  await expect(page.locator("#smart-agent-status")).toContainText("Validate the result");

  await expect.poll(() => page.evaluate(() => window.__HORMA_LONG_RUNS__)).toBe(1);
  const trace = await page.evaluate(() => window.__HORMA_LONG_EVENTS__);
  expect(trace.filter((event) => event === "tool_call").length).toBeGreaterThanOrEqual(15);
  // More recoveries than the former global 12-pass safeguard, each after a
  // concrete tool turn. A long task must still complete as a single run.
  expect(trace.filter((event) => event === "reasoning").length).toBeGreaterThanOrEqual(14);
  expect(trace).toContain("end:completed");
  expect(trace).not.toContain("end:continuation_safety_guard");

  const send = page.getByRole("button", { name: "Send message", exact: true });
  await expect(send).toBeEnabled();
  await page.screenshot({ path: path.join(OUT, "long-hormachuelos-session.png"), fullPage: true });

  const fatal = consoleErrors.filter((entry) => !/mock|tauri|invoke|favicon|vite/i.test(entry));
  expect(fatal, fatal.join("\n")).toEqual([]);
});
