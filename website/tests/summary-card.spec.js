import { test, expect } from "@playwright/test";

const APP = "http://localhost:1420";

test.use({
  baseURL: APP,
  viewport: { width: 1280, height: 800 },
});

test("completion summary keeps the result and verification details distinct", async ({ page }) => {
  const consoleErrors = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.goto(`${APP}/summary-harness.html`, { waitUntil: "networkidle" });
  const card = page.locator(".summary-card");

  await expect(card).toBeVisible();
  await expect(card.locator(".summary-status")).toHaveText("Completed");
  await expect(card.locator(".summary-title")).toHaveText("Gantt Heading Rename");
  await expect(card.locator("[data-summary-primary]"))
    .toHaveText("Updated the Gantt chart heading to PRAJEK MANEJIR and verified the page renders cleanly.");
  await expect(card.locator('[data-summary-section="verified"]'))
    .toContainText("all 17 chart rows still load, and there are zero console errors.");
  await expect(card.locator('[data-summary-section="included"]')).toHaveCount(0);
  await expect(card.locator(".summary-meta")).toContainText("HTML");
  await expect(card.locator(".summary-meta")).toContainText("1 file");
  await expect(card.getByRole("button", { name: "Export Client Pack" })).toBeVisible();

  const cardText = await card.innerText();
  expect((cardText.match(/PRAJEK MANEJIR/g) || [])).toHaveLength(1);
  expect((cardText.match(/zero console errors/gi) || [])).toHaveLength(1);

  const fatal = consoleErrors.filter((entry) => !/favicon|vite|tauri/i.test(entry));
  expect(fatal, fatal.join("\n")).toEqual([]);
});
