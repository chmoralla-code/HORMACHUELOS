import { convertFileSrc } from "@tauri-apps/api/core";
import { api, type ProjectNode } from "../ipc";
import type { SessionPreviewState, SessionPreviewTab } from "./session";
import { clear, el } from "./util";
import { icon } from "./icons";

export type PreviewOpenOptions = {
  projectRoot: string;
  entryPath?: string | null;
  files?: string[];
  title?: string;
  /** When false, open the shell without auto-picking an HTML entry (blank panel). Default true. */
  autoPickEntry?: boolean;
};

/** Result returned by the chat shell after a preview action creates a prompt. */
export type PreviewPromptDispatch =
  | "sent"
  | "queued"
  | "needs_project"
  | "usage_exhausted"
  | "stopping";

type SelectedEl = {
  tag: string;
  text: string;
  path: string;
  selector: string;
};

const PREVIEWABLE_EXT = /\.(html?|xhtml|css|js|mjs|ts|tsx|jsx|vue|svelte|apk|aab|ipa|exe|msi|dmg|wasm)$/i;
const HTML_EXT = /\.html?$/i;

function decodePath(value: string): string {
  let path = value.trim();
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path);
      path = decodeURIComponent(url.pathname);
      if (/^\/[a-zA-Z]:\//.test(path)) path = path.slice(1);
    } catch {
      path = path.replace(/^file:\/\/\/?/i, "");
    }
  }
  path = path.replace(/\\/g, "/").replace(/^\/\/\?\//, "");
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function withoutUrlSuffix(value: string): { path: string; suffix: string } {
  const query = value.indexOf("?");
  const hash = value.indexOf("#");
  const indexes = [query, hash].filter((index) => index >= 0);
  const split = indexes.length ? Math.min(...indexes) : -1;
  return split >= 0
    ? { path: value.slice(0, split), suffix: value.slice(split) }
    : { path: value, suffix: "" };
}

export function normalizePreviewEntry(projectRoot: string, value?: string | null): string | null {
  if (!projectRoot || !value) return null;
  const root = decodePath(projectRoot).replace(/\/+$/, "");
  let candidate = decodePath(withoutUrlSuffix(value).path);
  if (!candidate) return null;

  if (/^[a-zA-Z]:\//.test(candidate)) {
    const prefix = `${root.toLowerCase()}/`;
    if (!candidate.toLowerCase().startsWith(prefix)) return null;
    candidate = candidate.slice(root.length + 1);
  } else if (candidate.startsWith("/") || candidate.startsWith("//")) {
    return null;
  }

  const safe: string[] = [];
  for (const part of candidate.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!safe.length) return null;
      safe.pop();
      continue;
    }
    if (part.includes(":")) return null;
    safe.push(part);
  }
  return safe.length ? safe.join("/") : null;
}

function joinFs(root: string, rel: string): string {
  const clean = normalizePreviewEntry(root, rel);
  if (!clean) throw new Error("Preview path is outside the active project.");
  const base = root.replace(/[\\/]+$/, "");
  return `${base}\\${clean.replace(/\//g, "\\")}`;
}

function dirnameRel(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i >= 0 ? norm.slice(0, i) : "";
}

function resolveRel(fromDir: string, href: string): string {
  if (!href || /^(https?:|data:|blob:|mailto:|javascript:|#)/i.test(href)) return href;
  if (href.startsWith("//")) return href;
  const { path, suffix } = withoutUrlSuffix(href);
  if (!path) return href;
  const rootRelative = /^[\\/]/.test(path);
  const base = rootRelative || !fromDir ? [] : fromDir.split("/");
  const parts = path.replace(/\\/g, "/").replace(/^\/+/, "").split("/");
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") base.pop();
    else base.push(part);
  }
  return `${base.join("/")}${suffix}`;
}

function isExternalAssetUrl(value: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(value.trim());
}

function cssStringEnd(css: string, start: number): number {
  const quote = css[start];
  for (let i = start + 1; i < css.length; i += 1) {
    if (css[i] === "\\") {
      i += 1;
    } else if (css[i] === quote) {
      return i + 1;
    }
  }
  return css.length;
}

function isCssIdentifierChar(value: string | undefined): boolean {
  return !!value && /[a-z0-9_-]/i.test(value);
}

function rewriteInlineCssAssets(css: string, rewriteUrl: (url: string) => string): string {
  let output = "";
  let i = 0;
  while (i < css.length) {
    if (css.startsWith("/*", i)) {
      const end = css.indexOf("*/", i + 2);
      const next = end < 0 ? css.length : end + 2;
      output += css.slice(i, next);
      i = next;
      continue;
    }

    if (css[i] === '"' || css[i] === "'") {
      const end = cssStringEnd(css, i);
      output += css.slice(i, end);
      i = end;
      continue;
    }

    const importToken = css.slice(i, i + 7);
    if (
      importToken.toLowerCase() === "@import" &&
      !isCssIdentifierChar(css[i + 7])
    ) {
      let valueStart = i + 7;
      while (/\s/.test(css[valueStart] || "")) valueStart += 1;
      const quote = css[valueStart];
      if (quote === '"' || quote === "'") {
        const end = cssStringEnd(css, valueStart);
        if (end > valueStart + 1 && css[end - 1] === quote) {
          const raw = css.slice(valueStart + 1, end - 1).trim();
          output += !raw || isExternalAssetUrl(raw)
            ? css.slice(i, end)
            : css.slice(i, valueStart + 1) + rewriteUrl(raw) + quote;
          i = end;
          continue;
        }
      }
    }

    if (
      css.slice(i, i + 4).toLowerCase() === "url(" &&
      !isCssIdentifierChar(css[i - 1])
    ) {
      let valueStart = i + 4;
      while (/\s/.test(css[valueStart] || "")) valueStart += 1;
      const quote = css[valueStart];
      if (quote === '"' || quote === "'") {
        const end = cssStringEnd(css, valueStart);
        let close = end;
        while (/\s/.test(css[close] || "")) close += 1;
        if (end > valueStart + 1 && css[end - 1] === quote && css[close] === ")") {
          const raw = css.slice(valueStart + 1, end - 1).trim();
          output += !raw || isExternalAssetUrl(raw)
            ? css.slice(i, close + 1)
            : css.slice(i, valueStart + 1) + rewriteUrl(raw) + css.slice(end - 1, close + 1);
          i = close + 1;
          continue;
        }
      } else {
        let close = valueStart;
        while (close < css.length && css[close] !== ")") {
          if (css[close] === "\\") close += 1;
          close += 1;
        }
        if (css[close] === ")") {
          const raw = css.slice(valueStart, close).trim();
          output += !raw || isExternalAssetUrl(raw)
            ? css.slice(i, close + 1)
            : `${css.slice(i, valueStart)}"${rewriteUrl(raw)}"${css.slice(close, close + 1)}`;
          i = close + 1;
          continue;
        }
      }
    }

    output += css[i];
    i += 1;
  }
  return output;
}

function rewriteHtmlAssets(html: string, entryRel: string, projectRoot: string): string {
  const dir = dirnameRel(entryRel);
  const toAsset = (rel: string) => {
    try {
      const { path, suffix } = withoutUrlSuffix(rel);
      return `${convertFileSrc(joinFs(projectRoot, path))}${suffix}`;
    } catch {
      return rel;
    }
  };
  const rewriteUrl = (url: string) => {
    if (!url || isExternalAssetUrl(url)) return url;
    return toAsset(resolveRel(dir, url));
  };
  const rewrittenAttributes = html.replace(
    /(\s(?:src|href)=["'])([^"']+)(["'])/gi,
    (_m, pre: string, url: string, post: string) => {
      return `${pre}${rewriteUrl(url)}${post}`;
    },
  );
  const rewrittenStyleBlocks = rewrittenAttributes.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi,
    (_match, open: string, css: string, close: string) =>
      `${open}${rewriteInlineCssAssets(css, rewriteUrl)}${close}`,
  );
  return rewrittenStyleBlocks.replace(
    /(\sstyle\s*=\s*)(['"])([\s\S]*?)\2/gi,
    (_match, prefix: string, quote: string, css: string) =>
      `${prefix}${quote}${rewriteInlineCssAssets(css, rewriteUrl)}${quote}`,
  );
}

function flattenFiles(nodes: ProjectNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.isDir) flattenFiles(n.children || [], out);
    else out.push(n.path.replace(/\\/g, "/"));
  }
  return out;
}

export function pickPreviewEntry(files: string[]): string | null {
  const norm = files.map((f) => f.replace(/\\/g, "/"));
  const html = norm.filter((f) => HTML_EXT.test(f));
  if (!html.length) return null;
  const scored = html
    .map((f) => {
      const lower = f.toLowerCase();
      let score = 0;
      if (/(^|\/)index\.html?$/.test(lower)) score += 50;
      if (/(^|\/)(game|app|web|site|dist|public|build)\//.test(lower)) score += 20;
      if (/(snake|game|play|demo)/.test(lower)) score += 10;
      if (lower.split("/").length <= 2) score += 8;
      return { f, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0]?.f || null;
}

export function isPreviewableBuild(files: string[], tech: string[] = []): boolean {
  const joined = [...files, ...tech].join(" ").toLowerCase();
  if (files.some((f) => PREVIEWABLE_EXT.test(f))) return true;
  return /(html|css|javascript|typescript|react|vue|svelte|website|web app|game|apk|android|electron|tauri|wasm)/i.test(
    joined,
  );
}

function samePreviewProject(a: string, b: string): boolean {
  return decodePath(a).replace(/\/+$/, "").toLowerCase() ===
    decodePath(b).replace(/\/+$/, "").toLowerCase();
}

function cleanPreviewHistory(projectRoot: string, values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const history: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const path = normalizePreviewEntry(projectRoot, value);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    history.push(path);
  }
  return history;
}

function cleanPreviewTabs(
  projectRoot: string,
  tabs: SessionPreviewTab[] | undefined,
): SessionPreviewTab[] {
  if (!tabs?.length) return [];
  const seenEntries = new Set<string>();
  const clean: SessionPreviewTab[] = [];
  for (const raw of tabs) {
    const history = cleanPreviewHistory(projectRoot, raw.history);
    const requestedIndex = Math.floor(Number(raw.historyIndex) || 0);
    const historyIndex = history.length
      ? Math.max(0, Math.min(history.length - 1, requestedIndex))
      : 0;
    const entryPath =
      normalizePreviewEntry(projectRoot, raw.entryPath) || history[historyIndex] || null;
    if (!entryPath || seenEntries.has(entryPath)) continue;
    if (!history.length) history.push(entryPath);
    if (!history.includes(entryPath)) history.push(entryPath);
    const normalizedIndex = Math.max(0, Math.min(history.length - 1, historyIndex));
    seenEntries.add(entryPath);
    clean.push({
      entryPath: history[normalizedIndex] || entryPath,
      title: raw.title?.trim().slice(0, 160) || tabTitleFromPath(entryPath),
      history,
      historyIndex: normalizedIndex,
    });
  }
  return clean;
}

/**
 * Create a serializable preview state without mounting a preview iframe. This
 * is used for builds completed by a background session, so they never replace
 * the preview currently visible in another session.
 */
export function mergePreviewSessionState(
  current: SessionPreviewState | undefined,
  opts: PreviewOpenOptions,
): SessionPreviewState {
  const projectRoot = opts.projectRoot;
  const useCurrent = !!current && samePreviewProject(current.projectRoot, projectRoot);
  const tabs = cleanPreviewTabs(projectRoot, useCurrent ? current.tabs : undefined);
  let activeTabIndex = useCurrent
    ? Math.max(0, Math.min(tabs.length - 1, Number(current!.activeTabIndex) || 0))
    : 0;
  const files = (opts.files || [])
    .map((file) => normalizePreviewEntry(projectRoot, file))
    .filter((file): file is string => Boolean(file));
  let entry = normalizePreviewEntry(projectRoot, opts.entryPath);
  if (!entry) entry = pickPreviewEntry(files);
  if (!entry) {
    entry = files.find((file) => /\.(apk|aab|ipa|exe|msi|dmg|wasm)$/i.test(file)) || null;
  }
  if (entry) {
    const existingIndex = tabs.findIndex((tab) => tab.entryPath === entry);
    if (existingIndex >= 0) {
      activeTabIndex = existingIndex;
    } else {
      tabs.push({
        entryPath: entry,
        title: opts.title || tabTitleFromPath(entry),
        history: [entry],
        historyIndex: 0,
      });
      activeTabIndex = tabs.length - 1;
    }
  }
  return {
    version: 1,
    projectRoot,
    tabs,
    activeTabIndex: tabs.length ? activeTabIndex : 0,
    designMode: useCurrent && current!.designMode === true,
    androidMode: useCurrent && current!.androidMode === true,
    softwareMode: useCurrent && current!.softwareMode === true,
  };
}

type PreviewTab = {
  id: string;
  entryPath: string;
  title: string;
  history: string[];
  historyIndex: number;
  frame: HTMLIFrameElement;
  tabEl: HTMLButtonElement;
};

let previewTabSeq = 0;

const PREVIEW_W_KEY = "ai-forge:preview-w";
const PREVIEW_H_KEY = "ai-forge:preview-h";
const PREVIEW_W_MIN = 280;
const PREVIEW_H_MIN = 180;
const PREVIEW_CHAT_MIN = 240;

function tabTitleFromPath(path: string): string {
  const base = path.split("/").pop() || path;
  return base.replace(/\.html?$/i, "") || base;
}

function readStoredSize(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function writeStoredSize(key: string, value: number) {
  try {
    localStorage.setItem(key, String(Math.round(value)));
  } catch {
    /* ignore */
  }
}

function isStackedPreview(): boolean {
  return window.matchMedia("(max-width: 1179px)").matches;
}

export class SitePreview {
  readonly root: HTMLElement;
  private tabsEl: HTMLElement;
  private frameHost: HTMLElement;
  private urlInput: HTMLInputElement;
  private statusEl: HTMLElement;
  private backBtn: HTMLButtonElement;
  private forwardBtn: HTMLButtonElement;
  private designBtn: HTMLButtonElement;
  private androidBtn: HTMLButtonElement;
  private softwareBtn: HTMLButtonElement;
  private buildMenuToggle: HTMLButtonElement;
  private buildMenu: HTMLElement;
  private buildMenuCleanup: (() => void) | null = null;
  private makePublicBtn: HTMLButtonElement;
  private viewport: HTMLElement;
  private editBar: HTMLElement;
  private editInput: HTMLInputElement;
  private designMode = false;
  private androidMode = false;
  private softwareMode = false;
  private projectRoot = "";
  private tabs: PreviewTab[] = [];
  private activeTabId = "";
  private selected: SelectedEl | null = null;
  private onDescribe: ((prompt: string) => PreviewPromptDispatch | void) | null = null;
  private onStateChange: ((state: SessionPreviewState | null) => void) | null = null;
  private closing = false;
  private closeTimer: number | null = null;
  private closeGeneration = 0;
  /** Cancels stale asynchronous restores when a different session is selected. */
  private viewGeneration = 0;
  /** Suppress persistence callbacks while rebuilding an already-saved preview. */
  private stateRestoreDepth = 0;
  private resizing = false;
  private resizeCleanup: (() => void) | null = null;

  constructor(host?: HTMLElement | null) {
    this.root =
      host ||
      el("aside", {
        class: "site-preview",
        id: "site-preview",
        "aria-label": "Site preview",
        hidden: "true",
      });
    this.root.classList.add("site-preview");
    this.root.setAttribute("aria-label", "Site preview");
    clear(this.root);
    this.root.hidden = true;

    const chrome = el("div", { class: "site-preview-chrome" });
    const tabstrip = el("div", { class: "site-preview-tabstrip" });
    this.tabsEl = el("div", { class: "site-preview-tabs", role: "tablist", "aria-label": "Preview tabs" });
    const newTabBtn = el("button", {
      class: "site-preview-tab-new",
      type: "button",
      title: "New preview tab",
      "aria-label": "New preview tab",
      html: icon("new", 14),
    }) as HTMLButtonElement;
    newTabBtn.addEventListener("click", () => void this.openNewTab());
    tabstrip.append(this.tabsEl, newTabBtn);

    const toolbar = el("div", { class: "site-preview-toolbar" });
    this.backBtn = el("button", {
      class: "site-preview-nav-btn",
      type: "button",
      title: "Back",
      "aria-label": "Back",
      disabled: "true",
      html: icon("arrowLeft", 14),
    }) as HTMLButtonElement;
    this.backBtn.addEventListener("click", () => void this.goBack());

    this.forwardBtn = el("button", {
      class: "site-preview-nav-btn",
      type: "button",
      title: "Forward",
      "aria-label": "Forward",
      disabled: "true",
      html: icon("arrowRight", 14),
    }) as HTMLButtonElement;
    this.forwardBtn.addEventListener("click", () => void this.goForward());

    const refresh = el("button", {
      class: "site-preview-nav-btn",
      type: "button",
      title: "Reload preview",
      "aria-label": "Reload preview",
      html: icon("refresh", 14),
    }) as HTMLButtonElement;
    refresh.addEventListener("click", () => void this.reload());

    this.urlInput = el("input", {
      class: "site-preview-omnibox",
      type: "text",
      spellcheck: "false",
      placeholder: "Project file path",
      "aria-label": "Preview path",
    }) as HTMLInputElement;
    this.urlInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      void this.navigateOmnibox();
    });

    this.statusEl = el("div", { class: "site-preview-status" }, [""]);

    this.designBtn = el("button", {
      class: "site-preview-design-btn",
      type: "button",
      title: "Design Mode (Ctrl+Shift+D)",
      "aria-pressed": "false",
    }, ["Design"]) as HTMLButtonElement;
    this.designBtn.addEventListener("click", () => this.setDesignMode(!this.designMode));

    this.androidBtn = el("button", {
      class: "site-preview-design-btn site-preview-android-btn",
      type: "button",
      title: "Android device preview (412 × 915)",
      "aria-label": "Toggle Android device preview",
      "aria-pressed": "false",
    }, ["Android"]) as HTMLButtonElement;
    this.androidBtn.addEventListener("click", () => this.setAndroidMode(!this.androidMode));

    this.softwareBtn = el("button", {
      class: "site-preview-design-btn site-preview-software-btn",
      type: "button",
      title: "Desktop software window preview",
      "aria-label": "Toggle software window preview",
      "aria-pressed": "false",
    }, ["Software"]) as HTMLButtonElement;
    this.softwareBtn.addEventListener("click", () => this.setSoftwareMode(!this.softwareMode));

    const buildLauncher = el("div", { class: "site-preview-build-launcher" });
    this.buildMenuToggle = el("button", {
      class: "site-preview-design-btn site-preview-build-toggle",
      type: "button",
      title: "Choose a build target",
      "aria-label": "Choose build target",
      "aria-haspopup": "menu",
      "aria-controls": "site-preview-build-menu",
      "aria-expanded": "false",
    }, [
      el("span", { class: "site-preview-build-toggle-label" }, ["Build"]),
      el("span", { class: "site-preview-build-toggle-caret", "aria-hidden": "true" }, ["▾"]),
    ]) as HTMLButtonElement;
    this.buildMenuToggle.addEventListener("click", () => this.toggleBuildMenu());
    this.buildMenu = el("div", {
      class: "site-preview-build-menu",
      id: "site-preview-build-menu",
      role: "menu",
      "aria-label": "Build target",
      hidden: "true",
    });
    this.buildMenu.append(
      this.buildMenuItem(
        "apk",
        "Build APK",
        "Create an installable Android package",
      ),
      this.buildMenuItem(
        "software",
        "Build Software",
        "Create a runnable desktop application",
      ),
    );
    buildLauncher.append(this.buildMenuToggle, this.buildMenu);

    this.makePublicBtn = el("button", {
      class: "site-preview-design-btn site-preview-build-btn site-preview-make-public-btn",
      type: "button",
      title: "Publish this website using GitHub, Vercel, and Supabase",
      "aria-label": "Make the website public",
    }, ["Make site public"]) as HTMLButtonElement;
    this.makePublicBtn.addEventListener("click", () => this.makeWebsitePublic());

    const close = el("button", {
      class: "site-preview-icon-btn",
      type: "button",
      title: "Close preview",
      "aria-label": "Close preview",
      html: icon("close", 14),
    }) as HTMLButtonElement;
    close.addEventListener("click", () => this.close());

    const actions = el("div", { class: "site-preview-actions" });
    actions.append(buildLauncher, this.makePublicBtn, this.androidBtn, this.softwareBtn, this.designBtn, close);
    toolbar.append(this.backBtn, this.forwardBtn, refresh, this.urlInput, actions);
    chrome.append(tabstrip, toolbar);

    this.viewport = el("div", { class: "site-preview-viewport" });
    const device = el("div", {
      class: "site-preview-device",
      "aria-label": "Preview viewport",
    });
    const softwareTitlebar = el("div", {
      class: "site-preview-software-titlebar",
      "aria-hidden": "true",
    }, [
      el("span", { class: "site-preview-software-title" }, [
        el("span", { class: "site-preview-software-appicon" }, ["H"]),
        "Application Preview",
      ]),
      el("span", { class: "site-preview-software-controls" }, [
        el("span", {}, ["—"]),
        el("span", {}, ["□"]),
        el("span", {}, ["×"]),
      ]),
    ]);
    const androidStatus = el("div", {
      class: "site-preview-android-statusbar",
      "aria-hidden": "true",
    }, [
      el("span", {}, ["Android"]),
      el("span", {}, ["●  Wi-Fi  100%"]),
    ]);
    this.frameHost = el("div", { class: "site-preview-frame-host" });
    const androidNavigation = el("div", {
      class: "site-preview-android-navbar",
      "aria-hidden": "true",
    }, [el("span", { class: "site-preview-android-gesture" })]);
    device.append(softwareTitlebar, androidStatus, this.frameHost, androidNavigation);
    this.viewport.appendChild(device);

    this.editBar = el("div", { class: "site-preview-editbar", hidden: "true" });
    const tag = el("span", { class: "site-preview-edit-tag", id: "site-preview-edit-tag" }, ["el"]);
    this.editInput = el("input", {
      class: "site-preview-edit-input",
      type: "text",
      placeholder: "Describe the change",
      "aria-label": "Describe the change",
    }) as HTMLInputElement;
    this.editInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.submitDescribe();
      }
    });
    const send = el("button", {
      class: "site-preview-edit-send",
      type: "button",
      title: "Apply with AI",
    }, ["Ask AI"]) as HTMLButtonElement;
    send.addEventListener("click", () => this.submitDescribe());
    this.editBar.append(tag, this.editInput, send);

    const resizeHandle = el("button", {
      class: "site-preview-resize",
      type: "button",
      title: "Drag to resize preview · double-click to reset",
      "aria-label": "Resize preview panel",
    }) as HTMLButtonElement;
    this.wireResize(resizeHandle);

    this.root.append(resizeHandle, chrome, this.statusEl, this.viewport, this.editBar);
    this.applySavedPreviewSize();

    window.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "D" || e.key === "d")) {
        if (this.root.hidden) return;
        e.preventDefault();
        this.setDesignMode(!this.designMode);
      }
    });
    window.addEventListener("resize", () => {
      if (this.isOpen) this.applySavedPreviewSize();
    });
  }

  private workbench(): HTMLElement | null {
    return this.root.closest(".workbench") as HTMLElement | null
      ?? document.querySelector(".workbench");
  }

  private applySavedPreviewSize() {
    const wb = this.workbench();
    if (!wb) return;
    const stacked = isStackedPreview();
    if (stacked) {
      const h = readStoredSize(PREVIEW_H_KEY);
      if (h != null) {
        const max = Math.max(PREVIEW_H_MIN, Math.floor(window.innerHeight * 0.72));
        wb.style.setProperty("--preview-h", `${Math.min(max, Math.max(PREVIEW_H_MIN, h))}px`);
      } else {
        wb.style.removeProperty("--preview-h");
      }
      return;
    }
    const w = readStoredSize(PREVIEW_W_KEY);
    if (w != null) {
      const max = Math.max(PREVIEW_W_MIN, Math.floor(wb.clientWidth - PREVIEW_CHAT_MIN));
      wb.style.setProperty("--preview-w", `${Math.min(max, Math.max(PREVIEW_W_MIN, w))}px`);
    } else {
      wb.style.removeProperty("--preview-w");
    }
  }

  private resetPreviewSize() {
    const wb = this.workbench();
    if (!wb) return;
    if (isStackedPreview()) {
      try {
        localStorage.removeItem(PREVIEW_H_KEY);
      } catch {
        /* ignore */
      }
      wb.style.removeProperty("--preview-h");
      return;
    }
    try {
      localStorage.removeItem(PREVIEW_W_KEY);
    } catch {
      /* ignore */
    }
    wb.style.removeProperty("--preview-w");
  }

  private wireResize(handle: HTMLButtonElement) {
    handle.addEventListener("dblclick", (e) => {
      e.preventDefault();
      this.resetPreviewSize();
    });

    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || this.root.hidden) return;
      e.preventDefault();
      const wb = this.workbench();
      if (!wb) return;

      this.resizeCleanup?.();
      this.resizing = true;
      wb.classList.add("is-resizing");
      document.body.style.cursor = isStackedPreview() ? "row-resize" : "col-resize";
      handle.setPointerCapture(e.pointerId);

      const stacked = isStackedPreview();
      const onMove = (ev: PointerEvent) => {
        const rect = wb.getBoundingClientRect();
        if (stacked) {
          const fromBottom = rect.bottom - ev.clientY;
          const max = Math.max(PREVIEW_H_MIN, Math.floor(rect.height - 160));
          const next = Math.min(max, Math.max(PREVIEW_H_MIN, fromBottom));
          wb.style.setProperty("--preview-h", `${next}px`);
        } else {
          const fromRight = rect.right - ev.clientX;
          const max = Math.max(PREVIEW_W_MIN, Math.floor(rect.width - PREVIEW_CHAT_MIN));
          const next = Math.min(max, Math.max(PREVIEW_W_MIN, fromRight));
          wb.style.setProperty("--preview-w", `${next}px`);
        }
      };

      const onUp = (ev: PointerEvent) => {
        if (handle.hasPointerCapture(ev.pointerId)) {
          handle.releasePointerCapture(ev.pointerId);
        }
        this.resizing = false;
        wb.classList.remove("is-resizing");
        document.body.style.cursor = "";
        const size = stacked
          ? Number.parseFloat(getComputedStyle(wb).getPropertyValue("--preview-h"))
          : Number.parseFloat(getComputedStyle(wb).getPropertyValue("--preview-w"));
        if (Number.isFinite(size) && size > 0) {
          writeStoredSize(stacked ? PREVIEW_H_KEY : PREVIEW_W_KEY, size);
        }
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        this.resizeCleanup = null;
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      this.resizeCleanup = () => onUp(e);
      onMove(e);
    });
  }

  mount(parent?: HTMLElement) {
    if (parent && this.root.parentElement !== parent) {
      parent.appendChild(this.root);
    }
  }

  setDescribeHandler(cb: (prompt: string) => PreviewPromptDispatch | void) {
    this.onDescribe = cb;
  }

  private buildMenuItem(
    target: "apk" | "software",
    title: string,
    detail: string,
  ): HTMLButtonElement {
    const item = el("button", {
      class: `site-preview-build-option site-preview-build-option-${target}`,
      type: "button",
      role: "menuitem",
      "data-build-target": target,
      "aria-label": target === "apk" ? "Build Android APK" : "Build desktop software",
    }) as HTMLButtonElement;
    item.append(
      el("span", { class: "site-preview-build-option-title" }, [title]),
      el("span", { class: "site-preview-build-option-detail" }, [detail]),
    );
    item.addEventListener("click", () => this.requestBuild(target));
    return item;
  }

  private buildMenuItems(): HTMLButtonElement[] {
    return Array.from(this.buildMenu.querySelectorAll<HTMLButtonElement>("[role='menuitem']"));
  }

  private toggleBuildMenu() {
    this.setBuildMenuOpen(this.buildMenu.hidden);
  }

  private closeBuildMenu(restoreFocus = false) {
    this.setBuildMenuOpen(false, restoreFocus);
  }

  private setBuildMenuOpen(open: boolean, restoreFocus = false) {
    if (!open && this.buildMenu.hidden) return;
    this.buildMenuCleanup?.();
    this.buildMenuCleanup = null;
    this.buildMenu.hidden = !open;
    this.buildMenuToggle.setAttribute("aria-expanded", String(open));
    this.buildMenuToggle.classList.toggle("is-active", open);
    if (!open) {
      if (restoreFocus) this.buildMenuToggle.focus({ preventScroll: true });
      return;
    }

    const launcher = this.buildMenuToggle.parentElement;
    const onPointerDown = (event: PointerEvent) => {
      if (!launcher?.contains(event.target as Node)) this.closeBuildMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.closeBuildMenu(true);
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const items = this.buildMenuItems();
      if (!items.length) return;
      event.preventDefault();
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const offset = event.key === "ArrowDown" ? 1 : -1;
      const next = current < 0
        ? (offset > 0 ? 0 : items.length - 1)
        : (current + offset + items.length) % items.length;
      items[next].focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    this.buildMenuCleanup = () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
    requestAnimationFrame(() => this.buildMenuItems()[0]?.focus({ preventScroll: true }));
  }

  /** Called after a user changes the visible preview for the selected session. */
  setStateChangeHandler(cb: (state: SessionPreviewState | null) => void) {
    this.onStateChange = cb;
  }

  get isOpen(): boolean {
    return !this.root.hidden && this.root.classList.contains("is-open");
  }

  get isRestoring(): boolean {
    return this.stateRestoreDepth > 0;
  }

  /** Capture safe, serializable state for the currently displayed session. */
  captureSessionState(): SessionPreviewState | null {
    if (!this.isOpen || !this.projectRoot) return null;
    const activeTabIndex = Math.max(0, this.tabs.findIndex((tab) => tab.id === this.activeTabId));
    return {
      version: 1,
      projectRoot: this.projectRoot,
      tabs: this.tabs.map((tab) => ({
        entryPath: tab.entryPath,
        title: tab.title,
        history: [...tab.history],
        historyIndex: tab.historyIndex,
      })),
      activeTabIndex,
      designMode: this.designMode,
      androidMode: this.androidMode,
      softwareMode: this.softwareMode,
    };
  }

  /** Hide and destroy the rendered preview without changing the session's saved state. */
  clearSessionView() {
    this.viewGeneration += 1;
    this.stateRestoreDepth += 1;
    try {
      this.teardownSessionView();
    } finally {
      this.stateRestoreDepth -= 1;
    }
  }

  /**
   * Rebuild just one session's preview. Iframes are intentionally recreated so
   * a game's live DOM, timers, and user input never leak into another session.
   */
  async restoreSessionState(state: SessionPreviewState | null | undefined): Promise<void> {
    const generation = ++this.viewGeneration;
    this.stateRestoreDepth += 1;
    try {
      this.teardownSessionView();
      const projectRoot = state?.projectRoot?.trim();
      if (!projectRoot) return;

      const tabs = cleanPreviewTabs(projectRoot, state?.tabs);
      this.projectRoot = projectRoot;
      this.designMode = state?.designMode === true;
      this.androidMode = state?.androidMode === true;
      this.softwareMode = !this.androidMode && state?.softwareMode === true;
      this.syncModeUi();
      this.showShell("Preview");

      for (const savedTab of tabs) {
        if (generation !== this.viewGeneration) return;
        const id = `preview-tab-${++previewTabSeq}`;
        const frame = this.createFrame(id);
        const tab: PreviewTab = {
          id,
          entryPath: savedTab.entryPath,
          title: savedTab.title || tabTitleFromPath(savedTab.entryPath),
          history: [...savedTab.history],
          historyIndex: savedTab.historyIndex,
          frame,
          tabEl: null as unknown as HTMLButtonElement,
        };
        tab.tabEl = this.renderTabButton(tab);
        this.tabs.push(tab);
        await this.reloadTab(tab);
      }
      if (generation !== this.viewGeneration) return;

      if (!this.tabs.length) {
        this.statusEl.textContent = "No HTML preview found in this build.";
        return;
      }
      const activeIndex = Math.max(
        0,
        Math.min(this.tabs.length - 1, Math.floor(Number(state?.activeTabIndex) || 0)),
      );
      this.activeTabId = this.tabs[activeIndex].id;
      this.selected = null;
      this.syncModeUi();
      this.syncTabStrip();
      if (this.designMode) this.injectDesignMode();
      this.statusEl.textContent = /\.(apk|aab|ipa|exe|msi|dmg|wasm)$/i.test(this.entryPath)
        ? "Build artifact ready · open from Files to install/run"
        : this.readyStatus();
    } finally {
      this.stateRestoreDepth -= 1;
    }
  }

  private emitStateChange(force = false) {
    if (this.stateRestoreDepth > 0 && !force) return;
    this.onStateChange?.(this.captureSessionState());
  }

  private syncModeUi() {
    this.root.classList.toggle("is-android", this.androidMode);
    this.root.classList.toggle("is-software", this.softwareMode);
    this.designBtn.classList.toggle("is-active", this.designMode);
    this.designBtn.setAttribute("aria-pressed", String(this.designMode));
    this.androidBtn.classList.toggle("is-active", this.androidMode);
    this.androidBtn.setAttribute("aria-pressed", String(this.androidMode));
    this.softwareBtn.classList.toggle("is-active", this.softwareMode);
    this.softwareBtn.setAttribute("aria-pressed", String(this.softwareMode));
    this.editBar.hidden = !this.designMode;
    for (const tab of this.tabs) {
      tab.frame.title = this.androidMode
        ? "Website preview in Android device mode"
        : this.softwareMode
          ? "Website preview in desktop software window"
          : "Website preview";
    }
  }

  private teardownSessionView() {
    this.cancelCloseTeardown();
    this.closeBuildMenu();
    this.clearDesignMode();
    this.designMode = false;
    this.androidMode = false;
    this.softwareMode = false;
    this.syncModeUi();
    this.root.classList.remove("is-open", "is-closing");
    this.root.hidden = true;
    document.body.classList.remove("preview-open");
    document.querySelector(".workbench")?.classList.remove("preview-open");
    this.destroyAllTabs();
    this.projectRoot = "";
    this.selected = null;
    this.editInput.value = "";
    this.statusEl.textContent = "";
  }

  private get activeTab(): PreviewTab | null {
    return this.tabs.find((tab) => tab.id === this.activeTabId) ?? null;
  }

  private get entryPath(): string {
    return this.activeTab?.entryPath ?? "";
  }

  private get frame(): HTMLIFrameElement | null {
    return this.activeTab?.frame ?? null;
  }

  private cancelCloseTeardown() {
    this.closeGeneration += 1;
    if (this.closeTimer != null) {
      window.clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    this.closing = false;
  }

  async open(opts: PreviewOpenOptions) {
    const generation = ++this.viewGeneration;
    this.cancelCloseTeardown();
    this.projectRoot = opts.projectRoot;
    let files = opts.files?.length
      ? opts.files
      : await this.listProjectFilesSafe();
    if (generation !== this.viewGeneration) return;
    files = files
      .map((file) => normalizePreviewEntry(this.projectRoot, file))
      .filter((file): file is string => Boolean(file));
    let entry = normalizePreviewEntry(this.projectRoot, opts.entryPath);
    const autoPick = opts.autoPickEntry !== false;
    if (!entry && autoPick) {
      entry = pickPreviewEntry(files);
    }
    this.showShell(opts.title || "Preview");
    if (!entry) {
      if (autoPick) {
        const artifact = files.find((f) =>
          /\.(apk|aab|ipa|exe|msi|dmg|wasm)$/i.test(f),
        );
        if (artifact) {
          await this.openPathInTab(artifact, {
            activate: true,
            title: tabTitleFromPath(artifact),
            pushHistory: true,
          });
          this.statusEl.textContent = "Build artifact ready · open from Files to install/run";
          const frame = this.frame;
          if (frame) {
            frame.removeAttribute("srcdoc");
            frame.src = "about:blank";
          }
          this.emitStateChange();
          return;
        }
        this.statusEl.textContent = "No HTML preview found in this build.";
      } else {
        this.destroyAllTabs();
        this.syncTabStrip();
        this.updateNavButtons();
        this.statusEl.textContent = "Preview ready — open a file or wait for a build.";
      }
      this.emitStateChange();
      return;
    }
    this.statusEl.textContent = opts.title || "Loading preview…";
    const existing = this.tabs.find((tab) => tab.entryPath === entry);
    if (existing) {
      this.activateTab(existing.id);
      await this.reload();
      if (generation === this.viewGeneration) this.emitStateChange();
      return;
    }
    await this.openPathInTab(entry!, {
      activate: true,
      title: opts.title || tabTitleFromPath(entry!),
      pushHistory: true,
    });
    if (generation === this.viewGeneration) this.emitStateChange();
  }

  async openTab(entryPath: string, opts?: { title?: string }) {
    if (!this.projectRoot) return;
    const generation = ++this.viewGeneration;
    const entry = normalizePreviewEntry(this.projectRoot, entryPath);
    if (!entry) return;
    this.showShell(opts?.title || "Preview");
    const existing = this.tabs.find((tab) => tab.entryPath === entry);
    if (existing) {
      this.activateTab(existing.id);
      await this.reload();
      if (generation === this.viewGeneration) this.emitStateChange();
      return;
    }
    await this.openPathInTab(entry, {
      activate: true,
      title: opts?.title || tabTitleFromPath(entry),
      pushHistory: true,
    });
    if (generation === this.viewGeneration) this.emitStateChange();
  }

  close() {
    if (this.root.hidden || this.closing) return;
    this.viewGeneration += 1;
    this.closing = true;
    const generation = ++this.closeGeneration;
    this.closeBuildMenu();
    this.clearDesignMode();
    this.designMode = false;
    this.syncModeUi();
    this.root.classList.remove("is-open");
    this.root.classList.add("is-closing");
    document.body.classList.remove("preview-open");
    const workbench = document.querySelector(".workbench");
    workbench?.classList.remove("preview-open");
    this.emitStateChange(true);
    this.closeTimer = window.setTimeout(() => {
      this.closeTimer = null;
      if (!this.closing || generation !== this.closeGeneration) return;
      this.root.hidden = true;
      this.root.classList.remove("is-closing");
      this.destroyAllTabs();
      this.closing = false;
    }, 280);
  }

  private showShell(_title: string) {
    this.cancelCloseTeardown();
    this.root.removeAttribute("hidden");
    this.root.hidden = false;
    // Force reflow before fade-in
    void this.root.offsetWidth;
    this.root.classList.add("is-open");
    this.root.classList.remove("is-closing");
    document.body.classList.add("preview-open");
    document.querySelector(".workbench")?.classList.add("preview-open");
    this.applySavedPreviewSize();
    // Ensure right drawer space is available for preview
    const app = document.getElementById("app");
    if (app?.classList.contains("right-drawer-closed")) {
      app.classList.remove("right-drawer-closed");
      try {
        localStorage.setItem("ai-forge:right-drawer-open", "1");
      } catch {
        /* ignore */
      }
    }
  }

  private async listProjectFilesSafe(): Promise<string[]> {
    try {
      const tree = await api.listProjectFiles(10);
      return flattenFiles(tree.nodes || []);
    } catch {
      return [];
    }
  }

  private createFrame(tabId: string): HTMLIFrameElement {
    const frame = document.createElement("iframe");
    frame.className = "site-preview-frame";
    frame.dataset.tabId = tabId;
    frame.title = "Website preview";
    frame.hidden = true;
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-modals allow-popups");
    frame.addEventListener("load", () => {
      if (this.activeTab?.frame === frame && this.designMode) this.injectDesignMode();
    });
    this.frameHost.appendChild(frame);
    return frame;
  }

  private renderTabButton(tab: PreviewTab): HTMLButtonElement {
    const btn = el("button", {
      class: "site-preview-tab",
      type: "button",
      role: "tab",
      "aria-selected": "false",
      title: tab.entryPath,
    }, []) as HTMLButtonElement;
    const favicon = el("span", { class: "site-preview-tab-favicon", html: icon("globe", 12) });
    const title = el("span", { class: "site-preview-tab-title" }, [tab.title]);
    const closeBtn = el("button", {
      class: "site-preview-tab-close",
      type: "button",
      title: "Close tab",
      "aria-label": `Close ${tab.title}`,
      html: icon("close", 12),
    }) as HTMLButtonElement;
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.closeTab(tab.id);
    });
    btn.append(favicon, title, closeBtn);
    btn.addEventListener("click", () => {
      if (this.activeTabId !== tab.id) {
        this.activateTab(tab.id);
        if (this.designMode) this.injectDesignMode();
      }
    });
    tab.tabEl = btn;
    return btn;
  }

  private syncTabStrip() {
    this.tabsEl.replaceChildren(...this.tabs.map((tab) => tab.tabEl));
    for (const tab of this.tabs) {
      const active = tab.id === this.activeTabId;
      tab.tabEl.classList.toggle("is-active", active);
      tab.tabEl.setAttribute("aria-selected", String(active));
      tab.frame.hidden = !active;
    }
    this.urlInput.value = this.entryPath;
    this.updateNavButtons();
  }

  private updateNavButtons() {
    const tab = this.activeTab;
    if (!tab) {
      this.backBtn.disabled = true;
      this.forwardBtn.disabled = true;
      return;
    }
    this.backBtn.disabled = tab.historyIndex <= 0;
    this.forwardBtn.disabled = tab.historyIndex >= tab.history.length - 1;
  }

  private activateTab(tabId: string) {
    if (!this.tabs.some((tab) => tab.id === tabId)) return;
    if (this.designMode) this.clearDesignMode();
    this.activeTabId = tabId;
    this.selected = null;
    this.syncTabStrip();
    if (this.entryPath) this.statusEl.textContent = this.readyStatus();
    this.emitStateChange();
  }

  private closeTab(tabId: string) {
    const idx = this.tabs.findIndex((tab) => tab.id === tabId);
    if (idx < 0) return;
    const [removed] = this.tabs.splice(idx, 1);
    removed.tabEl.remove();
    removed.frame.remove();
    if (!this.tabs.length) {
      this.activeTabId = "";
      this.close();
      return;
    }
    if (this.activeTabId === tabId) {
      const next = this.tabs[Math.min(idx, this.tabs.length - 1)];
      this.activateTab(next.id);
      if (this.designMode) this.injectDesignMode();
    } else {
      this.syncTabStrip();
      this.emitStateChange();
    }
  }

  private destroyAllTabs() {
    for (const tab of this.tabs) {
      tab.tabEl.remove();
      tab.frame.removeAttribute("srcdoc");
      tab.frame.src = "about:blank";
      tab.frame.remove();
    }
    this.tabs = [];
    this.activeTabId = "";
    this.urlInput.value = "";
  }

  private pushHistory(tab: PreviewTab, entryPath: string) {
    if (tab.history[tab.historyIndex] === entryPath) return;
    tab.history = tab.history.slice(0, tab.historyIndex + 1);
    tab.history.push(entryPath);
    tab.historyIndex = tab.history.length - 1;
  }

  private async openPathInTab(
    entryPath: string,
    opts: { activate?: boolean; title?: string; pushHistory?: boolean },
  ) {
    const clean = entryPath.replace(/\\/g, "/");
    let tab = this.tabs.find((t) => t.entryPath === clean);
    if (!tab) {
      const id = `preview-tab-${++previewTabSeq}`;
      const frame = this.createFrame(id);
      tab = {
        id,
        entryPath: clean,
        title: opts.title || tabTitleFromPath(clean),
        history: [clean],
        historyIndex: 0,
        frame,
        tabEl: null as unknown as HTMLButtonElement,
      };
      tab.tabEl = this.renderTabButton(tab);
      this.tabs.push(tab);
    } else if (opts.pushHistory) {
      this.pushHistory(tab, clean);
    }
    if (opts.activate !== false) this.activeTabId = tab.id;
    this.syncTabStrip();
    await this.reloadTab(tab);
  }

  private async openNewTab() {
    if (!this.projectRoot) return;
    const generation = ++this.viewGeneration;
    const files = (await this.listProjectFilesSafe())
      .map((file) => normalizePreviewEntry(this.projectRoot, file))
      .filter((file): file is string => Boolean(file));
    if (generation !== this.viewGeneration) return;
    const openPaths = new Set(this.tabs.map((tab) => tab.entryPath));
    const candidates = files.filter((f) => HTML_EXT.test(f) && !openPaths.has(f));
    const entry = pickPreviewEntry(candidates) || pickPreviewEntry(files) || this.entryPath;
    if (!entry) return;
    await this.openPathInTab(entry, {
      activate: true,
      title: tabTitleFromPath(entry),
      pushHistory: true,
    });
    if (generation === this.viewGeneration) this.emitStateChange();
  }

  private async navigateOmnibox() {
    if (!this.projectRoot) return;
    const next = normalizePreviewEntry(this.projectRoot, this.urlInput.value.trim());
    if (!next) {
      this.urlInput.value = this.entryPath;
      this.statusEl.textContent = "Invalid preview path";
      return;
    }
    const tab = this.activeTab;
    if (tab && tab.entryPath === next) {
      await this.reload();
      return;
    }
    if (tab) {
      tab.entryPath = next;
      tab.title = tabTitleFromPath(next);
      tab.tabEl.querySelector(".site-preview-tab-title")!.textContent = tab.title;
      tab.tabEl.title = next;
      this.pushHistory(tab, next);
      this.syncTabStrip();
      await this.reloadTab(tab);
      this.emitStateChange();
      return;
    }
    await this.openPathInTab(next, { activate: true, pushHistory: true });
    this.emitStateChange();
  }

  private async goBack() {
    const tab = this.activeTab;
    if (!tab || tab.historyIndex <= 0) return;
    tab.historyIndex -= 1;
    tab.entryPath = tab.history[tab.historyIndex];
    tab.title = tabTitleFromPath(tab.entryPath);
    tab.tabEl.querySelector(".site-preview-tab-title")!.textContent = tab.title;
    tab.tabEl.title = tab.entryPath;
    this.syncTabStrip();
    await this.reloadTab(tab);
    this.emitStateChange();
  }

  private async goForward() {
    const tab = this.activeTab;
    if (!tab || tab.historyIndex >= tab.history.length - 1) return;
    tab.historyIndex += 1;
    tab.entryPath = tab.history[tab.historyIndex];
    tab.title = tabTitleFromPath(tab.entryPath);
    tab.tabEl.querySelector(".site-preview-tab-title")!.textContent = tab.title;
    tab.tabEl.title = tab.entryPath;
    this.syncTabStrip();
    await this.reloadTab(tab);
    this.emitStateChange();
  }

  async reload() {
    const tab = this.activeTab;
    if (!tab) return;
    await this.reloadTab(tab);
  }

  private async reloadTab(tab: PreviewTab) {
    if (!this.projectRoot || !tab.entryPath) return;
    this.statusEl.textContent = "Loading…";
    const frame = tab.frame;
    try {
      if (/\.(apk|aab|ipa|exe|msi|dmg|wasm)$/i.test(tab.entryPath)) {
        frame.removeAttribute("srcdoc");
        frame.src = "about:blank";
        this.statusEl.textContent = "Build artifact ready · open from Files to install/run";
        return;
      }
      const file = await api.readProjectFile(tab.entryPath);
      const rewritten = rewriteHtmlAssets(file.content, tab.entryPath, this.projectRoot);
      frame.removeAttribute("src");
      frame.srcdoc = rewritten;
      this.statusEl.textContent = this.readyStatus();
    } catch (error) {
      try {
        frame.removeAttribute("srcdoc");
        frame.src = convertFileSrc(joinFs(this.projectRoot, tab.entryPath));
        this.statusEl.textContent = this.readyStatus(true);
      } catch {
        this.statusEl.textContent = `Preview failed: ${String(error)}`;
      }
    }
  }

  setDesignMode(on: boolean) {
    if (this.designMode === on) return;
    if (!on) this.clearDesignMode();
    this.designMode = on;
    this.syncModeUi();
    if (on) {
      this.injectDesignMode();
      this.statusEl.textContent = this.readyStatus();
    } else {
      this.selected = null;
      this.statusEl.textContent = this.readyStatus();
    }
    this.emitStateChange();
  }

  setAndroidMode(on: boolean) {
    if (this.androidMode === on && (!on || !this.softwareMode)) return;
    this.androidMode = on;
    if (on) this.softwareMode = false;
    this.syncModeUi();
    if (this.entryPath) this.statusEl.textContent = this.readyStatus();
    this.emitStateChange();
  }

  setSoftwareMode(on: boolean) {
    if (this.softwareMode === on && (!on || !this.androidMode)) return;
    this.softwareMode = on;
    if (on) this.androidMode = false;
    this.syncModeUi();
    if (this.entryPath) this.statusEl.textContent = this.readyStatus();
    this.emitStateChange();
  }

  private readyStatus(assetMode = false): string {
    const mode = this.androidMode
      ? "Android · 412 × 915 viewport"
      : this.softwareMode
        ? "Software window"
        : "Desktop";
    if (this.designMode) {
      return `${mode} · Design mode · click to select, describe a change`;
    }
    return assetMode
      ? `${mode} · Ready (asset mode)`
      : `${mode} · Ready · toggle Design to edit`;
  }

  private clearDesignMode() {
    for (const tab of this.tabs) {
      try {
        const doc = tab.frame.contentDocument as (Document & { __hormaDesignCleanup?: () => void }) | null;
        doc?.__hormaDesignCleanup?.();
        delete doc?.__hormaDesignCleanup;
        doc?.getElementById("horma-design-style")?.remove();
        doc?.querySelectorAll(".horma-design-selected, .horma-design-hover").forEach((n) => {
          n.classList.remove("horma-design-selected", "horma-design-hover");
        });
        doc?.documentElement.classList.remove("horma-design");
      } catch {
        /* cross-origin */
      }
    }
  }

  private injectDesignMode() {
    const frame = this.frame;
    const doc = frame?.contentDocument;
    if (!doc?.body) return;
    this.clearDesignMode();
    const style = doc.createElement("style");
    style.id = "horma-design-style";
    style.textContent = `
      html.horma-design, html.horma-design body { cursor: crosshair !important; }
      .horma-design-hover {
        outline: 2px solid rgba(90, 160, 255, 0.85) !important;
        outline-offset: 2px !important;
      }
      .horma-design-selected {
        outline: 2px solid #5aa0ff !important;
        outline-offset: 2px !important;
        box-shadow: 0 0 0 1px rgba(90, 160, 255, 0.35) !important;
      }
    `;
    doc.head.appendChild(style);
    doc.documentElement.classList.add("horma-design");

    const onMove = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || t === doc.body || t === doc.documentElement) return;
      doc.querySelectorAll(".horma-design-hover").forEach((n) => n.classList.remove("horma-design-hover"));
      t.classList.add("horma-design-hover");
    };
    const onClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const t = e.target as HTMLElement | null;
      if (!t || t === doc.body || t === doc.documentElement) return;
      doc.querySelectorAll(".horma-design-selected").forEach((n) => n.classList.remove("horma-design-selected"));
      t.classList.add("horma-design-selected");
      const tag = (t.tagName || "el").toLowerCase();
      const text = (t.innerText || t.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
      const selector = this.cssPath(t);
      this.selected = { tag, text, path: this.entryPath, selector };
      const tagEl = this.editBar.querySelector("#site-preview-edit-tag");
      if (tagEl) tagEl.textContent = tag;
      this.editInput.focus();
      this.editInput.placeholder = text ? `Change “${text.slice(0, 40)}”…` : "Describe the change";
    };
    doc.addEventListener("mousemove", onMove, true);
    doc.addEventListener("click", onClick, true);
    (doc as any).__hormaDesignCleanup = () => {
      doc.removeEventListener("mousemove", onMove, true);
      doc.removeEventListener("click", onClick, true);
      doc.documentElement.classList.remove("horma-design");
    };
  }

  private cssPath(el: HTMLElement): string {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts: string[] = [];
    let cur: HTMLElement | null = el;
    while (cur && cur.nodeType === 1 && parts.length < 5) {
      let part = cur.tagName.toLowerCase();
      const parent: HTMLElement | null = cur.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(cur) + 1;
          part += `:nth-of-type(${idx})`;
        }
      }
      parts.unshift(part);
      cur = parent;
      if (cur?.tagName === "BODY") break;
    }
    return parts.join(" > ");
  }

  private requestBuild(target: "apk" | "software") {
    this.closeBuildMenu();
    const label = target === "apk" ? "Android APK build" : "Desktop software build";
    this.dispatchGeneratedPrompt(this.buildPrompt(target), label);
  }

  /** Send a preview-generated request through the regular chat / pending queue. */
  private dispatchGeneratedPrompt(prompt: string, label: string) {
    if (!this.onDescribe) {
      this.statusEl.textContent = "Preview actions are not available until chat is ready.";
      return;
    }

    const dispatch = this.onDescribe(prompt) || "sent";
    this.statusEl.textContent = dispatch === "queued"
      ? `${label} queued — it will start after the active task finishes.`
      : dispatch === "needs_project"
        ? "Open or create a project before starting a build."
        : dispatch === "usage_exhausted"
          ? "No usage remains for this build request."
          : dispatch === "stopping"
            ? "The current task is stopping — choose Build again after it ends."
            : `${label} request sent to the active model.`;
  }

  private buildPrompt(target: "apk" | "software"): string {
    const entry = this.entryPath || "the current project";
    const project = this.projectRoot || "the active project";
    const isApk = target === "apk";
    const targetName = isApk ? "Android APK" : "desktop software";
    const packaging = isApk
      ? "Use the least disruptive Android approach for the existing project (for example Capacitor/Cordova or a native Android wrapper when appropriate). Add Android manifest metadata, app icons, signing-ready Gradle configuration, and an installable APK output."
      : "Use the least disruptive desktop approach for the existing project (for example Tauri, Electron, or its existing native stack). Add app metadata, an icon, window configuration, and a runnable desktop executable output.";

    return `Build a production-ready ${targetName} from the currently previewed project.\n\n\
Build context:\n\
- Project root: ${project}\n\
- Preview entry: ${entry}\n\n\
Do the implementation now, not only an explanation:\n\
1. Inspect the existing project and preserve its current design, behavior, assets, and user data flow.\n\
2. ${packaging}\n\
3. Keep the original preview usable while adding the packaging files and build scripts.\n\
4. Run the most relevant build or validation command and fix issues you find.\n\
5. Produce the final ${isApk ? ".apk" : "desktop executable"} in a clear output folder and report its exact path.\n\n\
Continue autonomously until the build is genuinely complete. Do not ask me to type Continue.`;
  }

  private makeWebsitePublic() {
    const entry = this.entryPath || "the current project";
    const project = this.projectRoot || "the active project";
    const prompt = `Publish the currently previewed project as a production public website now. Work autonomously: perform the deployment instead of only explaining how to do it.

Publishing context:
- Project root: ${project}
- Preview entry: ${entry}

Use this GitHub → Vercel → Supabase flow:
1. Preflight — inspect the existing project, identify its framework, build command, output directory, and whether it truly uses Supabase. Preserve the current design, functionality, and user data flow.
2. Connected accounts — check the built-in GitHub, Vercel, and Supabase integrations first. If a required connection is missing, start the secure in-app connection flow for that service and resume as soon as the user completes it. Never ask for or print credentials in chat, and never run an interactive CLI login.
3. GitHub — reuse an existing repository and remote when present; otherwise initialize only this project, create an appropriately named repository in the connected account, commit the relevant project files, and push the deployment-ready code.
4. Supabase — only when the project needs database, authentication, edge functions, or storage, reuse its configured Supabase project or create one through the connected account. Apply migrations safely once, configure the required environment variable names securely, and never expose service-role or secret values in the client bundle.
5. Vercel — create or link the Vercel project from the GitHub repository, set the detected build/output settings and required environment variables, then deploy to Production using the connected Vercel account.
6. Verification — verify the deployed public URL and the essential website/backend path. Fix deployment configuration errors and re-deploy until the live result works.

When the task is complete, report the live public URL, GitHub repository URL, Vercel project, any Supabase project/migrations used, environment-variable names only (never values), and a short list of the deployment steps completed. Do not claim the website is public until the live URL has been verified. Continue autonomously until this is genuinely complete; do not ask me to type Continue.`;
    this.dispatchGeneratedPrompt(prompt, "Website publication");
  }

  private submitDescribe() {
    const text = this.editInput.value.trim();
    if (!text) return;
    const sel = this.selected;
    const prompt = sel
      ? `In the preview (${sel.path}), update the <${sel.tag}> element${sel.text ? ` that says “${sel.text}”` : ""} (selector: ${sel.selector}).\n\nRequested change: ${text}`
      : `In the preview (${this.entryPath}), apply this design change:\n\n${text}`;
    this.editInput.value = "";
    this.onDescribe?.(prompt);
  }
}
