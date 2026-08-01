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
    { headers: { Accept: "application/json" }, cache: "no-store" },
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

function openUpdateUrl(url: string) {
  void api.openExternalUrl(url).catch(() => window.open(url, "_blank"));
}

/** Dismissible manual update checker opened from the desktop sidebar. */
export function showUpdateDialog(): HTMLElement {
  const existing = document.querySelector<HTMLElement>(".update-dialog-overlay");
  if (existing) {
    existing.dispatchEvent(new Event("update-dialog-dismiss"));
    if (existing.isConnected) existing.remove();
  }
  const previousFocus = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  const inertSiblings = Array.from(document.body.children)
    .filter((node): node is HTMLElement => node instanceof HTMLElement)
    .map((node) => ({ node, wasInert: node.inert }));
  for (const { node } of inertSiblings) node.inert = true;

  const overlay = el("div", {
    class: "auth-gate-overlay update-dialog-overlay",
    role: "dialog",
    "aria-modal": "true",
    "aria-labelledby": "update-dialog-title",
  });
  const card = el("div", { class: "auth-gate-card update-dialog-card" });
  const top = el("div", { class: "update-dialog-top" });
  top.appendChild(el("div", { class: "auth-gate-brand" }, ["HORMACHUELOS"]));
  const closeBtn = el("button", {
    class: "update-dialog-close",
    type: "button",
    title: "Close",
    "aria-label": "Close update checker",
  }, ["×"]) as HTMLButtonElement;
  top.appendChild(closeBtn);
  card.appendChild(top);
  const content = el("div", { class: "update-dialog-content", "aria-live": "polite" });
  card.appendChild(content);
  overlay.appendChild(card);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
    for (const { node, wasInert } of inertSiblings) node.inert = wasInert;
    window.requestAnimationFrame(() => {
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    });
  };
  overlay.addEventListener("update-dialog-dismiss", close);
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      overlay.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])",
      ),
    ).filter((node) => !node.hidden && node.getAttribute("aria-hidden") !== "true");
    if (!focusable.length) {
      event.preventDefault();
      card.tabIndex = -1;
      card.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !overlay.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !overlay.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  });

  const ensureFocusInside = () => {
    const focusCloseButton = () => {
      if (overlay.isConnected && !overlay.contains(document.activeElement)) {
        closeBtn.focus({ preventScroll: true });
      }
    };
    if (overlay.isConnected) focusCloseButton();
    else window.requestAnimationFrame(focusCloseButton);
  };

  const addTitle = (title: string) => {
    content.appendChild(el("h1", { class: "auth-gate-title", id: "update-dialog-title" }, [title]));
  };
  const addSub = (message: string) => {
    content.appendChild(el("p", { class: "auth-gate-sub" }, [message]));
  };
  const addWebButton = (label = "Open update page") => {
    const button = el("button", { class: "btn", type: "button" }, [label]) as HTMLButtonElement;
    button.addEventListener("click", () => openUpdateUrl(`${HOSTED_API}/#/update`));
    content.appendChild(button);
  };

  const renderCheck = (check: UpdateCheck) => {
    content.replaceChildren();
    const latest = check.latest;
    if (check.updateAvailable && latest) {
      addTitle("Update available");
      addSub(`You're on v${check.currentVersion}. Hormachuelos v${latest.version} is ready.`);
      const notes = el("div", { class: "update-notes auth-gate-sub" });
      notes.style.whiteSpace = "pre-wrap";
      notes.textContent = latest.whatsNew || latest.title || "Bug fixes and improvements.";
      content.appendChild(notes);

      const primaryUrl = latest.msiUrl || latest.exeUrl || `${HOSTED_API}/#/update`;
      const downloadBtn = el("button", { class: "btn primary", type: "button" }, [
        `Download v${latest.version}`,
      ]) as HTMLButtonElement;
      downloadBtn.addEventListener("click", () => openUpdateUrl(primaryUrl));
      content.appendChild(downloadBtn);
      addWebButton();
      const laterBtn = el("button", { class: "btn", type: "button" }, ["Not now"]);
      laterBtn.addEventListener("click", close);
      content.appendChild(laterBtn);
      ensureFocusInside();
      return;
    }

    addTitle("You're up to date");
    addSub(`Hormachuelos v${check.currentVersion} is the latest version.`);
    addWebButton("View release history");
    const doneBtn = el("button", { class: "btn primary", type: "button" }, ["Done"]);
    doneBtn.addEventListener("click", close);
    content.appendChild(doneBtn);
    ensureFocusInside();
  };

  const runCheck = async () => {
    content.replaceChildren();
    addTitle("Checking for updates…");
    addSub("Looking for the latest Hormachuelos release.");
    try {
      renderCheck(await checkDesktopUpdate());
    } catch {
      content.replaceChildren();
      addTitle("Couldn't check for updates");
      addSub("Check your internet connection, then try again.");
      const retryBtn = el("button", { class: "btn primary", type: "button" }, ["Try again"]);
      retryBtn.addEventListener("click", () => void runCheck());
      content.appendChild(retryBtn);
      addWebButton();
      ensureFocusInside();
    }
  };

  void runCheck();
  ensureFocusInside();
  return overlay;
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
    openUpdateUrl(primaryUrl);
  });
  const webBtn = el("button", { class: "btn", type: "button" }, ["Open update page"]) as HTMLButtonElement;
  webBtn.addEventListener("click", () => {
    const url = `${HOSTED_API}/#/update`;
    openUpdateUrl(url);
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
