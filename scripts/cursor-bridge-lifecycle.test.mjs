import assert from "node:assert/strict";
import test from "node:test";

import { cursorRunFinishedSuccessfully } from "./cursor-bridge.mjs";

test("open Cursor tools are not reported as successful after an interrupted run", () => {
  assert.equal(cursorRunFinishedSuccessfully("finished", null), true);
  assert.equal(cursorRunFinishedSuccessfully("error", null), false);
  assert.equal(cursorRunFinishedSuccessfully("failed", "provider disconnected"), false);
  assert.equal(cursorRunFinishedSuccessfully("cancelled", null), false);
  assert.equal(cursorRunFinishedSuccessfully("running", null), false);
});
