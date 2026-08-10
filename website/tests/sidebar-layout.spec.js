import { test, expect } from "@playwright/test";

const APP = "http://localhost:1420";

test.use({
  baseURL: APP,
  viewport: { width: 1280, height: 900 },
});

test("sidebar nests usage in a collapsed account card and gives sessions more room", async ({ page }) => {
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
  await expect(sidebar.getByText("Account", { exact: true })).toBeVisible();
  await expect(sidebar.getByText("Synced · signed in", { exact: true })).toBeVisible();

  const account = sidebar.locator(".sb-account");
  const usageDisclosure = account.locator(".sb-account-usage");
  const usageToggle = usageDisclosure.locator("summary");
  const usagePanel = usageDisclosure.locator(".sb-usage");

  await expect(sidebar.locator(".sb-usage-section")).toHaveCount(0);
  await expect(sidebar.getByRole("button", { name: "Manage website account" })).toBeVisible();
  await expect(usageDisclosure).not.toHaveAttribute("open", "");
  await expect(usageToggle).toHaveAttribute("aria-expanded", "false");
  await expect(usageToggle.getByText("Usage", { exact: true })).toBeVisible();
  await expect(usageToggle.getByText("93% left", { exact: true })).toBeVisible();
  await expect(usagePanel).toBeHidden();

  const projectList = await sidebar.locator(".sb-projects-list").boundingBox();
  const sessionList = await sidebar.locator(".sb-recent").boundingBox();
  expect(projectList).not.toBeNull();
  expect(sessionList).not.toBeNull();
  expect(sessionList.height).toBeGreaterThanOrEqual(180);

  for (let index = 0; index < await projectRows.count(); index += 1) {
    const box = await projectRows.nth(index).boundingBox();
    expect(box).not.toBeNull();
    expect(box.y + box.height).toBeLessThanOrEqual(projectList.y + projectList.height + 1);
  }

  await usageToggle.focus();
  await page.keyboard.press("Enter");
  await expect(usageDisclosure).toHaveAttribute("open", "");
  await expect(usageToggle).toHaveAttribute("aria-expanded", "true");
  await expect(usagePanel).toBeVisible();
  await expect(usagePanel.getByText("93% usage remaining", { exact: true })).toBeVisible();

  await page.keyboard.press("Space");
  await expect(usageDisclosure).not.toHaveAttribute("open", "");
  await expect(usagePanel).toBeHidden();

  const fatal = consoleErrors.filter((entry) => !/favicon|vite/i.test(entry));
  expect(fatal, fatal.join("\n")).toEqual([]);
});

test("collapsed account usage keeps the full session list visible in a compact desktop window", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 720 });
  await page.goto(`${APP}/update-harness.html`, { waitUntil: "networkidle" });

  const sidebar = page.locator("#sidebar");
  const projects = sidebar.locator(".sb-project-workspace");
  const sessions = sidebar.locator(".sb-session-item");
  const lastProject = projects.last();
  const firstSession = sessions.first();
  const lastSession = sessions.last();
  await expect(lastProject).toBeVisible();
  await expect(firstSession).toBeVisible();
  await expect(lastSession).toBeVisible();

  const lastProjectBox = await lastProject.boundingBox();
  const projectList = await sidebar.locator(".sb-projects-list").boundingBox();
  const lastSessionBox = await lastSession.boundingBox();
  const sessionList = await sidebar.locator(".sb-recent").boundingBox();
  const account = await sidebar.locator(".sb-account-section").boundingBox();
  const usageDisclosure = sidebar.locator(".sb-account-usage");
  expect(lastProjectBox).not.toBeNull();
  expect(projectList).not.toBeNull();
  expect(lastSessionBox).not.toBeNull();
  expect(sessionList).not.toBeNull();
  expect(account).not.toBeNull();
  expect(lastProjectBox.y + lastProjectBox.height).toBeLessThanOrEqual(projectList.y + projectList.height + 1);
  expect(sessionList.height).toBeGreaterThanOrEqual(135);
  expect(lastSessionBox.y + lastSessionBox.height).toBeLessThanOrEqual(account.y + 1);
  await expect(usageDisclosure).not.toHaveAttribute("open", "");
  await expect(usageDisclosure.locator(".sb-usage")).toBeHidden();
});
