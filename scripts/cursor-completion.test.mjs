import assert from "node:assert/strict";
import test from "node:test";

import { createCompletionMarkerFilter } from "./cursor-bridge.mjs";

const MARKER = "[[HORMACHUELOS_TASK_COMPLETE]]";

test("completion marker is hidden when it spans streamed chunks", () => {
  const visible = [];
  const filter = createCompletionMarkerFilter(MARKER, (text) => visible.push(text));

  filter.push("Implemented and verified the build. [[HORMACHUELOS_TASK_");
  filter.push("COMPLETE]]");
  filter.flush();

  assert.equal(visible.join(""), "Implemented and verified the build. ");
  assert.equal(filter.completed, true);
});

test("missing completion marker remains eligible for automatic follow-up", () => {
  const visible = [];
  const filter = createCompletionMarkerFilter(MARKER, (text) => visible.push(text));

  filter.push("Still running verification.");
  filter.flush();

  assert.equal(visible.join(""), "Still running verification.");
  assert.equal(filter.completed, false);
});
