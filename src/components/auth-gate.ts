import { api } from "../ipc";
import { el } from "./util";

const HOSTED_API = "https://hormachuelos.vercel.app";

type DeviceStart = {
  ok: boolean;
  userCode: string;
  deviceCode: string;
  verifyUrl: string;
  intervalSeconds?: number;
};

type DevicePoll = {
  ok: boolean;
  status: "pending" | "complete" | "expired" | "claimed" | string;
  token?: string;
  user?: {
    email?: string;
    name?: string;
    licenseKey?: string | null;
    plan?: string | null;
  };
};

export type WebsiteAccount = {
  id?: string;
  email: string;
  name?: string;
  plan?: string | null;
  licenseKey?: string | null;
  credits?: number;
  emailVerified?: boolean;
  tokenBudget?: number;
  tokensUsed?: number;
  licenseActive?: boolean;
  expiresAt?: string;
  planRemainingPct?: number;
};

async function hostedFetch(path: string, init: RequestInit = {}) {
  const res = await fetch(`${HOSTED_API}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  }
  return data;
}

export async function fetchWebsiteAccount(token: string): Promise<WebsiteAccount> {
  const res = await fetch(`${HOSTED_API}/api/auth/me`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || "Session expired");
  }
  return (data as { user: WebsiteAccount }).user;
}

export async function ensureWebsiteSession(): Promise<WebsiteAccount | null> {
  const token = await api.getWebsiteSession();
  if (!token) return null;
  try {
    return await fetchWebsiteAccount(token);
  } catch {
    await api.clearWebsiteSession().catch(() => {});
    return null;
  }
}

/**
 * Full-screen gate: opens the website for login/signup, polls until the browser
 * session is linked, then stores the desktop session token locally.
 */
export function showAuthGate(onSignedIn: (user: WebsiteAccount) => void): HTMLElement {
  const overlay = el("div", { class: "auth-gate-overlay", role: "dialog", "aria-modal": "true" });
  const card = el("div", { class: "auth-gate-card" });
  card.appendChild(el("div", { class: "auth-gate-brand" }, ["HORMACHUELOS"]));
  card.appendChild(el("h1", { class: "auth-gate-title" }, ["Sign in to continue"]));
  card.appendChild(
    el("p", { class: "auth-gate-sub" }, [
      "After you download the app, log in or create an account on the website. This window signs in automatically.",
    ]),
  );

  const status = el("p", { class: "auth-gate-status", role: "status" }, [
    "Preparing secure login…",
  ]);
  const codeEl = el("div", { class: "auth-gate-code mono", hidden: "true" }, []);
  const openBtn = el("button", { class: "btn primary", type: "button" }, [
    "Open website to log in / sign up",
  ]) as HTMLButtonElement;
  openBtn.disabled = true;
  const hint = el("p", { class: "auth-gate-hint" }, [
    "Keep this window open while you finish in the browser.",
  ]);

  card.appendChild(status);
  card.appendChild(codeEl);
  card.appendChild(openBtn);
  card.appendChild(hint);
  overlay.appendChild(card);

  let deviceCode = "";
  let verifyUrl = "";
  let timer: number | null = null;
  let stopped = false;

  const stop = () => {
    stopped = true;
    if (timer != null) window.clearInterval(timer);
    timer = null;
  };

  const finish = async (token: string, user: WebsiteAccount) => {
    stop();
    await api.setWebsiteSession(token);
    if (user.licenseKey) {
      try {
        await api.applyLicenseKey(user.licenseKey);
        window.dispatchEvent(new CustomEvent("horma:license-updated"));
      } catch (e) {
        console.warn("auto license apply failed", e);
      }
    }
    status.textContent = `Signed in as ${user.email}`;
    onSignedIn(user);
    overlay.remove();
  };

  const poll = async () => {
    if (stopped || !deviceCode) return;
    try {
      const data = (await hostedFetch("/api/auth/device-poll", {
        method: "POST",
        body: JSON.stringify({ deviceCode }),
      })) as DevicePoll;
      if (data.status === "pending") {
        status.textContent = "Waiting for website login…";
        return;
      }
      if (data.status === "expired" || data.status === "claimed") {
        status.textContent = "Login expired. Click the button to try again.";
        openBtn.disabled = false;
        stop();
        return;
      }
      if (data.status === "complete" && data.token) {
        status.textContent = "Linking desktop…";
        const user: WebsiteAccount = {
          email: data.user?.email || "account",
          name: data.user?.name,
          licenseKey: data.user?.licenseKey ?? null,
          plan: data.user?.plan ?? null,
        };
        await finish(data.token, user);
      }
    } catch (e) {
      status.textContent = String((e as Error).message || e);
    }
  };

  const begin = async () => {
    stop();
    stopped = false;
    openBtn.disabled = true;
    status.textContent = "Starting secure login…";
    try {
      const data = (await hostedFetch("/api/auth/device-start", {
        method: "POST",
        body: "{}",
      })) as DeviceStart;
      deviceCode = data.deviceCode;
      verifyUrl = data.verifyUrl;
      codeEl.hidden = false;
      codeEl.textContent = data.userCode;
      status.textContent = "Browser will open — log in or sign up there.";
      openBtn.disabled = false;
      try {
        await api.openExternalUrl(verifyUrl);
      } catch {
        /* user can click the button */
      }
      const interval = Math.max(2, Number(data.intervalSeconds) || 2) * 1000;
      timer = window.setInterval(() => {
        void poll();
      }, interval);
      void poll();
    } catch (e) {
      status.textContent = String((e as Error).message || e);
      openBtn.disabled = false;
    }
  };

  openBtn.addEventListener("click", () => {
    if (verifyUrl) {
      void api.openExternalUrl(verifyUrl).catch(() => window.open(verifyUrl, "_blank"));
      return;
    }
    void begin();
  });

  void begin();
  return overlay;
}
