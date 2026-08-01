// Typed wrappers for Tauri invoke + event listening
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

export type Settings = {
  provider: string;
  model: string;
  base_url: string | null;
  /** Legacy setting retained for older desktop releases; agent runs are unbounded. */
  max_iterations: number;
  command_timeout_secs: number;
  auto_approve: boolean;
  /** plan | auto | research | full */
  permission_mode: string;
  /** thinking | guided | agent | balanced | investigate | brief | autonomous | max */
  capability_mode: string;
  /** Reply in Taglish when enabled */
  taglish: boolean;
  /** Allow the Cursor SDK agent to observe and control approved Windows apps. */
  computer_use_enabled: boolean;
  /** Cursor SDK effort: light | medium | high | xhigh | ultra */
  model_effort?: string;
};

export type Provider = "deepseek" | "openrouter" | "glm" | "openai" | "cursor" | "hormachuelos_free" | "anthropic" | "gemini" | "ollama" | "pollinations";

export type ConnectionTestResult = {
  ok: boolean;
  latencyMs: number;
  errorCode: string | null;
  message: string;
};

export type ComputerUseStatus = {
  supported: boolean;
  paused: boolean;
  emergencyShortcut: string;
  emergencyShortcutAvailable: boolean;
};

export type ComputerUseFxEvent = {
  kind: string;
  x: number;
  y: number;
  text?: string | null;
  charIndex?: number | null;
  totalChars?: number | null;
};

export type ProjectNode = {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modifiedMs: number;
  children: ProjectNode[];
  truncated: boolean;
};

export type ProjectTree = {
  nodes: ProjectNode[];
  truncated: boolean;
};

export type FilePreview = {
  path: string;
  content: string;
  size: number;
  language: string;
};

export type ClientPackResult = {
  zipPath: string;
  filesCount: number;
  handoffPath: string;
};

export type ProjectTemplate = {
  id: string;
  label: string;
  blurb: string;
};

export type LicenseStatus = {
  plan: string;
  active: boolean;
  expiresAt: string;
  email: string;
  tokenBudget: number;
  tokensUsed: number;
  topUpUrl: string;
  message: string;
  /** Provider-style rate windows */
  window4hUsed?: number;
  window4hStartedAt?: string;
  window4hBudget?: number;
  window4hResetsAt?: string;
  windowWeekUsed?: number;
  windowWeekStartedAt?: string;
  windowWeekBudget?: number;
  windowWeekResetsAt?: string;
  /** "" | "plan" | "4h" | "week" */
  blockedBy?: string;
  /** Dev bypass — limits not enforced (debug builds). */
  limitsDisabled?: boolean;
};

export const api = {
  getProjectRoot: (): Promise<string | null> => invoke("get_project_root"),
  setProjectRoot: (path: string): Promise<void> => invoke("set_project_root", { path }),
  listRecentProjects: (): Promise<string[]> => invoke("list_recent_projects"),
  getSettings: (): Promise<Settings> => invoke("get_settings"),
  saveSettings: (settings: Settings): Promise<void> => invoke("save_settings", { settings }),
  getComputerUseStatus: (): Promise<ComputerUseStatus> => invoke("get_computer_use_status"),
  setComputerUsePaused: (paused: boolean): Promise<ComputerUseStatus> =>
    invoke("set_computer_use_paused", { paused }),
  setApiKey: (provider: string, key: string): Promise<void> => invoke("set_api_key", { provider, key }),
  hasApiKey: (provider: string): Promise<boolean> => invoke("has_api_key", { provider }),
  clearApiKey: (provider: string): Promise<void> => invoke("clear_api_key", { provider }),
  setWebsiteSession: (token: string): Promise<void> => invoke("set_website_session", { token }),
  getWebsiteSession: (): Promise<string | null> => invoke("get_website_session"),
  clearWebsiteSession: (): Promise<void> => invoke("clear_website_session"),
  openExternalUrl: (url: string): Promise<void> => invoke("open_external_url", { url }),
  respondToQuestion: (answer: string, sessionId: string): Promise<void> =>
    invoke("respond_to_question", { answer, sessionId }),
  respondToConfirm: (approved: boolean, sessionId: string): Promise<void> =>
    invoke("respond_to_confirm", { approved, sessionId }),
  testProviderConnection: (provider: string, model: string, baseUrl: string | null): Promise<ConnectionTestResult> =>
    invoke("test_provider_connection", { provider, model, baseUrl }),
  listProviderModels: (provider: string, baseUrl: string | null): Promise<string[]> =>
    invoke("list_provider_models", { provider, baseUrl }),
  createProjectDir: (path: string, templateId?: string): Promise<void> =>
    invoke("create_project_dir", { path, templateId: templateId ?? null }),
  listProjectTemplates: (): Promise<ProjectTemplate[]> => invoke("list_project_templates"),
  listProjectFiles: (maxDepth = 8): Promise<ProjectTree> => invoke("list_project_files", { maxDepth }),
  readProjectFile: (relativePath: string): Promise<FilePreview> => invoke("read_project_file", { relativePath }),
  exportClientPack: (destPath?: string, handoffSummary?: string): Promise<ClientPackResult> =>
    invoke("export_client_pack", {
      destPath: destPath ?? null,
      handoffSummary: handoffSummary ?? null,
    }),
  getLicenseStatus: (): Promise<LicenseStatus> => invoke("get_license_status"),
  applyLicenseKey: (key: string): Promise<LicenseStatus> => invoke("apply_license_key", { key }),
  /** Account-wide token burn (persisted in license.json — not per project). */
  recordLicenseUsage: (tokens: number): Promise<LicenseStatus> =>
    invoke("record_license_usage", { tokens: Math.max(0, Math.floor(tokens || 0)) }),
  /** Save a clipboard/drag-drop image to a temp file; returns absolute path. */
  savePastedImage: (dataBase64: string, mime?: string | null): Promise<string> =>
    invoke("save_pasted_image", { dataBase64, mime: mime ?? null }),
  agentRun: (
    prompt: string,
    sessionId: string,
    history: Array<{
      role: string;
      content: string;
      tool_calls?: { id: string; name: string; arguments: unknown }[];
      tool_call_id?: string;
      name?: string;
    }> = [],
    projectRoot?: string,
  ): Promise<void> => invoke("agent_run", { prompt, sessionId, history, projectRoot }),
  agentStop: (sessionId: string): Promise<void> => invoke("agent_stop", { sessionId }),
  openProjectInExplorer: (relativePath: string | null = null): Promise<void> =>
    invoke("open_project_in_explorer", { relativePath }),
  appVersion: (): Promise<string> => invoke("app_version"),
  openFolderPicker: async (): Promise<string | null> => {
    const sel = await openDialog({ directory: true, multiple: false, title: "Select folder" });
    if (typeof sel === "string") return sel;
    return null;
  },
  openImagePicker: async (): Promise<string | null> => {
    const sel = await openDialog({
      multiple: false,
      title: "Attach image",
      filters: [
        {
          name: "Images",
          extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"],
        },
      ],
    });
    if (typeof sel === "string") return sel;
    return null;
  },
  openFilePicker: async (): Promise<string[]> => {
    const sel = await openDialog({
      multiple: true,
      title: "Attach files",
    });
    if (typeof sel === "string") return [sel];
    if (Array.isArray(sel)) return sel.filter((p): p is string => typeof p === "string");
    return [];
  },
  /** Connected accounts (GitHub, Supabase, Vercel, …) */
  listIntegrations: (): Promise<IntegrationStatus[]> => invoke("list_integrations"),
  setIntegrationToken: (id: string, token: string): Promise<void> =>
    invoke("set_integration_token", { id, token }),
  clearIntegrationToken: (id: string): Promise<void> =>
    invoke("clear_integration_token", { id }),
  setIntegrationExtras: (id: string, fields: Record<string, string>): Promise<void> =>
    invoke("set_integration_extras", { id, fields }),
  testIntegration: (id: string): Promise<IntegrationTestResult> =>
    invoke("test_integration", { id }),
  /** Open OS browser for device/token auth (GitHub web login, etc.) */
  startIntegrationBrowserAuth: (id: string): Promise<IntegrationTestResult> =>
    invoke("start_integration_browser_auth", { id }),
};

export type AgentSkill = {
  id: string;
  name: string;
  path: string;
  source: string;
};

export type IntegrationStatus = {
  id: string;
  label: string;
  description: string;
  tokenLabel: string;
  docsUrl: string;
  connected: boolean;
  envKeys: string[];
  testHint: string;
  extras: Record<string, string>;
};

export type IntegrationTestResult = {
  ok: boolean;
  message: string;
  detail: string | null;
};

export type AgentEventPayload =
  | { kind: "start"; payload: { prompt: string } }
  | { kind: "thinking"; payload: { iteration: number } }
  | { kind: "reasoning"; payload: { text: string; iteration?: number } }
  | { kind: "text"; payload: { text: string } }
  | { kind: "tool_preview"; payload: { id: string; name: string; arguments_delta?: string } }
  | { kind: "tool_call"; payload: { id: string; name: string; arguments: any; preview_id?: string } }
  | { kind: "integration_auth"; payload: { service: string; secure_entry: boolean } }
  | { kind: "tool_args_truncated"; payload: { id: string; preview: string } }
  | { kind: "tool_result"; payload: { id: string; name: string; ok: boolean; content: string; streamed?: boolean } }
  | { kind: "tool_confirm"; payload: { id: string; name: string; arguments: any; summary: string } }
  | { kind: "console_chunk"; payload: { stream: string; text: string } }
  | { kind: "usage"; payload: { iteration: number; turn_tokens: number; total_tokens: number; raw_tokens?: number; license?: LicenseStatus | null } }
  | { kind: "question"; payload: { id: string; question: string; options: string[]; allow_other: boolean } }
  | { kind: "done"; payload: { summary: string; title: string; description: string; files: string[]; tech: string[]; features: string[]; total_tokens?: number } }
  | { kind: "cancelled"; payload: { iteration: number } }
  | { kind: "end"; payload: { reason: string; iteration: number; total_tokens?: number } };

/** Wire event from backend — always includes the session that owns the run. */
export type AgentEvent = AgentEventPayload & { session_id: string };

export function onAgentEvent(cb: (e: AgentEvent) => void): Promise<UnlistenFn> {
  return listen<AgentEvent>("agent", (ev) => cb(ev.payload));
}

export function onComputerUseStatus(
  cb: (status: ComputerUseStatus) => void,
): Promise<UnlistenFn> {
  return listen<ComputerUseStatus>("computer-use-status", (ev) => cb(ev.payload));
}

export function onComputerUseFx(
  cb: (event: ComputerUseFxEvent) => void,
): Promise<UnlistenFn> {
  return listen<ComputerUseFxEvent>("computer-use-fx", (ev) => cb(ev.payload));
}
