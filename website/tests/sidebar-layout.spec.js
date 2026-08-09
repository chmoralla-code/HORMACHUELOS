import { test, expect } from "@playwright/test";

const APP = "http://localhost:1420";

test.use({
  baseURL: APP,
  viewport: { width: 1280, height: 900 },
});

test("sidebar keeps projects, sessions, usage, and account status readable", async ({ page }) => {
  const consoleErrors = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.goto(`${APP}/update-harness.html`, { waitUntil: "networkidle" });

  const sidebar = page.locator("#sidebar");
  const projectRows = sidebar.locator(".sb-projects-list .sb-project-workspace");
  const sessionRows = sidebar.locator(".sb-recent .sb-session-item");

  await expect(sidebar.getByRole("button", { name: "Add another project" })).toBeVisible();
  await expect(projectRows).toHaveCount(3);
  await expect(sessionRows).toHaveCount(3);
  await expect(sidebar.getByText("Usage", { exact: true })).toBeVisible();
  await expect(sidebar.getByText("Account", { exact: true })).toBeVisible();
  await expect(sidebar.getByText("Synced · signed in", { exact: true })).toBeVisible();

  const projectList = await sidebar.locator(".sb-projects-list").boundingBox();
  const sessionList = await sidebar.locator(".sb-recent").boundingBox();
  expect(projectList).not.toBeNull();
  expect(sessionList).not.toBeNull();
  expect(sessionList.height).toBeGreaterThanOrEqual(108);

  for (let index = 0; index < await projectRows.count(); index += 1) {
    const box = await projectRows.nth(index).boundingBox();
    expect(box).not.toBeNull();
    expect(box.y + box.height).toBeLessThanOrEqual(projectList.y + projectList.height + 1);
  }

  const fatal = consoleErrors.filter((entry) => !/favicon|vite/i.test(entry));
  expect(fatal, fatal.join("\n")).toEqual([]);
});

test("sidebar keeps an active session reachable in a compact desktop window", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 720 });
  await page.goto(`${APP}/update-harness.html`, { waitUntil: "networkidle" });

  const firstSession = page.locator("#sidebar .sb-session-item").first();
  await expect(firstSession).toBeVisible();

  const box = await firstSession.boundingBox();
  const usage = await page.locator("#sidebar .sb-usage-section").boundingBox();
  const account = await page.locator("#sidebar .sb-account-section").boundingBox();
  expect(box).not.toBeNull();
  expect(usage).not.toBeNull();
  expect(account).not.toBeNull();
  expect(box.y + box.height).toBeLessThanOrEqual(720);
  expect(usage.y + usage.height).toBeLessThanOrEqual(account.y + 1);
});
