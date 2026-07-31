import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.js",
  timeout: 45000,
  expect: { timeout: 8000 },
  retries: 0,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "test-results/report.json" }]],
  use: {
    baseURL: "http://localhost:5174",
    browserName: "chromium",
    headless: true,
    viewport: { width: 1280, height: 800 },
    actionTimeout: 12000,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
