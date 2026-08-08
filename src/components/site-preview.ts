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

type VisualFeatureTarget = {
  /** CSS-pixel rectangle relative to the visible preview frame. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Stable visual context for the fallback prompt when capture is unavailable. */
  xPercent: number;
  yPercent: number;
  widthPercent: number;
  heightPercent: number;
};

type SelectedEl = {
  tag: string;
  text: string;
  path: string;
  selector: string;
  /** Same-origin preview node used for the design-mode screenshot. */
  element: HTMLElement | null;
  /** data:image/… screenshot of the clicked control, captured on select. */
  shotDataUrl: string | null;
  /**
   * A user-drawn feature box when a live iframe is cross-origin. Its DOM is
   * intentionally inaccessible to the shell, but the visible feature can
   * still be outlined and captured as an image reference for the model.
   */
  visualTarget?: VisualFeatureTarget;
};

/** Result returned by the chat shell after a preview action creates a prompt. */
export type PreviewPromptDispatch =
  | "sent"
  | "queued"
  | "needs_project"
  | "usage_exhausted"
  | "stopping";

export type PreviewDescribeHandler = (
  prompt: string,
  imagePath?: string | null,
) => PreviewPromptDispatch | void;

const PREVIEWABLE_EXT = /\.(html?|xhtml|css|js|mjs|ts|tsx|jsx|vue|svelte|apk|aab|ipa|exe|msi|dmg|wasm)$/i;
const HTML_EXT = /\.html?$/i;

/**
 * Rasterize a same-origin preview element (with padding) to a PNG data URL.
 * Design-mode chrome should be hidden by the caller before invoking this.
 */
async function rasterizePreviewElement(target: HTMLElement, pad = 24): Promise<string | null> {
  const rect = target.getBoundingClientRect();
  const width = Math.max(1, Math.ceil(rect.width + pad * 2));
  const height = Math.max(1, Math.ceil(rect.height + pad * 2));
  const scale = Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);

  const clone = inlineElementClone(target);
  clone.style.margin = "0";
  clone.style.position = "static";
  clone.style.transform = "none";
  clone.style.left = "auto";
  clone.style.top = "auto";

  const wrapper = target.ownerDocument.createElement("div");
  wrapper.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  wrapper.style.cssText = [
    `width:${Math.max(1, Math.ceil(rect.width))}px`,
    `height:${Math.max(1, Math.ceil(rect.height))}px`,
    `padding:${pad}px`,
    "box-sizing:content-box",
    "background:#ffffff",
    "display:flex",
    "align-items:flex-start",
    "justify-content:flex-start",
    "overflow:hidden",
    "font-family:system-ui,-apple-system,Segoe UI,sans-serif",
  ].join(";");
  wrapper.appendChild(clone);

  const serialized = new XMLSerializer().serializeToString(wrapper);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<foreignObject width="100%" height="100%">${serialized}</foreignObject></svg>`;
  const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

  const img = new Image();
  img.decoding = "sync";
  const loaded = new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("preview snapshot failed"));
  });
  img.src = svgUrl;
  await loaded;

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(scale, scale);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL("image/png");
}

function inlineElementClone(source: HTMLElement): HTMLElement {
  const clone = source.cloneNode(true) as HTMLElement;
  const walk = (src: Element, dst: Element) => {
    if (src instanceof HTMLElement && dst instanceof HTMLElement) {
      const cs = src.ownerDocument.defaultView?.getComputedStyle(src);
      if (cs) {
        let cssText = "";
        for (let i = 0; i < cs.length; i++) {
          const prop = cs.item(i);
          if (!prop) continue;
          cssText += `${prop}:${cs.getPropertyValue(prop)};`;
        }
        dst.style.cssText = cssText;
      }
      dst.classList.remove("horma-design-selected", "horma-design-hover");
      if (dst instanceof HTMLImageElement && src instanceof HTMLImageElement) {
        try {
          dst.src = src.currentSrc || src.src;
        } catch {
          /* ignore */
        }
      }
    }
    const srcKids = Array.from(src.children);
    const dstKids = Array.from(dst.children);
    for (let i = 0; i < srcKids.length && i < dstKids.length; i++) {
      walk(srcKids[i]!, dstKids[i]!);
    }
  };
  walk(source, clone);
  return clone;
}

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

export function isExternalPreviewUrl(value: string): boolean {
  const trimmed = value.trim();
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(trimmed);
}

export function normalizePreviewEntry(projectRoot: string, value?: string | null): string | null {
  if (!projectRoot || !value) return null;
  // A live dev server (localhost) can be previewed directly in the iframe.
  if (isExternalPreviewUrl(value)) return value.trim();
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

/**
 * A srcdoc preview is scriptable, while a localhost/external iframe is not
 * scriptable from the Tauri WebView.  Check the configured source first so
 * Design mode can offer its visual-selection fallback immediately instead of
 * showing a misleading unavailable message after several retries.
 */
function isCrossOriginFrame(frame: HTMLIFrameElement): boolean {
  const declaredSrc = frame.getAttribute("src")?.trim();
  if (!declaredSrc || /^about:blank$/i.test(declaredSrc)) return false;
  try {
    return new URL(frame.src, window.location.href).origin !== window.location.origin;
  } catch {
    return true;
  }
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
  /** Set when design mode is being torn down, to cancel pending inject retries. */
  private designModeCleanedUp = false;
  private androidMode = false;
  private softwareMode = false;
  private projectRoot = "";
  private tabs: PreviewTab[] = [];
  private activeTabId = "";
  private selected: SelectedEl | null = null;
  /** Parent-side selector used when an iframe's DOM is isolated by origin. */
  private visualDesignOverlay: HTMLElement | null = null;
  /** Deduplicates a native visual-feature screenshot while it is being made. */
  private visualCapture:
    | { selection: SelectedEl; promise: Promise<string | null> }
    | null = null;
  private onDescribe: PreviewDescribeHandler | null = null;
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
        void this.submitDescribe();
      }
    });
    const send = el("button", {
      class: "site-preview-edit-send",
      type: "button",
      title: "Apply with AI",
    }, ["Ask AI"]) as HTMLButtonElement;
    send.addEventListener("click", () => void this.submitDescribe());
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

  setDescribeHandler(cb: PreviewDescribeHandler) {
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
      this.statusEl.textContent = /\.(apk|aab|ipa|exe|msi|dmg|wasm)$/i.test(this.entryPath)
        ? "Build artifact ready · open from Files to install/run"
        : this.readyStatus();
      if (this.designMode) this.injectDesignMode();
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

  private updateEditTargetUi(target: SelectedEl | null) {
    const tagEl = this.editBar.querySelector("#site-preview-edit-tag");
    if (!tagEl) return;
    if (target?.visualTarget) {
      tagEl.textContent = "feature";
      const width = Math.max(1, Math.round(target.visualTarget.widthPercent));
      const height = Math.max(1, Math.round(target.visualTarget.heightPercent));
      this.editInput.placeholder = `Change the selected feature (${width}% × ${height}% reference)…`;
      return;
    }
    if (target) {
      tagEl.textContent = target.tag;
      this.editInput.placeholder = target.text
        ? `Change “${target.text.slice(0, 40)}”…`
        : "Describe the change";
      return;
    }
    tagEl.textContent = "element";
    this.editInput.placeholder = this.designMode
      ? "Click an element or drag around a live feature, then describe the change"
      : "Describe the change";
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
        // Reopening the preview shell: keep previously opened tabs (they were
        // preserved on close) so the loaded website reappears. Only tear down
        // when there are no tabs to restore.
        if (!this.tabs.length) {
          this.destroyAllTabs();
          this.statusEl.textContent = "Preview ready — open a file or wait for a build.";
        } else {
          this.activeTabId = this.tabs.some((t) => t.id === this.activeTabId)
            ? this.activeTabId
            : this.tabs[this.tabs.length - 1].id;
          this.syncTabStrip();
          void this.reloadTab(this.activeTab!);
          this.statusEl.textContent = this.readyStatus();
        }
        this.updateNavButtons();
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
      // Preserve open tabs so the preview (and its loaded websites) survives a
      // drawer collapse / window minimize. Tabs are torn down only on explicit
      // close-all / destroyAllTabs callers (project switch, app close).
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
    this.updateEditTargetUi(null);
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
    const entry = pickPreviewEntry(candidates) || pickPreviewEntry(files.filter((f) => HTML_EXT.test(f)));
    // Always create a fresh tab: prefer an unopened HTML file; otherwise open a
    // blank tab the user can type a path/URL into (never re-activate an open one).
    const freshPath = entry || "";
    const tabId = `preview-tab-${++previewTabSeq}`;
    const frame = this.createFrame(tabId);
    const tab: PreviewTab = {
      id: tabId,
      entryPath: freshPath,
      title: freshPath ? tabTitleFromPath(freshPath) : "New tab",
      history: freshPath ? [freshPath] : [],
      historyIndex: 0,
      frame,
      tabEl: null as unknown as HTMLButtonElement,
    };
    tab.tabEl = this.renderTabButton(tab);
    this.tabs.push(tab);
    this.activeTabId = tabId;
    this.syncTabStrip();
    if (freshPath) {
      await this.reloadTab(tab);
    } else {
      frame.removeAttribute("srcdoc");
      frame.src = "about:blank";
      this.statusEl.textContent = "New tab — type a file path or http://localhost URL";
    }
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
      // A live dev server URL (localhost) is loaded directly in the iframe.
      if (isExternalPreviewUrl(tab.entryPath)) {
        frame.removeAttribute("srcdoc");
        frame.src = tab.entryPath;
        this.statusEl.textContent = this.readyStatus(true);
        return;
      }
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
    if (!on) {
      this.designModeCleanedUp = true;
      this.clearDesignMode();
    } else {
      this.designModeCleanedUp = false;
    }
    this.designMode = on;
    if (!on) this.selected = null;
    this.syncModeUi();
    this.updateEditTargetUi(this.selected);
    if (on) {
      this.statusEl.textContent = this.readyStatus();
      this.injectDesignMode();
    } else {
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
      return `${mode} · Design mode · click an element or drag around a live feature, then describe the change`;
    }
    return assetMode
      ? `${mode} · Ready (asset mode)`
      : `${mode} · Ready · toggle Design to edit`;
  }

  private clearDesignMode(cancelPendingInject = true) {
    if (cancelPendingInject) this.designModeCleanedUp = true;
    this.clearVisualDesignMode();
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

  /** Remove the parent-side target selector used for cross-origin previews. */
  private clearVisualDesignMode() {
    this.visualDesignOverlay?.remove();
    this.visualDesignOverlay = null;
    this.visualCapture = null;
  }

  /**
   * Cross-origin frames (including live localhost dev servers in WebView2)
   * cannot safely expose their DOM to the shell. Keep Design mode useful with
   * a precise user-drawn feature box rather than pretending a point is a DOM
   * selector. The selected box is captured as an image reference for the AI.
   */
  private enableVisualDesignMode(frame: HTMLIFrameElement) {
    this.clearVisualDesignMode();
    if (!this.designMode || this.activeTab?.frame !== frame) return;

    const overlay = el("div", {
      class: "site-preview-visual-design-overlay",
      "data-testid": "design-visual-overlay",
      tabindex: "0",
      "aria-label": "Drag around a feature in the live preview",
    });
    const hint = el("div", { class: "site-preview-visual-design-hint", "aria-hidden": "true" }, [
      el("span", { class: "site-preview-visual-design-hint-label" }, ["Live preview"]),
      el("span", {}, ["Drag around the exact feature to edit"]),
    ]);
    const cursor = el("span", {
      class: "site-preview-visual-design-cursor",
      "aria-hidden": "true",
      hidden: "true",
    });
    const featureBox = el("div", {
      class: "site-preview-visual-feature-selection",
      "data-testid": "design-feature-selection",
      "aria-hidden": "true",
      hidden: "true",
    }, [
      el("span", { class: "site-preview-visual-feature-corner is-top-left" }),
      el("span", { class: "site-preview-visual-feature-corner is-top-right" }),
      el("span", { class: "site-preview-visual-feature-corner is-bottom-left" }),
      el("span", { class: "site-preview-visual-feature-corner is-bottom-right" }),
      el("span", { class: "site-preview-visual-feature-label" }, ["Feature selected"]),
    ]);
    overlay.append(hint, cursor, featureBox);

    type OverlayPoint = { x: number; y: number; width: number; height: number };
    type DragStart = { pointerId: number; x: number; y: number };
    let drag: DragStart | null = null;
    const pointForEvent = (event: PointerEvent): OverlayPoint | null => {
      const rect = overlay.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return null;
      const clamp = (value: number, max: number) => Math.max(0, Math.min(max, value));
      return {
        x: clamp(event.clientX - rect.left, rect.width),
        y: clamp(event.clientY - rect.top, rect.height),
        width: rect.width,
        height: rect.height,
      };
    };
    const targetFromPoints = (from: DragStart, to: OverlayPoint, useClickSize = false): VisualFeatureTarget => {
      let left = Math.min(from.x, to.x);
      let top = Math.min(from.y, to.y);
      let width = Math.abs(to.x - from.x);
      let height = Math.abs(to.y - from.y);
      // A quick click still selects a useful, visible feature-sized box. A
      // drag is preferred when the user needs exact boundaries.
      if (useClickSize || (width < 12 && height < 12)) {
        width = Math.min(88, Math.max(42, to.width * 0.14));
        height = Math.min(58, Math.max(30, to.height * 0.1));
        left = Math.max(0, Math.min(to.width - width, from.x - width / 2));
        top = Math.max(0, Math.min(to.height - height, from.y - height / 2));
      }
      width = Math.max(12, Math.min(width, to.width - left));
      height = Math.max(12, Math.min(height, to.height - top));
      return {
        x: Math.round(left),
        y: Math.round(top),
        width: Math.round(width),
        height: Math.round(height),
        xPercent: Math.round((left / to.width) * 1000) / 10,
        yPercent: Math.round((top / to.height) * 1000) / 10,
        widthPercent: Math.round((width / to.width) * 1000) / 10,
        heightPercent: Math.round((height / to.height) * 1000) / 10,
      };
    };
    const drawFeatureBox = (target: VisualFeatureTarget, active = false) => {
      featureBox.hidden = false;
      featureBox.style.left = `${target.x}px`;
      featureBox.style.top = `${target.y}px`;
      featureBox.style.width = `${target.width}px`;
      featureBox.style.height = `${target.height}px`;
      featureBox.classList.toggle("is-dragging", active);
    };
    const finishSelection = (target: VisualFeatureTarget) => {
      const selection: SelectedEl = {
        tag: "visual feature",
        text: `${Math.round(target.widthPercent)}% × ${Math.round(target.heightPercent)}% feature reference`,
        path: this.entryPath,
        selector: `visual-feature(${target.xPercent}%,${target.yPercent}%,${target.widthPercent}%,${target.heightPercent}%)`,
        element: null,
        shotDataUrl: null,
        visualTarget: target,
      };
      this.selected = selection;
      drawFeatureBox(target);
      overlay.dataset.selected = "true";
      overlay.dataset.screenshot = "pending";
      this.updateEditTargetUi(selection);
      this.statusEl.textContent = "Feature selected · creating a visual reference for AI…";
      this.editInput.focus();
      void this.captureVisualFeatureShot(selection);
    };

    overlay.addEventListener("pointermove", (event) => {
      const point = pointForEvent(event);
      if (!point) return;
      if (drag?.pointerId === event.pointerId) {
        event.preventDefault();
        cursor.hidden = true;
        drawFeatureBox(targetFromPoints(drag, point), true);
        return;
      }
      cursor.hidden = false;
      cursor.style.left = `${point.x}px`;
      cursor.style.top = `${point.y}px`;
    });
    overlay.addEventListener("pointerleave", () => {
      if (!drag) cursor.hidden = true;
    });
    overlay.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const point = pointForEvent(event);
      if (!point) return;
      event.preventDefault();
      event.stopPropagation();
      drag = { pointerId: event.pointerId, x: point.x, y: point.y };
      overlay.dataset.dragging = "true";
      cursor.hidden = true;
      drawFeatureBox(targetFromPoints(drag, point, true), true);
      try {
        overlay.setPointerCapture(event.pointerId);
      } catch {
        /* Pointer capture is optional on older embedded WebViews. */
      }
    });
    overlay.addEventListener("pointerup", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const point = pointForEvent(event);
      const started = drag;
      drag = null;
      delete overlay.dataset.dragging;
      try {
        overlay.releasePointerCapture(event.pointerId);
      } catch {
        /* No pointer capture to release. */
      }
      if (!point) return;
      event.preventDefault();
      event.stopPropagation();
      finishSelection(targetFromPoints(started, point));
    });
    overlay.addEventListener("pointercancel", (event) => {
      if (drag?.pointerId !== event.pointerId) return;
      drag = null;
      delete overlay.dataset.dragging;
      featureBox.classList.remove("is-dragging");
    });
    overlay.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      this.setDesignMode(false);
    });

    this.frameHost.appendChild(overlay);
    this.visualDesignOverlay = overlay;
    this.selected = null;
    this.updateEditTargetUi(null);
    this.statusEl.textContent =
      "Design mode · live preview is isolated, so drag around the exact feature to create an AI reference.";
  }

  /**
   * A cross-origin iframe cannot be rasterized by browser JavaScript. This
   * user-triggered, bounded native capture records only the selected preview
   * box, after hiding Design-mode chrome so the image contains the feature
   * rather than its temporary outline.
   */
  private async captureVisualFeatureShot(selection: SelectedEl): Promise<string | null> {
    if (!selection.visualTarget) return null;
    if (selection.shotDataUrl) return selection.shotDataUrl;
    if (this.visualCapture?.selection === selection) return this.visualCapture.promise;
    const overlay = this.visualDesignOverlay;
    if (!overlay?.isConnected) return null;
    const target = selection.visualTarget;
    const promise = (async () => {
      overlay.classList.add("is-capturing");
      // Let WebView paint the temporary chrome-free frame before Windows reads
      // its bounded preview surface.
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      try {
        const host = this.frameHost.getBoundingClientRect();
        if (host.width < 1 || host.height < 1) return null;
        const raw = await api.capturePreviewSelection({
          x: host.left + target.x,
          y: host.top + target.y,
          width: target.width,
          height: target.height,
          devicePixelRatio: window.devicePixelRatio || 1,
        });
        const shot = raw.startsWith("data:image/") ? raw : `data:image/png;base64,${raw}`;
        if (this.selected === selection && this.visualDesignOverlay === overlay) {
          selection.shotDataUrl = shot;
          overlay.dataset.screenshot = "ready";
          this.statusEl.textContent = "Feature selected · visual reference ready for AI.";
        }
        return shot;
      } catch {
        if (this.selected === selection && this.visualDesignOverlay === overlay) {
          overlay.dataset.screenshot = "unavailable";
          this.statusEl.textContent = "Feature selected · describe the change and the outlined reference will be sent to AI.";
        }
        return null;
      } finally {
        overlay.classList.remove("is-capturing");
        if (this.visualCapture?.selection === selection) this.visualCapture = null;
      }
    })();
    this.visualCapture = { selection, promise };
    return promise;
  }

  private injectDesignMode(attempt = 0) {
    const frame = this.frame;
    if (!frame) return;
    // This is the entry point that (re)activates design mode on the active
    // frame, so clear the torn-down flag regardless of how we got here.
    this.designModeCleanedUp = false;
    // Some WebView2 versions expose the frame document via contentWindow when
    // contentDocument reads null; try both before giving up.
    if (isCrossOriginFrame(frame)) {
      this.enableVisualDesignMode(frame);
      return;
    }
    let doc = frame.contentDocument;
    if (!doc?.body) {
      try {
        doc = frame.contentWindow?.document ?? null;
      } catch {
        doc = null;
      }
    }
    if (!doc?.body) {
      // The frame may still be loading (srcdoc is set after readProjectFile
      // resolves). Retry a few times across a short window instead of giving
      // up immediately — WebView2 can be slower than Chromium here. Each retry
      // re-reads the active frame so a mid-retry tab switch can't inject into
      // a stale frame.
      if (attempt < 8 && !this.designModeCleanedUp) {
        window.setTimeout(() => {
          if (this.designMode && !this.designModeCleanedUp) this.injectDesignMode(attempt + 1);
        }, 120);
        return;
      }
      // If a same-origin frame still cannot be inspected (for example while a
      // navigation error page is active), retain a useful visual selector
      // instead of disabling Design mode entirely.
      if (frame.src && !/^about:blank$/.test(frame.src)) {
        this.enableVisualDesignMode(frame);
      }
      return;
    }
    this.clearDesignMode(false);
    this.selected = null;
    this.updateEditTargetUi(null);
    const style = doc.createElement("style");
    style.id = "horma-design-style";
    style.textContent = `
      html.horma-design, html.horma-design body { cursor: crosshair !important; }
      .horma-design-cursor {
        position: fixed !important;
        z-index: 2147483646 !important;
        width: 34px !important;
        height: 34px !important;
        margin: -17px 0 0 -17px !important;
        border: 2px solid rgba(90, 160, 255, 0.95) !important;
        border-radius: 50% !important;
        background: radial-gradient(circle, rgba(90, 160, 255, 0.18) 0%, rgba(90, 160, 255, 0) 70%) !important;
        box-shadow: 0 0 18px rgba(90, 160, 255, 0.45), inset 0 0 10px rgba(90, 160, 255, 0.25) !important;
        pointer-events: none !important;
        opacity: 0 !important;
        transition: opacity 0.18s ease, transform 0.12s ease !important;
        will-change: transform !important;
      }
      html.horma-design .horma-design-cursor.is-visible { opacity: 1 !important; }
      html.horma-design .horma-design-cursor.is-hovering {
        transform: scale(1.35) !important;
        border-color: #8fc2ff !important;
        box-shadow: 0 0 26px rgba(90, 160, 255, 0.65), inset 0 0 14px rgba(90, 160, 255, 0.4) !important;
      }
      .horma-design-cursor.is-clicked {
        transform: scale(0.7) !important;
        border-color: #fff !important;
        box-shadow: 0 0 30px rgba(90, 160, 255, 0.9) !important;
      }
      .horma-design-hover {
        outline: 2px solid rgba(90, 160, 255, 0.9) !important;
        outline-offset: 2px !important;
        box-shadow: 0 0 0 4px rgba(90, 160, 255, 0.22) !important;
        cursor: pointer !important;
      }
      .horma-design-selected {
        outline: 3px solid #5aa0ff !important;
        outline-offset: 2px !important;
        box-shadow: 0 0 0 6px rgba(90, 160, 255, 0.35), 0 4px 24px rgba(0, 0, 0, 0.3) !important;
        transition: outline-color 0.15s ease, box-shadow 0.15s ease !important;
        animation: hormaDesignPulse 1.6s ease-in-out infinite !important;
      }
      @keyframes hormaDesignPulse {
        0%, 100% { outline-color: #5aa0ff; }
        50% { outline-color: #8fc2ff; }
      }
      .horma-edit-chip {
        position: fixed !important;
        z-index: 2147483647 !important;
        display: inline-flex !important;
        align-items: center !important;
        gap: 6px !important;
        padding: 7px 12px !important;
        border-radius: 999px !important;
        background: #181818 !important;
        border: 1px solid rgba(90, 160, 255, 0.6) !important;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45) !important;
        color: #e8e6df !important;
        font: 600 12px/1 system-ui, -apple-system, "Segoe UI", sans-serif !important;
        letter-spacing: 0.01em !important;
        cursor: pointer !important;
        user-select: none !important;
        pointer-events: auto !important;
        transition: transform 0.12s ease, box-shadow 0.12s ease !important;
      }
      .horma-edit-chip:hover { transform: translateY(-1px) !important; box-shadow: 0 8px 26px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(90, 160, 255, 0.9) !important; }
      .horma-edit-chip .horma-edit-chip-ico { color: #5aa0ff !important; font-size: 13px !important; }
    `;
    doc.head.appendChild(style);
    doc.documentElement.classList.add("horma-design");

    // Cursor-follow ring that trails the mouse in design mode.
    const cursorRing = doc.createElement("div");
    cursorRing.className = "horma-design-cursor";
    doc.body.appendChild(cursorRing);
    let ringX = 0;
    let ringY = 0;
    let ringTargetX = 0;
    let ringTargetY = 0;
    let ringRaf = 0;
    const moveRing = () => {
      ringX += (ringTargetX - ringX) * 0.28;
      ringY += (ringTargetY - ringY) * 0.28;
      cursorRing.style.transform = `translate3d(${ringX}px, ${ringY}px, 0)`;
      if (Math.abs(ringTargetX - ringX) > 0.5 || Math.abs(ringTargetY - ringY) > 0.5) {
        ringRaf = requestAnimationFrame(moveRing);
      } else {
        ringRaf = 0;
      }
    };
    const onMove = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || t === doc.body || t === doc.documentElement) {
        cursorRing.classList.remove("is-visible", "is-hovering");
        return;
      }
      cursorRing.classList.add("is-visible");
      const hovering = !!t.closest?.(".horma-design-hover, a, button, input, select, textarea, [role='button']");
      cursorRing.classList.toggle("is-hovering", hovering);
      ringTargetX = e.clientX;
      ringTargetY = e.clientY;
      if (!ringRaf) ringRaf = requestAnimationFrame(moveRing);
      doc.querySelectorAll(".horma-design-hover").forEach((n) => n.classList.remove("horma-design-hover"));
      t.classList.add("horma-design-hover");
    };
    const positionEditChip = (chip: HTMLElement, target: HTMLElement) => {
      const rect = target.getBoundingClientRect();
      const top = Math.max(6, rect.top - 44);
      const left = Math.min(
        Math.max(6, rect.left + rect.width - 150),
        (doc.defaultView?.innerWidth || 0) - 156,
      );
      chip.style.top = `${top}px`;
      chip.style.left = `${left}px`;
    };
    const removeEditChip = () => {
      doc.querySelector(".horma-edit-chip")?.remove();
    };
    const onClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // Cursor click "pop" effect.
      cursorRing.classList.remove("is-hovering");
      cursorRing.classList.add("is-clicked");
      window.setTimeout(() => cursorRing.classList.remove("is-clicked"), 140);
      const t = e.target as HTMLElement | null;
      if (!t || t === doc.body || t === doc.documentElement) return;
      // Clicking the edit chip itself should not reselect.
      if (t.classList.contains("horma-edit-chip") || t.closest?.(".horma-edit-chip")) return;
      doc.querySelectorAll(".horma-design-selected").forEach((n) => n.classList.remove("horma-design-selected"));
      t.classList.add("horma-design-selected");
      const tag = (t.tagName || "el").toLowerCase();
      const text = (t.innerText || t.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
      const selector = this.cssPath(t);
      this.selected = {
        tag,
        text,
        path: this.entryPath,
        selector,
        element: t,
        shotDataUrl: null,
      };
      this.updateEditTargetUi(this.selected);

      // Floating "Edit this element" chip near the selection.
      removeEditChip();
      const chip = doc.createElement("div");
      chip.className = "horma-edit-chip";
      chip.setAttribute("role", "button");
      chip.setAttribute("tabindex", "0");
      const ico = doc.createElement("span");
      ico.className = "horma-edit-chip-ico";
      ico.textContent = "✎";
      const label = doc.createElement("span");
      label.textContent = "Edit this element";
      chip.append(ico, label);
      chip.addEventListener("click", (ce: MouseEvent) => {
        ce.preventDefault();
        ce.stopPropagation();
        removeEditChip();
        this.editInput.focus();
      });
      chip.addEventListener("keydown", (ke: KeyboardEvent) => {
        if (ke.key === "Enter" || ke.key === " ") {
          ke.preventDefault();
          removeEditChip();
          this.editInput.focus();
        }
      });
      doc.body.appendChild(chip);
      positionEditChip(chip, t);
      // Reposition as the page scrolls / resizes so the chip follows the element.
      const reposition = () => positionEditChip(chip, t);
      doc.addEventListener("scroll", reposition, true);
      doc.defaultView?.addEventListener("resize", reposition);
      (chip as any).__hormaReposition = () => {
        doc.removeEventListener("scroll", reposition, true);
        doc.defaultView?.removeEventListener("resize", reposition);
      };

      // Capture the clicked control (without the edit chrome) for the AI.
      void this.captureSelectionShot(t).then((shot) => {
        if (this.selected?.element === t) this.selected.shotDataUrl = shot;
      });
    };
    doc.addEventListener("mousemove", onMove, true);
    doc.addEventListener("click", onClick, true);
    (doc as any).__hormaDesignCleanup = () => {
      doc.removeEventListener("mousemove", onMove, true);
      doc.removeEventListener("click", onClick, true);
      if (ringRaf) cancelAnimationFrame(ringRaf);
      cursorRing.remove();
      const chip = doc.querySelector(".horma-edit-chip") as (HTMLElement & { __hormaReposition?: () => void }) | null;
      (chip as any)?.__hormaReposition?.();
      chip?.remove();
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

  /**
   * Snapshot the clicked preview control (design chrome hidden) so the AI can
   * see exactly what the user selected instead of relying on CSS selectors.
   */
  private async captureSelectionShot(target: HTMLElement): Promise<string | null> {
    const doc = target.ownerDocument;
    if (!doc) return null;
    const chip = doc.querySelector(".horma-edit-chip") as HTMLElement | null;
    const chipDisplay = chip?.style.display;
    const hadSelected = target.classList.contains("horma-design-selected");
    const hadHover = target.classList.contains("horma-design-hover");
    try {
      if (chip) chip.style.display = "none";
      target.classList.remove("horma-design-selected", "horma-design-hover");
      doc.querySelectorAll(".horma-design-hover").forEach((n) => n.classList.remove("horma-design-hover"));
      // Let the browser paint without the design outline/chip.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return await rasterizePreviewElement(target, 28);
    } catch {
      return null;
    } finally {
      if (chip) chip.style.display = chipDisplay || "";
      if (hadSelected) target.classList.add("horma-design-selected");
      if (hadHover) target.classList.add("horma-design-hover");
    }
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

  private async submitDescribe() {
    const text = this.editInput.value.trim();
    if (!text) return;
    const sel = this.selected;
    this.editInput.value = "";
    this.statusEl.textContent = sel?.visualTarget
      ? "Preparing selected feature for AI…"
      : "Capturing selection for AI…";

    let shot = sel?.shotDataUrl || null;
    if (!shot) {
      if (sel?.visualTarget) {
        shot = await this.captureVisualFeatureShot(sel);
      } else if (sel?.element?.isConnected) {
        shot = await this.captureSelectionShot(sel.element);
        if (this.selected === sel) this.selected.shotDataUrl = shot;
      }
    }

    let imagePath: string | null = null;
    if (shot) {
      try {
        const raw = shot.includes(",") ? shot.split(",")[1] : shot;
        imagePath = await api.savePastedImage(raw, "image/png");
      } catch {
        imagePath = null;
      }
    }

    const previewLabel = sel?.path || this.entryPath || "the current preview";
    const prompt = imagePath
      ? `In the preview (${previewLabel}), update the specific feature shown in the attached screenshot. It is the exact visual reference selected in Design mode; the temporary blue outline is not part of the page. Preserve surrounding behavior and make the requested change only to that feature.\n\nRequested change: ${text}`
      : sel?.visualTarget
        ? `In the live preview (${previewLabel}), apply this design change to the feature inside the selected visual box (about ${Math.round(sel.visualTarget.widthPercent)}% wide × ${Math.round(sel.visualTarget.heightPercent)}% high, beginning ${Math.round(sel.visualTarget.xPercent)}% from the left and ${Math.round(sel.visualTarget.yPercent)}% from the top). The live preview is isolated by the browser, so this box is a user-selected visual reference rather than a DOM selector. Inspect the relevant project files and running preview yourself, preserve surrounding behavior, and make the requested change only to that feature.\n\nRequested change: ${text}`
      : sel
        ? `In the preview (${previewLabel}), update the clicked <${sel.tag}>${sel.text ? ` (“${sel.text}”)` : ""} element.\n\nRequested change: ${text}`
        : `In the preview (${previewLabel}), apply this design change:\n\n${text}`;

    if (!this.onDescribe) {
      this.statusEl.textContent = "Preview actions are not available until chat is ready.";
      return;
    }
    const dispatch = this.onDescribe(prompt, imagePath) || "sent";
    this.statusEl.textContent =
      dispatch === "queued"
        ? "Design change queued — it will start after the active task finishes."
        : dispatch === "needs_project"
          ? "Open or create a project before sending a design change."
          : dispatch === "usage_exhausted"
            ? "No usage remains for this design change."
            : dispatch === "stopping"
              ? "The current task is stopping — ask again after it ends."
              : imagePath
                ? "Design change + screenshot sent to the active model."
                : sel?.visualTarget
                  ? "Selected feature reference sent to the active model."
                  : "Design change sent to the active model.";
  }
}
