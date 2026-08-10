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

const ADVERTISED_TOOL_PLAN = [
  { name: "read_file", arguments: { path: "src/main.ts" } },
  { name: "write_file", arguments: { path: "src/all-tools.ts", content: "// simulated" } },
  { name: "edit_file", arguments: { path: "src/main.ts", old_string: "old", new_string: "new" } },
  { name: "list_dir", arguments: { path: "." } },
  { name: "glob", arguments: { pattern: "src/**/*" } },
  { name: "grep", arguments: { pattern: "TODO", path: "src" } },
  { name: "run_command", arguments: { command: "npm run check" } },
  { name: "start_dev_server", arguments: { command: "npm run dev", port: 5173 } },
  { name: "git_init", arguments: {} },
  { name: "git_add_all", arguments: {} },
  { name: "git_commit", arguments: { message: "Test every tool" } },
  { name: "git_status", arguments: {} },
  { name: "list_drives", arguments: {} },
  { name: "sys_info", arguments: {} },
  { name: "env_vars", arguments: { filter: "PATH" } },
  { name: "list_processes", arguments: { filter: "node" } },
  { name: "kill_process", arguments: { pid: 424242 } },
  { name: "open_url", arguments: { url: "https://example.com" } },
  { name: "connect_account", arguments: { service: "github" } },
  { name: "integration_status", arguments: { service: "github", verify: false } },
  { name: "open_path", arguments: { path: "index.html" } },
  { name: "download_file", arguments: { url: "https://example.com/file.txt", path: "download.txt" } },
  { name: "move_file", arguments: { src: "old.txt", dst: "new.txt" } },
  { name: "copy_file", arguments: { src: "source.txt", dst: "copy.txt" } },
  { name: "delete_file", arguments: { path: "temporary.txt" } },
  { name: "make_dir", arguments: { path: "src/generated" } },
  { name: "file_info", arguments: { path: "package.json" } },
  { name: "view_image", arguments: { path: "public/terrain.png" } },
  { name: "view_video", arguments: { path: "demo.mp4" } },
  { name: "web_search", arguments: { query: "Tauri testing" } },
  { name: "browse_page", arguments: { url: "https://example.com" } },
  { name: "export_client_pack", arguments: { handoff_summary: "Ready" } },
  { name: "ask_user", arguments: { question: "Continue?", options: ["Yes", "No"] } },
  { name: "done", arguments: { title: "Verified", summary: "All tools checked" } },
  { name: "computer_list_windows", arguments: {} },
  { name: "computer_observe", arguments: { window_id: "window-1" } },
  { name: "computer_focus_window", arguments: { window_id: "window-1" } },
  { name: "computer_click", arguments: { window_id: "window-1", observation_token: "token", x: 10, y: 10 } },
  { name: "computer_type_text", arguments: { window_id: "window-1", observation_token: "token", text: "hidden" } },
  { name: "computer_press_key", arguments: { window_id: "window-1", observation_token: "token", key: "Enter" } },
  { name: "computer_scroll", arguments: { window_id: "window-1", observation_token: "token", delta_y: 120 } },
  { name: "computer_drag", arguments: { window_id: "window-1", observation_token: "token", from_x: 10, from_y: 10, to_x: 30, to_y: 30 } },
  { name: "computer_game_sequence", arguments: { window_id: "window-1", observation_token: "token", steps: [{ keys: ["W"], delay_ms: 16 }] } },
];

test.use({
  baseURL: APP,
  viewport: { width: 1400, height: 900 },
});

test.beforeAll(() => fs.mkdirSync(OUT, { recursive: true }));

async function installHormachuelosLongRunMock(page, { lifecycleScenario = false } = {}) {
  await page.addInitScript(({ projectRoot, lifecycleScenario }) => {
    const callbacks = new Map();
    const listeners = new Map();
    const settings = {
      provider: "hormachuelos_free",
      model: "hormachuelos-v1",
      base_url: "https://hormachuelos.vercel.app/api/v1",
      max_iterations: 0,
      command_timeout_secs: 120,
      auto_approve: true,
      permission_mode: window.__HORMA_LONG_PERMISSION_MODE__ || "auto",
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
    window.__HORMA_AGENT_RUN_ARGS__ = [];
    window.__HORMA_LIFECYCLE__ = {
      firstTerminal: false,
      secondPreview: false,
      secondPreviewRetired: false,
      secondFinished: false,
    };
    window.__HORMA_SPOKEN__ = [];
    if (lifecycleScenario) {
      class MockUtterance {
        constructor(text) { this.text = text; }
      }
      Object.defineProperty(window, "SpeechSynthesisUtterance", {
        configurable: true,
        value: MockUtterance,
      });
      Object.defineProperty(window, "speechSynthesis", {
        configurable: true,
        value: {
          cancel() {},
          getVoices() { return [{ name: "Mock female", lang: "en-US", localService: true }]; },
          addEventListener() {},
          speak(utterance) { window.__HORMA_SPOKEN__.push(utterance.text); },
        },
      });
    }

    async function simulateLongTask(prompt, sessionId) {
      window.__HORMA_LONG_RUNS__ += 1;
      const runNumber = window.__HORMA_LONG_RUNS__;
      const trace = window.__HORMA_LONG_EVENTS__;
      const event = (kind, payload) => {
        trace.push(kind === "end" ? `end:${payload.reason}` : kind);
        emit("agent", { kind, session_id: sessionId, payload });
      };

      const smartAgentEnabled = !(lifecycleScenario && runNumber === 2);
      event("start", {
        prompt,
        provider: "HORMACHUELOS FREE",
        model: settings.model,
        permission_mode: "auto",
        smart_agent_enabled: smartAgentEnabled,
      });

      if (lifecycleScenario && runNumber === 2) {
        event("thinking", { iteration: 0 });
        event("tool_preview", {
          id: "tool-preview-0-0",
          name: "grep",
          arguments_delta: "{\"path\":\"\"}",
        });
        window.__HORMA_LIFECYCLE__.secondPreview = true;
        await delay(220);
        event("tool_preview_end", {
          id: "tool-preview-0-0",
          name: "grep",
          reason: "Provider stream interrupted; retrying the tool request.",
        });
        window.__HORMA_LIFECYCLE__.secondPreviewRetired = true;
        await delay(120);
        event("thinking", { iteration: 1 });
        event("tool_call", {
          id: "recovered-grep",
          name: "grep",
          arguments: { pattern: "optimizer", path: "." },
        });
        event("tool_result", {
          id: "recovered-grep",
          name: "grep",
          ok: true,
          content: "Recovered search completed.",
        });
        event("text", { text: "Recovered the interrupted tool and finished the follow-up." });
        event("end", { reason: "no_tool_calls", iteration: 2 });
        window.__HORMA_LIFECYCLE__.secondFinished = true;
        return;
      }

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
          { id: "debug", label: "Debug failures", state: "pending" },
          { id: "deliver", label: "Deliver the result", state: "pending" },
        ],
      });

      // Fifteen tool rounds model a genuinely long hosted task. Fourteen
      // interrupted-stream recoveries deliberately exceed the legacy
      // twelve-recovery ceiling. Each recovery follows concrete tool work;
      // the host must keep the one task alive instead of producing an `end`
      // event or waiting for the client to type Continue.
      const defaultToolPlan = Array.from({ length: 15 }, (_, round) => ({
        name: round < 2 ? "read_file" : round < 12 ? "write_file" : round < 14 ? "run_command" : "grep",
        arguments: round < 2 ? { path: "src/main.ts" } : round < 12
          ? { path: `src/feature-${round}.ts`, content: "// simulated" }
          : round < 14
            ? { command: "npm run check" }
            : { pattern: "Error", path: "src" },
      }));
      const toolPlan = Array.isArray(window.__HORMA_LONG_TOOL_PLAN__) && window.__HORMA_LONG_TOOL_PLAN__.length
        ? window.__HORMA_LONG_TOOL_PLAN__
        : defaultToolPlan;
      const totalWorkRounds = toolPlan.length;
      const parallelSafe = new Set(["list_dir", "glob", "grep", "read_file", "git_status", "file_info"]);
      const initialBatch = toolPlan
        .slice(0, 6)
        .filter((tool) => parallelSafe.has(tool.name))
        .map((tool, index) => ({ ...tool, id: `long-task-${index}` }));
      if (settings.permission_mode === "multi_agent" && initialBatch.length >= 2) {
        event("multi_agent_batch", { tools: initialBatch });
      }
      for (let round = 0; round < totalWorkRounds; round += 1) {
        event("thinking", { iteration: round });
        const step = round < 2 ? 1 : round < totalWorkRounds - 3 ? 2 : round < totalWorkRounds - 1 ? 3 : 4;
        event("task_progress", {
          step,
          phase: ["scope", "inspect", "implement", "validate", "debug", "deliver"][step],
          status: "active",
          completed_before: step,
          detail: step === 4
            ? "Debugging failures and inspecting runtime evidence..."
            : step === 3
              ? "Running a focused validation check..."
              : "Applying the requested changes...",
        });
        const tool = toolPlan[round];
        const id = `long-task-${round}`;
        event("tool_call", {
          id,
          name: tool.name,
          arguments: tool.arguments,
        });
        event("tool_result", {
          id,
          name: tool.name,
          ok: true,
          content: "ok",
        });
        if (round < totalWorkRounds - 1) {
          // A recovery is live status, not model reasoning. Treating it as
          // reasoning made the same continuation sentence accumulate inside
          // the thought transcript while a long run was still progressing.
          event("status", {
            iteration: round,
            message: "Response limit reached — resuming from the next unfinished step…",
          });
        }
        await delay(12);
      }

      event("task_progress", {
        step: 5,
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
      if (lifecycleScenario && runNumber === 1) {
        window.__HORMA_LIFECYCLE__.firstTerminal = true;
        // Reproduce Tauri's small event/command-return gap. Completion audio
        // must wait for this command to return and for queued work to drain.
        await delay(420);
      }
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
            window.__HORMA_AGENT_RUN_ARGS__.push({ ...args });
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
  }, { projectRoot: PROJECT_ROOT, lifecycleScenario });
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
  // The compact Smart Agent strip intentionally uses short labels, but it must
  // still visibly show that the task completed and that every ledger step did.
  const smartAgentStatus = page.locator("#smart-agent-status");
  await expect(smartAgentStatus.locator(".smart-agent-badge.completed")).toHaveText("Done");
  await expect(smartAgentStatus.locator(".smart-agent-step.completed")).toHaveCount(6);
  await expect(smartAgentStatus).toContainText("Check");

  await expect.poll(() => page.evaluate(() => window.__HORMA_LONG_RUNS__)).toBe(1);
  const runArgs = await page.evaluate(() => window.__HORMA_AGENT_RUN_ARGS__);
  expect(runArgs[0].taskProfile).toBe("default");
  const trace = await page.evaluate(() => window.__HORMA_LONG_EVENTS__);
  expect(trace.filter((event) => event === "tool_call").length).toBeGreaterThanOrEqual(15);
  // More recoveries than the former global 12-pass safeguard, each after a
  // concrete tool turn. A long task must still complete as a single run.
  expect(trace.filter((event) => event === "status").length).toBeGreaterThanOrEqual(14);
  expect(trace).toContain("end:completed");
  expect(trace).not.toContain("end:continuation_safety_guard");
  await expect(page.locator("#chat")).not.toContainText("Response limit reached");

  const send = page.getByRole("button", { name: "Send message", exact: true });
  await expect(send).toBeEnabled();
  await page.screenshot({ path: path.join(OUT, "long-hormachuelos-session.png"), fullPage: true });

  const fatal = consoleErrors.filter((entry) => !/mock|tauri|invoke|favicon|vite/i.test(entry));
  expect(fatal, fatal.join("\n")).toEqual([]);
});

test("Multi-Agent UI completes every advertised tool without leaving a pending card", async ({ page }) => {
  await page.addInitScript(() => {
    window.__HORMA_LONG_PERMISSION_MODE__ = "multi_agent";
  });
  await page.addInitScript((toolPlan) => {
    window.__HORMA_LONG_TOOL_PLAN__ = toolPlan;
  }, ADVERTISED_TOOL_PLAN);
  await installHormachuelosLongRunMock(page);
  await page.route("https://hormachuelos.vercel.app/api/update?*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ updateAvailable: false, forceUpdate: false, currentVersion: "0.1.57", latest: null }),
  }));
  await page.route("https://hormachuelos.vercel.app/api/auth/me", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, user: { email: "minecraft@example.com", plan: "pro" } }),
  }));

  await page.goto(APP, { waitUntil: "networkidle" });
  const input = page.locator("#forge-prompt, .composer-input, textarea").first();
  await input.fill("Create a polished Minecraft-style browser game and keep working until preview and checks are ready.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();

  const chat = page.locator("#chat");
  await expect(chat).toContainText("Long-session Hormachuelos task complete.", { timeout: 30000 });
  await expect(chat.locator(".multi-agent-batch")).toContainText("Multi-Agent");
  await expect(chat.locator(".multi-agent-batch .multi-agent-live")).toHaveText("DONE");
  for (const { name: tool } of ADVERTISED_TOOL_PLAN) {
    await expect(chat.locator(`.tool-name[data-tool="${tool}"]`)).toHaveCount(1);
  }
  await expect(chat).not.toContainText(/tool naming error|unknown tool|list_dirglob/i);
  await expect(chat.locator(".tool-card.pending, .tool-card.streaming")).toHaveCount(0);

  const trace = await page.evaluate(() => window.__HORMA_LONG_EVENTS__);
  expect(trace.filter((event) => event === "tool_call")).toHaveLength(ADVERTISED_TOOL_PLAN.length);
  expect(trace).toContain("end:completed");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
});

test("queued follow-up retires an interrupted preview before announcing completion", async ({ page }) => {
  await installHormachuelosLongRunMock(page, { lifecycleScenario: true });
  await page.route("https://hormachuelos.vercel.app/api/update?*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ updateAvailable: false, forceUpdate: false, currentVersion: "0.1.60", latest: null }),
  }));
  await page.route("https://hormachuelos.vercel.app/api/auth/me", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, user: { email: "lifecycle@example.com", plan: "pro" } }),
  }));

  await page.goto(APP, { waitUntil: "networkidle" });
  const input = page.locator("#forge-prompt, .composer-input, textarea").first();
  await input.fill("Build and verify the first project task.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();

  // Queue a follow-up while the first run is active. The first completion event
  // must not announce global idleness because this work is already queued.
  await input.fill("Check the optimizer one more time.");
  await page.getByRole("button", { name: /Queue message while AI works/ }).click();
  await expect.poll(() => page.evaluate(() => window.__HORMA_LIFECYCLE__.firstTerminal)).toBe(true);
  expect(await page.evaluate(() => window.__HORMA_SPOKEN__)).toEqual([]);

  await expect.poll(() => page.evaluate(() => window.__HORMA_LIFECYCLE__.secondPreview)).toBe(true);
  await expect(page.locator("#smart-agent-status")).toBeHidden();
  await expect(page.locator("#chat .tool-card.pending, #chat .tool-card.streaming")).toHaveCount(1);
  expect(await page.evaluate(() => window.__HORMA_SPOKEN__)).toEqual([]);

  await expect.poll(() => page.evaluate(() => window.__HORMA_LIFECYCLE__.secondPreviewRetired)).toBe(true);
  await expect(page.locator("#chat .tool-card.pending, #chat .tool-card.streaming")).toHaveCount(0);
  await expect(page.locator("#chat")).toContainText("Provider stream interrupted; retrying the tool request.");

  await expect.poll(() => page.evaluate(() => window.__HORMA_LIFECYCLE__.secondFinished)).toBe(true);
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => window.__HORMA_SPOKEN__)).toEqual(["done working"]);
});
