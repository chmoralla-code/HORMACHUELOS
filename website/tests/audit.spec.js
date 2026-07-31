/**
 * Playwright audit for Hormachuelos marketing site.
 * Covers routes, auth, pricing, checkout, a11y basics, console errors, mobile.
 */
import { test, expect } from "@playwright/test";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "test-results");
const findings = [];

function note(severity, area, message, detail = "") {
  findings.push({ severity, area, message, detail });
}

function uniqueEmail() {
  return `qa_${Date.now()}_${Math.floor(Math.random() * 9999)}@test.local`;
}

test.beforeAll(() => {
  fs.mkdirSync(OUT, { recursive: true });
});

test.afterAll(() => {
  const report = {
    generatedAt: new Date().toISOString(),
    baseURL: "http://localhost:5174",
    findings,
    summary: {
      total: findings.length,
      critical: findings.filter((f) => f.severity === "critical").length,
      major: findings.filter((f) => f.severity === "major").length,
      minor: findings.filter((f) => f.severity === "minor").length,
      improvement: findings.filter((f) => f.severity === "improvement").length,
    },
  };
  fs.writeFileSync(path.join(OUT, "audit-findings.json"), JSON.stringify(report, null, 2));
  const md = [
    "# Hormachuelos website — Playwright audit",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `Critical: ${report.summary.critical} · Major: ${report.summary.major} · Minor: ${report.summary.minor} · Improvements: ${report.summary.improvement}`,
    "",
    ...findings.map(
      (f, i) =>
        `### ${i + 1}. [${f.severity.toUpperCase()}] ${f.area}\n\n${f.message}${f.detail ? `\n\n_${f.detail}_` : ""}\n`,
    ),
  ].join("\n");
  fs.writeFileSync(path.join(OUT, "AUDIT.md"), md);
});

test.describe("Smoke & routes", () => {
  test("home loads with hero and no crash", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await page.goto("/");
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.getByRole("link", { name: /pricing/i }).first()).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "01-home.png"), fullPage: true });

    if (errors.length) {
      note("major", "console", "JS errors on home load", errors.join(" | "));
    }
    expect(errors, `Console/page errors: ${errors.join("; ")}`).toEqual([]);
  });

  test("all primary hash routes render", async ({ page }) => {
    const routes = [
      ["#/", "GCash"],
      ["#/features", "Features"],
      ["#/pricing", "Pricing"],
      ["#/faq", "FAQ"],
      ["#/support", "Support"],
      ["#/login", "Log in"],
      ["#/signup", "Create account"],
      ["#/download", "Download"],
      ["#/terms", "Terms"],
      ["#/privacy", "Privacy"],
      ["#/refund", "Refund"],
    ];
    await page.goto("/");
    for (const [hash, needle] of routes) {
      await page.goto(`/${hash}`);
      await page.waitForTimeout(200);
      const main = page.locator("#main");
      await expect(main).toBeVisible();
      const text = await main.innerText();
      if (!text.toLowerCase().includes(needle.toLowerCase()) && hash !== "#/") {
        // home checked loosely
        note("major", "routing", `Route ${hash} missing expected text "${needle}"`, text.slice(0, 200));
      }
      expect(text.length, `Empty main for ${hash}`).toBeGreaterThan(20);
    }
  });

  test("404 route shows not found", async ({ page }) => {
    await page.goto("/#/this-does-not-exist");
    await expect(page.locator("#main")).toContainText(/404|not found/i);
  });
});

test.describe("Auth flows", () => {
  test("signup → dashboard → logout", async ({ page }) => {
    const email = uniqueEmail();
    const password = "testpass123";

    await page.goto("/#/signup");
    await page.fill("#su-name", "QA Tester");
    await page.fill("#su-email", email);
    await page.fill("#su-password", password);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(400);

    // Should leave signup
    const hash = await page.evaluate(() => location.hash);
    if (hash.includes("signup")) {
      note("critical", "auth", "Signup did not navigate away from signup page", hash);
    }
    expect(hash).not.toContain("signup");

    // Header should show user or logout
    const loggedIn = await page.locator(".user-chip, button:has-text('Log out')").count();
    if (loggedIn === 0) {
      note("major", "auth", "After signup, no user chip / logout in header");
    }
    expect(loggedIn).toBeGreaterThan(0);

    await page.goto("/#/dashboard");
    await expect(page.locator("#main")).toContainText(/Dashboard|Signed in/i);
    await expect(page.locator("#main")).toContainText(email);
    await page.screenshot({ path: path.join(OUT, "02-dashboard.png"), fullPage: true });

    await page.getByRole("button", { name: /log out/i }).click();
    await page.waitForTimeout(300);
    await page.goto("/#/dashboard");
    // Should redirect to login
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => location.hash);
    if (!after.includes("login")) {
      note("major", "auth", "Dashboard accessible without session after logout", after);
    }
    expect(after).toMatch(/login/i);
  });

  test("login rejects bad password", async ({ page }) => {
    const email = uniqueEmail();
    await page.goto("/#/signup");
    await page.fill("#su-name", "Bad Pass");
    await page.fill("#su-email", email);
    await page.fill("#su-password", "goodpass1");
    await page.click('button[type="submit"]');
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: /log out/i }).click();
    await page.waitForTimeout(200);

    await page.goto("/#/login");
    await page.fill("#login-email", email);
    await page.fill("#login-password", "wrong-password");
    await page.click('button[type="submit"]');
    await expect(page.locator("#login-error")).toBeVisible();
    await expect(page.locator("#login-error")).toContainText(/invalid/i);
  });

  test("duplicate signup shows error", async ({ page }) => {
    const email = uniqueEmail();
    for (let i = 0; i < 2; i++) {
      await page.goto("/#/signup");
      // if already logged in from first signup, logout
      const logout = page.getByRole("button", { name: /log out/i });
      if (await logout.count()) {
        await logout.click();
        await page.waitForTimeout(200);
        await page.goto("/#/signup");
      }
      await page.fill("#su-name", "Dup User");
      await page.fill("#su-email", email);
      await page.fill("#su-password", "duppass1");
      await page.click('button[type="submit"]');
      await page.waitForTimeout(350);
    }
    // Second attempt should error if still on signup, or we need to be logged out first
    const err = page.locator("#signup-error");
    if (await err.isVisible().catch(() => false)) {
      await expect(err).toContainText(/already exists/i);
    } else {
      // might have navigated — check we can still detect duplicate on clean form
      await page.goto("/#/signup");
      const logout = page.getByRole("button", { name: /log out/i });
      if (await logout.count()) await logout.click();
      await page.goto("/#/signup");
      await page.fill("#su-name", "Dup User");
      await page.fill("#su-email", email);
      await page.fill("#su-password", "duppass1");
      await page.click('button[type="submit"]');
      await expect(page.locator("#signup-error")).toContainText(/already exists/i);
    }
  });
});

test.describe("Pricing & checkout", () => {
  test("pricing shows pay-as-you-go model and plan cards", async ({ page }) => {
    await page.goto("/#/pricing");
    await expect(page.locator("#pricing-model")).toContainText(/usage limit base pricing/i);
    await expect(page.locator(".price-card").first()).toBeVisible();

    const starterPrice = await page.locator(".price-card .num").first().innerText();
    const proPrice = await page.locator(".price-card.featured .num").innerText();

    expect(starterPrice).not.toEqual(proPrice);

    const cards = await page.locator(".price-card").count();
    expect(cards).toBe(3);
    await page.screenshot({ path: path.join(OUT, "03-pricing.png"), fullPage: true });

    if (proPrice) {
      note("improvement", "pricing", "Verify pay-as-you-go prices match product strategy", `Sample num: ${proPrice}`);
    }
  });

  test("checkout requires auth then completes GCash demo", async ({ page }) => {
    const email = uniqueEmail();
    await page.goto("/#/pricing");
    await page.getByRole("button", { name: /Choose Pro/i }).first().click();
    await page.waitForTimeout(400);
    let hash = await page.evaluate(() => location.hash);
    if (!hash.includes("signup") && !hash.includes("login") && !hash.includes("checkout")) {
      note("major", "checkout", "Choose plan did not navigate to signup/checkout", hash);
    }
    // If redirected to signup
    if (hash.includes("signup")) {
      await page.fill("#su-name", "Buyer");
      await page.fill("#su-email", email);
      await page.fill("#su-password", "buyme123");
      await page.click('button[type="submit"]');
      await page.waitForTimeout(500);
      hash = await page.evaluate(() => location.hash);
    }

    // Should land on checkout (next param)
    if (!hash.includes("checkout")) {
      // navigate manually if next failed
      note("major", "checkout", "After signup from pricing, next did not open checkout", hash);
      await page.goto("/#/checkout?plan=pro&period=monthly");
    }

    await expect(page.locator("#main")).toContainText(/Checkout|Order summary|GCash/i);
    await page.locator('input[value="GCash"]').check();
    await page.click("#pay-btn");
    await page.waitForTimeout(1200);
    hash = await page.evaluate(() => location.hash);
    expect(hash).toMatch(/success/i);
    await expect(page.locator("#main")).toContainText(/You're in|Payment|plan/i);
    await page.screenshot({ path: path.join(OUT, "04-success.png"), fullPage: true });

    await page.goto("/#/dashboard");
    await expect(page.locator("#main")).toContainText(/Pro|Active|order/i);
  });
});

test.describe("Interactive text & UX", () => {
  test("hero typewriter and compare row interaction", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(800);
    const typeEl = page.locator("#hero-type");
    await expect(typeEl).toBeVisible();
    const t1 = await typeEl.innerText();
    await page.waitForTimeout(2200);
    const t2 = await typeEl.innerText();
    // Should change over time unless reduced motion
    if (t1 === t2 && t1 === "") {
      note("minor", "interactive-text", "Hero typewriter stayed empty");
    }

    const row = page.locator("#compare-table tbody tr").first();
    await row.click();
    await page.waitForTimeout(600);
    const live = await page.locator("#compare-live").innerText();
    if (live.includes("Click a row")) {
      note("minor", "interactive-text", "Compare live text did not update after row click", live);
    }
    expect(live.length).toBeGreaterThan(10);
  });

  test("FAQ opens and types answer", async ({ page }) => {
    await page.goto("/#/faq");
    const items = page.locator(".faq-item");
    await expect(items.first()).toBeVisible();
    // open second item
    if ((await items.count()) > 1) {
      await items.nth(1).locator("button").click();
      await page.waitForTimeout(800);
      const ans = await items.nth(1).locator(".answer").innerText();
      expect(ans.length).toBeGreaterThan(20);
    }
  });
});

test.describe("Accessibility & responsive", () => {
  test("skip link and main landmarks", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("a.skip-link")).toHaveAttribute("href", "#main");
    await expect(page.locator("main#main")).toBeVisible();
    await expect(page.locator("header")).toBeVisible();
    await expect(page.locator("footer")).toBeVisible();

    // Focusable pay buttons should have type
    const buttons = page.locator("button");
    const count = await buttons.count();
    if (count === 0) note("minor", "a11y", "No buttons found on home");
  });

  test("mobile viewport: nav toggle works", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const toggle = page.locator("#nav-toggle");
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.locator("#nav")).toHaveClass(/open/);
    await page.locator('#nav a[href="#/pricing"]').click();
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => location.hash)).toContain("pricing");
    await page.screenshot({ path: path.join(OUT, "05-mobile-pricing.png"), fullPage: true });
  });

  test("form labels associated", async ({ page }) => {
    await page.goto("/#/signup");
    for (const id of ["su-name", "su-email", "su-password"]) {
      const label = page.locator(`label[for="${id}"]`);
      if ((await label.count()) === 0) {
        note("minor", "a11y", `Missing label for #${id}`);
      }
      await expect(label).toBeVisible();
    }
  });
});

test.describe("Security / quality notes", () => {
  test("passwords stored client-side (demo risk)", async ({ page }) => {
    const email = uniqueEmail();
    await page.goto("/#/signup");
    await page.fill("#su-name", "Sec Check");
    await page.fill("#su-email", email);
    await page.fill("#su-password", "secret99");
    await page.click('button[type="submit"]');
    await page.waitForTimeout(300);

    const usersRaw = await page.evaluate(() => localStorage.getItem("horma:users"));
    if (usersRaw && usersRaw.includes("secret99")) {
      note(
        "major",
        "security",
        "Passwords stored in plaintext in localStorage (ok for demo, not for production)",
        "horma:users contains raw password",
      );
    }
    if (!usersRaw) {
      note("minor", "storage", "No horma:users after signup");
    }
  });

  test("external assets: fonts load or fail gracefully", async ({ page }) => {
    const failed = [];
    page.on("requestfailed", (req) => {
      if (req.url().includes("fonts.googleapis") || req.url().includes("fonts.gstatic")) {
        failed.push(req.url());
      }
    });
    await page.goto("/");
    await page.waitForTimeout(1500);
    if (failed.length) {
      note("improvement", "perf", "Google Fonts request failed — consider self-hosting for PH latency", failed[0]);
    }
  });
});

test.describe("Heuristic improvements", () => {
  test("collect product UX improvements", async ({ page }) => {
    await page.goto("/");
    // Live payment disclaimer visibility
    await page.goto("/#/pricing");
    const body = await page.locator("#main").innerText();
    if (!/demo|temporary|coming soon/i.test(body)) {
      note("improvement", "trust", "Pricing page should more clearly state payments are demo until PayMongo is live");
    } else {
      note("improvement", "trust", "Demo disclaimer present — keep it until real GCash goes live");
    }

    // CTA contrast: primary buttons exist
    const primary = await page.locator(".btn-primary").count();
    if (primary < 1) note("minor", "ui", "No primary CTA on pricing");

    // GCash badge present
    if (!(await page.locator(".pay-badge", { hasText: "GCash" }).count())) {
      note("improvement", "positioning", "Add more visible GCash branding on pricing");
    }

    // SEO: title
    const title = await page.title();
    if (!/Hormachuelos|GCash/i.test(title)) {
      note("minor", "seo", "Page title should include brand / GCash keywords", title);
    }

    // meta description
    const desc = await page.locator('meta[name="description"]').getAttribute("content");
    if (!desc || desc.length < 40) {
      note("improvement", "seo", "Strengthen meta description for PH search");
    }

    note(
      "improvement",
      "product",
      "Wire PayMongo/Xendit webhooks; replace localStorage auth with real backend before public launch",
    );
    note(
      "improvement",
      "product",
      "Add receipt/email after payment and OR-ready invoice for PH freelancers",
    );
    note(
      "improvement",
      "product",
      "Add loading skeletons while typewriter runs so LCP text is stable for SEO crawlers",
    );
  });
});
