/**
 * Hormachuelos marketing site — client-side SPA (localStorage mock auth + billing).
 * Temporary PHP prices. GCash-first checkout demo (no real payment gateway yet).
 */

const STORAGE_USER = "horma:user";
const STORAGE_USERS = "horma:users";
const STORAGE_ORDERS = "horma:orders";

/** Desktop installer files served from /website/downloads (copy after `npm run desktop:build`). */
const DESKTOP_DOWNLOADS = {
  version: "0.1.0",
  windows: {
    msi: {
      label: "Windows installer (MSI)",
      href: "./downloads/Hormachuelos_0.1.0_x64_en-US.msi",
      file: "Hormachuelos_0.1.0_x64_en-US.msi",
    },
    setup: {
      label: "Windows setup (EXE)",
      href: "./downloads/Hormachuelos_0.1.0_x64-setup.exe",
      file: "Hormachuelos_0.1.0_x64-setup.exe",
    },
  },
};

function primaryDownloadHref() {
  return DESKTOP_DOWNLOADS.windows.msi.href;
}

function renderDownloadButton(extraClass = "btn-lg") {
  const cls = extraClass ? ` ${extraClass}` : "";
  return `<a class="btn${cls}" href="${primaryDownloadHref()}" download="${DESKTOP_DOWNLOADS.windows.msi.file}">Download</a>`;
}

function renderDownloadButtons(extraClass = "") {
  const cls = extraClass ? ` ${extraClass}` : "";
  return `
    <a class="btn btn-primary btn-lg${cls}" href="${primaryDownloadHref()}" download="${DESKTOP_DOWNLOADS.windows.msi.file}">
      Download for Windows
    </a>
    <a class="btn btn-lg${cls}" href="${DESKTOP_DOWNLOADS.windows.setup.href}" download="${DESKTOP_DOWNLOADS.windows.setup.file}">
      Setup (.exe)
    </a>
  `;
}

/** Usage-limit base pricing — pay as you go (PHP). */
const BILLING = {
  payg: {
    id: "payg",
    label: "Pay as you go",
    short: "usage",
    period: "usage-based",
  },
};

/** Max tiers — lean ROI (~80% of plan price → usage pool). Pools vs Pro (1×). */
const MAX_ROI_TIERS = {
  "5x": {
    id: "max5",
    label: "5×",
    multiplier: 5,
    price: 2499,
    pool: "27.5M units",
    tagline: "Teams & parallel builds",
  },
  "10x": {
    id: "max10",
    label: "10×",
    multiplier: 10,
    price: 4999,
    pool: "55M units",
    tagline: "Agency sprints",
  },
  "20x": {
    id: "max20",
    label: "20×",
    multiplier: 20,
    price: 9999,
    pool: "110M units",
    tagline: "Multi-seat shops",
  },
};

const PLANS = [
  {
    id: "starter",
    name: "Starter",
    desc: "Real client work on your first GCash load.",
    featured: false,
    price: 299,
    features: [
      "Full desktop agent (GPT 5.6, Opus 5, Claude & more)",
      "Included usage wallet",
      "Plan · Auto modes",
      "Pinoy templates + Client Pack",
      "GCash & Maya checkout",
      "Messenger support",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    desc: "Daily client builds and serious side projects.",
    featured: true,
    price: 999,
    features: [
      "Everything in Starter",
      "3× usage headroom",
      "Full autonomy mode",
      "Priority model routing",
      "GCash credit top-ups",
      "Client Pack + deploy checklist",
      "Priority support (Viber / FB)",
    ],
  },
  {
    id: "max",
    name: "Max",
    tierLabel: "5× · 10× · 20×",
    desc: "Teams billing multiple clients in parallel.",
    featured: false,
    tiers: MAX_ROI_TIERS,
    defaultTier: "5x",
    features: [
      "Everything in Pro",
      "ROI-tier usage pool",
      "Up to 5 team seats",
      "Shared workspaces",
      "BIR-ready receipts",
      "Dedicated onboarding call",
    ],
  },
];

const FEATURES = [
  { icon: "AI", title: "Local-first agent", body: "Open a project folder and let the agent read, edit, and run tools — on your machine." },
  { icon: "₱", title: "Pay with GCash", body: "No foreign card required. Checkout in PHP with GCash or Maya — built for Filipino builders." },
  { icon: "Pk", title: "Client Pack", body: "One-click zip + CLIENT_HANDOFF.md with deploy checklist — ready to send to clients." },
  { icon: "Pl", title: "Plan · Auto · Full", body: "Start careful, scale autonomy when you trust the run. OpenCode-style controls." },
  { icon: "Mo", title: "Bring your models", body: "DeepSeek, OpenRouter, and more. Your keys, your spend, your rules." },
  { icon: "Ms", title: "Taglish + PH templates", body: "Reply in Taglish. Start from portfolio, sari-sari, booking, or FB ads landing." },
  { icon: "Cr", title: "Credit top-ups", body: "Mag-load when you need more tokens. Same wallet flow you already use daily." },
];

const FAQ = [
  {
    q: "Bakit mas unique ang Hormachuelos vs Cursor / ChatGPT?",
    a: "Global AI tools almost never accept GCash. We price in ₱ PHP and checkout with GCash / Maya so freelancers and students can pay without a credit card or USD billing.",
  },
  {
    q: "Real ba ang GCash payment ngayon?",
    a: "This site is a product demo: checkout is interactive and saves a local order. Live PayMongo / Xendit GCash will replace the mock when merchant KYC is ready.",
  },
  {
    q: "Paano gumagana ang pay-as-you-go pricing?",
    a: "Each plan includes a generous usage limit. When you need more, mag-load credits via GCash — no fixed monthly lock-in. Pay only for what you actually use.",
  },
  {
    q: "Kasama ba ang model API costs?",
    a: "Subscription unlocks the agent and a token budget. Heavy use may need GCash credit top-ups. You can also bring your own provider API keys.",
  },
  {
    q: "Pwede ba i-refund?",
    a: "Within 7 days of first paid purchase if you have not heavily used the token allotment — see Refunds. Contact support with your order id.",
  },
  {
    q: "Desktop app ba o web?",
    a: "Hormachuelos is a desktop agent (Tauri). This website handles account, plans, and GCash-ready billing.",
  },
];

// ——— storage helpers ———

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function getSessionUser() {
  return loadJSON(STORAGE_USER, null);
}

function setSessionUser(user) {
  if (user) saveJSON(STORAGE_USER, user);
  else localStorage.removeItem(STORAGE_USER);
}

function getUsers() {
  return loadJSON(STORAGE_USERS, []);
}

function upsertUser(user) {
  const users = getUsers();
  const i = users.findIndex((u) => u.email === user.email);
  if (i >= 0) users[i] = user;
  else users.push(user);
  saveJSON(STORAGE_USERS, users);
  return user;
}

function findUser(email) {
  return getUsers().find((u) => u.email.toLowerCase() === email.toLowerCase()) || null;
}

function getOrders() {
  return loadJSON(STORAGE_ORDERS, []);
}

function addOrder(order) {
  const orders = getOrders();
  orders.unshift(order);
  saveJSON(STORAGE_ORDERS, orders);
  return order;
}

function formatPHP(n) {
  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
    maximumFractionDigits: 0,
  }).format(n);
}

function toast(msg) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, 3200);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ——— routing ———

const routes = {
  "/": renderHome,
  "/features": renderFeatures,
  "/pricing": renderPricing,
  "/login": renderLogin,
  "/signup": renderSignup,
  "/dashboard": renderDashboard,
  "/checkout": renderCheckout,
  "/download": renderDownload,
  "/faq": renderFaq,
  "/support": renderSupport,
  "/terms": () => renderLegal("Terms of Service", TERMS),
  "/privacy": () => renderLegal("Privacy Policy", PRIVACY),
  "/refund": () => renderLegal("Refund Policy", REFUNDS),
  "/success": renderSuccess,
};

function pathOf() {
  const h = location.hash.replace(/^#/, "") || "/";
  const path = h.split("?")[0];
  return path.startsWith("/") ? path : `/${path}`;
}

function queryOf() {
  const h = location.hash.replace(/^#/, "") || "/";
  const q = h.includes("?") ? h.slice(h.indexOf("?") + 1) : "";
  return new URLSearchParams(q);
}

function navigate(path) {
  location.hash = path.startsWith("#") ? path : `#${path}`;
}

/** Cancel timers from previous page (typewriters, demos). */
let pageCleanups = [];

function onPageCleanup(fn) {
  pageCleanups.push(fn);
}

function runPageCleanups() {
  for (const fn of pageCleanups) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
  pageCleanups = [];
}

function render() {
  runPageCleanups();
  const path = pathOf();
  const main = document.getElementById("main");
  const fn = routes[path] || renderNotFound;
  main.innerHTML = "";
  main.appendChild(fn());
  updateHeader();
  document.querySelectorAll(".nav a").forEach((a) => {
    const href = a.getAttribute("href")?.replace(/^#/, "") || "";
    a.classList.toggle("active", href === path || (path === "/" && href === "/"));
  });
  window.scrollTo(0, 0);
  document.getElementById("nav")?.classList.remove("open");
  document.getElementById("nav-toggle")?.setAttribute("aria-expanded", "false");
  // After DOM is in, wire interactive text
  requestAnimationFrame(() => initTextInteractions(main));
}

function updateHeader() {
  const host = document.getElementById("header-actions");
  if (!host) return;
  host.innerHTML = "";
  const user = getSessionUser();
  if (user) {
    const chip = document.createElement("a");
    chip.href = "#/dashboard";
    chip.className = "user-chip";
    chip.innerHTML = `<span class="av">${escapeHtml((user.name || user.email)[0].toUpperCase())}</span><span class="name">${escapeHtml(user.name || user.email)}</span>`;
    host.appendChild(chip);
    const out = document.createElement("button");
    out.type = "button";
    out.className = "btn btn-sm btn-ghost";
    out.textContent = "Log out";
    out.addEventListener("click", () => {
      setSessionUser(null);
      toast("Logged out");
      navigate("/");
      render();
    });
    host.appendChild(out);
  } else {
    const login = document.createElement("a");
    login.href = "#/login";
    login.className = "btn btn-sm btn-ghost";
    login.textContent = "Log in";
    host.appendChild(login);
    const signup = document.createElement("a");
    signup.href = "#/signup";
    signup.className = "btn btn-sm btn-primary";
    signup.textContent = "Sign up";
    host.appendChild(signup);
  }
}

// ——— pages ———

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function page(childrenHtml) {
  return el(`<div class="page">${childrenHtml}</div>`);
}

function renderHome() {
  return page(`
    <section class="hero container">
      <div class="eyebrow ix-reveal" data-delay="0"><span class="dot"></span> Built for PH · GCash ready</div>
      <h1 class="ix-headline" aria-label="GPT 5.6, Opus 5, Opus 4.8 and more. Pinoy-made AI for builders without bank accounts.">
        GPT 5.6, Opus 5, Opus 4.8 &amp; more — Pinoy-made AI for builders without bank accounts.
      </h1>
      <p class="lead ix-reveal" data-delay="1" data-ix-hover-words>
        Hormachuelos is a monochrome AI coding agent with PHP pricing. No foreign card. No USD surprise. Code on your machine — bayad sa GCash.
      </p>
      <div class="hero-cta ix-reveal" data-delay="2">
        <a class="btn btn-primary btn-lg" href="#/pricing">View pricing</a>
        ${renderDownloadButton("btn-lg")}
      </div>
      <div class="trust-row ix-reveal" data-delay="3">
        <button type="button" class="trust-chip" data-tip="Pay with the wallet you already use">GCash &amp; Maya checkout</button>
        <button type="button" class="trust-chip" data-tip="No USD conversion surprises">₱ transparent pricing</button>
        <button type="button" class="trust-chip" data-tip="Agent works on your local folders">Desktop agent · your folders</button>
      </div>
    </section>

    <section class="section demo-video-section">
      <div class="container">
        <figure class="demo-video-wrap ix-reveal">
          <figcaption class="demo-video-caption">DEMO WITH THE SOFTWARE</figcaption>
          <video
            class="demo-video"
            controls
            playsinline
            autoplay
            muted
            preload="auto"
            poster=""
            aria-label="Hormachuelos software demo"
          >
            <source src="./videos/hormachuelos-demo-ad.mp4" type="video/mp4" />
            Your browser does not support video playback.
          </video>
        </figure>
      </div>
    </section>

    <section class="section">
      <div class="container">
        <div class="section-head center ix-reveal">
          <h2 data-ix-split>Them vs us</h2>
          <p>Temporary comparison — prices illustrative. Click a row.</p>
        </div>
        <div class="compare ix-reveal">
          <table id="compare-table">
            <thead>
              <tr><th></th><th>Typical global AI</th><th>Hormachuelos</th></tr>
            </thead>
            <tbody>
              <tr tabindex="0" data-line="They stop at Visa. We start at GCash."><td>GCash</td><td class="no">No</td><td class="yes">Yes</td></tr>
              <tr tabindex="0" data-line="Maya works too — same PH wallets."><td>Maya</td><td class="no">No</td><td class="yes">Yes</td></tr>
              <tr tabindex="0" data-line="See ₱ on the price tag, not $20 + FX."><td>PHP pricing</td><td class="no">USD + FX</td><td class="yes">₱ PHP</td></tr>
              <tr tabindex="0" data-line="Message us on Messenger — 09505339963."><td>Local support</td><td class="no">Email / Discord</td><td class="yes"><a class="compare-messenger" href="https://www.facebook.com/profile.php?id=61584774638218" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">Messenger</a> + 09505339963</td></tr>
              <tr tabindex="0" data-line="No surprise hourly or weekly caps — keep building."><td>Usage reset</td><td class="no">Hourly · Weekly · Monthly</td><td class="yes">No hourly, weekly, or monthly reset</td></tr>
              <tr tabindex="0" data-line="Try for ₱149 — fifteen days, no card drama."><td>From</td><td class="no">~$20/mo card</td><td class="yes">₱149 / 15 days</td></tr>
            </tbody>
          </table>
          <p class="compare-live mono" id="compare-live" aria-live="polite">Click a row to hear the pitch…</p>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="container">
        <div class="cta-band ix-reveal">
          <h2 data-ix-split>Start in 15 days. Or go yearly.</h2>
          <p data-ix-hover-words>Temporary promo pricing while we finish live GCash via PayMongo. Lock a plan that fits your cash flow.</p>
          <a class="btn btn-primary btn-lg" href="#/pricing">See plans</a>
        </div>
      </div>
    </section>
  `);
}

function renderFeatures() {
  return page(`
    <section class="section" style="border-top:0;padding-top:48px">
      <div class="container">
        <div class="section-head ix-reveal">
          <h2 data-ix-split>Features</h2>
          <p data-ix-hover-words>Everything you need to ship client work and side projects without fighting payment walls. Hover any line.</p>
        </div>
        <div class="grid-3">
          ${FEATURES.map(
            (f, i) => `
            <article class="card ix-card ix-reveal" data-delay="${i % 3}" tabindex="0">
              <div class="card-icon">${f.icon}</div>
              <h3 data-ix-split>${escapeHtml(f.title)}</h3>
              <p class="ix-body" data-ix-hover-words>${escapeHtml(f.body)}</p>
            </article>`,
          ).join("")}
        </div>
      </div>
    </section>
  `);
}

function findPlanByCheckoutId(planId) {
  for (const plan of PLANS) {
    if (plan.id === planId) return { plan, tier: null };
    if (plan.tiers) {
      for (const tier of Object.values(plan.tiers)) {
        if (tier.id === planId) return { plan, tier };
      }
    }
  }
  return { plan: PLANS[1], tier: null };
}

function checkoutAmount(planId) {
  const { plan, tier } = findPlanByCheckoutId(planId);
  if (tier) return tier.price;
  return plan.price;
}

function checkoutPlanLabel(planId) {
  const { plan, tier } = findPlanByCheckoutId(planId);
  if (tier) return `Max ${tier.label}`;
  return plan.name;
}

function renderPricing() {
  const wrap = page(`
    <section class="section" style="border-top:0;padding-top:48px">
      <div class="container">
        <div class="section-head center ix-reveal">
          <h2 data-ix-split>Pricing</h2>
          <p data-ix-hover-words>Pay-as-you-go in ₱ PHP. Pick a plan, load GCash when you need more.</p>
          <p class="pricing-live mono" id="pricing-live" aria-live="polite"></p>
        </div>
        <div class="center">
          <p class="pricing-model-badge" id="pricing-model">Usage limit base pricing (Pay as you go)</p>
        </div>
        <div class="pricing-grid" id="pricing-grid"></div>
        <div class="gcash-note ix-reveal">
          <span class="pay-badge">GCash</span>
          <span class="pay-badge">Maya</span>
          <span class="ix-type-once" data-text="Demo checkout · live gateway coming soon"></span>
        </div>
      </div>
    </section>
  `);

  const period = "payg";
  let maxTier = "5x";
  const grid = wrap.querySelector("#pricing-grid");
  const live = wrap.querySelector("#pricing-live");

  function resolvePlanCheckout(plan, tierKey = maxTier) {
    if (plan.tiers) {
      const tier = plan.tiers[tierKey] || plan.tiers[plan.defaultTier || "5x"];
      return { planId: tier.id, price: tier.price, tierKey, tier, label: `Max ${tier.label}` };
    }
    return { planId: plan.id, price: plan.price, tierKey: null, tier: null, label: plan.name };
  }

  function featureLabel(f) {
    return typeof f === "string" ? f : f.title;
  }

  function paintCards(animate = false) {
    grid.innerHTML = PLANS.map((plan) => {
      const checkout = resolvePlanCheckout(plan);
      const price = checkout.price;
      const tier = checkout.tier;
      const tierToggle = plan.tiers
        ? `<div class="price-card-max">
            <p class="plan-tier-label">${escapeHtml(plan.tierLabel || "")}</p>
            <div class="max-tier-toggle" role="tablist" aria-label="Max usage multiplier">
              ${Object.entries(plan.tiers)
                .map(
                  ([key, t]) =>
                    `<button type="button" role="tab" class="${key === maxTier ? "active" : ""}" data-max-tier="${key}" aria-selected="${key === maxTier}">${t.label}</button>`,
                )
                .join("")}
            </div>
          </div>`
        : "";
      const tierMeta = plan.tiers && tier
        ? `<div class="max-tier-meta">
            <span class="max-tier-chip">${escapeHtml(tier.tagline)}</span>
            <span class="max-tier-chip">${escapeHtml(tier.pool)}</span>
            <span class="max-tier-chip">80% → usage</span>
          </div>`
        : "";
      return `
        <article class="price-card ix-card ${plan.featured ? "featured" : ""}" data-plan-card="${plan.id}" tabindex="0">
          ${plan.featured ? `<span class="badge">Popular</span>` : ""}
          <header class="price-card-head">
            <div class="plan-name">${escapeHtml(plan.name)}</div>
            <p class="plan-desc">${escapeHtml(plan.desc)}</p>
          </header>
          ${tierToggle}
          <div class="price-block">
            <div class="price-amount">
              <span class="currency">₱</span>
              <span class="num" data-count-to="${price}" data-animate="${animate ? "1" : "0"}">${price.toLocaleString("en-PH")}</span>
            </div>
            <p class="price-note">Pay as you go · GCash top-ups</p>
          </div>
          ${tierMeta}
          <ul class="feature-list feature-list-compact">
            ${plan.features.map((f) => `<li>${escapeHtml(featureLabel(f))}</li>`).join("")}
          </ul>
          <button type="button" class="btn ${plan.featured ? "btn-primary" : ""} btn-block" data-plan="${checkout.planId}" data-period="${period}" data-tier="${checkout.tierKey || ""}">
            Choose ${escapeHtml(checkout.label)}
          </button>
        </article>`;
    }).join("");

    grid.querySelectorAll("[data-max-tier]").forEach((btn) => {
      btn.addEventListener("click", () => {
        maxTier = btn.getAttribute("data-max-tier") || "5x";
        paintCards(true);
        const tier = MAX_ROI_TIERS[maxTier];
        typeInto(live, `Max ${tier.label} · ${formatPHP(tier.price)} · lean ROI (~80% to usage)`, 18);
      });
    });

    grid.querySelectorAll("button[data-plan]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const user = getSessionUser();
        const tierQ = btn.dataset.tier ? `&tier=${encodeURIComponent(btn.dataset.tier)}` : "";
        const q = `plan=${btn.dataset.plan}&period=${btn.dataset.period}${tierQ}`;
        if (!user) {
          toast("Create an account to continue to checkout");
          navigate(`/signup?next=${encodeURIComponent(`/checkout?${q}`)}`);
          return;
        }
        navigate(`/checkout?${q}`);
      });
    });

    // Animate price numbers
    grid.querySelectorAll("[data-count-to]").forEach((node) => {
      if (node.getAttribute("data-animate") === "1") {
        animateCount(node, Number(node.getAttribute("data-count-to")));
      }
    });
    splitWordsIn(wrap.querySelector(".section-head"));
  }

  paintCards(false);
  typeInto(live, "Starter · Pro · Max tiers · prices in ₱", 16);
  return wrap;
}

function renderLogin() {
  const next = queryOf().get("next") || "/dashboard";
  const wrap = page(`
    <div class="auth-wrap container">
      <div class="auth-card">
        <h1>Log in</h1>
        <p class="sub">Access your plan, credits, and orders.</p>
        <form id="login-form" novalidate>
          <div class="field">
            <label for="login-email">Email</label>
            <input id="login-email" name="email" type="email" autocomplete="email" required placeholder="you@email.com" />
          </div>
          <div class="field">
            <label for="login-password">Password</label>
            <input id="login-password" name="password" type="password" autocomplete="current-password" required placeholder="••••••••" minlength="6" />
          </div>
          <div class="field-error" id="login-error" hidden></div>
          <button class="btn btn-primary btn-block" type="submit">Log in</button>
        </form>
        <div class="divider">or</div>
        <p class="auth-foot">New here? <a href="#/signup">Create an account</a></p>
      </div>
    </div>
  `);

  wrap.querySelector("#login-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const email = wrap.querySelector("#login-email").value.trim();
    const password = wrap.querySelector("#login-password").value;
    const err = wrap.querySelector("#login-error");
    const user = findUser(email);
    if (!user || user.password !== password) {
      err.hidden = false;
      err.textContent = "Invalid email or password.";
      return;
    }
    const { password: _, ...session } = user;
    setSessionUser(session);
    toast(`Welcome back, ${session.name || session.email}`);
    navigate(next.startsWith("/") ? next : `/${next}`);
  });

  return wrap;
}

function renderSignup() {
  const next = queryOf().get("next") || "/pricing";
  const wrap = page(`
    <div class="auth-wrap container">
      <div class="auth-card">
        <h1>Create account</h1>
        <p class="sub">Free to join. Upgrade anytime with GCash.</p>
        <form id="signup-form" novalidate>
          <div class="field">
            <label for="su-name">Name</label>
            <input id="su-name" name="name" type="text" autocomplete="name" required placeholder="Juan Dela Cruz" />
          </div>
          <div class="field">
            <label for="su-email">Email</label>
            <input id="su-email" name="email" type="email" autocomplete="email" required placeholder="you@email.com" />
          </div>
          <div class="field">
            <label for="su-password">Password</label>
            <input id="su-password" name="password" type="password" autocomplete="new-password" required minlength="6" placeholder="Min. 6 characters" />
            <div class="hint">Demo only — stored in this browser (localStorage).</div>
          </div>
          <div class="field-error" id="signup-error" hidden></div>
          <button class="btn btn-primary btn-block" type="submit">Sign up</button>
        </form>
        <p class="auth-foot" style="margin-top:18px">Already have an account? <a href="#/login">Log in</a></p>
      </div>
    </div>
  `);

  wrap.querySelector("#signup-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = wrap.querySelector("#su-name").value.trim();
    const email = wrap.querySelector("#su-email").value.trim();
    const password = wrap.querySelector("#su-password").value;
    const err = wrap.querySelector("#signup-error");
    if (findUser(email)) {
      err.hidden = false;
      err.textContent = "An account with that email already exists.";
      return;
    }
    if (password.length < 6) {
      err.hidden = false;
      err.textContent = "Password must be at least 6 characters.";
      return;
    }
    const user = {
      id: crypto.randomUUID(),
      name,
      email,
      password,
      plan: null,
      period: null,
      credits: 0,
      createdAt: Date.now(),
    };
    upsertUser(user);
    const { password: _, ...session } = user;
    setSessionUser(session);
    toast("Account created");
    navigate(next.startsWith("/") ? next : `/${next}`);
  });

  return wrap;
}

function renderDashboard() {
  const user = getSessionUser();
  if (!user) {
    navigate("/login?next=/dashboard");
    return page(`<div class="container" style="padding:48px 0"><p class="muted">Redirecting to login…</p></div>`);
  }

  // refresh from store
  const full = findUser(user.email) || user;
  const orders = getOrders().filter((o) => o.email === full.email);
  const planLabel = full.plan ? checkoutPlanLabel(full.plan) : null;
  const bill = BILLING[full.period] || BILLING.payg;

  const wrap = page(`
    <div class="dash container">
      <div class="dash-head">
        <div>
          <h1>Dashboard</h1>
          <p class="muted small">Signed in as ${escapeHtml(full.email)}</p>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <a class="btn btn-sm" href="#/pricing">Change plan</a>
          <a class="btn btn-sm btn-primary" href="#/download">Download app</a>
        </div>
      </div>

      <div class="stat-row">
        <div class="stat">
          <div class="label">Plan</div>
          <div class="value">${planLabel ? escapeHtml(planLabel) : "Free"}</div>
        </div>
        <div class="stat">
          <div class="label">Model</div>
          <div class="value">${bill ? escapeHtml(bill.label) : "—"}</div>
        </div>
        <div class="stat">
          <div class="label">Credits</div>
          <div class="value">${(full.credits || 0).toLocaleString("en-PH")}</div>
        </div>
      </div>

      <div class="dash-grid">
        <div class="card">
          <h3>Account</h3>
          <p style="margin:12px 0" class="muted small">Name</p>
          <p style="margin:0 0 12px">${escapeHtml(full.name || "—")}</p>
          <p style="margin:0 0 4px" class="muted small">Member since</p>
          <p style="margin:0" class="mono small">${full.createdAt ? new Date(full.createdAt).toLocaleDateString() : "—"}</p>
          ${
            !full.plan
              ? `<div class="alert warn" style="margin-top:18px">No active plan yet. Pick a plan and unlock the agent.</div>
                 <a class="btn btn-primary" href="#/pricing">View pricing</a>`
              : `<div class="alert ok" style="margin-top:18px">Active · ${escapeHtml(planLabel || "")} (${escapeHtml(bill?.label || "")}). GCash renewals will appear here.</div>`
          }
        </div>
        <div class="card">
          <h3>Recent orders</h3>
          ${
            orders.length === 0
              ? `<p class="muted small" style="margin-top:12px">No orders yet.</p>`
              : `<ul class="feature-list" style="margin-top:12px">${orders
                  .slice(0, 5)
                  .map(
                    (o) =>
                      `<li><span class="mono">${escapeHtml(o.id.slice(0, 8))}</span> · ${escapeHtml(o.planName)} · ${formatPHP(o.amount)} · ${escapeHtml(o.method)}</li>`,
                  )
                  .join("")}</ul>`
          }
        </div>
      </div>
    </div>
  `);
  return wrap;
}

function renderCheckout() {
  const user = getSessionUser();
  const q = queryOf();
  const planId = q.get("plan") || "pro";
  const period = q.get("period") || "payg";
  const tier = q.get("tier") || "";
  const amount = checkoutAmount(planId);
  const planLabel = checkoutPlanLabel(planId);
  const tierQ = tier ? `&tier=${encodeURIComponent(tier)}` : "";

  if (!user) {
    navigate(`/login?next=${encodeURIComponent(`/checkout?plan=${planId}&period=${period}${tierQ}`)}`);
    return page(`<div class="container" style="padding:48px 0"><p class="muted">Please log in…</p></div>`);
  }

  const wrap = page(`
    <div class="container checkout-layout">
      <div>
        <h1 style="margin:0 0 8px;font-size:1.6rem;letter-spacing:-0.03em">Checkout</h1>
        <p class="muted" style="margin:0 0 20px">GCash-first checkout. Demo mode until PayMongo keys are live — you still get a desktop license key.</p>
        <div class="card">
          <h3 style="margin-top:0">Payment method</h3>
          <div class="pay-methods">
            <label class="pay-method">
              <input type="radio" name="method" value="GCash" checked />
              <div>
                <strong>GCash</strong>
                <div class="muted small">Most popular in PH</div>
              </div>
              <span class="pay-badge" style="margin-left:auto">GCash</span>
            </label>
            <label class="pay-method">
              <input type="radio" name="method" value="Maya" />
              <div>
                <strong>Maya</strong>
                <div class="muted small">E-wallet alternative</div>
              </div>
              <span class="pay-badge" style="margin-left:auto">Maya</span>
            </label>
            <label class="pay-method">
              <input type="radio" name="method" value="Card" />
              <div>
                <strong>Card</strong>
                <div class="muted small">Optional · same gateway later</div>
              </div>
            </label>
          </div>
          <div class="field">
            <label for="gcash-ref">Mobile number (optional)</label>
            <input id="gcash-ref" type="tel" placeholder="09xx xxx xxxx" autocomplete="tel" />
          </div>
          <button type="button" class="btn btn-primary btn-block btn-lg" id="pay-btn">
            Pay ${formatPHP(amount)} with GCash
          </button>
          <p class="muted small center" style="margin-top:12px">Temporary prices · demo only · PayMongo/Xendit next</p>
        </div>
      </div>
      <aside class="checkout-summary">
        <h2>Order summary</h2>
        <div class="summary-row"><span>Plan</span><span>${escapeHtml(planLabel)}</span></div>
        <div class="summary-row"><span>Billing</span><span>Pay as you go · lean ROI</span></div>
        <div class="summary-row"><span>Account</span><span class="mono small">${escapeHtml(user.email)}</span></div>
        <div class="summary-row total"><span>Total</span><span class="mono">${formatPHP(amount)}</span></div>
        <ul class="feature-list" style="margin-top:12px">
          ${plan.features
            .slice(0, 4)
            .map((f) => `<li>${escapeHtml(typeof f === "string" ? f : f.title)}</li>`)
            .join("")}
        </ul>
      </aside>
    </div>
  `);

  const payBtn = wrap.querySelector("#pay-btn");
  const updatePayLabel = () => {
    const method = wrap.querySelector('input[name="method"]:checked')?.value || "GCash";
    payBtn.textContent = `Pay ${formatPHP(amount)} with ${method}`;
  };
  wrap.querySelectorAll('input[name="method"]').forEach((r) => r.addEventListener("change", updatePayLabel));

  payBtn.addEventListener("click", async () => {
    const method = wrap.querySelector('input[name="method"]:checked')?.value || "GCash";
    payBtn.disabled = true;
    payBtn.textContent = "Processing…";
    try {
      const { createCheckout } = await import("./paymongo.js");
      const checkout = await createCheckout({
        amountPhp: amount,
        planId,
        planName: planLabel,
        period,
        email: user.email,
        method,
      });

      if (!checkout.demo && checkout.checkoutUrl) {
        // Live PayMongo: redirect to GCash
        sessionStorage.setItem(
          "horma:pendingPayment",
          JSON.stringify({
            planId,
            period,
            amount,
            method,
            licenseKey: checkout.licenseKey,
            paymentId: checkout.paymentId,
          }),
        );
        location.href = checkout.checkoutUrl;
        return;
      }

      const order = {
        id: checkout.paymentId || crypto.randomUUID(),
        email: user.email,
        planId,
        planName: planLabel,
        period,
        amount,
        method,
        licenseKey: checkout.licenseKey,
        at: Date.now(),
        demo: true,
      };
      addOrder(order);

      const full = findUser(user.email);
      if (full) {
        full.plan = planId;
        full.period = period;
        full.licenseKey = checkout.licenseKey;
        const creditBonus =
          planId === "starter"
            ? 50000
            : planId === "pro"
              ? 500000
              : planId === "max20"
                ? 4_000_000
                : planId === "max10"
                  ? 2_000_000
                  : planId.startsWith("max")
                    ? 1_000_000
                    : 200000;
        full.credits = (full.credits || 0) + creditBonus;
        full.password = full.password;
        upsertUser(full);
        const { password: _, ...session } = full;
        setSessionUser(session);
      }

      navigate(`/success?order=${order.id}`);
    } catch (err) {
      console.error(err);
      toast(String(err.message || err));
      payBtn.disabled = false;
      updatePayLabel();
    }
  });

  return wrap;
}

function renderSuccess() {
  const orderId = queryOf().get("order");
  const order = getOrders().find((o) => o.id === orderId);
  const licenseKey = order?.licenseKey || "";
  return page(`
    <div class="container" style="padding:64px 0;max-width:560px;margin:0 auto;text-align:center">
      <div class="eyebrow" style="margin-bottom:16px"><span class="dot"></span> ${order?.demo === false ? "Payment received" : "Payment simulated"}</div>
      <h1 style="margin:0 0 12px;font-size:2rem;letter-spacing:-0.03em">You're in</h1>
      <p class="muted" style="margin:0 0 20px">
        ${
          order
            ? `${escapeHtml(order.planName)} · ${formatPHP(order.amount)} via ${escapeHtml(order.method)}`
            : "Order recorded."
        }
      </p>
      ${order ? `<p class="mono small muted" style="margin:0 0 16px">Order ${escapeHtml(order.id.slice(0, 8))}</p>` : ""}
      ${
        licenseKey
          ? `<div class="card" style="text-align:left;margin:0 0 24px">
              <h3 style="margin:0 0 8px">Desktop license key</h3>
              <p class="muted small" style="margin:0 0 10px">Open Hormachuelos → Settings → Subscription · GCash → paste &amp; Activate.</p>
              <code class="mono" style="display:block;padding:10px 12px;border-radius:8px;background:rgba(0,0,0,.25);word-break:break-all">${escapeHtml(licenseKey)}</code>
            </div>`
          : ""
      }
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
        <a class="btn btn-primary" href="#/dashboard">Go to dashboard</a>
        <a class="btn" href="#/download">Download app</a>
      </div>
    </div>
  `);
}

function renderDownload() {
  const { version, windows } = DESKTOP_DOWNLOADS;
  return page(`
    <div class="prose container">
      <h1>Download Hormachuelos</h1>
      <p>Install the desktop AI agent on Windows. v${escapeHtml(version)} · 64-bit · includes Cursor runtime bundle.</p>
      <div class="card" style="margin:20px 0">
        <h3 style="margin-top:0">Windows</h3>
        <p class="muted small">Pick MSI for IT-style installs, or EXE for one-click setup. After install, open Hormachuelos and connect your provider—or use Mag-load when hosted billing is live.</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:16px">
          <a class="btn btn-primary" href="${windows.msi.href}" download="${windows.msi.file}">${escapeHtml(windows.msi.label)}</a>
          <a class="btn" href="${windows.setup.href}" download="${windows.setup.file}">${escapeHtml(windows.setup.label)}</a>
        </div>
        <p class="muted small" style="margin:12px 0 0">Need an account for billing? <a href="#/signup">Sign up free</a> · already paid? <a href="#/dashboard">Dashboard</a></p>
      </div>
      <p class="muted small">Rebuild installers: <code class="mono">npm run desktop:build</code> then copy <code class="mono">src-tauri/target/release/bundle/*</code> into <code class="mono">website/downloads/</code>.</p>
    </div>
  `);
}

function renderFaq() {
  const wrap = page(`
    <section class="section" style="border-top:0;padding-top:48px">
      <div class="container">
        <div class="section-head center ix-reveal">
          <h2 data-ix-split>FAQ</h2>
          <p data-ix-hover-words>Straight answers — Taglish welcome in support. Open a question to type the answer.</p>
        </div>
        <div class="faq-list" id="faq-list"></div>
      </div>
    </section>
  `);
  const list = wrap.querySelector("#faq-list");
  FAQ.forEach((item, i) => {
    const row = el(`
      <div class="faq-item ${i === 0 ? "open" : ""}">
        <button type="button">${escapeHtml(item.q)} <span>${i === 0 ? "−" : "+"}</span></button>
        <div class="answer" data-full="${escapeHtml(item.a)}"></div>
      </div>
    `);
    const answer = row.querySelector(".answer");
    if (i === 0) {
      // first open: type on mount after interactions init — mark for type
      answer.setAttribute("data-type-on-show", "1");
      answer.textContent = prefersReducedMotion() ? item.a : "";
    }
    row.querySelector("button").addEventListener("click", () => {
      const open = row.classList.toggle("open");
      row.querySelector("span").textContent = open ? "−" : "+";
      if (open) {
        typeInto(answer, item.a, 12);
      }
    });
    list.appendChild(row);
  });
  // Type first answer shortly after paint
  const first = list.querySelector(".faq-item.open .answer");
  if (first && first.getAttribute("data-type-on-show")) {
    window.setTimeout(() => typeInto(first, FAQ[0].a, 12), 200);
  }
  return wrap;
}

function renderSupport() {
  const wrap = page(`
    <div class="prose container">
      <h1>Support</h1>
      <p>Prefer Messenger or Viber — we reply in Taglish. Demo form stores nothing on a server.</p>
      <form id="support-form" class="card" style="margin-top:20px">
        <div class="field">
          <label for="sup-name">Name</label>
          <input id="sup-name" required placeholder="Your name" />
        </div>
        <div class="field">
          <label for="sup-email">Email</label>
          <input id="sup-email" type="email" required placeholder="you@email.com" />
        </div>
        <div class="field">
          <label for="sup-msg">Message</label>
          <textarea id="sup-msg" required placeholder="Paano mag-upgrade via GCash?"></textarea>
        </div>
        <button class="btn btn-primary" type="submit">Send message</button>
      </form>
    </div>
  `);
  wrap.querySelector("#support-form").addEventListener("submit", (e) => {
    e.preventDefault();
    toast("Message queued (demo). We'll wire this to email/Messenger later.");
    e.target.reset();
  });
  return wrap;
}

const TERMS = `
  <p>By using Hormachuelos and this website you agree to use the product lawfully, keep your account credentials private, and not abuse rate limits or shared infrastructure.</p>
  <p>Subscriptions and credit packs are sold in Philippine Pesos at the prices shown at checkout (temporary promo pricing may change).</p>
  <p>This demo site does not process real payments. When live GCash is enabled via a licensed payment partner (e.g. PayMongo / Xendit), their terms also apply.</p>
`;

const PRIVACY = `
  <p>We collect account email, name, and plan metadata to operate billing and support. Demo data stays in your browser localStorage.</p>
  <p>When live payments launch, payment partners process e-wallet transactions; we receive payment status, not your GCash PIN.</p>
  <p>Project files stay on your machine when using the desktop agent unless you explicitly connect cloud features.</p>
`;

const REFUNDS = `
  <p>First-time purchases may be refunded within 7 days if token usage is minimal and the license has not been widely redistributed.</p>
  <p>Contact support with your order id. Abuse, chargebacks without contact, or heavy token consumption may void eligibility.</p>
  <p>Promotional and demo orders on this site are not real charges.</p>
`;

function renderLegal(title, bodyHtml) {
  return page(`
    <div class="prose container">
      <h1>${escapeHtml(title)}</h1>
      ${bodyHtml}
    </div>
  `);
}

function renderNotFound() {
  return page(`
    <div class="container center" style="padding:80px 0">
      <h1>404</h1>
      <p class="muted">Page not found.</p>
      <a class="btn" href="#/">Home</a>
    </div>
  `);
}

// ——— boot ———

// ——— Interactive text engine ———

function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
}

/** Split element text into hoverable words. */
function splitWords(el) {
  if (!el || el.dataset.ixSplitDone === "1") return;
  // Don't destroy nested interactive nodes
  if (el.querySelector(".ix-type, #hero-type, input, button, a")) return;
  const text = el.textContent || "";
  if (!text.trim()) return;
  el.dataset.ixSplitDone = "1";
  if (!el.getAttribute("aria-label")) el.setAttribute("aria-label", text.trim());
  const parts = text.split(/(\s+)/);
  el.textContent = "";
  el.classList.add("ix-split");
  for (const part of parts) {
    if (/^\s+$/.test(part) || part === "") {
      el.appendChild(document.createTextNode(part));
      continue;
    }
    const span = document.createElement("span");
    span.className = "ix-word";
    span.textContent = part;
    el.appendChild(span);
  }
}

function splitWordsIn(root) {
  root.querySelectorAll("[data-ix-split]").forEach((el) => splitWords(el));
}

/** Wrap each word so hover highlights it. */
function hoverWordsIn(root) {
  root.querySelectorAll("[data-ix-hover-words]").forEach((el) => {
    if (el.dataset.ixHoverDone === "1") return;
    const text = el.textContent || "";
    if (!text.trim()) return;
    el.dataset.ixHoverDone = "1";
    el.classList.add("ix-hover-words");
    const words = text.split(/(\s+)/);
    el.textContent = "";
    for (const w of words) {
      if (/^\s+$/.test(w)) {
        el.appendChild(document.createTextNode(w));
        continue;
      }
      const span = document.createElement("span");
      span.className = "ix-hword";
      span.textContent = w;
      el.appendChild(span);
    }
  });
}

/** Typewriter into element; returns cancel fn. */
function typeInto(el, text, msPerChar = 28) {
  if (!el) return () => {};
  let i = 0;
  let cancelled = false;
  el.textContent = "";
  el.classList.add("ix-typing");
  if (prefersReducedMotion()) {
    el.textContent = text;
    el.classList.remove("ix-typing");
    return () => {};
  }
  const tick = () => {
    if (cancelled) return;
    i += 1;
    el.textContent = text.slice(0, i);
    if (i < text.length) {
      timer = window.setTimeout(tick, msPerChar);
    } else {
      el.classList.remove("ix-typing");
    }
  };
  let timer = window.setTimeout(tick, msPerChar);
  const cancel = () => {
    cancelled = true;
    clearTimeout(timer);
    el.classList.remove("ix-typing");
  };
  onPageCleanup(cancel);
  return cancel;
}

/** Rotating phrase typewriter. */
function rotateType(el, phrases, { typeMs = 55, holdMs = 1600, deleteMs = 32 } = {}) {
  if (!el || !phrases.length) return;
  if (prefersReducedMotion()) {
    el.textContent = phrases[0];
    return;
  }
  let pi = 0;
  let cancelled = false;
  let timer = 0;

  const set = (t) => {
    el.textContent = t;
  };

  const loop = async () => {
    while (!cancelled) {
      const phrase = phrases[pi % phrases.length];
      for (let i = 1; i <= phrase.length && !cancelled; i++) {
        set(phrase.slice(0, i));
        await wait(typeMs);
      }
      await wait(holdMs);
      for (let i = phrase.length; i >= 0 && !cancelled; i--) {
        set(phrase.slice(0, i));
        await wait(deleteMs);
      }
      await wait(200);
      pi += 1;
    }
  };

  function wait(ms) {
    return new Promise((resolve) => {
      timer = window.setTimeout(resolve, ms);
    });
  }

  loop();
  onPageCleanup(() => {
    cancelled = true;
    clearTimeout(timer);
  });
}

function animateCount(el, to, duration = 480) {
  if (!el) return;
  if (prefersReducedMotion()) {
    el.textContent = to.toLocaleString("en-PH");
    return;
  }
  const from = Number(String(el.textContent).replace(/[^\d]/g, "")) || 0;
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const val = Math.round(from + (to - from) * eased);
    el.textContent = val.toLocaleString("en-PH");
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Scroll / mount reveal. */
function revealIn(root) {
  const nodes = root.querySelectorAll(".ix-reveal");
  if (prefersReducedMotion()) {
    nodes.forEach((n) => n.classList.add("ix-in"));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          const delay = Number(e.target.getAttribute("data-delay") || 0);
          window.setTimeout(() => e.target.classList.add("ix-in"), delay * 70);
          io.unobserve(e.target);
        }
      }
    },
    { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
  );
  nodes.forEach((n) => io.observe(n));
  // Hero items above fold
  nodes.forEach((n) => {
    if (n.closest(".hero")) {
      const delay = Number(n.getAttribute("data-delay") || 0);
      window.setTimeout(() => n.classList.add("ix-in"), 40 + delay * 80);
    }
  });
  onPageCleanup(() => io.disconnect());
}

function wireDemoVideo(root) {
  const video = root.querySelector(".demo-video");
  if (!video) return;

  const tryPlay = () => {
    video.muted = true;
    const playPromise = video.play();
    if (playPromise?.catch) playPromise.catch(() => {});
  };

  tryPlay();

  const wrap = video.closest(".demo-video-wrap");
  if (!wrap || prefersReducedMotion()) return;

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          tryPlay();
          io.unobserve(wrap);
        }
      }
    },
    { threshold: 0.25 },
  );
  io.observe(wrap);
  onPageCleanup(() => io.disconnect());
}

function wireCompare(root) {
  const table = root.querySelector("#compare-table");
  const live = root.querySelector("#compare-live");
  if (!table || !live) return;
  table.querySelectorAll("tbody tr").forEach((tr) => {
    const activate = () => {
      table.querySelectorAll("tr.active").forEach((r) => r.classList.remove("active"));
      tr.classList.add("active");
      typeInto(live, tr.getAttribute("data-line") || "", 16);
    };
    tr.addEventListener("click", activate);
    tr.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate();
      }
    });
  });
}

function wireTrustChips(root) {
  root.querySelectorAll(".trust-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tip = btn.getAttribute("data-tip") || btn.textContent;
      toast(tip);
      btn.classList.add("pulse");
      window.setTimeout(() => btn.classList.remove("pulse"), 400);
    });
  });
}

function wireTypeOnce(root) {
  root.querySelectorAll(".ix-type-once").forEach((el) => {
    const text = el.getAttribute("data-text") || el.textContent || "";
    typeInto(el, text, 20);
  });
}

function initTextInteractions(root) {
  if (!root) return;
  splitWordsIn(root);
  hoverWordsIn(root);
  revealIn(root);
  wireDemoVideo(root);
  wireCompare(root);
  wireTrustChips(root);
  wireTypeOnce(root);

  const heroType = root.querySelector("#hero-type");
  if (heroType) {
    const phrases = (heroType.getAttribute("data-phrases") || "GCash")
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean);
    rotateType(heroType, phrases);
  }

  // Feature cards: type body on first focus/hover once
  root.querySelectorAll(".ix-card").forEach((card) => {
    const body = card.querySelector(".ix-body, .plan-desc");
    if (!body) return;
    let done = false;
    const kick = () => {
      if (done) return;
      done = true;
      card.classList.add("ix-active");
    };
    card.addEventListener("mouseenter", kick);
    card.addEventListener("focus", kick);
  });
}

function boot() {
  const y = document.getElementById("year");
  if (y) y.textContent = String(new Date().getFullYear());

  document.getElementById("nav-toggle")?.addEventListener("click", () => {
    const nav = document.getElementById("nav");
    const open = nav.classList.toggle("open");
    document.getElementById("nav-toggle").setAttribute("aria-expanded", String(open));
  });

  window.addEventListener("hashchange", render);
  if (!location.hash) location.hash = "#/";
  else render();
}

boot();
