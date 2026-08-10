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
  await expect(sidebar.getByRole("button", { name: "Search projects" })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "Collapse projects" })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "Search sessions" })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "Collapse sessions" })).toBeVisible();
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

test("project and session search filter immediately and support keyboard dismissal", async ({ page }) => {
  await page.goto(`${APP}/update-harness.html`, { waitUntil: "networkidle" });
  await page.locator("#background-action").evaluate((node) => { node.hidden = true; });

  const sidebar = page.locator("#sidebar");
  const projects = sidebar.locator(".sb-project-workspace");
  const sessions = sidebar.locator(".sb-session-item");

  await sidebar.getByRole("button", { name: "Search projects" }).click();
  const projectSearch = sidebar.getByRole("searchbox", { name: "Search projects" });
  await expect(projectSearch).toBeVisible();
  await expect(projectSearch).toBeFocused();
  await projectSearch.fill("beacon");
  await expect(projects.filter({ visible: true })).toHaveCount(1);
  await expect(projects.filter({ visible: true }).first()).toContainText("Beacon");

  await projectSearch.fill("missing workspace");
  await expect(projects.filter({ visible: true })).toHaveCount(0);
  await expect(sidebar.getByText("No matching projects.", { exact: true })).toBeVisible();

  await projectSearch.press("Escape");
  await expect(projectSearch).toHaveValue("");
  await expect(projects.filter({ visible: true })).toHaveCount(3);
  await projectSearch.press("Escape");
  await expect(projectSearch).toBeHidden();
  await expect(sidebar.getByRole("button", { name: "Search projects" })).toBeFocused();

  await sidebar.getByRole("button", { name: "Search sessions" }).click();
  const sessionSearch = sidebar.getByRole("searchbox", { name: "Search sessions" });
  await sessionSearch.fill("installation");
  await expect(sessions.filter({ visible: true })).toHaveCount(1);
  await expect(sessions.filter({ visible: true }).first()).toContainText("Refine the installation flow");

  await sessionSearch.fill("not here");
  await expect(sessions.filter({ visible: true })).toHaveCount(0);
  await expect(sidebar.getByText("No matching sessions.", { exact: true })).toBeVisible();
  await sidebar.getByRole("button", { name: "Close session search" }).click();
  await expect(sessionSearch).toBeHidden();
  await expect(sessions.filter({ visible: true })).toHaveCount(3);
});

test("projects and sessions collapse independently, persist, and reopen for search", async ({ page }) => {
  await page.goto(`${APP}/update-harness.html`, { waitUntil: "networkidle" });
  await page.locator("#background-action").evaluate((node) => { node.hidden = true; });

  const sidebar = page.locator("#sidebar");
  const projectBody = sidebar.locator("#sidebar-project-body");
  const sessionBody = sidebar.locator("#sidebar-session-body");

  await sidebar.getByRole("button", { name: "Collapse projects" }).click();
  await expect(projectBody).toBeHidden();
  await expect(sidebar.getByRole("button", { name: "Expand projects" })).toHaveAttribute("aria-expanded", "false");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ai-forge:sidebar-projects-collapsed"))).toBe("1");

  await sidebar.getByRole("button", { name: "Collapse sessions" }).click();
  await expect(sessionBody).toBeHidden();
  await expect(sidebar.getByRole("button", { name: "Expand sessions" })).toHaveAttribute("aria-expanded", "false");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ai-forge:sidebar-sessions-collapsed"))).toBe("1");

  await page.reload({ waitUntil: "networkidle" });
  await page.locator("#background-action").evaluate((node) => { node.hidden = true; });
  await expect(sidebar.locator("#sidebar-project-body")).toBeHidden();
  await expect(sidebar.locator("#sidebar-session-body")).toBeHidden();

  await sidebar.getByRole("button", { name: "Search projects" }).click();
  await expect(sidebar.locator("#sidebar-project-body")).toBeVisible();
  await expect(sidebar.getByRole("searchbox", { name: "Search projects" })).toBeFocused();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ai-forge:sidebar-projects-collapsed"))).toBe("0");

  await sidebar.getByRole("button", { name: "Search sessions" }).click();
  await expect(sidebar.locator("#sidebar-session-body")).toBeVisible();
  await expect(sidebar.getByRole("searchbox", { name: "Search sessions" })).toBeFocused();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ai-forge:sidebar-sessions-collapsed"))).toBe("0");
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
