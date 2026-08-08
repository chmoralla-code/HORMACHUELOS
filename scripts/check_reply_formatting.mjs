import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");

function loadReplyFormatter() {
  const source = readFileSync(new URL("../src/components/util.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  const sandbox = { module: { exports: {} }, exports: null };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(output, sandbox, { filename: "util.ts" });
  return sandbox.module.exports.normalizeAssistantMarkdown;
}

const normalizeAssistantMarkdown = loadReplyFormatter();

const malformedCompletion = [
  "done",
  "Title: Enhanced Snake Game",
  "Description: A polished snake game with responsive controls.",
  "Features:",
  "- Smooth particle effects",
  "- Dynamic difficulty scaling",
  "Tech: HTML5 Canvas, JavaScript",
  "Files: snake/game.js",
  "",
  "index",
  ".",
  "html`,",
  "`,",
  "snake",
  "/",
  "style",
  ".",
  "css`,",
].join("\n");

const cleaned = normalizeAssistantMarkdown(malformedCompletion);
assert.match(cleaned, /^## Enhanced Snake Game/m);
assert.match(cleaned, /^### Highlights$/m);
assert.match(cleaned, /^### Technology$/m);
assert.match(cleaned, /^### Files$/m);
assert.match(cleaned, /- `snake\/game\.js`/);
assert.match(cleaned, /index\.html/);
assert.match(cleaned, /snake\/style\.css/);
assert.doesNotMatch(cleaned, /^done$/im);

const fenced = "```json\n{\"files\":[\"index\",\".\",\"html\"]}\n```";
assert.equal(normalizeAssistantMarkdown(fenced), fenced);
assert.equal(
  normalizeAssistantMarkdown('Before\n<tool_call>{"name":"done"}</tool_call>\nAfter'),
  "Before\n\nAfter",
);

// Keep the session-bound lock intact even if the toolbar is refactored.
const modelBar = readFileSync(new URL("../src/components/modelbar.ts", import.meta.url), "utf8");
for (const requiredGuard of [
  "setActiveSessionRunProfile",
  "modelSelectionLocked",
  "allowModelSelection",
  "modelBtn.disabled = true",
  "effortBtn.disabled = true",
]) {
  assert.ok(modelBar.includes(requiredGuard), `missing model-lock guard: ${requiredGuard}`);
}

const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
for (const requiredLifecycleHook of [
  "const runModelProfiles",
  "runModelProfiles.set(sessionId",
  "runModelProfiles.delete(sessionId)",
  "syncActiveSessionModelLock();",
]) {
  assert.ok(main.includes(requiredLifecycleHook), `missing session-lock lifecycle hook: ${requiredLifecycleHook}`);
}

console.log("reply formatting and session model-lock checks passed");
