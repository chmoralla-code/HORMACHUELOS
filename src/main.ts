import { api, onAgentEvent, onComputerUseFx, onComputerUseStatus, type AgentEvent } from "./ipc";
import { Sidebar } from "./components/sidebar";
import { Chat } from "./components/chat";
import { ConsolePanel } from "./components/console";
import { SettingsModal, displayModelName, displayProviderName, getProviderMeta, getSettingsSafe } from "./components/settings";
import { ModelBar } from "./components/modelbar";
import { ProjectPicker } from "./components/picker";
import { WorkspacePanel } from "./components/workspace";
import { SitePreview, isPreviewableBuild, pickPreviewEntry } from "./components/site-preview";
import { mountComputerUseHud, updateComputerUseHud, clearComputerUseHud } from "./components/computer-use-hud";
import { ensureWebsiteSession, fetchWebsiteAccount, showAuthGate, type WebsiteAccount } from "./components/auth-gate";
import { checkDesktopUpdate, showUpdateGate } from "./components/update-gate";
import { basename, clear, div, el, speakDoneWorking } from "./components/util";
import {
  loadSessions, saveSession, scheduleSessionSave, flushSessionSaves,
  deleteSession, deleteAllSessions, newSessionId, sessionTitle,
  recordAgentEvent, buildLlmHistory, redactChatCredentials, addSessionTokens, SESSION_TOKEN_BUDGET,
  type Session,
} from "./components/session";
import { icon, logo } from "./components/icons";

let sidebar: Sidebar;
let chat: Chat;
let consolePanel: ConsolePanel;
let settingsModal: SettingsModal;
let modelBar: ModelBar;
let workspacePanel: WorkspacePanel;
let sitePreview: SitePreview;
let currentProjectPath: string | null = null;
let sessions: Session[] = [];
let activeSessionId: string | null = null;
/** Session ids with an in-flight agent run (multiple can run at once). */
const runningSessions = new Set<string>();
/** Files created/edited during a run — used to auto-open the build preview. */
const runTouchedFiles = new Map<string, Set<string>>();
/** Snapshot of project files at run start (relative paths). */
const runBaselineFiles = new Map<string, Set<string>>();
/** Sessions that already auto-opened preview this run (avoid double open on done+end). */
const previewOpenedForRun = new Set<string>();
/** Pending tool approvals while a session may be in the background. */
const pendingConfirms = new Map<
  string,
  { id: string; name: string; summary: string; arguments: any }
>();

function normalizeToolName(name: string): string {
  return (name || "")
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[\s.-]+/g, "_")
    .toLowerCase();
}

const PREVIEW_WRITE_TOOLS = new Set([
  "write_file",
  "write",
  "writefile",
  "edit_file",
  "edit",
  "strreplace",
  "str_replace",
  "apply_patch",
  "applypatch",
  "copy_file",
  "copy",
  "move_file",
  "move",
  "download_file",
  "download",
  "shell",
  "bash",
  "run_command",
  "run_terminal_cmd",
  "shelltool",
  "terminal",
]);

const PREVIEW_OPEN_TOOLS = new Set([
  "open_path",
  "openpath",
  "open_url",
  "openurl",
  "open_file",
  "openfile",
]);

function toProjectRelPath(path: string): string {
  let p = path.replace(/\\/g, "/").trim();
  if (/^file:\/\//i.test(p)) {
    p = decodeURIComponent(p.replace(/^file:\/\/\/?/i, ""));
    if (/^[a-zA-Z]:/.test(p) === false && /^[a-zA-Z]%3A/i.test(path)) {
      /* keep decoded */
    }
  }
  const root = currentProjectPath?.replace(/\\/g, "/").replace(/\/$/, "");
  if (root && p.toLowerCase().startsWith(root.toLowerCase() + "/")) {
    return p.slice(root.length + 1);
  }
  return p.replace(/^\.\//, "");
}

function walkProjectFiles(nodes: { path: string; isDir: boolean; children?: any[] }[], out: string[] = []): string[] {
  for (const n of nodes || []) {
    if (n.isDir) walkProjectFiles(n.children || [], out);
    else out.push(String(n.path).replace(/\\/g, "/"));
  }
  return out;
}

async function snapshotProjectFiles(): Promise<Set<string>> {
  try {
    const tree = await api.listProjectFiles(16);
    return new Set(walkProjectFiles(tree.nodes || []));
  } catch {
    return new Set();
  }
}

function trackRunTouchedFile(sessionId: string | undefined, name: string, args: Record<string, unknown> | undefined) {
  if (!sessionId || !args) return;
  const tool = normalizeToolName(name);
  if (!PREVIEW_WRITE_TOOLS.has(tool)) return;
  const keys = ["path", "file_path", "target", "dst", "destination", "src", "source", "filename"];
  let bucket = runTouchedFiles.get(sessionId);
  if (!bucket) {
    bucket = new Set();
    runTouchedFiles.set(sessionId, bucket);
  }
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      bucket.add(toProjectRelPath(value));
    }
  }
  // Shell-ish tools sometimes pass a command string containing an .html path
  const blob = JSON.stringify(args);
  for (const m of blob.matchAll(/[A-Za-z0-9_./\\-]+\.(?:html?|css|js|mjs|tsx?|jsx|apk|exe)/gi)) {
    bucket.add(toProjectRelPath(m[0]));
  }
}

function htmlPathFromOpenArgs(name: string, args: Record<string, unknown> | undefined): string | null {
  if (!args) return null;
  const tool = normalizeToolName(name);
  if (!PREVIEW_OPEN_TOOLS.has(tool)) return null;
  const raw =
    (typeof args.path === "string" && args.path) ||
    (typeof args.file_path === "string" && args.file_path) ||
    (typeof args.url === "string" && args.url) ||
    "";
  if (!raw) return null;
  const rel = toProjectRelPath(raw.replace(/^file:\/\/\/?/i, ""));
  if (/\.html?$/i.test(rel) || /\.html?$/i.test(raw)) return rel;
  return null;
}

async function openBuildPreview(opts: {
  entryPath?: string | null;
  files?: string[];
  title?: string;
  sessionId?: string;
}) {
  if (!currentProjectPath || !sitePreview) return;
  if (opts.sessionId) {
    if (previewOpenedForRun.has(opts.sessionId) && sitePreview.isOpen) return;
    previewOpenedForRun.add(opts.sessionId);
  }
  let files = opts.files || [];
  if (!files.length) {
    files = [...(await snapshotProjectFiles())];
  }
  const entry = opts.entryPath || pickPreviewEntry(files);
  await sitePreview.open({
    projectRoot: currentProjectPath,
    files,
    entryPath: entry,
    title: opts.title || "Build preview",
  });
}

async function maybeOpenBuildPreview(sessionId: string | undefined, reason: string) {
  if (!sessionId || reason === "cancelled" || !currentProjectPath) return;
  if (previewOpenedForRun.has(sessionId) && sitePreview?.isOpen) {
    runTouchedFiles.delete(sessionId);
    runBaselineFiles.delete(sessionId);
    return;
  }

  const touched = [...(runTouchedFiles.get(sessionId) || [])];
  const baseline = runBaselineFiles.get(sessionId);
  runTouchedFiles.delete(sessionId);
  runBaselineFiles.delete(sessionId);

  const now = await snapshotProjectFiles();
  const added = baseline
    ? [...now].filter((f) => !baseline.has(f))
    : [];
  const candidates = [...new Set([...touched, ...added])];

  // Prefer HTML written/added this run; fall back to any previewable touch
  const htmlEntry = pickPreviewEntry(candidates) || pickPreviewEntry([...now]);
  const shouldOpen =
    !!pickPreviewEntry(candidates) ||
    isPreviewableBuild(candidates) ||
    (touched.length > 0 && !!htmlEntry && candidates.some((f) => /\.(html?|css|js|mjs|tsx?|jsx)$/i.test(f)));

  if (!shouldOpen && !pickPreviewEntry(candidates)) return;

  await openBuildPreview({
    sessionId,
    files: [...now],
    entryPath: pickPreviewEntry(candidates) || htmlEntry,
    title: "Build preview",
  });
}

function refreshSidebar() {
  sidebar.render(sessions, activeSessionId, runningSessions).catch((e) => console.error("sidebar render failed", e));
}

function updateGlobalRunStatus() {
  const n = runningSessions.size;
  if (n === 0) sidebar.setStatus("Ready", false);
  else if (n === 1) sidebar.setStatus("Running", true);
  else sidebar.setStatus(`${n} runs`, true);
}

function persistCurrentSession(deferred = false) {
  if (!activeSessionId || !currentProjectPath) return;
  const s = sessions.find((x) => x.id === activeSessionId);
  if (!s) return;
  s.messages = chat.getMessages();
  if (deferred) scheduleSessionSave(s);
  else saveSession(s);
}

/** Tokens already used across all sessions in this project. */
/** Active subscription token budget + burn (account-wide via license.json). */
let activeTokenBudget = SESSION_TOKEN_BUDGET;
let accountTokensUsed = 0;
/** "" | "plan" | "4h" | "week" */
let usageBlockedBy = "";
/** Dev bypass — usage limits disabled in debug builds. */
let usageLimitsDisabled = false;
let planExpiresAt = "";
let planName = "";
let planActive = false;

function remainingPct(used: number, budget: number): number {
  if (budget <= 0) return 100;
  const remaining = Math.max(0, budget - used);
  return Math.max(0, Math.min(100, Math.round((remaining / budget) * 100)));
}

function applyLicenseSnapshot(lic: {
  plan?: string;
  active?: boolean;
  expiresAt?: string;
  tokenBudget?: number;
  tokensUsed?: number;
  blockedBy?: string;
  limitsDisabled?: boolean;
}) {
  activeTokenBudget = Math.max(1, Math.floor(Number(lic.tokenBudget) || SESSION_TOKEN_BUDGET));
  accountTokensUsed = Math.max(0, Math.floor(Number(lic.tokensUsed) || 0));
  usageLimitsDisabled = lic.limitsDisabled === true;
  usageBlockedBy = usageLimitsDisabled ? "" : String(lic.blockedBy || "");
  planExpiresAt = String(lic.expiresAt || "");
  planName = String(lic.plan || "free");
  planActive = lic.active !== false && planName.toLowerCase() !== "free";
}

async function refreshLicenseBudget() {
  try {
    const lic = await api.getLicenseStatus();
    applyLicenseSnapshot(lic);
  } catch {
    activeTokenBudget = SESSION_TOKEN_BUDGET;
  }
}

/** Serialize license refreshes so concurrent session usage events never apply out of order. */
let licenseSyncTail: Promise<void> = Promise.resolve();

function enqueueLicenseSync(opts: { haltIfExhausted?: boolean } = {}) {
  const haltIfExhausted = opts.haltIfExhausted !== false;
  licenseSyncTail = licenseSyncTail
    .then(async () => {
      await refreshLicenseBudget();
      syncUsageBar();
      if (haltIfExhausted && isUsageExhausted()) haltRunsForUsageLimit();
    })
    .catch((err) => console.warn("license sync failed", err));
  return licenseSyncTail;
}

/** Remaining capacity 0–100% for the plan period pool. */
function usageRemainingPercent(): number {
  return remainingPct(accountTokensUsed, activeTokenBudget);
}

/** True when plan period budget is exhausted. */
function isUsageExhausted(): boolean {
  if (usageLimitsDisabled) return false;
  if (usageBlockedBy) return true;
  return usageRemainingPercent() <= 0;
}

function usageBlockMessage(): string {
  return "You've used up this plan period. Mag-load via GCash or upgrade to continue.";
}

/** Sync left-drawer usage from the active hosted plan. */
function syncUsageBar(_session?: Session | null) {
  const pct = remainingPct(accountTokensUsed, activeTokenBudget);
  sidebar?.setSessionUsage(accountTokensUsed, activeTokenBudget, {
    percent: pct,
    poolLabel: "plan",
    resetsIn: "",
    blockedBy: usageLimitsDisabled ? "" : usageBlockedBy || (pct <= 0 && planActive ? "plan" : ""),
    planRemaining: pct,
    planExpiresAt,
    planName,
    planActive,
    tokensUsed: accountTokensUsed,
    tokenBudget: activeTokenBudget,
  });
  if (chat) {
    chat.setUsageExhausted(isUsageExhausted(), usageBlockMessage());
  }
}

/** Prefer live website license usage (source of truth for bought plans). */
function applyWebsitePlanUsage(user: WebsiteAccount) {
  const plan = String(user.plan || "free");
  const active = user.licenseActive === true && !["free", "expired", ""].includes(plan.toLowerCase());
  const budget = Math.max(0, Math.floor(Number(user.tokenBudget) || 0));
  const used = Math.max(0, Math.floor(Number(user.tokensUsed) || 0));
  planName = plan || "free";
  planActive = active;
  planExpiresAt = String(user.expiresAt || "");
  if (active && budget > 0) {
    activeTokenBudget = budget;
    accountTokensUsed = used;
    usageBlockedBy = used >= budget ? "plan" : "";
  } else if (!active) {
    activeTokenBudget = SESSION_TOKEN_BUDGET;
    accountTokensUsed = 0;
    usageBlockedBy = plan.toLowerCase() === "expired" ? "plan" : "";
  }
  syncUsageBar();
}

/** Stop every in-flight run + clear queues the moment usage hits 0%. */
function haltRunsForUsageLimit() {
  if (!isUsageExhausted()) return;
  chat?.clearPendingQueue();
  const ids = [...runningSessions];
  for (const id of ids) {
    api.agentStop(id).catch(() => {});
  }
  if (ids.length > 0) {
    reportError(usageBlockMessage());
  }
  syncUsageBar();
  updateGlobalRunStatus();
  refreshSidebar();
}

/**
 * Usage event from agent/bridge. Rust already persisted tokens — prefer the
 * embedded license snapshot (fresh after the write) so parallel sessions stay
 * accurate; otherwise reconcile from disk in order.
 */
function applyUsageToSession(
  sessionId: string,
  payload: {
    turn_tokens?: number;
    total_tokens?: number;
    iteration?: number;
    license?: {
      plan?: string;
      active?: boolean;
      expiresAt?: string;
      tokenBudget?: number;
      tokensUsed?: number;
      blockedBy?: string;
      limitsDisabled?: boolean;
    } | null;
  },
) {
  const s = sessions.find((x) => x.id === sessionId);
  const add = Math.max(0, Math.floor(payload.turn_tokens ?? 0));
  if (s && add > 0) {
    addSessionTokens(s, add);
    saveSession(s);
  }
  if (payload.license && typeof payload.license === "object") {
    applyLicenseSnapshot(payload.license);
    syncUsageBar();
    if (isUsageExhausted()) haltRunsForUsageLimit();
    return;
  }
  void enqueueLicenseSync({ haltIfExhausted: true });
}

function persistSessionById(id: string, deferred = false) {
  const s = sessions.find((x) => x.id === id);
  if (!s || !currentProjectPath) return;
  if (id === activeSessionId) {
    s.messages = chat.getMessages();
  }
  if (deferred) scheduleSessionSave(s);
  else saveSession(s);
}

function createNewSession() {
  if (!currentProjectPath) {
    openNewProjectPicker();
    return;
  }
  // Other sessions may keep running in the background
  persistCurrentSession();
  const s: Session = {
    id: newSessionId(),
    title: "New session",
    projectId: currentProjectPath,
    messages: [],
    createdAt: Date.now(),
    sessionTokens: 0,
  };
  sessions.unshift(s);
  activeSessionId = s.id;
  chat.startSession("");
  // Clear the empty user message that startSession pushes for a blank session
  chat.messages = [];
  chat.renderEmpty();
  chat.setRunning(false);
  saveSession(s);
  // Shared project budget — do not reset when opening another session
  refreshSidebar();
  syncUsageBar();
  updateGlobalRunStatus();
}

function switchSession(id: string) {
  if (id === activeSessionId) return;
  const s = sessions.find((x) => x.id === id);
  if (!s) return;
  // Keep background runs alive — just switch the visible transcript
  persistCurrentSession();
  activeSessionId = id;
  if (s.messages.length === 0) {
    chat.messages = [];
    chat.renderEmpty();
  } else {
    chat.loadSession(s.messages);
  }
  chat.setRunning(runningSessions.has(id));
  // Restore a tool-approval prompt if this run is waiting in the background
  const conf = pendingConfirms.get(id);
  if (conf) {
    chat.showToolConfirm(conf.id, conf.name, conf.summary);
  }
  refreshSidebar();
  syncUsageBar();
  updateGlobalRunStatus();
}

function renameSession(id: string, title: string) {
  const name = title.trim().replace(/\s+/g, " ");
  if (!name) return;
  const s = sessions.find((x) => x.id === id);
  if (!s || s.title === name) {
    refreshSidebar();
    return;
  }
  s.title = name.length > 80 ? name.slice(0, 80) : name;
  saveSession(s);
  refreshSidebar();
}

function removeSession(id: string) {
  // Stop this session's run if active; other sessions keep running
  if (runningSessions.has(id)) {
    api.agentStop(id).catch(() => {});
    runningSessions.delete(id);
  }
  deleteSession(id);
  sessions = sessions.filter((s) => s.id !== id);
  if (activeSessionId === id) {
    activeSessionId = null;
    if (sessions.length > 0) {
      switchSession(sessions[0].id);
    } else {
      chat.messages = [];
      chat.renderEmpty();
      chat.setRunning(false);
      refreshSidebar();
    }
  } else {
    refreshSidebar();
  }
  updateGlobalRunStatus();
}
function removeAllSessions() {
  if (sessions.length === 0) return;
  const count = sessions.length;
  const root = document.getElementById("modal-root");
  if (!root) {
    // Fallback if modal host is missing
    if (!window.confirm(`Delete all ${count} session${count === 1 ? "" : "s"}? This cannot be undone.`)) return;
    doRemoveAllSessions();
    return;
  }

  clear(root);
  const overlay = el("div", { class: "modal-overlay" });
  const modal = el("div", {
    class: "modal confirm-modal",
    role: "alertdialog",
    "aria-modal": "true",
    "aria-labelledby": "delete-all-title",
    "aria-describedby": "delete-all-desc",
  });

  const head = el("div", { class: "modal-head" });
  head.appendChild(el("div", { class: "modal-title", id: "delete-all-title" }, ["Delete all sessions?"]));
  const closeBtn = el("button", {
    class: "modal-close",
    type: "button",
    "aria-label": "Cancel",
    html: icon("close", 16),
  }) as HTMLButtonElement;
  head.appendChild(closeBtn);
  modal.appendChild(head);

  const body = el("div", { class: "modal-body" });
  body.appendChild(
    el("p", { class: "confirm-modal-desc", id: "delete-all-desc" }, [
      `This will permanently delete ${count} session${count === 1 ? "" : "s"}. Usage remaining will stay as it is. This cannot be undone.`,
    ]),
  );
  modal.appendChild(body);

  const foot = el("div", { class: "modal-foot" });
  const cancelBtn = el("button", { class: "btn", type: "button" }, ["Cancel"]) as HTMLButtonElement;
  const deleteBtn = el("button", { class: "btn danger", type: "button" }, ["Delete all"]) as HTMLButtonElement;
  foot.appendChild(cancelBtn);
  foot.appendChild(deleteBtn);
  modal.appendChild(foot);

  const close = () => clear(root);
  closeBtn.addEventListener("click", close);
  cancelBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  deleteBtn.addEventListener("click", () => {
    close();
    doRemoveAllSessions();
  });

  overlay.appendChild(modal);
  root.appendChild(overlay);
  deleteBtn.focus();
}

function doRemoveAllSessions() {
  if (sessions.length === 0) return;
  // Stop every concurrent run
  for (const id of [...runningSessions]) {
    api.agentStop(id).catch(() => {});
  }
  runningSessions.clear();
  deleteAllSessions(currentProjectPath!);
  // Keep project token usage — do not reset the meter to 100%
  sessions = [];
  activeSessionId = null;
  chat.messages = [];
  chat.renderEmpty();
  chat.setRunning(false);
  refreshSidebar();
  syncUsageBar();
  updateGlobalRunStatus();
}


function loadProjectSessions() {
  if (!currentProjectPath) {
    sessions = [];
    activeSessionId = null;
    syncUsageBar();
    return;
  }
  sessions = loadSessions(currentProjectPath);
  if (sessions.length > 0) {
    activeSessionId = sessions[0].id;
    if (sessions[0].messages.length > 0) {
      chat.loadSession(sessions[0].messages);
    } else {
      chat.messages = [];
      chat.renderEmpty();
    }
  } else {
    activeSessionId = null;
    chat.messages = [];
    chat.renderEmpty();
  }
  // Shared budget across every session in this project
  syncUsageBar();
}

function showFatalError(msg: string) {
  const app = document.getElementById("app");
  if (!app) return;
  app.innerHTML = "";
  app.style.cssText = "display:flex;align-items:center;justify-content:center;height:100vh;width:100vw;background:#0a0a0a;color:#fafafa;font-family:monospace;font-size:13px;padding:40px;text-align:center;white-space:pre-wrap;";
  app.textContent = "Hormachuelos failed to start.\n\n" + msg + "\n\nCheck DevTools (F12) for details.";
}

// Non-destructive error banner — logs the error and shows a small notice
// in the corner. Use this for runtime errors so the UI stays usable.
function reportError(msg: string) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = msg;
  toast.hidden = false;
  window.setTimeout(() => { toast.hidden = true; }, 6000);
}

// Only wipe the UI for the rare *boot* error (no DOM yet, nothing to lose).
window.addEventListener("error", (e) => {
  const app = document.getElementById("app");
  if (app && app.children.length > 0) {
    console.error("runtime error:", e.message || e.error);
    reportError(e.message || String(e.error));
  } else {
    showFatalError(e.message || String(e.error));
  }
});

window.addEventListener("unhandledrejection", (e) => {
  const app = document.getElementById("app");
  if (app && app.children.length > 0) {
    console.error("unhandled rejection:", e.reason);
    reportError(e.reason?.message || String(e.reason));
    e.preventDefault();
  } else {
    showFatalError(e.reason?.message || String(e.reason));
  }
});

const LEFT_DRAWER_KEY = "ai-forge:left-drawer-open";
const RIGHT_DRAWER_KEY = "ai-forge:right-drawer-open";

function isDrawerOpen(key: string, fallback = true): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return fallback;
    return v === "1";
  } catch {
    return fallback;
  }
}

function setDrawerOpen(key: string, open: boolean) {
  try {
    localStorage.setItem(key, open ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/** Apply left/right drawer open state to #app classes. */
function applyDrawers() {
  const app = document.getElementById("app");
  if (!app) return;
  const leftOpen = isDrawerOpen(LEFT_DRAWER_KEY, true);
  const rightOpen = isDrawerOpen(RIGHT_DRAWER_KEY, true);
  app.classList.toggle("left-drawer-closed", !leftOpen);
  app.classList.toggle("right-drawer-closed", !rightOpen);
  // Legacy class cleanup
  app.classList.remove("drawer-closed");
}

function toggleLeftDrawer() {
  const open = !isDrawerOpen(LEFT_DRAWER_KEY, true);
  setDrawerOpen(LEFT_DRAWER_KEY, open);
  applyDrawers();
  syncDrawerButtons();
}

function toggleRightDrawer() {
  const open = !isDrawerOpen(RIGHT_DRAWER_KEY, true);
  setDrawerOpen(RIGHT_DRAWER_KEY, open);
  applyDrawers();
  syncDrawerButtons();
}

function syncDrawerButtons() {
  const leftOpen = isDrawerOpen(LEFT_DRAWER_KEY, true);
  const rightOpen = isDrawerOpen(RIGHT_DRAWER_KEY, true);
  const leftBtn = document.getElementById("drawer-left-btn");
  const rightBtn = document.getElementById("drawer-right-btn");
  if (leftBtn) {
    leftBtn.classList.toggle("active", leftOpen);
    leftBtn.setAttribute("aria-pressed", String(leftOpen));
    leftBtn.setAttribute("title", leftOpen ? "Hide left panel" : "Show left panel");
    leftBtn.setAttribute("aria-label", leftOpen ? "Hide left panel" : "Show left panel");
  }
  if (rightBtn) {
    rightBtn.classList.toggle("active", rightOpen);
    rightBtn.setAttribute("aria-pressed", String(rightOpen));
    rightBtn.setAttribute("title", rightOpen ? "Hide right panel" : "Show right panel");
    rightBtn.setAttribute("aria-label", rightOpen ? "Hide right panel" : "Show right panel");
  }
}

/** Wire permanent sandwich buttons once (they live in index.html). */
function bindDrawerButtons() {
  const leftBtn = document.getElementById("drawer-left-btn");
  const rightBtn = document.getElementById("drawer-right-btn");
  if (leftBtn && !(leftBtn as any).__bound) {
    leftBtn.addEventListener("click", () => toggleLeftDrawer());
    (leftBtn as any).__bound = true;
  }
  if (rightBtn && !(rightBtn as any).__bound) {
    rightBtn.addEventListener("click", () => toggleRightDrawer());
    (rightBtn as any).__bound = true;
  }
  applyDrawers();
  syncDrawerButtons();
}

async function refreshHeader() {
  // Project name/path is only in the left sandwich drawer — not in the top header
  const actionsEl = document.getElementById("header-actions");
  if (!actionsEl) return;

  sidebar?.setProject(currentProjectPath);
  chat?.setComposerProject(currentProjectPath);

  clear(actionsEl);
  try {
    const s = await getSettingsSafe();
    const meta = getProviderMeta(s.provider);
    const chip = el("span", { class: "chip" });
    const label = `${displayProviderName(s.provider)} · ${displayModelName(s.model)}`;
    if (meta) {
      chip.innerHTML = logo(meta.logoKey, 13) + `<span style="margin-left:2px">${label}</span>`;
    } else {
      chip.textContent = label;
    }
    actionsEl.appendChild(chip);
  } catch (e) {
    console.error("refreshHeader: getSettings failed", e);
  }
  const explorerBtn = el("button", {
    class: "btn sm",
    title: "Reveal project in Explorer",
    "aria-label": "Reveal project in Explorer",
    html: icon("folder", 12),
  });
  explorerBtn.disabled = !currentProjectPath;
  explorerBtn.addEventListener("click", () => {
    if (currentProjectPath) api.openProjectInExplorer();
  });
  actionsEl.appendChild(explorerBtn);

  const previewBtn = el("button", {
    class: "btn sm",
    title: "Open build preview",
    "aria-label": "Open build preview",
  }, ["Preview"]);
  previewBtn.disabled = !currentProjectPath;
  previewBtn.addEventListener("click", () => {
    if (!currentProjectPath) return;
    if (sitePreview?.isOpen) sitePreview.close();
    else void openBuildPreview({ title: "Build preview" });
  });
  actionsEl.appendChild(previewBtn);

  bindDrawerButtons();
}

async function selectProject(path: string) {
  if (!canChangeProject()) return;
  persistCurrentSession();
  flushSessionSaves();
  await api.setProjectRoot(path);
  currentProjectPath = path;
  loadProjectSessions();
  await sidebar.render(sessions, activeSessionId);
  chat.setProjectReady(true);
  await workspacePanel.setProject(path);
  await refreshHeader();
}

async function createProject(path: string, templateId?: string) {
  if (!canChangeProject()) return;
  persistCurrentSession();
  flushSessionSaves();
  await api.createProjectDir(path, templateId);
  currentProjectPath = path;
  sessions = [];
  activeSessionId = null;
  chat.messages = [];
  await sidebar.render(sessions, activeSessionId);
  chat.setProjectReady(true);
  await workspacePanel.setProject(path);
  await refreshHeader();
}

function canChangeProject(): boolean {
  if (runningSessions.size === 0) return true;
  const count = runningSessions.size;
  reportError(
    `Finish or stop the active run${count === 1 ? "" : "s"} before changing projects.`,
  );
  return false;
}

function openNewProjectPicker() {
  if (!canChangeProject()) return;
  const root = document.getElementById("modal-root")!;
  clear(root);
  const picker = new ProjectPicker(root, "new", async (path, templateId) => {
    clear(root);
    await createProject(path, templateId);
  }, () => clear(root));
  void picker.render();
}

function openOpenProjectPicker() {
  if (!canChangeProject()) return;
  const root = document.getElementById("modal-root")!;
  clear(root);
  const picker = new ProjectPicker(root, "open", async (path) => {
    clear(root);
    await selectProject(path);
  }, () => clear(root));
  void picker.render();
}

function openSettings(integrationId?: string) {
  settingsModal = new SettingsModal(async () => {
    await refreshHeader();
    await refreshProviderReadiness();
  }, integrationId);
  void settingsModal.open();
}

async function refreshProviderReadiness(): Promise<boolean> {
  const settings = await getSettingsSafe();
  const provider = getProviderMeta(settings.provider);
  let ready = !provider?.keyRequired;
  if (provider?.keyRequired) {
    ready = await api.hasApiKey(settings.provider).catch(() => false);
  }
  chat?.setProviderReady(ready, displayProviderName(settings.provider));
  return ready;
}

async function openGCashTopUp() {
  try {
    const lic = await api.getLicenseStatus();
    window.open(lic.topUpUrl || "https://hormachuelos.com/#/pricing", "_blank", "noopener");
  } catch {
    window.open("https://hormachuelos.com/#/pricing", "_blank", "noopener");
  }
}

async function exportClientPack() {
  if (!currentProjectPath) {
    reportError("Open or create a project before exporting a client pack.");
    openNewProjectPicker();
    return;
  }
  try {
    const result = await api.exportClientPack();
    reportError(`Client pack saved: ${result.zipPath} (${result.filesCount} files)`);
  } catch (e) {
    reportError("Client pack failed: " + String(e));
  }
}

async function sendPrompt(prompt: string) {
  if (!currentProjectPath) {
    reportError("Open or create a project before starting.");
    openNewProjectPicker();
    return;
  }
  if (!(await refreshProviderReadiness())) {
    reportError("Connect the selected provider in Settings before sending a request.");
    openSettings();
    return;
  }
  if (isUsageExhausted()) {
    reportError(usageBlockMessage());
    syncUsageBar();
    return;
  }
  // Backend still holds this session until agent_run returns — never double-start.
  // Chat UI queues follow-ups; drain happens only after the IPC fully completes.
  if (activeSessionId && runningSessions.has(activeSessionId)) {
    return;
  }
  // A credential accidentally entered in chat must never reach local history,
  // model prompts, tool arguments, or results. The replacement keeps enough
  // intent for the backend to open the secure integration form.
  prompt = redactChatCredentials(prompt);

  let existing = activeSessionId ? sessions.find((x) => x.id === activeSessionId) : null;
  const hasMessages = existing && existing.messages.length > 0;

  if (!existing || !hasMessages) {
    // Fresh session — create one and start clean
    if (existing) {
      existing.title = sessionTitle(prompt);
    } else {
      const s: Session = {
        id: newSessionId(),
        title: sessionTitle(prompt),
        projectId: currentProjectPath,
        messages: [],
        createdAt: Date.now(),
        sessionTokens: 0,
      };
      sessions.unshift(s);
      activeSessionId = s.id;
      existing = s;
    }
    chat.startSession(prompt);
  } else {
    // Continuing an existing conversation — append, don't clear
    chat.continueSession(prompt);
  }

  const sessionId = activeSessionId!;
  // Maximize memory: send prior turns in this session (user, AI, tools, decisions)
  const history = buildLlmHistory(chat.getMessages(), prompt);
  runningSessions.add(sessionId);
  runTouchedFiles.set(sessionId, new Set());
  previewOpenedForRun.delete(sessionId);
  void snapshotProjectFiles().then((snap) => runBaselineFiles.set(sessionId, snap));
  // Only touch workspace/console UI for the active view
  await workspacePanel.beginRun();
  chat.setRunning(true);
  updateGlobalRunStatus();
  // Shared project budget — continues across all sessions
  syncUsageBar();
  refreshSidebar();
  try {
    await api.agentRun(prompt, sessionId, history);
  } catch (e: any) {
    const msg = String(e ?? "");
    // Don't dump "already running" into the transcript — queue handles that path
    const isBusy =
      /already running/i.test(msg) || /wait for it to finish/i.test(msg);
    if (!isBusy) {
      if (activeSessionId === sessionId) {
        chat.appendAssistantText(`Error: ${e}`);
        chat.appendEnd("no_tool_calls");
      } else {
        const s = sessions.find((x) => x.id === sessionId);
        if (s) {
          recordAgentEvent(s.messages, { kind: "text", payload: { text: `Error: ${e}` } });
          recordAgentEvent(s.messages, { kind: "end", payload: { reason: "no_tool_calls" } });
          saveSession(s);
        }
      }
      reportError(msg);
    }
  } finally {
    // Only drop the busy flag here — after backend finish_run. Early deletes on
    // cancelled/done events race a follow-up send ("session already running").
    runningSessions.delete(sessionId);
    const allowQueue = !isUsageExhausted();
    if (!allowQueue) {
      chat.clearPendingQueue();
    }
    if (activeSessionId === sessionId) {
      await workspacePanel.finishRun();
      // Never auto-start queued prompts once usage is at 0%
      chat.setRunning(false, { processQueue: allowQueue });
      persistCurrentSession();
    } else {
      persistSessionById(sessionId);
      if (!runningSessions.has(activeSessionId || "")) {
        chat.setRunning(false, { processQueue: allowQueue });
      }
    }
    if (isUsageExhausted()) {
      haltRunsForUsageLimit();
    }
    updateGlobalRunStatus();
    syncUsageBar();
    refreshSidebar();
  }
}

function handleAgentEvent(e: AgentEvent) {
  const sid = e.session_id;
  const isActive = !!sid && sid === activeSessionId;

  // UI-only secure handoff. Inline chat form — never persist credentials to transcript.
  if (e.kind === "integration_auth") {
    if (isActive) {
      void chat.showIntegrationAuth(e.payload.service, e.payload.secure_entry);
    }
    return;
  }

  // Track approval prompts for every session (active or background)
  if (e.kind === "tool_confirm" && sid) {
    pendingConfirms.set(sid, {
      id: e.payload.id,
      name: e.payload.name,
      summary: e.payload.summary,
      arguments: e.payload.arguments,
    });
  }
  if ((e.kind === "tool_result" || e.kind === "done" || e.kind === "end" || e.kind === "cancelled") && sid) {
    pendingConfirms.delete(sid);
  }

  // Background session: only update stored transcript (run continues)
  if (sid && !isActive) {
    if (e.kind === "usage") {
      applyUsageToSession(sid, e.payload);
      return;
    }
    // Skip UI-only streams
    if (e.kind === "console_chunk" || e.kind === "tool_confirm") {
      return;
    }
    if (e.kind === "tool_call") {
      trackRunTouchedFile(sid, e.payload.name, e.payload.arguments);
      const htmlOpen = htmlPathFromOpenArgs(e.payload.name, e.payload.arguments);
      if (htmlOpen) {
        void openBuildPreview({
          sessionId: sid,
          entryPath: htmlOpen,
          title: "Build preview",
        });
      }
    }
    const s = sessions.find((x) => x.id === sid);
    if (s) {
      recordAgentEvent(s.messages, e);
      if (
        e.kind === "text" ||
        e.kind === "tool_result" ||
        e.kind === "done" ||
        e.kind === "end" ||
        e.kind === "cancelled" ||
        e.kind === "reasoning" ||
        e.kind === "thinking" ||
        e.kind === "tool_call" ||
        e.kind === "question"
      ) {
        if (e.kind === "text" || e.kind === "reasoning") {
          scheduleSessionSave(s);
        } else {
          saveSession(s);
        }
      }
    }
    // Background run end events: do NOT remove from runningSessions here.
    // sendPrompt's finally owns that set (avoids "already running" races).
    if (e.kind === "done" || e.kind === "end" || e.kind === "cancelled") {
      speakDoneWorking();
      updateGlobalRunStatus();
      refreshSidebar();
      void maybeOpenBuildPreview(sid, e.kind);
    }
    return;
  }

  // Active session — live UI
  if (e.kind === "console_chunk") {
    consolePanel.handleConsoleChunk(e.payload.stream, e.payload.text);
    return;
  }
  if (e.kind === "usage") {
    if (sid) applyUsageToSession(sid, e.payload);
    return;
  }

  chat.handleEvent(e);
  workspacePanel.handleAgentEvent(e);
  if (e.kind === "tool_call") {
    trackRunTouchedFile(sid, e.payload.name, e.payload.arguments);
    const htmlOpen = htmlPathFromOpenArgs(e.payload.name, e.payload.arguments);
    if (htmlOpen) {
      void openBuildPreview({
        sessionId: sid || undefined,
        entryPath: htmlOpen,
        title: "Build preview",
      });
    }
    consolePanel.handleToolCall(e.payload.name, e.payload.arguments);
  } else if (e.kind === "tool_result") {
    consolePanel.handleToolResult(
      e.payload.name,
      e.payload.ok,
      e.payload.content,
      !!e.payload.streamed,
    );
  } else if (e.kind === "done" || e.kind === "end" || e.kind === "cancelled") {
    // Keep runningSessions + chat.running true until sendPrompt's agentRun
    // await finishes. Early setRunning(false) / runningSessions.delete races
    // the next send (backend still in start_run → "already running").
    // chat.handleEvent already cleared pending + marked userCancelled.
    speakDoneWorking();
    updateGlobalRunStatus();
    syncUsageBar();
    refreshSidebar();
    void maybeOpenBuildPreview(sid, e.kind);
  }
  // Persist session after meaningful events
  if (e.kind === "text" || e.kind === "tool_result" || e.kind === "done" || e.kind === "end" || e.kind === "cancelled" || e.kind === "reasoning") {
    persistCurrentSession(e.kind === "text" || e.kind === "reasoning");
  }
}

async function init() {
  // Sandwich buttons are in HTML — bind them and restore open/closed state first
  bindDrawerButtons();

  workspacePanel = new WorkspacePanel();
  consolePanel = new ConsolePanel();
  sitePreview = new SitePreview(document.getElementById("site-preview-slot"));
  sitePreview.setDescribeHandler((prompt) => {
    void sendPrompt(prompt);
  });
  chat = new Chat({
    onSend: sendPrompt,
    onStop: () => {
      if (activeSessionId) api.agentStop(activeSessionId).catch((e) => reportError(String(e)));
    },
    onNeedProject: openNewProjectPicker,
    onOpenProject: openOpenProjectPicker,
    onNewProject: openNewProjectPicker,
    onRevealProject: () => {
      if (currentProjectPath) api.openProjectInExplorer().catch((e) => reportError(String(e)));
    },
    getSessionId: () => activeSessionId,
    onOpenSettings: openSettings,
  });
  chat.setProjectReady(false);
  const HOSTED_SITE = "https://hormachuelos.vercel.app";
  let websiteUser: WebsiteAccount | null = null;

  async function syncHostedPlan(user: WebsiteAccount | null) {
    if (!user) return;
    applyWebsitePlanUsage(user);
    if (user.licenseKey) {
      try {
        const lic = await api.applyLicenseKey(user.licenseKey);
        applyLicenseSnapshot(lic);
        // Keep website counters if activate returned older/empty numbers.
        if (
          user.licenseActive &&
          Number(user.tokenBudget) > 0 &&
          (Number(lic.tokenBudget) || 0) > 0
        ) {
          applyWebsitePlanUsage({
            ...user,
            tokenBudget: Number(lic.tokenBudget) || user.tokenBudget,
            tokensUsed: Math.max(Number(lic.tokensUsed) || 0, Number(user.tokensUsed) || 0),
            plan: lic.plan || user.plan,
            licenseActive: lic.active,
            expiresAt: lic.expiresAt || user.expiresAt,
          });
        } else {
          syncUsageBar();
        }
      } catch (e) {
        console.warn("license sync from website account failed", e);
        syncUsageBar();
      }
    } else {
      syncUsageBar();
    }
  }

  async function refreshWebsiteAccountStatus(opts: { quiet?: boolean } = {}) {
    if (!opts.quiet) sidebar.setAccountStatus({ state: "checking" });
    const token = await api.getWebsiteSession().catch(() => null);
    if (!token) {
      websiteUser = null;
      sidebar.setAccountStatus({
        state: "signed_out",
        detail: "Sign in on hormachuelos.vercel.app",
      });
      return null;
    }
    try {
      const user = await fetchWebsiteAccount(token);
      websiteUser = user;
      sidebar.setAccountStatus({
        state: "synced",
        email: user.email,
        name: user.name,
        plan: user.plan,
      });
      await syncHostedPlan(user);
      return user;
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      const expired = /session|expired|unauthorized|401/i.test(msg);
      if (expired) {
        await api.clearWebsiteSession().catch(() => {});
        websiteUser = null;
        sidebar.setAccountStatus({
          state: "signed_out",
          detail: "Session expired — sign in again",
        });
        return null;
      }
      sidebar.setAccountStatus({
        state: "offline",
        detail: "Can't reach website — click to open",
      });
      return null;
    }
  }

  async function manageWebsiteAccount() {
    const current = await refreshWebsiteAccountStatus({ quiet: true });
    if (current) {
      void api.openExternalUrl(`${HOSTED_SITE}/#/`).catch(() => window.open(`${HOSTED_SITE}/#/`, "_blank"));
      return;
    }
    await new Promise<void>((resolve) => {
      const gate = showAuthGate((user) => {
        websiteUser = user;
        sidebar.setAccountStatus({
          state: "synced",
          email: user.email,
          name: user.name,
          plan: user.plan,
        });
        resolve();
      });
      document.body.appendChild(gate);
    });
    await syncHostedPlan(websiteUser);
  }

  sidebar = new Sidebar({
    onNewProject: openNewProjectPicker,
    onOpenProject: openOpenProjectPicker,
    onOpenSettings: openSettings,
    onNewSession: createNewSession,
    onSelectSession: switchSession,
    onDeleteSession: removeSession,
    onDeleteAllSessions: removeAllSessions,
    onRenameSession: renameSession,
    onExportClientPack: () => void exportClientPack(),
    onTopUp: () => void openGCashTopUp(),
    onManageAccount: () => void manageWebsiteAccount(),
    onRefreshAccount: () => void refreshWebsiteAccountStatus(),
  });
  await sidebar.render().catch((e) => console.error("sidebar render failed", e));
  await refreshHeader().catch((e) => console.error("refreshHeader failed", e));

  // Required app update (published from website Admin → Releases).
  try {
    const update = await checkDesktopUpdate();
    if (update.forceUpdate && update.latest) {
      document.body.appendChild(showUpdateGate(update));
      return;
    }
  } catch (e) {
    console.warn("update check failed", e);
  }

  // Website account required — desktop signs in automatically after browser login/signup.
  websiteUser = await ensureWebsiteSession().catch(() => null);
  if (!websiteUser) {
    sidebar.setAccountStatus({
      state: "signed_out",
      detail: "Sign in on hormachuelos.vercel.app",
    });
    await new Promise<void>((resolve) => {
      const gate = showAuthGate((user) => {
        websiteUser = user;
        resolve();
      });
      document.body.appendChild(gate);
    });
  }
  if (websiteUser) {
    sidebar.setAccountStatus({
      state: "synced",
      email: websiteUser.email,
      name: websiteUser.name,
      plan: websiteUser.plan,
    });
    applyWebsitePlanUsage(websiteUser);
  }
  await refreshWebsiteAccountStatus({ quiet: true }).catch(() => {});

  // OpenCode-style chips inside the composer card
  modelBar = new ModelBar(() => {
    refreshHeader().catch(() => {});
    void refreshProviderReadiness();
    const s = modelBar.settings;
    if (s) chat.setReplyProfile({ provider: s.provider, model: s.model, effort: s.model_effort });
  });
  await modelBar.load().catch((e) => console.error("modelbar load failed", e));
  await refreshProviderReadiness().catch(() => false);
  // Prefer website plan usage; fall back to local license.json if website had none.
  if (!planActive) {
    await refreshLicenseBudget().catch(() => {});
    syncUsageBar();
  }
  chat.attachComposerSide(modelBar.providerRail);
  if (modelBar.settings) {
    chat.setReplyProfile({
      provider: modelBar.settings.provider,
      model: modelBar.settings.model,
      effort: modelBar.settings.model_effort,
    });
  }
  window.addEventListener("horma:ultra-effort", () => {
    chat.applyUltraChrome();
  });
  window.addEventListener("horma:new-session", () => createNewSession());
  window.addEventListener("horma:composer-insert", ((e: CustomEvent<{ text?: string }>) => {
    const text = e.detail?.text;
    if (typeof text === "string" && text) chat.insertComposerText(text);
  }) as EventListener);
  window.addEventListener("horma:open-settings", ((e: CustomEvent<{ integrationId?: string }>) => {
    openSettings(e.detail?.integrationId);
  }) as EventListener);
  // New/renewed key already resets tokensUsed in license.json — just reload meter.
  window.addEventListener("horma:license-updated", () => {
    void enqueueLicenseSync({ haltIfExhausted: false });
  });
  window.addEventListener("beforeunload", flushSessionSaves);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSessionSaves();
  });

  // Restore last project if any
  try {
    const recent = await api.listRecentProjects();
    if (recent.length > 0) {
      await selectProject(recent[0]);
    }
  } catch (e) {
    console.error("restore recent project failed", e);
  }

  syncUsageBar();

  // Refresh license so plan expiry / usage stay in sync.
  window.setInterval(() => {
    void enqueueLicenseSync({ haltIfExhausted: true });
  }, 60_000);

  // Re-verify website account sync periodically.
  window.setInterval(() => {
    void refreshWebsiteAccountStatus({ quiet: true });
  }, 90_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void refreshWebsiteAccountStatus({ quiet: true });
    }
  });

  onAgentEvent(handleAgentEvent).catch((error) => console.warn("agent event bridge unavailable", error));

  mountComputerUseHud();
  onComputerUseFx((event) => {
    updateComputerUseHud(event);
    chat.handleComputerFx(event);
  }).catch((error) => console.warn("computer fx bridge unavailable", error));
  onComputerUseStatus((status) => {
    if (status.paused) clearComputerUseHud();
  }).catch((error) => console.warn("computer use status bridge unavailable", error));
}

init().catch((e) => console.error("init failed", e));
