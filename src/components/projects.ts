/**
 * Locally persisted project workspaces. A workspace is only a remembered
 * folder — it never copies, uploads, or changes the user's project files.
 */
export type ProjectWorkspace = {
  path: string;
  name: string;
  addedAt: number;
  lastOpenedAt: number;
};

const WORKSPACES_KEY = "ai-forge:project-workspaces";
const ACTIVE_WORKSPACE_KEY = "ai-forge:active-project-workspace";

function normalizePath(path: string): string {
  return String(path || "").trim().replace(/[\\/]+$/, "");
}

function workspaceKey(path: string): string {
  return normalizePath(path).toLocaleLowerCase();
}

function projectName(path: string): string {
  const parts = normalizePath(path).replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}

function readWorkspaces(): ProjectWorkspace[] {
  try {
    const raw = localStorage.getItem(WORKSPACES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    return parsed
      .map((entry): ProjectWorkspace | null => {
        const path = normalizePath(entry?.path || "");
        const key = workspaceKey(path);
        if (!path || seen.has(key)) return null;
        seen.add(key);
        const addedAt = Math.max(0, Number(entry?.addedAt) || Date.now());
        const lastOpenedAt = Math.max(addedAt, Number(entry?.lastOpenedAt) || addedAt);
        return { path, name: projectName(path), addedAt, lastOpenedAt };
      })
      .filter((entry): entry is ProjectWorkspace => entry !== null)
      .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  } catch {
    return [];
  }
}

function writeWorkspaces(workspaces: ProjectWorkspace[]): void {
  try {
    localStorage.setItem(WORKSPACES_KEY, JSON.stringify(workspaces));
  } catch {
    // Persistence is a convenience; the active workspace still works in memory.
  }
}

export function listProjectWorkspaces(): ProjectWorkspace[] {
  return readWorkspaces();
}

/** Remember a project and mark it as the active workspace. */
export function activateProjectWorkspace(path: string): ProjectWorkspace[] {
  const normalized = normalizePath(path);
  if (!normalized) return readWorkspaces();
  const now = Date.now();
  const key = workspaceKey(normalized);
  const workspaces = readWorkspaces();
  const existing = workspaces.find((workspace) => workspaceKey(workspace.path) === key);
  if (existing) {
    existing.path = normalized;
    existing.name = projectName(normalized);
    existing.lastOpenedAt = now;
  } else {
    workspaces.push({
      path: normalized,
      name: projectName(normalized),
      addedAt: now,
      lastOpenedAt: now,
    });
  }
  const ordered = workspaces.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  writeWorkspaces(ordered);
  try {
    localStorage.setItem(ACTIVE_WORKSPACE_KEY, normalized);
  } catch {
    // non-fatal
  }
  return ordered;
}

/** Import Tauri's existing recent folders without changing which workspace is active. */
export function rememberRecentProjectWorkspaces(paths: string[]): ProjectWorkspace[] {
  const workspaces = readWorkspaces();
  const known = new Set(workspaces.map((workspace) => workspaceKey(workspace.path)));
  const now = Date.now();
  let changed = false;
  for (const [index, rawPath] of paths.entries()) {
    const path = normalizePath(rawPath);
    const key = workspaceKey(path);
    if (!path || known.has(key)) continue;
    known.add(key);
    const seenAt = now - index;
    workspaces.push({ path, name: projectName(path), addedAt: seenAt, lastOpenedAt: seenAt });
    changed = true;
  }
  const ordered = workspaces.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  if (changed) writeWorkspaces(ordered);
  return ordered;
}

export function activeProjectWorkspacePath(): string | null {
  try {
    const path = normalizePath(localStorage.getItem(ACTIVE_WORKSPACE_KEY) || "");
    return path || null;
  } catch {
    return null;
  }
}
