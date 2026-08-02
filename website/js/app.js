/**
 * Hormachuelos marketing site — SPA with server auth (email/password, no email magic links).
 * Temporary PHP prices. GCash-first checkout demo (no real payment gateway yet).
 */

const STORAGE_USER = "horma:user";
const STORAGE_TOKEN = "horma:token";
const STORAGE_ADMIN = "horma:admin";
const STORAGE_ORDERS = "horma:orders";
const STORAGE_DESKTOP_CODE = "horma:desktop_code";
const STORAGE_DESKTOP_FLOW = "horma:desktop_flow";

/** Public assets hosted on Supabase Storage (keeps Vercel deploy under size limits). */
const ASSET_BASE =
  "https://mketkzycxmtvgdbwzsvh.supabase.co/storage/v1/object/public/public-assets";

/** Desktop installer files (uploaded to Supabase after `npm run desktop:build`). */
const DESKTOP_DOWNLOADS = {
  version: "0.1.24",
  windows: {
    msi: {
      label: "Windows installer (MSI)",
      href: "/downloads/Hormachuelos_0.1.24_x64_en-US.msi",
      file: "Hormachuelos_0.1.24_x64_en-US.msi",
    },
    setup: {
      label: "Windows setup (EXE)",
      href: "/downloads/Hormachuelos_0.1.24_x64-setup.exe",
      file: "Hormachuelos_0.1.24_x64-setup.exe",
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

/** Max tiers — multipliers for team plans (token pools stay server-side). */
const MAX_ROI_TIERS = {
  "5x": {
    id: "max5",
    label: "5×",
    multiplier: 5,
    price: 2499,
    tagline: "Teams & parallel builds",
  },
  "10x": {
    id: "max10",
    label: "10×",
    multiplier: 10,
    price: 4999,
    tagline: "Agency sprints",
  },
  "20x": {
    id: "max20",
    label: "20×",
    multiplier: 20,
    price: 9999,
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
      "Larger usage wallet",
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
      "Highest usage headroom",
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

function getSessionToken() {
  return localStorage.getItem(STORAGE_TOKEN) || "";
}

function setSessionUser(user, token) {
  if (user) saveJSON(STORAGE_USER, user);
  else localStorage.removeItem(STORAGE_USER);
  if (token) localStorage.setItem(STORAGE_TOKEN, token);
  if (!user) localStorage.removeItem(STORAGE_TOKEN);
}

function authHeaders(extra = {}) {
  const token = getSessionToken();
  const headers = { Accept: "application/json", ...extra };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function apiAuth(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: authHeaders(body ? { "Content-Type": "application/json" } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.code = data.code;
    err.email = data.email;
    err.status = res.status;
    throw err;
  }
  return data;
}

async function refreshSessionUser() {
  if (!getSessionToken()) return null;
  try {
    const data = await apiAuth("/api/auth/me");
    setSessionUser(data.user, getSessionToken());
    if (Array.isArray(data.orders)) saveJSON(STORAGE_ORDERS, data.orders);
    return data.user;
  } catch {
    setSessionUser(null);
    return null;
  }
}

function desktopCodeFromQuery() {
  const dcode = queryOf().get("dcode") || queryOf().get("desktop_code");
  if (dcode) return String(dcode).trim().toUpperCase();
  // Legacy: code=ABCD-EFGH (not a 6-digit email OTP)
  const code = String(queryOf().get("code") || "").trim().toUpperCase();
  if (/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) return code;
  return "";
}

function rememberDesktopLinkFromUrl() {
  const code = desktopCodeFromQuery();
  if (code) {
    try {
      sessionStorage.setItem(STORAGE_DESKTOP_CODE, code);
      sessionStorage.setItem(STORAGE_DESKTOP_FLOW, "1");
    } catch {
      /* private mode */
    }
  } else if (queryOf().get("desktop") === "1") {
    try {
      sessionStorage.setItem(STORAGE_DESKTOP_FLOW, "1");
    } catch {
      /* ignore */
    }
  }
}

function pendingDesktopCode() {
  const fromUrl = desktopCodeFromQuery();
  if (fromUrl) return fromUrl;
  try {
    return String(sessionStorage.getItem(STORAGE_DESKTOP_CODE) || "").trim().toUpperCase();
  } catch {
    return "";
  }
}

function clearPendingDesktopLink() {
  try {
    sessionStorage.removeItem(STORAGE_DESKTOP_CODE);
    sessionStorage.removeItem(STORAGE_DESKTOP_FLOW);
  } catch {
    /* ignore */
  }
}

function isDesktopLinkFlow() {
  rememberDesktopLinkFromUrl();
  if (queryOf().get("desktop") === "1" || Boolean(desktopCodeFromQuery())) return true;
  try {
    return sessionStorage.getItem(STORAGE_DESKTOP_FLOW) === "1" || Boolean(pendingDesktopCode());
  } catch {
    return false;
  }
}

function withDesktopParams(path) {
  const code = pendingDesktopCode();
  if (!isDesktopLinkFlow()) return path;
  const base = path.startsWith("/") ? path : `/${path}`;
  const join = base.includes("?") ? "&" : "?";
  return `${base}${join}desktop=1${code ? `&dcode=${encodeURIComponent(code)}` : ""}`;
}

async function finishDesktopLinkIfNeeded() {
  rememberDesktopLinkFromUrl();
  const code = pendingDesktopCode();
  if (!code || !getSessionToken()) return false;
  try {
    const data = await apiAuth("/api/auth/device-complete", {
      method: "POST",
      body: { code },
    });
    // Keep pairing code so "Send link again" can re-issue a desktop token.
    toast(data.message || "Desktop app linked");
    navigate("/desktop-linked");
    return true;
  } catch (ex) {
    toast(String(ex.message || ex));
    return false;
  }
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
  "/verify": renderVerify,
  "/desktop-linked": renderDesktopLinked,
  "/dashboard": renderDashboard,
  "/admin": renderAdmin,
  "/checkout": renderCheckout,
  "/download": renderDownload,
  "/update": renderUpdate,
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
    out.addEventListener("click", async () => {
      try {
        await apiAuth("/api/auth/logout", { method: "POST" });
      } catch {
        /* ignore network errors on logout */
      }
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
            <source src="${ASSET_BASE}/videos/hormachuelos-demo-ad.mp4" type="video/mp4" />
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
      const tierMeta = "";
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
        typeInto(live, `Max ${tier.label} · ${formatPHP(tier.price)} · ${tier.tagline}`, 18);
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
  const next = queryOf().get("next") || (isDesktopLinkFlow() ? "/desktop-linked" : "/dashboard");
  const deskCode = pendingDesktopCode();
  const alreadyIn = Boolean(getSessionToken() && getSessionUser());

  // Already signed in + desktop pairing → show link UI (not the password form).
  if (isDesktopLinkFlow() && alreadyIn) {
    const user = getSessionUser();
    const wrap = page(`
      <div class="auth-wrap container">
        <div class="auth-card">
          <h1>Link desktop app</h1>
          <p class="sub">You're signed in as <strong>${escapeHtml(user.email || "account")}</strong>${
            deskCode ? ` · code <strong class="mono">${escapeHtml(deskCode)}</strong>` : ""
          }.</p>
          <p class="muted small" id="desk-link-status" style="margin:0 0 16px">Connecting Hormachuelos desktop…</p>
          <div class="field-error" id="desk-link-error" hidden></div>
          <button class="btn btn-primary btn-block" type="button" id="desk-link-btn">Link desktop now</button>
          <p class="auth-foot" style="margin-top:16px">Wrong account? <a href="#" id="desk-link-logout">Log out</a> then sign in again.</p>
        </div>
      </div>
    `);
    const statusEl = wrap.querySelector("#desk-link-status");
    const errEl = wrap.querySelector("#desk-link-error");
    const btn = wrap.querySelector("#desk-link-btn");
    const runLink = async () => {
      errEl.hidden = true;
      btn.disabled = true;
      btn.textContent = "Linking…";
      statusEl.textContent = "Sending sign-in to the desktop app…";
      const ok = await finishDesktopLinkIfNeeded();
      if (!ok) {
        errEl.hidden = false;
        errEl.textContent =
          "Could not link yet. Keep the Hormachuelos app open, then click Link desktop now again.";
        btn.disabled = false;
        btn.textContent = "Link desktop now";
        statusEl.textContent = "Waiting for another try…";
      }
    };
    btn.addEventListener("click", () => void runLink());
    wrap.querySelector("#desk-link-logout").addEventListener("click", async (e) => {
      e.preventDefault();
      try {
        await apiAuth("/api/auth/logout", { method: "POST" });
      } catch {
        /* ignore */
      }
      setSessionUser(null);
      navigate(withDesktopParams("/login"));
      render();
    });
    queueMicrotask(() => void runLink());
    return wrap;
  }

  const wrap = page(`
    <div class="auth-wrap container">
      <div class="auth-card">
        <h1>Log in</h1>
        <p class="sub">${
          isDesktopLinkFlow()
            ? `Sign in to unlock the desktop app${deskCode ? ` · code <strong class="mono">${escapeHtml(deskCode)}</strong>` : ""}.`
            : "Access your plan, credits, and orders."
        }</p>
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
        <p class="auth-foot">New here? <a href="#${withDesktopParams("/signup")}">Create an account</a></p>
      </div>
    </div>
  `);

  wrap.querySelector("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = wrap.querySelector("#login-email").value.trim();
    const password = wrap.querySelector("#login-password").value;
    const err = wrap.querySelector("#login-error");
    const btn = wrap.querySelector('button[type="submit"]');
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = "Signing in…";
    try {
      const data = await apiAuth("/api/auth/login", {
        method: "POST",
        body: { email, password },
      });
      setSessionUser(data.user, data.token);
      toast(`Welcome back, ${data.user.name || data.user.email}`);
      if (await finishDesktopLinkIfNeeded()) return;
      navigate(next.startsWith("/") ? next : `/${next}`);
    } catch (ex) {
      if (ex.code === "email_unverified") {
        toast("Verify your email first");
        navigate(
          withDesktopParams(
            `/verify?email=${encodeURIComponent(ex.email || email)}&next=${encodeURIComponent(next)}`,
          ),
        );
        return;
      }
      err.hidden = false;
      err.textContent = String(ex.message || "Invalid email or password.");
      btn.disabled = false;
      btn.textContent = "Log in";
    }
  });

  return wrap;
}

function renderSignup() {
  const next = queryOf().get("next") || (isDesktopLinkFlow() ? "/desktop-linked" : "/pricing");
  const wrap = page(`
    <div class="auth-wrap container">
      <div class="auth-card">
        <h1>Create account</h1>
        <p class="sub">${
          isDesktopLinkFlow()
            ? "Create an account to unlock the Hormachuelos desktop app."
            : "Free to join. Upgrade anytime with GCash."
        }</p>
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
            <div class="hint">We'll email a code from HORMACHUELOS to confirm you're real (stops spam signups).</div>
          </div>
          <div class="field-error" id="signup-error" hidden></div>
          <button class="btn btn-primary btn-block" type="submit">Sign up</button>
        </form>
        <p class="auth-foot" style="margin-top:18px">Already have an account? <a href="#${withDesktopParams("/login")}">Log in</a></p>
      </div>
    </div>
  `);

  wrap.querySelector("#signup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = wrap.querySelector("#su-name").value.trim();
    const email = wrap.querySelector("#su-email").value.trim();
    const password = wrap.querySelector("#su-password").value;
    const err = wrap.querySelector("#signup-error");
    const btn = wrap.querySelector('button[type="submit"]');
    err.hidden = true;
    if (password.length < 6) {
      err.hidden = false;
      err.textContent = "Password must be at least 6 characters.";
      return;
    }
    btn.disabled = true;
    btn.textContent = "Sending code…";
    try {
      const data = await apiAuth("/api/auth/signup", {
        method: "POST",
        body: { name, email, password },
      });
      toast(data.message || "Check your email for the code");
      navigate(
        withDesktopParams(
          `/verify?email=${encodeURIComponent(data.email || email)}&next=${encodeURIComponent(next)}`,
        ),
      );
    } catch (ex) {
      if (ex.code === "pending_verification") {
        toast("Account pending verification — enter the code we emailed");
        navigate(
          withDesktopParams(
            `/verify?email=${encodeURIComponent(ex.email || email)}&next=${encodeURIComponent(next)}`,
          ),
        );
        return;
      }
      err.hidden = false;
      err.textContent = String(ex.message || "Could not create account.");
      btn.disabled = false;
      btn.textContent = "Sign up";
    }
  });

  return wrap;
}

function renderDesktopLinked() {
  const wrap = page(`
    <div class="container" style="padding:64px 0;max-width:560px;margin:0 auto;text-align:center">
      <div class="eyebrow" style="margin-bottom:16px"><span class="dot"></span> Desktop linked</div>
      <h1 style="margin:0 0 12px;font-size:2rem;letter-spacing:-0.03em">You're signed in</h1>
      <p class="muted" style="margin:0 0 20px">
        Return to the Hormachuelos app — it should sign in within a few seconds.
        If the app still says waiting, click below to send the link again.
      </p>
      <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center">
        <button type="button" class="btn btn-primary" id="desk-relink-btn">Send link to app again</button>
        <a class="btn" href="#/dashboard">Open web dashboard</a>
      </div>
      <p class="muted small" id="desk-relink-status" style="margin-top:14px"></p>
    </div>
  `);
  wrap.querySelector("#desk-relink-btn")?.addEventListener("click", async () => {
    const status = wrap.querySelector("#desk-relink-status");
    const btn = wrap.querySelector("#desk-relink-btn");
    if (!getSessionToken()) {
      navigate(withDesktopParams("/login"));
      return;
    }
    // Restore last code if user still has the app waiting on the same pairing.
    if (!pendingDesktopCode()) {
      status.textContent = "Open the link from the desktop app again (it includes a fresh code).";
      return;
    }
    btn.disabled = true;
    status.textContent = "Re-sending…";
    // Re-enable flow flag and complete again (mints a fresh desktop token).
    try {
      sessionStorage.setItem(STORAGE_DESKTOP_FLOW, "1");
    } catch {
      /* ignore */
    }
    const ok = await finishDesktopLinkIfNeeded();
    status.textContent = ok
      ? "Sent. Check the Hormachuelos app window."
      : "Still waiting — keep the app open and try once more.";
    btn.disabled = false;
  });
  return wrap;
}

function renderVerify() {
  const q = queryOf();
  const email = q.get("email") || "";
  // Email OTP uses `code`; desktop pairing also uses `code` (ABCD-EFGH). Prefer OTP when 6 digits.
  const rawCode = q.get("code") || "";
  const presetCode = /^\d{6}$/.test(rawCode) ? rawCode : "";
  const next = q.get("next") || (isDesktopLinkFlow() ? "/desktop-linked" : "/dashboard");
  const wrap = page(`
    <div class="auth-wrap container">
      <div class="auth-card">
        <h1>Verify email</h1>
        <p class="sub">Enter the 6-digit code sent by <strong>HORMACHUELOS</strong>${
          isDesktopLinkFlow() ? " to finish unlocking the desktop app." : "."
        }</p>
        <form id="verify-form" novalidate>
          <div class="field">
            <label for="vf-email">Email</label>
            <input id="vf-email" name="email" type="email" required value="${escapeHtml(email)}" placeholder="you@email.com" />
          </div>
          <div class="field">
            <label for="vf-code">Verification code</label>
            <input id="vf-code" name="code" inputmode="numeric" autocomplete="one-time-code" required maxlength="6" minlength="6" placeholder="123456" value="${escapeHtml(presetCode)}" />
          </div>
          <div class="field-error" id="verify-error" hidden></div>
          <button class="btn btn-primary btn-block" type="submit">Verify &amp; continue</button>
        </form>
        <p class="auth-foot" style="margin-top:18px">
          Didn't get it?
          <button type="button" class="linkish" id="resend-code" style="background:none;border:0;padding:0;color:inherit;text-decoration:underline;cursor:pointer">Resend code</button>
        </p>
      </div>
    </div>
  `);

  const err = wrap.querySelector("#verify-error");
  wrap.querySelector("#verify-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = wrap.querySelector('button[type="submit"]');
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = "Verifying…";
    try {
      const data = await apiAuth("/api/auth/verify", {
        method: "POST",
        body: {
          email: wrap.querySelector("#vf-email").value.trim(),
          code: wrap.querySelector("#vf-code").value.trim(),
        },
      });
      setSessionUser(data.user, data.token);
      toast(data.message || "Email verified");
      if (await finishDesktopLinkIfNeeded()) return;
      navigate(next.startsWith("/") ? next : `/${next}`);
    } catch (ex) {
      err.hidden = false;
      err.textContent = String(ex.message || "Verification failed");
      btn.disabled = false;
      btn.textContent = "Verify & continue";
    }
  });

  wrap.querySelector("#resend-code").addEventListener("click", async () => {
    const em = wrap.querySelector("#vf-email").value.trim();
    if (!em) {
      err.hidden = false;
      err.textContent = "Enter your email first.";
      return;
    }
    try {
      const data = await apiAuth("/api/auth/resend-verification", {
        method: "POST",
        body: { email: em },
      });
      toast(data.message || "Code resent");
    } catch (ex) {
      err.hidden = false;
      err.textContent = String(ex.message || "Could not resend");
    }
  });

  if (email && presetCode) {
    queueMicrotask(() => wrap.querySelector("#verify-form")?.requestSubmit?.());
  }

  return wrap;
}

function renderDashboard() {
  const user = getSessionUser();
  if (!user || !getSessionToken()) {
    navigate("/login?next=/dashboard");
    return page(`<div class="container" style="padding:48px 0"><p class="muted">Redirecting to login…</p></div>`);
  }

  const wrap = page(`
    <div class="dash container">
      <div class="dash-head">
        <div>
          <h1>Dashboard</h1>
          <p class="muted small" id="dash-email">Loading account…</p>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <a class="btn btn-sm" href="#/pricing">Change plan</a>
          <a class="btn btn-sm btn-primary" href="#/download">Download app</a>
        </div>
      </div>
      <div id="dash-body"><p class="muted">Loading…</p></div>
    </div>
  `);

  (async () => {
    try {
      const data = await apiAuth("/api/auth/me");
      const full = data.user;
      setSessionUser(full, getSessionToken());
      if (Array.isArray(data.orders)) saveJSON(STORAGE_ORDERS, data.orders);
      const orders = data.orders || getOrders().filter((o) => o.email === full.email);
      const planLabel = full.plan ? checkoutPlanLabel(full.plan) : null;
      const bill = BILLING[full.period] || BILLING.payg;
      const emailEl = wrap.querySelector("#dash-email");
      const body = wrap.querySelector("#dash-body");
      if (emailEl) emailEl.textContent = `Signed in as ${full.email}`;
      if (body) {
        body.innerHTML = `
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
                full.licenseKey
                  ? `<p style="margin:16px 0 4px" class="muted small">Desktop license</p>
                     <code class="mono small" style="display:block;word-break:break-all">${escapeHtml(full.licenseKey)}</code>`
                  : ""
              }
              ${
                !full.plan
                  ? `<div class="alert warn" style="margin-top:18px">No active plan yet. Pick a plan and unlock the agent.</div>
                     <a class="btn btn-primary" href="#/pricing">View pricing</a>`
                  : `<div class="alert ok" style="margin-top:18px">Active · ${escapeHtml(planLabel || "")} (${escapeHtml(bill?.label || "")}).</div>`
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
                          `<li><span class="mono">${escapeHtml(String(o.id || "").slice(0, 8))}</span> · ${escapeHtml(o.planName || o.planId || "")} · ${formatPHP(o.amount)} · ${escapeHtml(o.method || "")}</li>`,
                      )
                      .join("")}</ul>`
              }
            </div>
          </div>`;
      }
    } catch (ex) {
      setSessionUser(null);
      toast(String(ex.message || "Session expired"));
      navigate("/login?next=/dashboard");
    }
  })();

  return wrap;
}

function getAdminToken() {
  return localStorage.getItem(STORAGE_ADMIN) || "";
}

function setAdminToken(token) {
  if (token) localStorage.setItem(STORAGE_ADMIN, token);
  else localStorage.removeItem(STORAGE_ADMIN);
}

async function apiAdmin(path, { method = "GET", body } = {}) {
  const headers = { Accept: "application/json" };
  const token = getAdminToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Admin request failed (${res.status})`);
  return data;
}

function renderAdmin() {
  const wrap = page(`
    <div class="dash container admin-dash">
      <div class="dash-head">
        <div>
          <h1>Admin</h1>
          <p class="muted small">Manage users, plans, secure provider credentials, aliases, and software releases.</p>
        </div>
        <div id="admin-actions" style="display:flex;gap:8px;flex-wrap:wrap"></div>
      </div>
      <div id="admin-root"><p class="muted">Loading…</p></div>
    </div>
  `);

  const root = wrap.querySelector("#admin-root");
  const actions = wrap.querySelector("#admin-actions");

  function paintLogin() {
    actions.innerHTML = "";
    root.innerHTML = `
      <div class="auth-card" style="max-width:420px;margin:0 auto">
        <h1 style="font-size:1.35rem">Admin login</h1>
        <p class="sub">Staff only. Not for customer accounts.</p>
        <form id="admin-login-form" novalidate>
          <div class="field">
            <label for="admin-user">Username</label>
            <input id="admin-user" name="username" autocomplete="username" required placeholder="admin" />
          </div>
          <div class="field">
            <label for="admin-pass">Password</label>
            <input id="admin-pass" name="password" type="password" autocomplete="current-password" required />
          </div>
          <div class="field-error" id="admin-login-error" hidden></div>
          <button class="btn btn-primary btn-block" type="submit">Enter admin</button>
        </form>
      </div>`;
    root.querySelector("#admin-login-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = root.querySelector("#admin-login-error");
      const btn = root.querySelector('button[type="submit"]');
      err.hidden = true;
      btn.disabled = true;
      btn.textContent = "Checking…";
      try {
        const data = await fetch("/api/admin/login", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            username: root.querySelector("#admin-user").value.trim(),
            password: root.querySelector("#admin-pass").value,
          }),
        }).then(async (r) => {
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error || "Login failed");
          return j;
        });
        setAdminToken(data.token);
        toast("Admin signed in");
        await paintAdmin("users");
      } catch (ex) {
        err.hidden = false;
        err.textContent = String(ex.message || ex);
        btn.disabled = false;
        btn.textContent = "Enter admin";
      }
    });
  }

  function wireAdminChrome(tab) {
    actions.innerHTML = `
      <button type="button" class="btn btn-sm ${tab === "users" ? "btn-primary" : ""}" id="admin-tab-users">Users</button>
      <button type="button" class="btn btn-sm ${tab === "models" ? "btn-primary" : ""}" id="admin-tab-models">Models</button>
      <button type="button" class="btn btn-sm ${tab === "releases" ? "btn-primary" : ""}" id="admin-tab-releases">Releases</button>
      <button type="button" class="btn btn-sm" id="admin-refresh">Refresh</button>
      <button type="button" class="btn btn-sm btn-ghost" id="admin-logout">Log out</button>`;
    actions.querySelector("#admin-logout").onclick = () => {
      setAdminToken("");
      toast("Admin logged out");
      paintLogin();
    };
    actions.querySelector("#admin-refresh").onclick = () => paintAdmin(tab);
    actions.querySelector("#admin-tab-users").onclick = () => paintAdmin("users");
    actions.querySelector("#admin-tab-models").onclick = () => paintAdmin("models");
    actions.querySelector("#admin-tab-releases").onclick = () => paintAdmin("releases");
  }

  async function paintAdmin(tab = "users") {
    if (!getAdminToken()) {
      paintLogin();
      return;
    }
    wireAdminChrome(tab);
    if (tab === "models") {
      await paintModels();
      return;
    }
    if (tab === "releases") {
      await paintReleases();
      return;
    }
    await paintUsers();
  }

  async function paintUsers() {
    root.innerHTML = `<p class="muted">Loading users…</p>`;
    try {
      const data = await apiAdmin("/api/admin/users");
      const users = data.users || [];
      if (!users.length) {
        root.innerHTML = `<div class="card"><p class="muted" style="margin:0">No registered users yet.</p></div>`;
        return;
      }
      root.innerHTML = `
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Plan</th>
                <th>Credits</th>
                <th>Token budget</th>
                <th>Tokens used</th>
                <th>Expires</th>
                <th>License</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${users
                .map((u) => {
                  const plan = u.plan || "free";
                  return `<tr data-id="${escapeHtml(u.id)}">
                    <td>
                      <div class="admin-user">
                        <strong>${escapeHtml(u.name || "—")}</strong>
                        <span class="muted small mono">${escapeHtml(u.email)}</span>
                        ${u.licenseKey ? `<span class="muted small mono">${escapeHtml(u.licenseKey)}</span>` : `<span class="muted small">No license key</span>`}
                      </div>
                    </td>
                    <td>
                      <select class="field admin-plan">
                        ${["free", "starter", "pro", "proplus", "max5", "max10", "max20"]
                          .map(
                            (p) =>
                              `<option value="${p}" ${plan === p ? "selected" : ""}>${p}</option>`,
                          )
                          .join("")}
                      </select>
                    </td>
                    <td><input class="field admin-credits" type="number" min="0" step="1000" value="${Number(u.credits) || 0}" /></td>
                    <td><input class="field admin-budget" type="number" min="0" step="100000" value="${Number(u.tokenBudget) || 0}" /></td>
                    <td><input class="field admin-used" type="number" min="0" step="1000" value="${Number(u.tokensUsed) || 0}" /></td>
                    <td><input class="field admin-expires" type="date" value="${escapeHtml(u.expiresAt || "")}" /></td>
                    <td>
                      <label class="admin-active">
                        <input type="checkbox" class="admin-lic-active" ${u.licenseActive ? "checked" : ""} />
                        Active
                      </label>
                    </td>
                    <td><button type="button" class="btn btn-sm btn-primary admin-save">Save</button></td>
                  </tr>`;
                })
                .join("")}
            </tbody>
          </table>
        </div>
        <p class="muted small" style="margin-top:12px">${users.length} user${users.length === 1 ? "" : "s"} · edits apply to website account + hosted license usage.</p>`;

      root.querySelectorAll("tr[data-id]").forEach((tr) => {
        tr.querySelector(".admin-save")?.addEventListener("click", async () => {
          const btn = tr.querySelector(".admin-save");
          btn.disabled = true;
          btn.textContent = "Saving…";
          try {
            const plan = tr.querySelector(".admin-plan").value;
            await apiAdmin("/api/admin/users", {
              method: "PATCH",
              body: {
                id: tr.getAttribute("data-id"),
                plan,
                credits: Number(tr.querySelector(".admin-credits").value) || 0,
                tokenBudget: Number(tr.querySelector(".admin-budget").value) || 0,
                tokensUsed: Number(tr.querySelector(".admin-used").value) || 0,
                expiresAt: tr.querySelector(".admin-expires").value || undefined,
                licenseActive: tr.querySelector(".admin-lic-active").checked,
              },
            });
            toast("User updated");
            btn.textContent = "Saved";
            setTimeout(() => {
              btn.disabled = false;
              btn.textContent = "Save";
            }, 900);
          } catch (ex) {
            toast(String(ex.message || ex));
            btn.disabled = false;
            btn.textContent = "Save";
          }
        });
      });
    } catch (ex) {
      if (String(ex.message || "").toLowerCase().includes("admin")) {
        setAdminToken("");
        paintLogin();
        return;
      }
      root.innerHTML = `<div class="alert warn">${escapeHtml(String(ex.message || ex))}</div>`;
    }
  }

  async function paintModels() {
    root.innerHTML = `<p class="muted">Loading provider registry…</p>`;
    try {
      const data = await apiAdmin("/api/admin/providers");
      const providers = Array.isArray(data.providers) ? data.providers : [];
      const configs = Array.isArray(data.configs) ? data.configs : [];
      const modelsByProvider = new Map();
      for (const config of configs) {
        const providerId = String(config.providerId || "").trim().toLowerCase();
        const items = modelsByProvider.get(providerId) || [];
        items.push(config);
        modelsByProvider.set(providerId, items);
      }

      const storageWarning = data.credentialStorageReady
        ? ""
        : `<div class="alert warn">Credential encryption is not configured on the server. Set <code>HORMACHUELOS_MODEL_CONFIG_KEY</code> before saving a provider or model API key.</div>`;

      const modelRow = (model, provider) => {
        const inheritedEndpoint = !String(model.baseUrl || "").trim();
        const keyStatus = model.keyConfigured
          ? "Route-specific key saved"
          : provider.keyConfigured
            ? "Uses the provider default key"
            : "No key configured";
        return `<div class="admin-model-row" data-model-id="${escapeHtml(model.id)}" data-provider-id="${escapeHtml(provider.providerId)}">
          <div class="admin-model-row-head">
            <strong>${escapeHtml(model.displayName || model.alias)}</strong>
            <span class="admin-state ${model.active ? "is-active" : "is-paused"}">${model.active ? "Active" : "Paused"}</span>
          </div>
          <div class="admin-model-grid">
            <div class="field"><label>Model alias shown in app</label><input class="field admin-model-alias mono" value="${escapeHtml(model.alias)}" maxlength="81" pattern="[a-z0-9][a-z0-9._-]*" required /></div>
            <div class="field"><label>Model display name</label><input class="field admin-model-name" value="${escapeHtml(model.displayName)}" maxlength="120" required /></div>
            <div class="field"><label>Upstream model ID</label><input class="field admin-model-upstream mono" value="${escapeHtml(model.upstreamModel)}" maxlength="200" required /></div>
            <div class="field"><label>Endpoint override <span class="muted">(optional)</span></label><input class="field admin-model-base mono" type="url" value="${escapeHtml(model.baseUrl || "")}" maxlength="400" placeholder="${inheritedEndpoint ? "Uses provider endpoint" : "https://provider.example/v1"}" /><p class="muted small">${inheritedEndpoint ? "Inherited from provider" : "This model overrides the provider endpoint"}</p></div>
            <div class="field admin-key-field"><label>Route API key override <span class="muted">(optional)</span></label><input class="field admin-model-key" type="password" autocomplete="new-password" placeholder="${model.keyConfigured ? "•••••••• (leave blank to keep)" : "Use provider key"}" /><p class="muted small">${keyStatus}</p></div>
            <label class="admin-active admin-toggle-field"><input type="checkbox" class="admin-model-active" ${model.active ? "checked" : ""} /> Model active</label>
          </div>
          <div class="admin-row-actions">
            <button type="button" class="btn btn-sm btn-primary admin-model-save">Save alias</button>
            <button type="button" class="btn btn-sm admin-model-clear" ${model.keyConfigured ? "" : "disabled"}>Clear route key</button>
            <button type="button" class="btn btn-sm danger admin-model-delete">Delete alias</button>
          </div>
        </div>`;
      };

      const addModelForm = (provider) => `<details class="admin-add-model">
        <summary>Add a model alias to this provider</summary>
        <form class="admin-model-add-form" data-provider-id="${escapeHtml(provider.providerId)}">
          <div class="admin-model-grid">
            <div class="field"><label>Model alias shown in app</label><input class="field new-model-alias mono" required maxlength="81" placeholder="my-model-fast" pattern="[a-z0-9][a-z0-9._-]*" /></div>
            <div class="field"><label>Model display name</label><input class="field new-model-name" required maxlength="120" placeholder="My Model Fast" /></div>
            <div class="field"><label>Upstream model ID</label><input class="field new-model-upstream mono" required maxlength="200" placeholder="grok-4.5" /></div>
            <div class="field"><label>Endpoint override <span class="muted">(optional)</span></label><input class="field new-model-base mono" type="url" maxlength="400" placeholder="Uses provider endpoint" /></div>
            <div class="field admin-key-field"><label>Route API key override <span class="muted">(optional)</span></label><input class="field new-model-key" type="password" autocomplete="new-password" placeholder="Uses provider key" /></div>
            <label class="admin-active admin-toggle-field"><input type="checkbox" class="new-model-active" checked /> Model active</label>
          </div>
          <div class="admin-row-actions"><button type="submit" class="btn btn-sm btn-primary">Add model alias</button></div>
        </form>
      </details>`;

      const providerCards = providers.map((provider) => {
        const models = (modelsByProvider.get(provider.providerId) || [])
          .slice()
          .sort((left, right) => String(left.displayName).localeCompare(String(right.displayName)));
        const keyStatus = provider.keyConfigured ? "Default key configured" : "No default key";
        const modelSummary = `${models.length} model alias${models.length === 1 ? "" : "es"}`;
        return `<article class="admin-provider-card" data-provider-id="${escapeHtml(provider.providerId)}" data-profile-id="${escapeHtml(provider.id || "")}" data-profile-configured="${provider.profileConfigured ? "true" : "false"}" data-model-count="${String(models.length)}">
          <header class="admin-provider-head">
            <div>
              <p class="admin-eyebrow">Provider configuration</p>
              <h3>${escapeHtml(provider.displayName)}</h3>
              <p class="muted small mono">${escapeHtml(provider.providerId)}</p>
            </div>
            <div class="admin-provider-status"><span class="admin-state ${provider.active ? "is-active" : "is-paused"}">${provider.active ? "Active" : "Paused"}</span><span class="muted small">${escapeHtml(modelSummary)}</span></div>
          </header>
          <div class="admin-provider-grid">
            <div class="field"><label>Provider ID</label><input class="field mono admin-provider-id" value="${escapeHtml(provider.providerId)}" readonly aria-readonly="true" /><p class="muted small">Stable technical ID</p></div>
            <div class="field"><label>Provider alias shown in app</label><input class="field admin-provider-name" value="${escapeHtml(provider.displayName)}" maxlength="120" required /></div>
            <div class="field admin-provider-endpoint"><label>Default HTTPS endpoint</label><input class="field mono admin-provider-base" type="url" value="${escapeHtml(provider.baseUrl)}" maxlength="400" required /><p class="muted small">OpenAI-compatible chat-completions endpoint</p></div>
            <div class="field admin-key-field"><label>Default server API key</label><input class="field admin-provider-key" type="password" autocomplete="new-password" placeholder="${provider.keyConfigured ? "•••••••• (leave blank to keep)" : "Paste a provider key"}" /><p class="muted small">${keyStatus}. It applies to aliases without a route-specific override.</p></div>
            <label class="admin-active admin-toggle-field"><input type="checkbox" class="admin-provider-active" ${provider.active ? "checked" : ""} /> Provider active</label>
          </div>
          <div class="admin-provider-actions">
            <button type="button" class="btn btn-sm btn-primary admin-provider-save">${provider.profileConfigured ? "Save provider" : "Configure provider"}</button>
            <button type="button" class="btn btn-sm admin-provider-clear" ${provider.keyConfigured ? "" : "disabled"}>Clear default key</button>
            ${provider.profileConfigured && models.length === 0 ? `<button type="button" class="btn btn-sm danger admin-provider-delete">Remove provider</button>` : ""}
          </div>
          <section class="admin-model-section">
            <div class="admin-model-section-head"><div><p class="admin-eyebrow">Model aliases</p><h4>Models available under ${escapeHtml(provider.displayName)}</h4></div><span class="muted small">${escapeHtml(modelSummary)}</span></div>
            ${models.length ? `<div class="admin-model-list">${models.map((model) => modelRow(model, provider)).join("")}</div>` : `<div class="admin-empty-models">No model aliases yet. Configure the provider, then add the first alias below.</div>`}
            ${addModelForm(provider)}
          </section>
        </article>`;
      }).join("");

      root.innerHTML = `
        <section class="admin-provider-intro card">
          <div>
            <p class="admin-eyebrow">Secure provider registry</p>
            <h2>Provider keys, names, and model aliases</h2>
            <p class="muted">Every API key is write-only and encrypted before it reaches storage. Set a provider default once, override an individual model only when that model needs a different credential, and control the names clients see in the desktop picker.</p>
          </div>
          <div class="admin-security-note"><span aria-hidden="true">◆</span><p><strong>Keys never leave the server.</strong> The dashboard only reports whether a key is configured; it never displays the saved value.</p></div>
        </section>
        ${storageWarning}
        <section class="admin-add-provider-card card">
          <div class="admin-model-section-head"><div><p class="admin-eyebrow">Create provider</p><h3>Add a custom hosted provider</h3></div><span class="muted small">Use an OpenAI-compatible endpoint</span></div>
          <form id="admin-provider-new-form">
            <div class="admin-provider-grid">
              <div class="field"><label>Provider ID</label><input class="field mono" id="new-provider-id" required maxlength="49" placeholder="my-provider" pattern="[a-z][a-z0-9_-]*" /><p class="muted small">Lowercase letters, numbers, dashes, or underscores</p></div>
              <div class="field"><label>Provider alias shown in app</label><input class="field" id="new-provider-name" required maxlength="120" placeholder="My Provider" /></div>
              <div class="field admin-provider-endpoint"><label>Default HTTPS endpoint</label><input class="field mono" id="new-provider-base" required type="url" maxlength="400" placeholder="https://provider.example/v1" /></div>
              <div class="field admin-key-field"><label>Default server API key</label><input class="field" id="new-provider-key" type="password" autocomplete="new-password" placeholder="Paste a provider key" /><p class="muted small">You can add the provider first and save the key later.</p></div>
              <label class="admin-active admin-toggle-field"><input type="checkbox" id="new-provider-active" checked /> Provider active</label>
            </div>
            <div class="admin-row-actions"><button class="btn btn-primary" type="submit">Add provider</button></div>
          </form>
        </section>
        <div class="admin-provider-list">${providerCards}</div>`;

      const providerFields = (card) => ({
        id: card.getAttribute("data-profile-id") || undefined,
        providerId: card.getAttribute("data-provider-id"),
        displayName: card.querySelector(".admin-provider-name").value.trim(),
        baseUrl: card.querySelector(".admin-provider-base").value.trim(),
        active: card.querySelector(".admin-provider-active").checked,
      });

      root.querySelectorAll(".admin-provider-card").forEach((card) => {
        const save = card.querySelector(".admin-provider-save");
        const clear = card.querySelector(".admin-provider-clear");
        const remove = card.querySelector(".admin-provider-delete");
        save?.addEventListener("click", async () => {
          const key = card.querySelector(".admin-provider-key").value.trim();
          save.disabled = true;
          save.textContent = "Saving…";
          try {
            const body = providerFields(card);
            if (key) body.apiKey = key;
            await apiAdmin("/api/admin/providers", {
              method: card.getAttribute("data-profile-configured") === "true" ? "PATCH" : "POST",
              body,
            });
            toast("Provider saved securely");
            await paintAdmin("models");
          } catch (ex) {
            toast(String(ex.message || ex));
            save.disabled = false;
            save.textContent = card.getAttribute("data-profile-configured") === "true" ? "Save provider" : "Configure provider";
          }
        });
        clear?.addEventListener("click", async () => {
          if (!confirm("Clear this provider's default API key? Aliases with a route-specific key will continue to work.")) return;
          clear.disabled = true;
          try {
            await apiAdmin("/api/admin/providers", {
              method: "PATCH",
              body: { ...providerFields(card), clearApiKey: true },
            });
            toast("Provider default key cleared");
            await paintAdmin("models");
          } catch (ex) {
            toast(String(ex.message || ex));
            clear.disabled = false;
          }
        });
        remove?.addEventListener("click", async () => {
          const providerName = card.querySelector(".admin-provider-name").value.trim() || "this provider";
          if (!confirm(`Remove ${providerName}? It has no model aliases, so this only removes its saved provider configuration.`)) return;
          remove.disabled = true;
          try {
            await apiAdmin("/api/admin/providers", {
              method: "DELETE",
              body: { providerId: card.getAttribute("data-provider-id") },
            });
            toast("Provider removed");
            await paintAdmin("models");
          } catch (ex) {
            toast(String(ex.message || ex));
            remove.disabled = false;
          }
        });
      });

      const modelFields = (row) => ({
        id: row.getAttribute("data-model-id"),
        providerId: row.getAttribute("data-provider-id"),
        alias: row.querySelector(".admin-model-alias").value.trim(),
        displayName: row.querySelector(".admin-model-name").value.trim(),
        upstreamModel: row.querySelector(".admin-model-upstream").value.trim(),
        baseUrl: row.querySelector(".admin-model-base").value.trim(),
        active: row.querySelector(".admin-model-active").checked,
      });

      root.querySelectorAll(".admin-model-row").forEach((row) => {
        const save = row.querySelector(".admin-model-save");
        const clear = row.querySelector(".admin-model-clear");
        const remove = row.querySelector(".admin-model-delete");
        save.addEventListener("click", async () => {
          const key = row.querySelector(".admin-model-key").value.trim();
          save.disabled = true;
          save.textContent = "Saving…";
          try {
            const body = modelFields(row);
            if (key) body.apiKey = key;
            await apiAdmin("/api/admin/models", { method: "PATCH", body });
            toast("Model alias saved");
            await paintAdmin("models");
          } catch (ex) {
            toast(String(ex.message || ex));
            save.disabled = false;
            save.textContent = "Save alias";
          }
        });
        clear.addEventListener("click", async () => {
          if (!confirm("Clear this route-specific API key? The model will use the provider default key if one is configured.")) return;
          clear.disabled = true;
          try {
            await apiAdmin("/api/admin/models", {
              method: "PATCH",
              body: { ...modelFields(row), clearApiKey: true },
            });
            toast("Route key cleared");
            await paintAdmin("models");
          } catch (ex) {
            toast(String(ex.message || ex));
            clear.disabled = false;
          }
        });
        remove.addEventListener("click", async () => {
          const modelName = row.querySelector(".admin-model-name").value.trim() || "this model alias";
          if (!confirm(`Delete ${modelName}? It will no longer appear in the desktop app.`)) return;
          remove.disabled = true;
          try {
            await apiAdmin("/api/admin/models", {
              method: "DELETE",
              body: { id: row.getAttribute("data-model-id") },
            });
            toast("Model alias deleted");
            await paintAdmin("models");
          } catch (ex) {
            toast(String(ex.message || ex));
            remove.disabled = false;
          }
        });
      });

      root.querySelectorAll(".admin-model-add-form").forEach((form) => {
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          const btn = form.querySelector('button[type="submit"]');
          btn.disabled = true;
          btn.textContent = "Adding…";
          try {
            const key = form.querySelector(".new-model-key").value.trim();
            const body = {
              providerId: form.getAttribute("data-provider-id"),
              alias: form.querySelector(".new-model-alias").value.trim(),
              displayName: form.querySelector(".new-model-name").value.trim(),
              upstreamModel: form.querySelector(".new-model-upstream").value.trim(),
              baseUrl: form.querySelector(".new-model-base").value.trim(),
              active: form.querySelector(".new-model-active").checked,
            };
            if (key) body.apiKey = key;
            await apiAdmin("/api/admin/models", { method: "POST", body });
            toast("Model alias added");
            await paintAdmin("models");
          } catch (ex) {
            toast(String(ex.message || ex));
            btn.disabled = false;
            btn.textContent = "Add model alias";
          }
        });
      });

      root.querySelector("#admin-provider-new-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        btn.textContent = "Adding…";
        try {
          const key = root.querySelector("#new-provider-key").value.trim();
          const body = {
            providerId: root.querySelector("#new-provider-id").value.trim(),
            displayName: root.querySelector("#new-provider-name").value.trim(),
            baseUrl: root.querySelector("#new-provider-base").value.trim(),
            active: root.querySelector("#new-provider-active").checked,
          };
          if (key) body.apiKey = key;
          await apiAdmin("/api/admin/providers", { method: "POST", body });
          toast("Custom provider added securely");
          await paintAdmin("models");
        } catch (ex) {
          toast(String(ex.message || ex));
          btn.disabled = false;
          btn.textContent = "Add provider";
        }
      });
    } catch (ex) {
      if (String(ex.message || "").toLowerCase().includes("admin")) {
        setAdminToken("");
        paintLogin();
        return;
      }
      root.innerHTML = `<div class="alert warn">${escapeHtml(String(ex.message || ex))}</div>`;
    }
  }

  async function paintLegacyModels() {
    root.innerHTML = `<p class="muted">Loading hosted models…</p>`;
    try {
      const data = await apiAdmin("/api/admin/models");
      const configs = Array.isArray(data.configs) ? data.configs : [];
      const providerOptions = Array.isArray(data.providerOptions) ? data.providerOptions : [];
      const providerLabels = new Map(
        providerOptions.map((provider) => [provider.id, provider.label]),
      );
      const providerLabel = (id) => {
        const normalized = String(id || "").trim().toLowerCase();
        return providerLabels.get(normalized) || normalized
          .split(/[-_]+/)
          .filter(Boolean)
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(" ") || "Hosted provider";
      };
      const knownProviderIds = new Set(providerOptions.map((provider) => provider.id));
      for (const config of configs) knownProviderIds.add(config.providerId);
      const formProviderOptions = [...knownProviderIds]
        .sort((left, right) => providerLabel(left).localeCompare(providerLabel(right)))
        .map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(providerLabel(id))} · ${escapeHtml(id)}</option>`)
        .join("");
      const groupedConfigs = new Map();
      for (const config of configs) {
        const rows = groupedConfigs.get(config.providerId) || [];
        rows.push(config);
        groupedConfigs.set(config.providerId, rows);
      }
      const storageWarning = data.credentialStorageReady
        ? ""
        : `<div class="alert warn">Credential encryption is not configured on the server. Set <code>HORMACHUELOS_MODEL_CONFIG_KEY</code> before saving a model key.</div>`;
      const tables = [...groupedConfigs.entries()]
        .sort(([left], [right]) => providerLabel(left).localeCompare(providerLabel(right)))
        .map(([providerId, rows]) => `
          <section class="card" style="margin-bottom:16px">
            <div style="display:flex;gap:12px;align-items:baseline;justify-content:space-between;flex-wrap:wrap">
              <div><h3 style="margin:0">${escapeHtml(providerLabel(providerId))}</h3><p class="muted small mono" style="margin:4px 0 0">provider alias: ${escapeHtml(providerId)}</p></div>
              <span class="muted small">${rows.length} model route${rows.length === 1 ? "" : "s"}</span>
            </div>
            <div class="admin-table-wrap" style="margin-top:12px">
              <table class="admin-table">
                <thead><tr><th>Provider alias</th><th>Model alias &amp; name</th><th>Upstream model</th><th>Base URL</th><th>Server key</th><th>Active</th><th></th></tr></thead>
                <tbody>
                  ${rows
                    .slice()
                    .sort((left, right) => String(left.displayName).localeCompare(String(right.displayName)))
                    .map((model) => `<tr data-model-id="${escapeHtml(model.id)}">
                      <td><input class="field admin-model-provider" value="${escapeHtml(model.providerId)}" aria-label="Provider alias" /></td>
                      <td><input class="field admin-model-alias mono" value="${escapeHtml(model.alias)}" aria-label="Model alias" /><input class="field admin-model-name" value="${escapeHtml(model.displayName)}" aria-label="Model display name" style="margin-top:6px" /></td>
                      <td><input class="field admin-model-upstream" value="${escapeHtml(model.upstreamModel)}" aria-label="Upstream model ID" /></td>
                      <td><input class="field admin-model-base" type="url" value="${escapeHtml(model.baseUrl)}" aria-label="HTTPS base URL" /></td>
                      <td><input class="field admin-model-key" type="password" autocomplete="new-password" placeholder="${model.keyConfigured ? "•••••••• (leave blank to keep)" : "No key saved"}" aria-label="Replacement server API key" /><span class="muted small">${model.keyConfigured ? "Key configured" : "No key configured"}</span></td>
                      <td><label class="admin-active"><input type="checkbox" class="admin-model-active" ${model.active ? "checked" : ""} /> Active</label></td>
                      <td><button type="button" class="btn btn-sm btn-primary admin-model-save">Save</button><button type="button" class="btn btn-sm admin-model-clear" ${model.keyConfigured ? "" : "disabled"}>Clear key</button><button type="button" class="btn btn-sm danger admin-model-delete">Delete</button></td>
                    </tr>`)
                    .join("")}
                </tbody>
              </table>
            </div>
          </section>`)
        .join("");
      root.innerHTML = `
        <div class="card" style="margin-bottom:16px">
          <h3 style="margin-top:0">Hosted provider and model aliases</h3>
          <p class="muted small">Create a provider alias, then add one or more model aliases beneath it. Each route keeps its upstream API key encrypted on the server; keys are never returned to the desktop app or ordinary users.</p>
          ${storageWarning}
          <form id="hosted-model-form" class="admin-release-form">
            <div class="field"><label>Provider alias</label><select id="model-provider" class="field">${formProviderOptions}<option value="__custom__">Create a custom provider alias…</option></select></div>
            <div class="field" id="model-provider-custom-wrap" hidden><label>New provider alias</label><input id="model-provider-custom" class="field mono" maxlength="49" placeholder="my-provider" pattern="[a-z][a-z0-9_-]*" /><p class="muted small" style="margin:6px 0 0">Use lowercase letters, numbers, dashes, or underscores. This identifier is the provider alias shown in the app.</p></div>
            <div class="field"><label>Model alias</label><input id="model-alias" class="field mono" required maxlength="81" placeholder="my-model-fast" pattern="[a-z0-9][a-z0-9._-]*" /></div>
            <div class="field"><label>Model display name</label><input id="model-name" class="field" required maxlength="120" placeholder="My Model Fast" /></div>
            <div class="field"><label>Upstream model ID</label><input id="model-upstream" class="field" required maxlength="200" placeholder="grok-4.5" /></div>
            <div class="field"><label>HTTPS base URL</label><input id="model-base" class="field" required type="url" maxlength="400" placeholder="https://provider.example/v1" /></div>
            <div class="field"><label>Server API key</label><input id="model-key" class="field" type="password" autocomplete="new-password" placeholder="Paste once — it will not be shown again" /><p class="muted small" style="margin:6px 0 0">Required for a route to become available. Leave blank only when you are creating the route first and will add its key afterward.</p></div>
            <p class="muted small" style="margin:0 0 12px">Example: select <code>xAI</code>, use model alias <code>gpt-5.6-sol</code> with upstream ID <code>grok-4.5</code>, and set the base URL to <code>https://api.x.ai/v1</code>.</p>
            <label class="admin-active" style="margin:8px 0 14px;display:inline-flex"><input type="checkbox" id="model-active" checked /> Active</label>
            <div class="field-error" id="model-error" hidden></div>
            <button class="btn btn-primary" type="submit">Add model alias</button>
          </form>
        </div>
        ${tables || `<div class="card muted">No hosted model aliases yet. Add the first provider route above.</div>`}`;

      const fieldsFor = (row) => ({
        id: row.getAttribute("data-model-id"),
        providerId: row.querySelector(".admin-model-provider").value.trim(),
        alias: row.querySelector(".admin-model-alias").value.trim(),
        displayName: row.querySelector(".admin-model-name").value.trim(),
        upstreamModel: row.querySelector(".admin-model-upstream").value.trim(),
        baseUrl: row.querySelector(".admin-model-base").value.trim(),
        active: row.querySelector(".admin-model-active").checked,
      });

      root.querySelectorAll("tr[data-model-id]").forEach((row) => {
        row.querySelector(".admin-model-save").addEventListener("click", async () => {
          const btn = row.querySelector(".admin-model-save");
          const keyInput = row.querySelector(".admin-model-key");
          btn.disabled = true;
          btn.textContent = "Saving…";
          try {
            const body = fieldsFor(row);
            if (keyInput.value.trim()) body.apiKey = keyInput.value.trim();
            await apiAdmin("/api/admin/models", { method: "PATCH", body });
            toast("Hosted model saved");
            await paintAdmin("models");
          } catch (ex) {
            toast(String(ex.message || ex));
            btn.disabled = false;
            btn.textContent = "Save";
          }
        });
        row.querySelector(".admin-model-clear").addEventListener("click", async () => {
          if (!confirm("Clear this server-side API key? The model will stop serving requests until a new key is saved.")) return;
          const btn = row.querySelector(".admin-model-clear");
          btn.disabled = true;
          try {
            await apiAdmin("/api/admin/models", {
              method: "PATCH",
              body: { ...fieldsFor(row), clearApiKey: true },
            });
            toast("Hosted model key cleared");
            await paintAdmin("models");
          } catch (ex) {
            toast(String(ex.message || ex));
            btn.disabled = false;
          }
        });
        row.querySelector(".admin-model-delete").addEventListener("click", async () => {
          const modelName = row.querySelector(".admin-model-name").value.trim() || "this model alias";
          if (!confirm(`Delete ${modelName}? This removes its server-side route and stops it from appearing in the desktop app.`)) return;
          const btn = row.querySelector(".admin-model-delete");
          btn.disabled = true;
          try {
            await apiAdmin("/api/admin/models", {
              method: "DELETE",
              body: { id: row.getAttribute("data-model-id") },
            });
            toast("Hosted model alias deleted");
            await paintAdmin("models");
          } catch (ex) {
            toast(String(ex.message || ex));
            btn.disabled = false;
          }
        });
      });

      const providerSelect = root.querySelector("#model-provider");
      const customProviderWrap = root.querySelector("#model-provider-custom-wrap");
      const customProviderInput = root.querySelector("#model-provider-custom");
      const syncCustomProvider = () => {
        const isCustom = providerSelect.value === "__custom__";
        customProviderWrap.hidden = !isCustom;
        customProviderInput.required = isCustom;
      };
      providerSelect.addEventListener("change", syncCustomProvider);
      syncCustomProvider();

      root.querySelector("#hosted-model-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const error = root.querySelector("#model-error");
        const btn = root.querySelector('#hosted-model-form button[type="submit"]');
        error.hidden = true;
        btn.disabled = true;
        btn.textContent = "Saving…";
        try {
          const providerId = providerSelect.value === "__custom__"
            ? customProviderInput.value.trim()
            : providerSelect.value;
          await apiAdmin("/api/admin/models", {
            method: "POST",
            body: {
              providerId,
              alias: root.querySelector("#model-alias").value.trim(),
              displayName: root.querySelector("#model-name").value.trim(),
              upstreamModel: root.querySelector("#model-upstream").value.trim(),
              baseUrl: root.querySelector("#model-base").value.trim(),
              apiKey: root.querySelector("#model-key").value.trim(),
              active: root.querySelector("#model-active").checked,
            },
          });
          toast("Hosted model added");
          await paintAdmin("models");
        } catch (ex) {
          error.hidden = false;
          error.textContent = String(ex.message || ex);
          btn.disabled = false;
          btn.textContent = "Add model alias";
        }
      });
    } catch (ex) {
      if (String(ex.message || "").toLowerCase().includes("admin")) {
        setAdminToken("");
        paintLogin();
        return;
      }
      root.innerHTML = `<div class="alert warn">${escapeHtml(String(ex.message || ex))}</div>`;
    }
  }

  async function paintReleases() {
    root.innerHTML = `<p class="muted">Loading releases…</p>`;
    try {
      const data = await apiAdmin("/api/admin/releases");
      const releases = data.releases || [];
      root.innerHTML = `
        <div class="card" style="margin-bottom:16px">
          <h3 style="margin-top:0">Publish software update</h3>
          <p class="muted small">Users on older builds will see What's new and must update when Force update is on.</p>
          <form id="release-form" class="admin-release-form">
            <div class="field"><label>Version</label><input id="rel-version" class="field" required placeholder="0.1.1" /></div>
            <div class="field"><label>Title</label><input id="rel-title" class="field" placeholder="Hormachuelos 0.1.1" /></div>
            <div class="field"><label>What's new</label><textarea id="rel-notes" class="field" rows="5" required placeholder="• Bug fixes&#10;• New features"></textarea></div>
            <div class="field"><label>MSI download URL</label><input id="rel-msi" class="field" type="url" placeholder="https://…/Hormachuelos_x_x64_en-US.msi" /></div>
            <div class="field"><label>MSI SHA-256</label><input id="rel-msi-sha256" class="field mono" maxlength="64" pattern="[a-fA-F0-9]{64}" placeholder="64-character installer checksum" /></div>
            <div class="field"><label>EXE download URL</label><input id="rel-exe" class="field" type="url" placeholder="https://…/Hormachuelos_x_x64-setup.exe" /></div>
            <div class="field"><label>EXE SHA-256</label><input id="rel-exe-sha256" class="field mono" maxlength="64" pattern="[a-fA-F0-9]{64}" placeholder="64-character installer checksum" /></div>
            <label class="admin-active" style="margin:8px 0 14px;display:inline-flex">
              <input type="checkbox" id="rel-force" checked /> Force update (block old app until installed)
            </label>
            <div class="field-error" id="rel-error" hidden></div>
            <button class="btn btn-primary" type="submit">Publish update</button>
          </form>
        </div>
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead>
              <tr>
                <th>Version</th>
                <th>Title</th>
                <th>Force</th>
                <th>Latest</th>
                <th>Published</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${
                releases.length
                  ? releases
                      .map(
                        (r) => `<tr data-id="${escapeHtml(r.id)}">
                  <td class="mono">${escapeHtml(r.version)}${r.isLatest ? " · latest" : ""}</td>
                  <td>${escapeHtml(r.title || "")}</td>
                  <td>${r.forceUpdate ? "Yes" : "No"}</td>
                  <td>${r.isLatest ? "Yes" : "—"}</td>
                  <td class="mono small">${escapeHtml(String(r.publishedAt || "").slice(0, 10))}</td>
                  <td><button type="button" class="btn btn-sm admin-toggle-force" data-force="${r.forceUpdate ? "0" : "1"}">${r.forceUpdate ? "Disable force" : "Enable force"}</button></td>
                </tr>`,
                      )
                      .join("")
                  : `<tr><td colspan="6" class="muted">No releases yet.</td></tr>`
              }
            </tbody>
          </table>
        </div>`;

      root.querySelector("#release-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const err = root.querySelector("#rel-error");
        const btn = root.querySelector('#release-form button[type="submit"]');
        err.hidden = true;
        btn.disabled = true;
        btn.textContent = "Publishing…";
        try {
          await apiAdmin("/api/admin/releases", {
            method: "POST",
            body: {
              version: root.querySelector("#rel-version").value.trim(),
              title: root.querySelector("#rel-title").value.trim(),
              whatsNew: root.querySelector("#rel-notes").value.trim(),
              msiUrl: root.querySelector("#rel-msi").value.trim(),
              msiSha256: root.querySelector("#rel-msi-sha256").value.trim(),
              exeUrl: root.querySelector("#rel-exe").value.trim(),
              exeSha256: root.querySelector("#rel-exe-sha256").value.trim(),
              forceUpdate: root.querySelector("#rel-force").checked,
              isLatest: true,
            },
          });
          toast("Update published");
          await paintAdmin("releases");
        } catch (ex) {
          err.hidden = false;
          err.textContent = String(ex.message || ex);
          btn.disabled = false;
          btn.textContent = "Publish update";
        }
      });

      root.querySelectorAll(".admin-toggle-force").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const tr = btn.closest("tr");
          try {
            await apiAdmin("/api/admin/releases", {
              method: "PATCH",
              body: { id: tr.getAttribute("data-id"), forceUpdate: btn.getAttribute("data-force") === "1" },
            });
            toast("Release updated");
            await paintAdmin("releases");
          } catch (ex) {
            toast(String(ex.message || ex));
          }
        });
      });
    } catch (ex) {
      if (String(ex.message || "").toLowerCase().includes("admin")) {
        setAdminToken("");
        paintLogin();
        return;
      }
      root.innerHTML = `<div class="alert warn">${escapeHtml(String(ex.message || ex))}</div>`;
    }
  }

  paintAdmin("users");
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
        <div class="summary-row"><span>Billing</span><span>Pay as you go</span></div>
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
      try {
        const patched = await apiAuth("/api/auth/me", {
          method: "PATCH",
          body: {
            plan: planId,
            period,
            licenseKey: checkout.licenseKey,
            credits: (user.credits || 0) + creditBonus,
            order,
          },
        });
        setSessionUser(patched.user, getSessionToken());
      } catch (syncErr) {
        console.warn("Account sync failed", syncErr);
        setSessionUser(
          {
            ...user,
            plan: planId,
            period,
            licenseKey: checkout.licenseKey,
            credits: (user.credits || 0) + creditBonus,
          },
          getSessionToken(),
        );
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
  const wrap = page(`
    <div class="prose container">
      <h1>Download Hormachuelos</h1>
      <p id="dl-lead">Install the desktop AI agent on Windows. Loading latest build…</p>
      <div class="card" style="margin:20px 0">
        <h3 style="margin-top:0">Windows</h3>
        <p class="muted small">After install, open Hormachuelos — it opens this website so you can <strong>log in or sign up</strong>, then the app signs in automatically.</p>
        <div id="dl-actions" style="display:flex;gap:10px;flex-wrap:wrap;margin-top:16px">
          <a class="btn btn-primary" id="dl-msi" href="${windows.msi.href}">${escapeHtml(windows.msi.label)}</a>
          <a class="btn" id="dl-exe" href="${windows.setup.href}">${escapeHtml(windows.setup.label)}</a>
          <a class="btn btn-ghost" href="#/update">What's new / Update</a>
        </div>
        <ol class="muted small" style="margin:16px 0 0;padding-left:18px;line-height:1.55">
          <li>Download &amp; install</li>
          <li>Open the app → browser opens for login/signup</li>
          <li>Return to the app — you're signed in automatically</li>
        </ol>
      </div>
    </div>
  `);
  (async () => {
    try {
      const data = await fetch("/api/update").then((r) => r.json());
      const latest = data.latest;
      if (!latest) return;
      const lead = wrap.querySelector("#dl-lead");
      if (lead) {
        lead.textContent = `Latest: v${latest.version}${latest.title ? ` · ${latest.title}` : ""} · 64-bit Windows`;
      }
      const msi = wrap.querySelector("#dl-msi");
      const exe = wrap.querySelector("#dl-exe");
      if (msi && latest.msiUrl) {
        msi.href = latest.msiUrl;
        msi.textContent = `Windows installer (MSI) v${latest.version}`;
      }
      if (exe && latest.exeUrl) {
        exe.href = latest.exeUrl;
        exe.textContent = `Windows setup (EXE) v${latest.version}`;
      }
    } catch {
      const lead = wrap.querySelector("#dl-lead");
      if (lead) lead.textContent = `Install the desktop AI agent on Windows. v${version} · 64-bit.`;
    }
  })();
  return wrap;
}

function renderUpdate() {
  const wrap = page(`
    <div class="prose container">
      <h1>Update Hormachuelos</h1>
      <p class="muted" id="upd-lead">Checking for the latest desktop build…</p>
      <div class="card" id="upd-card" style="margin:20px 0">
        <p class="muted" style="margin:0">Loading…</p>
      </div>
    </div>
  `);
  (async () => {
    const card = wrap.querySelector("#upd-card");
    const lead = wrap.querySelector("#upd-lead");
    try {
      const data = await fetch("/api/update").then((r) => r.json());
      const latest = data.latest;
      if (!latest) {
        lead.textContent = "No published releases yet.";
        card.innerHTML = `<p class="muted" style="margin:0">Check back soon.</p>`;
        return;
      }
      lead.textContent = latest.forceUpdate
        ? "A required update is available. Install before using the desktop app."
        : "Install the latest build to get fixes and new features.";
      const notes = escapeHtml(latest.whatsNew || "Improvements and fixes.")
        .replace(/\n/g, "<br>");
      card.innerHTML = `
        <div class="eyebrow" style="margin-bottom:10px"><span class="dot"></span> Latest release</div>
        <h2 style="margin:0 0 8px;font-size:1.45rem">${escapeHtml(latest.title || `v${latest.version}`)}</h2>
        <p class="mono small muted" style="margin:0 0 16px">Version ${escapeHtml(latest.version)} · ${escapeHtml(String(latest.publishedAt || "").slice(0, 10))}${latest.forceUpdate ? " · required update" : ""}</p>
        <h3 style="margin:0 0 8px">What's new</h3>
        <div class="update-notes">${notes}</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:20px">
          ${latest.msiUrl ? `<a class="btn btn-primary" href="${escapeHtml(latest.msiUrl)}">Update (MSI)</a>` : ""}
          ${latest.exeUrl ? `<a class="btn btn-primary" href="${escapeHtml(latest.exeUrl)}">Update (EXE)</a>` : ""}
          <a class="btn" href="#/download">Download page</a>
        </div>`;
    } catch (ex) {
      lead.textContent = "Could not load update info.";
      card.innerHTML = `<p class="muted" style="margin:0">${escapeHtml(String(ex.message || ex))}</p>`;
    }
  })();
  return wrap;
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

async function boot() {
  const y = document.getElementById("year");
  if (y) y.textContent = String(new Date().getFullYear());

  document.getElementById("nav-toggle")?.addEventListener("click", () => {
    const nav = document.getElementById("nav");
    const open = nav.classList.toggle("open");
    document.getElementById("nav-toggle").setAttribute("aria-expanded", String(open));
  });

  window.addEventListener("hashchange", render);
  rememberDesktopLinkFromUrl();
  if (getSessionToken()) {
    await refreshSessionUser();
  }
  // Already signed in + desktop pairing code in URL/session → jump straight to link flow.
  if (getSessionToken() && pendingDesktopCode() && pathOf() !== "/desktop-linked") {
    const target = `#/login?desktop=1&dcode=${encodeURIComponent(pendingDesktopCode())}`;
    if (location.hash !== target) {
      location.hash = target;
      return; // hashchange → render
    }
  }
  if (!location.hash) location.hash = "#/";
  else render();
}

boot();
