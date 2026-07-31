import { api } from "../ipc";
import { el } from "./util";

const HOSTED_API = "https://hormachuelos.vercel.app";

export type AppRelease = {
  version: string;
  title?: string;
  whatsNew?: string;
  msiUrl?: string;
  exeUrl?: string;
  forceUpdate?: boolean;
  publishedAt?: string;
};

export type UpdateCheck = {
  updateAvailable: boolean;
  forceUpdate: boolean;
  latest: AppRelease | null;
  currentVersion: string;
};

export async function checkDesktopUpdate(): Promise<UpdateCheck> {
  const currentVersion = await api.appVersion().catch(() => "0.0.0");
  const res = await fetch(
    `${HOSTED_API}/api/update?current=${encodeURIComponent(currentVersion)}`,
    { headers: { Accept: "application/json" } },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `Update check failed (${res.status})`);
  }
  return {
    updateAvailable: Boolean((data as UpdateCheck).updateAvailable),
    forceUpdate: Boolean((data as UpdateCheck).forceUpdate),
    latest: (data as UpdateCheck).latest || null,
    currentVersion: String((data as UpdateCheck).currentVersion || currentVersion),
  };
}

/** Non-dismissible gate when a forced update is published. */
export function showUpdateGate(check: UpdateCheck): HTMLElement {
  const latest = check.latest!;
  const overlay = el("div", { class: "auth-gate-overlay", role: "dialog", "aria-modal": "true" });
  const card = el("div", { class: "auth-gate-card" });
  card.appendChild(el("div", { class: "auth-gate-brand" }, ["HORMACHUELOS"]));
  card.appendChild(el("h1", { class: "auth-gate-title" }, ["Update required"]));
  card.appendChild(
    el("p", { class: "auth-gate-sub" }, [
      `You're on v${check.currentVersion}. Install v${latest.version} before using the app.`,
    ]),
  );
  card.appendChild(el("h2", { style: "margin:8px 0 6px;font-size:1.05rem" }, ["What's new"]));
  const notes = el("div", { class: "update-notes auth-gate-sub" });
  notes.style.whiteSpace = "pre-wrap";
  notes.textContent = latest.whatsNew || latest.title || "Bug fixes and improvements.";
  card.appendChild(notes);

  const actions = el("div", { style: "display:flex;flex-direction:column;gap:8px;margin-top:8px" });
  const primaryUrl = latest.msiUrl || latest.exeUrl || `${HOSTED_API}/#/update`;
  const updateBtn = el("button", { class: "btn primary", type: "button" }, [
    `Update to v${latest.version}`,
  ]) as HTMLButtonElement;
  updateBtn.addEventListener("click", () => {
    void api.openExternalUrl(primaryUrl).catch(() => window.open(primaryUrl, "_blank"));
  });
  const webBtn = el("button", { class: "btn", type: "button" }, ["Open update page"]) as HTMLButtonElement;
  webBtn.addEventListener("click", () => {
    const url = `${HOSTED_API}/#/update`;
    void api.openExternalUrl(url).catch(() => window.open(url, "_blank"));
  });
  actions.appendChild(updateBtn);
  actions.appendChild(webBtn);
  card.appendChild(actions);
  card.appendChild(
    el("p", { class: "auth-gate-hint" }, [
      "After installing, reopen Hormachuelos. This screen stays until you're on the latest required build.",
    ]),
  );
  overlay.appendChild(card);
  return overlay;
}
