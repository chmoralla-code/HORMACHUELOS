import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appUrl = new URL("../js/app.js", import.meta.url);
const cssUrl = new URL("../css/styles.css", import.meta.url);

test("download buttons route to the two-edition chooser", async () => {
  const app = await readFile(appUrl, "utf8");
  assert.match(app, /function renderDownloadButton[\s\S]*?href="#\/download">Download<\/a>/);
  assert.match(app, /Option 1[\s\S]*Hormachuelos Standard/);
  assert.match(app, /Option 2[\s\S]*Hormachuelos Optimized/);
});

test("download chooser pins both verified release tracks", async () => {
  const app = await readFile(appUrl, "utf8");
  assert.ok(app.includes("HORMACHUELOS/releases/download/v0.1.76"));
  assert.ok(app.includes("Hormachuelos_0.1.76_x64_en-US.msi"));
  assert.ok(app.includes("Hormachuelos_0.1.76_x64-setup.exe"));
  assert.ok(app.includes("HORMACHUELOS-OPTIMIZED/releases/download/v1.2.5-1"));
  assert.ok(app.includes("Hormachuelos_Optimized_1.2.5-1_x64.msi"));
  assert.ok(app.includes("Hormachuelos_Optimized_1.2.5-1_x64-setup.exe"));
  assert.match(app, /Ask Max retries silent replies/);
  assert.match(app, /Preview Computer Use can open and switch tabs/);
  assert.match(app, /reliably scroll pages, tables, and nested panels/);
  assert.match(app, /Native date, time, select, and other form controls/);
  assert.match(app, /pass\/fail evidence checks/);
  assert.match(app, /Cinematic target-aware AI cursor/);
  assert.match(app, /hover frames, press feedback, motion beads, shockwaves, and edge-safe labels/);
  assert.match(app, /FPS Optimized · New beta/);
  assert.match(app, /Separate installs:/);
});

test("download chooser has responsive two-card layout styles", async () => {
  const css = await readFile(cssUrl, "utf8");
  assert.match(css, /\.download-editions\s*\{[\s\S]*grid-template-columns:\s*repeat\(2,/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.download-editions\s*\{\s*grid-template-columns:\s*1fr;/);
});