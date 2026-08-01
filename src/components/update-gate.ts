import { api, onAppUpdateProgress, type AppUpdateProgress } from "../ipc";
import { el } from "./util";

const HOSTED_API = "https://hormachuelos.vercel.app";

export type AppRelease = {
  version: string;
  title?: string;
  whatsNew?: string;
  msiUrl?: string;
  exeUrl?: string;
  msiSha256?: string;
  exeSha256?: string;
  forceUpdate?: boolean;
  publishedAt?: string;
};

export type UpdateCheck = {
  updateAvailable: boolean;
  forceUpdate: boolean;
  latest: AppRelease | null;
  currentVersion: string;
};

export type UpdateInstallOptions = {
  /** Flush any in-memory chat/session work immediately before the backup. */
  beforeInstall?: () => void | Promise<void>;
};

type UpdateStateBackup = {
  format: 1;
  savedAt: string;
  entries: Record<string, string>;
};

function serializeUpdateState(): string {
  const entries: Record<string, string> = {};
  const probeKey = "ai-forge:update-storage-probe";
  localStorage.setItem(probeKey, "ok");
  if (localStorage.getItem(probeKey) !== "ok") {
    throw new Error("Local app data could not be verified before updating.");
  }
  localStorage.removeItem(probeKey);
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith("ai-forge:")) continue;
    const value = localStorage.getItem(key);
    if (value !== null) entries[key] = value;
  }
  return JSON.stringify({
    format: 1,
    savedAt: new Date().toISOString(),
    entries,
  } satisfies UpdateStateBackup);
}

/** Restore only missing WebView keys from the one-shot pre-update backup. */
export async function restoreUpdateState(): Promise<number> {
  const raw = await api.loadUpdateBackup();
  if (!raw) return 0;
  const backup = JSON.parse(raw) as Partial<UpdateStateBackup>;
  if (backup.format !== 1 || !backup.entries || typeof backup.entries !== "object") {
    throw new Error("The saved pre-update data has an unsupported format.");
  }
  let restored = 0;
  for (const [key, value] of Object.entries(backup.entries)) {
    if (!key.startsWith("ai-forge:") || typeof value !== "string") continue;
    if (localStorage.getItem(key) !== null) continue;
    localStorage.setItem(key, value);
    restored += 1;
  }
  await api.clearUpdateBackup();
  return restored;
}

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

function progressMessage(event: AppUpdateProgress): string {
  const percent = Number.isFinite(event.percent) && Number(event.percent) >= 0
    ? Math.min(100, Math.round(Number(event.percent)))
    : null;
  const fallback = `${event.phase[0].toUpperCase()}${event.phase.slice(1)}`;
  const message = String(event.message || fallback).replace(/…$/, "");
  return `${message}${percent === null ? "" : ` ${percent}%`}…`;
}

async function installInsideApp(
  release: AppRelease,
  options: UpdateInstallOptions,
  onProgress: (message: string, event?: AppUpdateProgress) => void,
): Promise<void> {
  const installer = [
    { url: release.exeUrl, sha256: release.exeSha256 },
    { url: release.msiUrl, sha256: release.msiSha256 },
  ].find((candidate) => candidate.url && candidate.sha256);
  if (!installer?.url || !installer.sha256) {
    if (release.exeUrl || release.msiUrl) {
      throw new Error("This release is missing its installer checksum.");
    }
    throw new Error("This release has no Windows installer.");
  }
  await options.beforeInstall?.();
  await api.saveUpdateBackup(serializeUpdateState());
  const unlisten = await onAppUpdateProgress(
    (event) => onProgress(progressMessage(event), event),
  ).catch(() => null);
  try {
    onProgress("Downloading the update inside Hormachuelos…");
    await api.installAppUpdate(installer.url, release.version, installer.sha256);
    onProgress("Update prepared. Hormachuelos is restarting…");
  } finally {
    unlisten?.();
  }
}

/** Dismissible manual update checker opened from the desktop sidebar. */
export function showUpdateDialog(options: UpdateInstallOptions = {}): HTMLElement {
  const existing = document.querySelector<HTMLElement>(".update-dialog-overlay");
  if (existing) {
    if (existing.getAttribute("aria-busy") === "true") return existing;
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
  let installing = false;
  const close = () => {
    if (closed || installing) return;
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

      const dataHint = el("p", { class: "auth-gate-hint update-data-hint" }, [
        "Sessions, projects, settings, and account data stay on this device.",
      ]);
      content.appendChild(dataHint);
      const status = el("div", {
        class: "update-install-status",
        role: "status",
        "aria-live": "polite",
        hidden: "",
      });
      content.appendChild(status);

      const installBtn = el("button", { class: "btn primary", type: "button" }, [
        `Install v${latest.version} and restart`,
      ]) as HTMLButtonElement;
      const laterBtn = el("button", { class: "btn", type: "button" }, ["Not now"]);
      laterBtn.addEventListener("click", close);
      installBtn.addEventListener("click", () => {
        if (installing) return;
        installing = true;
        overlay.setAttribute("aria-busy", "true");
        closeBtn.disabled = true;
        installBtn.disabled = true;
        laterBtn.disabled = true;
        status.hidden = false;
        status.classList.remove("is-error");
        void installInsideApp(latest, options, (message, event) => {
          status.textContent = message;
          status.dataset.phase = event?.phase || "preparing";
        }).catch((error) => {
          installing = false;
          overlay.removeAttribute("aria-busy");
          closeBtn.disabled = false;
          installBtn.disabled = false;
          laterBtn.disabled = false;
          status.hidden = false;
          status.classList.add("is-error");
          status.dataset.phase = "error";
          status.textContent = error instanceof Error
            ? `Update failed: ${error.message}`
            : "Update failed. Please try again.";
          installBtn.focus({ preventScroll: true });
        });
      });
      content.appendChild(installBtn);
      content.appendChild(laterBtn);
      ensureFocusInside();
      return;
    }

    addTitle("You're up to date");
    addSub(`Hormachuelos v${check.currentVersion} is the latest version.`);
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
      ensureFocusInside();
    }
  };

  void runCheck();
  ensureFocusInside();
  return overlay;
}

/** Non-dismissible gate when a forced update is published. */
export function showUpdateGate(
  check: UpdateCheck,
  options: UpdateInstallOptions = {},
): HTMLElement {
  const latest = check.latest!;
  const overlay = el("div", {
    class: "auth-gate-overlay",
    role: "dialog",
    "aria-modal": "true",
    "aria-labelledby": "required-update-title",
  });
  const card = el("div", { class: "auth-gate-card" });
  card.appendChild(el("div", { class: "auth-gate-brand" }, ["HORMACHUELOS"]));
  card.appendChild(el("h1", { class: "auth-gate-title", id: "required-update-title" }, ["Update required"]));
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
  card.appendChild(
    el("p", { class: "auth-gate-hint update-data-hint" }, [
      "Sessions, projects, settings, and account data stay on this device.",
    ]),
  );

  const actions = el("div", { style: "display:flex;flex-direction:column;gap:8px;margin-top:8px" });
  const updateBtn = el("button", { class: "btn primary", type: "button" }, [
    `Install v${latest.version} and restart`,
  ]) as HTMLButtonElement;
  const status = el("div", {
    class: "update-install-status",
    role: "status",
    "aria-live": "polite",
    hidden: "",
  });
  updateBtn.addEventListener("click", () => {
    if (updateBtn.disabled) return;
    updateBtn.disabled = true;
    overlay.setAttribute("aria-busy", "true");
    status.hidden = false;
    status.classList.remove("is-error");
    void installInsideApp(latest, options, (message, event) => {
      status.textContent = message;
      status.dataset.phase = event?.phase || "preparing";
    }).catch((error) => {
      overlay.removeAttribute("aria-busy");
      updateBtn.disabled = false;
      status.classList.add("is-error");
      status.dataset.phase = "error";
      status.textContent = error instanceof Error
        ? `Update failed: ${error.message}`
        : "Update failed. Please try again.";
      updateBtn.focus({ preventScroll: true });
    });
  });
  actions.appendChild(updateBtn);
  actions.appendChild(status);
  card.appendChild(actions);
  card.appendChild(
    el("p", { class: "auth-gate-hint" }, [
      "Hormachuelos installs this update internally and restarts automatically when it is ready.",
    ]),
  );
  overlay.appendChild(card);
  return overlay;
}
