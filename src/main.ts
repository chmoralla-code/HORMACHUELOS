import { api, onAgentEvent, onComputerUseFx, onComputerUseStatus, type AgentEvent } from "./ipc";
import { Sidebar } from "./components/sidebar";
import { Chat } from "./components/chat";
import { ConsolePanel } from "./components/console";
import { SettingsModal, displayModelName, displayProviderName, getProviderMeta, getSettingsSafe } from "./components/settings";
import { ModelBar } from "./components/modelbar";
import { ProjectPicker } from "./components/picker";
import { WorkspacePanel } from "./components/workspace";
import {
  SitePreview,
  isPreviewableBuild,
  mergePreviewSessionState,
  pickPreviewEntry,
} from "./components/site-preview";
import { mountComputerUseHud, updateComputerUseHud, clearComputerUseHud } from "./components/computer-use-hud";
import {
  ensureWebsiteSession,
  fetchWebsiteAccount,
  isWebsiteSessionRejected,
  showAuthGate,
  type WebsiteAccount,
} from "./components/auth-gate";
import {
  checkDesktopUpdate,
  restoreUpdateState,
  showUpdateDialog,
  showUpdateGate,
} from "./components/update-gate";
import { basename, clear, div, el, speakDoneWorking } from "./components/util";
import {
  activeProjectWorkspacePath,
  activateProjectWorkspace,
  listProjectWorkspaces,
  rememberRecentProjectWorkspaces,
} from "./components/projects";
import {
  loadSessions, saveSession, saveSessionForUpdate, scheduleSessionSave,
  flushSessionSaves, flushSessionSavesForUpdate,
  deleteSession, deleteAllSessions, newSessionId, sessionTitle,
  recordAgentEvent, buildLlmHistory, redactChatCredentials, addSessionTokens, SESSION_TOKEN_BUDGET,
  type Session,
} from "./components/session";
import { icon } from "./components/icons";

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
/** Loaded sessions remain addressable after switching to another project. */
const sessionRegistry = new Map<string, Session>();
/** Session ids with an in-flight agent run (multiple can run at once). */
const runningSessions = new Set<string>();
/** Exact provider/model profile captured when each in-flight run starts. */
const runModelProfiles = new Map<
  string,
  { provider: string; model: string; effort?: string }
>();
/** Each run keeps its original workspace even when the visible project changes. */
const runProjectPaths = new Map<string, string>();
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

function projectPathKey(path: string | null | undefined): string {
  return String(path || "")
    .trim()
    .replace(/[\\/]+$/, "")
    .toLocaleLowerCase();
}

function sameProjectPath(a: string | null | undefined, b: string | null | undefined): boolean {
  const aKey = projectPathKey(a);
  return !!aKey && aKey === projectPathKey(b);
}

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

function toProjectRelPath(path: string, projectRoot = currentProjectPath): string {
  let p = path.replace(/\\/g, "/").trim();
  if (/^file:\/\//i.test(p)) {
    p = decodeURIComponent(p.replace(/^file:\/\/\/?/i, ""));
    if (/^[a-zA-Z]:/.test(p) === false && /^[a-zA-Z]%3A/i.test(path)) {
      /* keep decoded */
    }
  }
  const root = projectRoot?.replace(/\\/g, "/").replace(/\/$/, "");
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

async function snapshotProjectFiles(projectRoot = currentProjectPath): Promise<Set<string>> {
  // The IPC file tree is rooted in the currently selected workspace. Do not
  // accidentally snapshot a second project after the user has switched views.
  if (!sameProjectPath(projectRoot, currentProjectPath)) return new Set();
  try {
    const tree = await api.listProjectFiles(16);
    return new Set(walkProjectFiles(tree.nodes || []));
  } catch {
    return new Set();
  }
}

function trackRunTouchedFile(sessionId: string | undefined, name: string, args: Record<string, unknown> | undefined) {
  if (!sessionId || !args) return;
  const projectRoot = runProjectPaths.get(sessionId) || currentProjectPath;
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
      bucket.add(toProjectRelPath(value, projectRoot));
    }
  }
  // Shell-ish tools sometimes pass a command string containing an .html path
  const blob = JSON.stringify(args);
  for (const m of blob.matchAll(/[A-Za-z0-9_./\\-]+\.(?:html?|css|js|mjs|tsx?|jsx|apk|exe)/gi)) {
    bucket.add(toProjectRelPath(m[0], projectRoot));
  }
}

function htmlPathFromOpenArgs(
  name: string,
  args: Record<string, unknown> | undefined,
  projectRoot = currentProjectPath,
): string | null {
  if (!args) return null;
  const tool = normalizeToolName(name);
  if (!PREVIEW_OPEN_TOOLS.has(tool)) return null;
  const raw =
    (typeof args.path === "string" && args.path) ||
    (typeof args.file_path === "string" && args.file_path) ||
    (typeof args.url === "string" && args.url) ||
    "";
  if (!raw) return null;
  const rel = toProjectRelPath(raw.replace(/^file:\/\/\/?/i, ""), projectRoot);
  if (/\.html?$/i.test(rel) || /\.html?$/i.test(raw)) return rel;
  return null;
}

async function openBuildPreview(opts: {
  entryPath?: string | null;
  files?: string[];
  title?: string;
  sessionId?: string;
  projectRoot?: string | null;
  /** When false, open a blank preview shell (no auto-picked HTML). Default true. */
  autoPickEntry?: boolean;
}) {
  if (!currentProjectPath || !sitePreview) return;
  if (opts.projectRoot && !sameProjectPath(opts.projectRoot, currentProjectPath)) return;
  const projectRoot = opts.projectRoot || currentProjectPath;
  const targetSessionId = opts.sessionId || activeSessionId || undefined;
  if (opts.sessionId) {
    const storedPreview = sessionForId(opts.sessionId)?.preview;
    const targetAlreadyOpen = opts.sessionId === activeSessionId
      ? sitePreview.isOpen
      : Boolean(storedPreview && sameProjectPath(storedPreview.projectRoot, projectRoot));
    if (previewOpenedForRun.has(opts.sessionId) && targetAlreadyOpen) return;
    previewOpenedForRun.add(opts.sessionId);
  }
  let files = opts.files || [];
  if (!files.length) {
    files = [...(await snapshotProjectFiles(projectRoot))];
  }
  const autoPick = opts.autoPickEntry !== false;
  const entry = opts.entryPath || (autoPick ? pickPreviewEntry(files) : null);
  const targetSession = sessionForId(targetSessionId);

  // A background agent may finish a game or app while the user is reading a
  // different session. Store its preview on its own session, but never mount it
  // into the currently visible session's iframe panel.
  if (targetSessionId && targetSessionId !== activeSessionId) {
    if (!targetSession || !sameProjectPath(targetSession.projectId, projectRoot)) return;
    targetSession.preview = mergePreviewSessionState(targetSession.preview, {
      projectRoot,
      files,
      entryPath: entry,
      title: opts.title || "Build preview",
    });
    sessionRegistry.set(targetSession.id, targetSession);
    saveSession(targetSession);
    return;
  }

  await sitePreview.open({
    projectRoot,
    files,
    entryPath: entry,
    title: opts.title || "Build preview",
    autoPickEntry: autoPick,
  });
  // The component emits this itself for regular UI actions. Persist here too so
  // an automatically opened preview is durable even if a view transition raced it.
  if (targetSessionId && targetSessionId === activeSessionId) {
    persistPreviewForSession(targetSessionId, sitePreview.captureSessionState());
  }
}

async function maybeOpenBuildPreview(sessionId: string | undefined, reason: string) {
  if (!sessionId || reason === "cancelled" || !currentProjectPath) return;
  const runProjectPath = runProjectPaths.get(sessionId);
  if (runProjectPath && !sameProjectPath(runProjectPath, currentProjectPath)) {
    runTouchedFiles.delete(sessionId);
    runBaselineFiles.delete(sessionId);
    return;
  }
  const storedPreview = sessionForId(sessionId)?.preview;
  const sessionPreviewOpen = sessionId === activeSessionId
    ? sitePreview?.isOpen
    : Boolean(storedPreview && sameProjectPath(storedPreview.projectRoot, runProjectPath || currentProjectPath));
  if (previewOpenedForRun.has(sessionId) && sessionPreviewOpen) {
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
    projectRoot: runProjectPath,
  });
}

function refreshSidebar() {
  const runningProjectPaths = new Set(
    [...runningSessions]
      .map((sessionId) => sessionRegistry.get(sessionId)?.projectId || runProjectPaths.get(sessionId) || "")
      .filter(Boolean),
  );
  sidebar.setProjectWorkspaces(listProjectWorkspaces(), currentProjectPath, runningProjectPaths);
  sidebar.render(sessions, activeSessionId, runningSessions).catch((e) => console.error("sidebar render failed", e));
}

function updateGlobalRunStatus() {
  syncActiveSessionModelLock();
  const n = runningSessions.size;
  if (n === 0) sidebar.setStatus("Ready", false);
  else if (n === 1) sidebar.setStatus("Running", true);
  else sidebar.setStatus(`${n} runs`, true);
}

/**
 * The model selector is global UI, but a run belongs to one session. While the
 * selected session is busy, display and lock the model that actually started
 * that run. Other idle sessions remain free to choose their own next model.
 */
function syncActiveSessionModelLock() {
  if (typeof modelBar === "undefined" || typeof chat === "undefined") return;
  const profile = activeSessionId ? runModelProfiles.get(activeSessionId) || null : null;
  modelBar.setActiveSessionRunProfile(profile);
  if (profile) {
    chat.setReplyProfile({
      provider: profile.provider,
      model: profile.model,
      effort: profile.effort,
    });
  } else if (modelBar.settings) {
    chat.setReplyProfile({
      provider: modelBar.settings.provider,
      model: modelBar.settings.model,
      effort: modelBar.settings.model_effort,
    });
  }
}

function sessionForId(id: string | null | undefined): Session | undefined {
  if (!id) return undefined;
  return sessionRegistry.get(id) || sessions.find((session) => session.id === id);
}

function syncVisiblePreviewIntoSession(session: Session) {
  if (!sitePreview || sitePreview.isRestoring) return;
  const preview = sitePreview.captureSessionState();
  if (preview && sameProjectPath(preview.projectRoot, session.projectId)) {
    session.preview = preview;
  } else {
    delete session.preview;
  }
}

function persistPreviewForSession(
  sessionId: string | null | undefined,
  preview: ReturnType<SitePreview["captureSessionState"]>,
) {
  const session = sessionForId(sessionId);
  if (!session) return;
  if (preview && !sameProjectPath(preview.projectRoot, session.projectId)) return;
  if (preview) session.preview = preview;
  else delete session.preview;
  sessionRegistry.set(session.id, session);
  saveSession(session);
}

function restoreActiveSessionPreview() {
  if (!sitePreview) return;
  const sessionId = activeSessionId;
  const session = sessionForId(sessionId);
  const preview = session?.preview;
  if (
    !sessionId ||
    !session ||
    !currentProjectPath ||
    !preview ||
    !sameProjectPath(session.projectId, currentProjectPath) ||
    !sameProjectPath(preview.projectRoot, currentProjectPath)
  ) {
    sitePreview.clearSessionView();
    renderWorkspaceMenu();
    return;
  }
  void sitePreview.restoreSessionState(preview).then(
    () => {
      if (activeSessionId === sessionId) renderWorkspaceMenu();
    },
    (error) => {
      if (activeSessionId !== sessionId) return;
      sitePreview.clearSessionView();
      renderWorkspaceMenu();
      reportError(`Could not restore this session's preview: ${String(error)}`);
    },
  );
}

function persistCurrentSession(deferred = false) {
  if (!activeSessionId || !currentProjectPath) return;
  const s = sessionForId(activeSessionId);
  if (!s) return;
  syncVisiblePreviewIntoSession(s);
  sessionRegistry.set(s.id, s);
  s.messages = chat.getMessages();
  if (deferred) scheduleSessionSave(s);
  else saveSession(s);
}

function prepareForAppUpdate() {
  if (runningSessions.size > 0) {
    throw new Error("Stop active AI runs before updating so their latest work can be saved safely.");
  }
  if (activeSessionId && currentProjectPath) {
    const session = sessions.find((candidate) => candidate.id === activeSessionId);
    if (session) {
      syncVisiblePreviewIntoSession(session);
      sessionRegistry.set(session.id, session);
      session.messages = chat.getMessages();
      saveSessionForUpdate(session);
    }
  }
  flushSessionSavesForUpdate();
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
  const s = sessionRegistry.get(sessionId) || sessions.find((x) => x.id === sessionId);
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
  const s = sessionForId(id);
  if (!s) return;
  if (id === activeSessionId) {
    syncVisiblePreviewIntoSession(s);
    s.messages = chat.getMessages();
  }
  sessionRegistry.set(s.id, s);
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
  sessionRegistry.set(s.id, s);
  activeSessionId = s.id;
  restoreActiveSessionPreview();
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
  restoreActiveSessionPreview();
  if (s.messages.length === 0) {
    chat.messages = [];
    chat.renderEmpty();
  } else {
    chat.loadSession(s.messages);
  }
  chat.setRunning(runningSessions.has(id));
  syncActiveSessionModelLock();
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
    runModelProfiles.delete(id);
  }
  deleteSession(id);
  sessionRegistry.delete(id);
  sessions = sessions.filter((s) => s.id !== id);
  if (activeSessionId === id) {
    activeSessionId = null;
    if (sessions.length > 0) {
      switchSession(sessions[0].id);
    } else {
      chat.messages = [];
      chat.renderEmpty();
      chat.setRunning(false);
      sitePreview?.clearSessionView();
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
  // Remove only the current project's work; other project runs stay alive.
  const ids = sessions.map((session) => session.id);
  for (const id of ids.filter((id) => runningSessions.has(id))) {
    api.agentStop(id).catch(() => {});
    runningSessions.delete(id);
    runModelProfiles.delete(id);
  }
  deleteAllSessions(currentProjectPath!);
  for (const id of ids) sessionRegistry.delete(id);
  // Keep project token usage — do not reset the meter to 100%
  sessions = [];
  activeSessionId = null;
  sitePreview?.clearSessionView();
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
  for (const session of sessions) sessionRegistry.set(session.id, session);
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
  // Project switching is allowed during a run. Reflect only the selected
  // session's activity instead of leaving the previous project in the UI.
  chat.setRunning(!!activeSessionId && runningSessions.has(activeSessionId), { processQueue: false });
  syncActiveSessionModelLock();
  // Shared budget across every session in this project
  syncUsageBar();
  restoreActiveSessionPreview();
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
  renderWorkspaceMenu();
}

function syncDrawerButtons() {
  const leftOpen = isDrawerOpen(LEFT_DRAWER_KEY, true);
  const leftBtn = document.getElementById("drawer-left-btn");
  if (leftBtn) {
    leftBtn.classList.toggle("active", leftOpen);
    leftBtn.setAttribute("aria-pressed", String(leftOpen));
    leftBtn.setAttribute("title", leftOpen ? "Hide left panel" : "Show left panel");
    leftBtn.setAttribute("aria-label", leftOpen ? "Hide left panel" : "Show left panel");
  }
}

let workspaceMenuCleanup: (() => void) | null = null;

function workspaceMenuItems(): HTMLButtonElement[] {
  const menu = document.getElementById("workspace-menu");
  if (!menu) return [];
  return Array.from(menu.querySelectorAll<HTMLButtonElement>(".workspace-menu-item:not(:disabled)"));
}

function closeWorkspaceMenu(restoreFocus = false) {
  const menu = document.getElementById("workspace-menu");
  const button = document.getElementById("workspace-menu-btn") as HTMLButtonElement | null;
  if (!menu || !button || menu.hidden) return;
  menu.hidden = true;
  button.setAttribute("aria-expanded", "false");
  button.classList.remove("is-open");
  const cleanup = workspaceMenuCleanup;
  workspaceMenuCleanup = null;
  cleanup?.();
  if (restoreFocus) button.focus({ preventScroll: true });
}

function renderWorkspaceMenu() {
  const menu = document.getElementById("workspace-menu");
  if (!menu) return;
  clear(menu);

  const hasProject = !!currentProjectPath;
  const previewOpen = !!sitePreview?.isOpen;
  const rightOpen = isDrawerOpen(RIGHT_DRAWER_KEY, true);
  menu.appendChild(el("div", { class: "workspace-menu-title" }, ["Workspace"]));

  const appendAction = (
    action: string,
    label: string,
    iconName: "folder" | "globe" | "panelRight",
    onClick: () => void,
    disabled = false,
  ) => {
    const item = el("button", {
      class: "workspace-menu-item",
      type: "button",
      role: "menuitem",
      "data-workspace-action": action,
    }) as HTMLButtonElement;
    item.disabled = disabled;
    item.append(
      el("span", { class: "workspace-menu-icon", html: icon(iconName, 15) }),
      el("span", { class: "workspace-menu-label" }, [label]),
    );
    item.addEventListener("click", () => {
      if (item.disabled) return;
      closeWorkspaceMenu();
      onClick();
    });
    menu.appendChild(item);
  };

  appendAction(
    "preview",
    previewOpen ? "Close build preview" : "Open build preview",
    "globe",
    () => {
      if (!currentProjectPath) return;
      if (sitePreview?.isOpen) sitePreview.close();
      else void openBuildPreview({ title: "Build preview", autoPickEntry: false });
    },
    !hasProject,
  );
  appendAction(
    "explorer",
    "Reveal project in Explorer",
    "folder",
    () => {
      if (currentProjectPath) void api.openProjectInExplorer();
    },
    !hasProject,
  );
  menu.appendChild(el("div", { class: "workspace-menu-divider", role: "separator" }));
  appendAction(
    "inspector",
    rightOpen ? "Hide project panel" : "Show project panel",
    "panelRight",
    () => toggleRightDrawer(),
  );
}

function openWorkspaceMenu() {
  const menu = document.getElementById("workspace-menu");
  const button = document.getElementById("workspace-menu-btn") as HTMLButtonElement | null;
  const anchor = document.getElementById("workspace-menu-anchor");
  if (!menu || !button || !anchor) return;
  renderWorkspaceMenu();
  menu.hidden = false;
  button.setAttribute("aria-expanded", "true");
  button.classList.add("is-open");

  const onPointerDown = (event: PointerEvent) => {
    if (!anchor.contains(event.target as Node)) closeWorkspaceMenu();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeWorkspaceMenu(true);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = workspaceMenuItems();
    if (!items.length) return;
    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    const offset = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = currentIndex < 0
      ? (offset > 0 ? 0 : items.length - 1)
      : (currentIndex + offset + items.length) % items.length;
    items[nextIndex].focus({ preventScroll: true });
  };
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  workspaceMenuCleanup = () => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
  };
  requestAnimationFrame(() => workspaceMenuItems()[0]?.focus({ preventScroll: true }));
}

function bindWorkspaceMenuButton() {
  const button = document.getElementById("workspace-menu-btn") as HTMLButtonElement | null;
  if (!button || (button as any).__bound) return;
  button.addEventListener("click", () => {
    const menu = document.getElementById("workspace-menu");
    if (menu?.hidden) openWorkspaceMenu();
    else closeWorkspaceMenu();
  });
  button.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    openWorkspaceMenu();
    requestAnimationFrame(() => {
      const items = workspaceMenuItems();
      const target = event.key === "ArrowUp" ? items.at(-1) : items[0];
      target?.focus({ preventScroll: true });
    });
  });
  (button as any).__bound = true;
}

/** Wire permanent header controls once (they live in index.html). */
function bindDrawerButtons() {
  const leftBtn = document.getElementById("drawer-left-btn");
  if (leftBtn && !(leftBtn as any).__bound) {
    leftBtn.addEventListener("click", () => toggleLeftDrawer());
    (leftBtn as any).__bound = true;
  }
  bindWorkspaceMenuButton();
  applyDrawers();
  syncDrawerButtons();
}

async function refreshHeader() {
  sidebar?.setProject(currentProjectPath);
  chat?.setComposerProject(currentProjectPath);
  bindDrawerButtons();
  renderWorkspaceMenu();
}

async function selectProject(path: string) {
  if (sameProjectPath(currentProjectPath, path)) return;
  persistCurrentSession();
  flushSessionSaves();
  await api.setProjectRoot(path);
  const canonicalPath = (await api.getProjectRoot()) || path;
  currentProjectPath = canonicalPath;
  activateProjectWorkspace(canonicalPath);
  loadProjectSessions();
  refreshSidebar();
  chat.setProjectReady(true);
  await workspacePanel.setProject(canonicalPath);
  await refreshHeader();
}

async function createProject(path: string, templateId?: string) {
  persistCurrentSession();
  flushSessionSaves();
  await api.createProjectDir(path, templateId);
  const canonicalPath = (await api.getProjectRoot()) || path;
  currentProjectPath = canonicalPath;
  activateProjectWorkspace(canonicalPath);
  sessions = [];
  activeSessionId = null;
  sitePreview?.clearSessionView();
  chat.messages = [];
  chat.renderEmpty();
  chat.setRunning(false, { processQueue: false });
  refreshSidebar();
  chat.setProjectReady(true);
  await workspacePanel.setProject(canonicalPath);
  await refreshHeader();
}

function openNewProjectPicker() {
  const root = document.getElementById("modal-root")!;
  clear(root);
  const picker = new ProjectPicker(root, "new", async (path, templateId) => {
    clear(root);
    await createProject(path, templateId);
  }, () => clear(root));
  void picker.render();
}

function openOpenProjectPicker() {
  const root = document.getElementById("modal-root")!;
  clear(root);
  const picker = new ProjectPicker(root, "open", async (path) => {
    clear(root);
    await selectProject(path);
  }, () => clear(root));
  void picker.render();
}

function openSettings(integrationId?: string) {
  try {
    settingsModal?.close();
  } catch {
    /* ignore stale modal */
  }
  settingsModal = new SettingsModal(async () => {
    await refreshHeader();
    await refreshProviderReadiness();
  }, integrationId);
  void settingsModal.open();
}

async function refreshProviderReadiness(): Promise<boolean> {
  const settings = await getSettingsSafe();
  const provider = getProviderMeta(settings.provider);
  const label = displayProviderName(settings.provider);
  if (!provider) {
    chat?.setProviderReady(false, label);
    return false;
  }

  // Keyless local providers, or hosted-managed aliases, are ready immediately.
  if (provider.id === "ollama" || provider.hostedManaged) {
    chat?.setProviderReady(true, label);
    return true;
  }

  if (provider.keyRequired) {
    if (await api.hasApiKey(settings.provider).catch(() => false)) {
      chat?.setProviderReady(true, label);
      return true;
    }
  } else if (provider.id !== "openrouter") {
    chat?.setProviderReady(true, label);
    return true;
  } else if (await api.hasApiKey("openrouter").catch(() => false)) {
    chat?.setProviderReady(true, label);
    return true;
  }

  // Active Hormachuelos plans proxy OpenRouter (and other cloud providers)
  // through the hosted API — no local provider key required.
  if (settings.provider !== "cursor" && settings.provider !== "ollama") {
    const lic = await api.getLicenseStatus().catch(() => null);
    const hostedReady = Boolean(
      lic?.hosted && lic.active && String(lic.licenseKey || "").trim(),
    );
    if (hostedReady) {
      chat?.setProviderReady(true, label);
      return true;
    }
  }

  chat?.setProviderReady(false, label);
  return false;
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
  const projectRoot = currentProjectPath;
  if (!(await refreshProviderReadiness())) {
    reportError("Connect the selected provider in Settings before sending a request.");
    openSettings();
    return;
  }
  if (!sameProjectPath(projectRoot, currentProjectPath)) {
    reportError("Project changed before the request started. Send it again from the active project.");
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
        projectId: projectRoot,
        messages: [],
        createdAt: Date.now(),
        sessionTokens: 0,
      };
      sessions.unshift(s);
      sessionRegistry.set(s.id, s);
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
  if (modelBar.settings) {
    runModelProfiles.set(sessionId, {
      provider: modelBar.settings.provider,
      model: modelBar.settings.model,
      effort: modelBar.settings.model_effort,
    });
  }
  runningSessions.add(sessionId);
  syncActiveSessionModelLock();
  runProjectPaths.set(sessionId, projectRoot);
  runTouchedFiles.set(sessionId, new Set());
  previewOpenedForRun.delete(sessionId);
  void snapshotProjectFiles(projectRoot).then((snap) => {
    if (sameProjectPath(runProjectPaths.get(sessionId), projectRoot)) runBaselineFiles.set(sessionId, snap);
  });
  // Only touch workspace/console UI while this project is still visible.
  if (sameProjectPath(projectRoot, currentProjectPath)) {
    await workspacePanel.beginRun();
    if (sameProjectPath(projectRoot, currentProjectPath) && activeSessionId === sessionId) {
      chat.setRunning(true);
    }
  }
  updateGlobalRunStatus();
  // Shared project budget — continues across all sessions
  syncUsageBar();
  refreshSidebar();
  try {
    await api.agentRun(prompt, sessionId, history, projectRoot);
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
        const s = sessionRegistry.get(sessionId) || sessions.find((x) => x.id === sessionId);
        if (s) {
          recordAgentEvent(s.messages, { kind: "text", payload: { text: `Error: ${e}` } });
          recordAgentEvent(s.messages, { kind: "end", payload: { reason: "no_tool_calls" } });
          saveSession(s);
          sessionRegistry.set(s.id, s);
        }
      }
      reportError(msg);
    }
  } finally {
    // Only drop the busy flag here — after backend finish_run. Early deletes on
    // cancelled/done events race a follow-up send ("session already running").
    runningSessions.delete(sessionId);
    runModelProfiles.delete(sessionId);
    syncActiveSessionModelLock();
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
    runProjectPaths.delete(sessionId);
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
      const htmlOpen = htmlPathFromOpenArgs(e.payload.name, e.payload.arguments, runProjectPaths.get(sid));
      if (htmlOpen) {
        void openBuildPreview({
          sessionId: sid,
          entryPath: htmlOpen,
          title: "Build preview",
          projectRoot: runProjectPaths.get(sid),
        });
      }
    }
    const s = sessionRegistry.get(sid) || sessions.find((x) => x.id === sid);
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
      sessionRegistry.set(s.id, s);
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
    const htmlOpen = htmlPathFromOpenArgs(
      e.payload.name,
      e.payload.arguments,
      sid ? runProjectPaths.get(sid) : currentProjectPath,
    );
    if (htmlOpen) {
      void openBuildPreview({
        sessionId: sid || undefined,
        entryPath: htmlOpen,
        title: "Build preview",
        projectRoot: sid ? runProjectPaths.get(sid) : currentProjectPath,
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
  let restoredUpdateKeys = 0;
  try {
    restoredUpdateKeys = await restoreUpdateState();
  } catch (error) {
    console.warn("Pre-update backup is retained because restoration did not complete.", error);
  }
  if (restoredUpdateKeys > 0) {
    console.info(`Restored ${restoredUpdateKeys} persisted value(s) after the app update.`);
  }
  // Sandwich buttons are in HTML — bind them and restore open/closed state first
  bindDrawerButtons();

  workspacePanel = new WorkspacePanel();
  consolePanel = new ConsolePanel();
  sitePreview = new SitePreview(document.getElementById("site-preview-slot"));
  sitePreview.setDescribeHandler((prompt) => {
    void sendPrompt(prompt);
  });
  sitePreview.setStateChangeHandler((preview) => {
    // The preview component only emits user-driven changes, never a restore of
    // another session. Keep the serialized preview alongside the active chat.
    persistPreviewForSession(activeSessionId, preview);
    renderWorkspaceMenu();
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
      if (isWebsiteSessionRejected(e)) {
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
    // A just-linked browser account may unlock administrator-managed provider
    // aliases. Refresh the picker immediately instead of requiring a restart.
    if (typeof modelBar !== "undefined") {
      await modelBar.refresh().catch(() => {});
      await refreshProviderReadiness().catch(() => false);
    }
  }

  sidebar = new Sidebar({
    onNewProject: openNewProjectPicker,
    onOpenProject: openOpenProjectPicker,
    onSelectProject: (path) => void selectProject(path).catch((error) => reportError(String(error))),
    onAddAnotherProject: openNewProjectPicker,
    onOpenSettings: openSettings,
    onCheckForUpdates: () => document.body.appendChild(showUpdateDialog({
      beforeInstall: prepareForAppUpdate,
    })),
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

  // New releases get a visible sidebar badge. Required releases still block
  // the app, while the background refresh keeps long-running clients informed.
  let forcedUpdateGateVisible = false;
  const refreshUpdateNotification = async () => {
    try {
      const update = await checkDesktopUpdate();
      const available = update.updateAvailable || update.forceUpdate;
      sidebar.setUpdateNotification(available, update.latest?.version);
      if (update.forceUpdate && update.latest && !forcedUpdateGateVisible) {
        forcedUpdateGateVisible = true;
        document.body.appendChild(showUpdateGate(update, {
          beforeInstall: prepareForAppUpdate,
        }));
        return true;
      }
    } catch (e) {
      // Keep an already-shown notification rather than hiding it due to a
      // transient offline error.
      console.warn("update check failed", e);
    }
    return false;
  };
  if (await refreshUpdateNotification()) return;
  window.setInterval(() => {
    void refreshUpdateNotification();
  }, 15 * 60 * 1000);
  window.addEventListener("online", () => {
    void refreshUpdateNotification();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refreshUpdateNotification();
  });

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
    syncActiveSessionModelLock();
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
  syncActiveSessionModelLock();
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

  // Restore every known workspace. Runs keep their own root, so opening or
  // adding another project never interrupts an existing project run.
  try {
    const recent = await api.listRecentProjects();
    const workspaces = rememberRecentProjectWorkspaces(recent);
    const rememberedActive = activeProjectWorkspacePath();
    const initialProject =
      workspaces.find((workspace) => workspace.path === rememberedActive)?.path ||
      recent[0] ||
      workspaces[0]?.path;
    if (initialProject) {
      await selectProject(initialProject);
    } else {
      refreshSidebar();
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
