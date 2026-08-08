import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const APP = "http://localhost:1420";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "test-results");

test.use({
  baseURL: APP,
  viewport: { width: 1280, height: 900 },
});

test.beforeAll(() => fs.mkdirSync(OUT, { recursive: true }));

test("Client Success Center persists project intent, dispatches workflows, and creates a handoff", async ({ page }) => {
  const consoleErrors = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.goto(`${APP}/client-success-harness.html`, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });

  await page.getByRole("button", { name: "Open Client Success Center" }).click();
  const dialog = page.getByRole("dialog", { name: "Make this project easy to win and deliver" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Acme Launch", { exact: true })).toBeVisible();

  await page.locator('[data-client-brief="goal"]').fill("Launch a fast booking website that converts mobile visitors.");
  await page.locator('[data-client-brief="audience"]').fill("Independent salons and their customers");
  await page.locator('[data-client-brief="requirements"]').fill("Keep the brand, preserve current bookings, and keep every primary path usable on a phone.");
  await page.locator('[data-client-brief="done"]').fill("A visitor can find a service, book it, and receive a clear confirmation in the live preview.");
  await page.getByRole("button", { name: "Save outcome brief" }).click();
  await expect(page.locator('[data-client-success-status="true"]')).toContainText("Outcome brief saved");
  await expect(page.locator('[data-readiness-score="1"]')).toHaveText("25%");

  const missionPrompt = await page.evaluate(() => window.__clientSuccessHarness.compose());
  expect(missionPrompt).toContain("[Persistent Project Outcome Brief]");
  expect(missionPrompt).toContain("Launch a fast booking website");
  expect(missionPrompt).toContain("Independent salons");
  expect(missionPrompt).toContain("Current user request:");
  expect(missionPrompt).toContain("Build the requested page");
  await page.screenshot({ path: path.join(OUT, "client-success-center.png"), fullPage: true });

  await page.locator('[data-client-workflow="qa"] [data-run-workflow="qa"]').click();
  await expect(page.locator('[data-client-success-status="true"]')).toContainText("Workflow sent to the active model");
  const workflowEvents = await page.evaluate(() => window.__clientSuccessHarness.events);
  expect(workflowEvents).toHaveLength(1);
  expect(workflowEvents[0].kind).toBe("workflow");
  expect(workflowEvents[0].prompt).toContain("QA & Repair workflow");
  expect(workflowEvents[0].prompt).toContain("Do not stop at an observation");

  await page.getByRole("button", { name: "Create client pack" }).click();
  await expect(page.locator('[data-client-success-status="true"]')).toContainText("Acme Launch-client-pack.zip");
  const allEvents = await page.evaluate(() => window.__clientSuccessHarness.events);
  expect(allEvents).toHaveLength(2);
  expect(allEvents[1].kind).toBe("pack");
  expect(allEvents[1].handoffSummary).toContain("# Client delivery brief");
  expect(allEvents[1].handoffSummary).toContain("Launch a fast booking website");
  await expect(page.locator('[data-readiness-score="2"]')).toHaveText("50%");

  await page.getByRole("button", { name: "Close Client Success Center" }).click();
  await page.getByRole("button", { name: "Open Client Success Center" }).click();
  await expect(page.locator('[data-client-brief="goal"]')).toHaveValue("Launch a fast booking website that converts mobile visitors.");
  await expect(page.locator('[data-client-brief="done"]')).toHaveValue("A visitor can find a service, book it, and receive a clear confirmation in the live preview.");

  const fatal = consoleErrors.filter((entry) => !/favicon|vite/i.test(entry));
  expect(fatal, fatal.join("\n")).toEqual([]);
});
