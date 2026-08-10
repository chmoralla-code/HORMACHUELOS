import { api, type AgentEvent, type FilePreview, type ProjectNode, type ProjectTree } from "../ipc";
import { clear, el } from "./util";
import { icon } from "./icons";

type InspectorTab = "files" | "changes" | "console";
type ChangeKind = "added" | "modified" | "deleted" | "touched" | "command";
type ChangeItem = { path: string; kind: ChangeKind; detail: string };
type ToolCall = { name: string; args: Record<string, unknown> };

const MUTATING_TOOLS = new Set([
  "write_file", "edit_file", "move_file", "copy_file", "delete_file",
  "make_dir", "download_file", "git_commit", "git_add_all",
]);

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function flattenTree(nodes: ProjectNode[], output = new Map<string, string>()): Map<string, string> {
  for (const node of nodes) {
    if (!node.isDir) output.set(node.path, `${node.size}:${node.modifiedMs}`);
    flattenTree(node.children, output);
  }
  return output;
}

function nodeMatches(node: ProjectNode, query: string): boolean {
  return node.path.toLowerCase().includes(query) || node.children.some((child) => nodeMatches(child, query));
}

function countProjectItems(nodes: ProjectNode[]): { files: number; folders: number } {
  return nodes.reduce(
    (total, node) => {
      if (node.isDir) {
        total.folders += 1;
        const childTotals = countProjectItems(node.children);
        total.files += childTotals.files;
        total.folders += childTotals.folders;
      } else {
        total.files += 1;
      }
      return total;
    },
    { files: 0, folders: 0 },
  );
}

export class WorkspacePanel {
  private inspector = document.getElementById("inspector")!;
  private filesPanel = document.getElementById("files-panel")!;
  private changesPanel = document.getElementById("changes-panel")!;
  private viewer = document.getElementById("file-viewer")!;
  private chat = document.getElementById("chat")!;
  private treeRoot!: HTMLElement;
  private changesRoot!: HTMLElement;
  private searchInput!: HTMLInputElement;
  private fileCount!: HTMLElement;
  private fileNotice!: HTMLElement;
  private clearFilesButton!: HTMLButtonElement;
  private projectPath: string | null = null;
  private tree: ProjectTree | null = null;
  private expanded = new Set<string>();
  private pendingCalls = new Map<string, ToolCall>();
  private changes = new Map<string, ChangeItem>();
  private baseline: Map<string, string> | null = null;
  private refreshTimer: number | null = null;
  private finishing = false;
  private fileActionInFlight = false;
  private activePreview: FilePreview | null = null;

  constructor() {
    this.buildFilesPanel();
    this.buildChangesPanel();
    this.buildViewer();
    const tabs = Array.from(
      this.inspector.querySelectorAll<HTMLButtonElement>("[data-inspector-tab]"),
    );
    tabs.forEach((button, index) => {
      button.addEventListener("click", () => this.activateTab(button.dataset.inspectorTab as InspectorTab));
      button.addEventListener("keydown", (event) => {
        let nextIndex: number | null = null;
        if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
        if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
        if (event.key === "Home") nextIndex = 0;
        if (event.key === "End") nextIndex = tabs.length - 1;
        if (nextIndex === null) return;
        event.preventDefault();
        const next = tabs[nextIndex];
        this.activateTab(next.dataset.inspectorTab as InspectorTab);
        next.focus();
      });
    });
    this.activateTab("files");
    this.renderNoProject();
  }

  private buildFilesPanel() {
    clear(this.filesPanel);
    const toolbar = el("div", { class: "project-toolbar" });
    const toolbarTop = el("div", { class: "project-toolbar-top" });
    const identity = el("div", { class: "project-toolbar-identity" });
    identity.appendChild(el("div", { class: "project-toolbar-title" }, ["Project files"]));
    this.fileCount = el("div", { class: "project-file-count", "aria-live": "polite" }, ["No project selected"]);
    identity.appendChild(this.fileCount);
    const actions = el("div", { class: "project-toolbar-actions" });
    const refresh = el("button", {
      class: "inspector-action", type: "button", "aria-label": "Refresh project files", title: "Refresh project files", html: icon("refresh", 14),
    }) as HTMLButtonElement;
    refresh.addEventListener("click", () => void this.refresh());
    this.clearFilesButton = el("button", {
      class: "project-clear-files", type: "button", disabled: "", "aria-label": "Clear all project files", title: "Clear all project files", html: `${icon("trash", 13)}<span>Clear files</span>`,
    }) as HTMLButtonElement;
    this.clearFilesButton.addEventListener("click", () => void this.requestClearProjectFiles());
    actions.append(refresh, this.clearFilesButton);
    toolbarTop.append(identity, actions);
    this.searchInput = el("input", {
      class: "project-filter", type: "search", placeholder: "Filter project files", "aria-label": "Filter project files",
    }) as HTMLInputElement;
    this.searchInput.addEventListener("input", () => this.renderTree());
    toolbar.append(toolbarTop, this.searchInput);
    this.fileNotice = el("div", { class: "project-file-notice", role: "status", hidden: "" });
    this.treeRoot = el("div", { class: "project-tree", role: "tree", "aria-label": "Project files" });
    this.filesPanel.append(toolbar, this.fileNotice, this.treeRoot);
  }

  private buildChangesPanel() {
    clear(this.changesPanel);
    const intro = el("div", { class: "changes-intro" }, ["Files touched during the current or most recent run."]);
    this.changesRoot = el("div", { class: "changes-list", "aria-live": "polite" });
    this.changesPanel.append(intro, this.changesRoot);
    this.renderChanges();
  }

  private buildViewer() {
    clear(this.viewer);
    const head = el("header", { class: "viewer-head" });
    const close = el("button", { class: "viewer-back", "aria-label": "Return to build ledger", html: icon("chevron", 15) });
    close.addEventListener("click", () => this.closeViewer());
    const identity = el("div", { class: "viewer-identity" });
    identity.append(el("div", { class: "viewer-path", id: "viewer-path" }, ["No file selected"]));
    identity.append(el("div", { class: "viewer-meta", id: "viewer-meta" }));
    const copy = el("button", { class: "btn sm", id: "viewer-copy" }, ["Copy content"]);
    copy.addEventListener("click", () => void this.copyPreview());
    head.append(close, identity, copy);
    const content = el("pre", { class: "viewer-content", id: "viewer-content", tabindex: "0" });
    this.viewer.append(head, content);
  }

  async setProject(path: string | null) {
    this.projectPath = path;
    document.body.classList.toggle("has-project", Boolean(path));
    this.closeViewer();
    this.tree = null;
    this.setFileNotice();
    this.expanded.clear();
    this.changes.clear();
    this.renderChanges();
    if (path) await this.refresh();
    else this.renderNoProject();
  }

  async refresh() {
    if (!this.projectPath) return this.renderNoProject();
    this.treeRoot.setAttribute("aria-busy", "true");
    this.treeRoot.replaceChildren(el("div", { class: "inspector-state" }, ["Indexing project…"]));
    try {
      this.tree = await api.listProjectFiles(8);
      this.renderTree();
    } catch (error) {
      this.treeRoot.replaceChildren(el("div", { class: "inspector-state error", role: "alert" }, [String(error)]));
    } finally {
      this.treeRoot.removeAttribute("aria-busy");
    }
  }

  private renderNoProject() {
    this.treeRoot.replaceChildren(el("div", { class: "inspector-state" }, ["Open or create a project to inspect its files."]));
    this.fileCount.textContent = "No project selected";
    this.clearFilesButton.disabled = true;
  }

  private renderTree() {
    if (!this.tree) return this.renderNoProject();
    this.updateFilesToolbar();
    clear(this.treeRoot);
    const query = this.searchInput.value.trim().toLowerCase();
    const visible = query ? this.tree.nodes.filter((node) => nodeMatches(node, query)) : this.tree.nodes;
    if (!visible.length) {
      this.treeRoot.appendChild(el("div", { class: "inspector-state" }, [query ? "No matching project files." : "This project is empty."]));
      return;
    }
    this.appendNodes(visible, this.treeRoot, 0, query);
    if (this.tree.truncated) {
      this.treeRoot.appendChild(el("div", { class: "tree-limit", role: "status" }, ["Large project: showing a bounded file index."]));
    }
  }

  private appendNodes(nodes: ProjectNode[], parent: HTMLElement, depth: number, query: string) {
    for (const node of nodes) {
      if (query && !nodeMatches(node, query)) continue;
      const row = el("div", { class: "tree-row", style: `--tree-depth:${depth}` });
      const button = el("button", {
        class: `tree-item ${node.isDir ? "directory" : "file"}`,
        role: "treeitem", title: node.path,
      });
      button.appendChild(el("span", { class: "tree-disclosure", html: node.isDir ? icon("chevron", 11) : "" }));
      button.appendChild(el("span", { class: "tree-icon", html: icon(node.isDir ? "folder" : "file", 14) }));
      button.appendChild(el("span", { class: "tree-name" }, [node.name]));
      if (node.isDir) {
        const open = query.length > 0 || this.expanded.has(node.path);
        button.setAttribute("aria-expanded", String(open));
        row.classList.toggle("open", open);
        button.addEventListener("click", () => {
          this.expanded.has(node.path) ? this.expanded.delete(node.path) : this.expanded.add(node.path);
          this.renderTree();
        });
      } else {
        button.addEventListener("click", () => void this.openFile(node.path));
      }
      row.appendChild(button);
      if (!node.isDir) {
        const remove = el("button", {
          class: "tree-delete",
          type: "button",
          "aria-label": `Delete ${node.path}`,
          title: `Delete ${node.path}`,
          html: icon("trash", 13),
        }) as HTMLButtonElement;
        remove.disabled = this.fileActionInFlight;
        remove.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          void this.requestDeleteFile(node.path);
        });
        row.appendChild(remove);
      }
      parent.appendChild(row);
      if (node.isDir && (query || this.expanded.has(node.path))) this.appendNodes(node.children, parent, depth + 1, query);
    }
  }

  async openFile(relativePath: string) {
    this.activePreview = null;
    this.chat.hidden = true;
    this.viewer.hidden = false;
    document.body.classList.add("viewer-open");
    document.getElementById("viewer-path")!.textContent = relativePath;
    document.getElementById("viewer-meta")!.textContent = "Loading preview…";
    document.getElementById("viewer-content")!.textContent = "";
    try {
      const preview = await api.readProjectFile(relativePath);
      this.activePreview = preview;
      document.getElementById("viewer-path")!.textContent = preview.path;
      document.getElementById("viewer-meta")!.textContent = `${formatBytes(preview.size)} · ${preview.language.toUpperCase()} · read only`;
      document.getElementById("viewer-content")!.textContent = preview.content;
    } catch (error) {
      document.getElementById("viewer-meta")!.textContent = "Preview unavailable";
      document.getElementById("viewer-content")!.textContent = String(error);
    }
  }

  closeViewer() {
    this.viewer.hidden = true;
    this.chat.hidden = false;
    document.body.classList.remove("viewer-open");
  }

  private async copyPreview() {
    if (!this.activePreview) return;
    await navigator.clipboard.writeText(this.activePreview.content).catch(() => undefined);
  }

  private updateFilesToolbar() {
    if (!this.tree || !this.projectPath) {
      this.fileCount.textContent = "No project selected";
      this.clearFilesButton.disabled = true;
      return;
    }
    const { files, folders } = countProjectItems(this.tree.nodes);
    const parts = [`${files} file${files === 1 ? "" : "s"}`];
    if (folders) parts.push(`${folders} folder${folders === 1 ? "" : "s"}`);
    this.fileCount.textContent = parts.join(" · ");
    this.clearFilesButton.disabled = this.fileActionInFlight || this.tree.nodes.length === 0;
    this.treeRoot.querySelectorAll<HTMLButtonElement>(".tree-delete").forEach((button) => {
      button.disabled = this.fileActionInFlight;
    });
  }

  private setFileNotice(message = "", kind: "success" | "error" = "success") {
    this.fileNotice.hidden = !message;
    this.fileNotice.className = `project-file-notice${message ? ` ${kind}` : ""}`;
    this.fileNotice.textContent = message;
  }

  private confirmProjectFileAction(options: {
    title: string;
    description: string;
    confirmLabel: string;
  }): Promise<boolean> {
    const root = document.getElementById("modal-root");
    if (!root || root.childElementCount > 0) {
      return Promise.resolve(window.confirm(`${options.title}\n\n${options.description}`));
    }

    return new Promise((resolve) => {
      const overlay = el("div", { class: "modal-overlay" });
      const modal = el("div", {
        class: "modal confirm-modal",
        role: "alertdialog",
        "aria-modal": "true",
        "aria-labelledby": "project-files-confirm-title",
        "aria-describedby": "project-files-confirm-description",
        tabindex: "-1",
      });
      const head = el("div", { class: "modal-head" });
      head.appendChild(el("div", { class: "modal-title", id: "project-files-confirm-title" }, [options.title]));
      const closeButton = el("button", {
        class: "modal-close", type: "button", "aria-label": "Cancel", html: icon("close", 16),
      }) as HTMLButtonElement;
      head.appendChild(closeButton);
      const body = el("div", { class: "modal-body" });
      body.appendChild(el("p", { class: "confirm-modal-desc", id: "project-files-confirm-description" }, [options.description]));
      const foot = el("div", { class: "modal-foot" });
      const cancelButton = el("button", { class: "btn", type: "button" }, ["Cancel"]) as HTMLButtonElement;
      const confirmButton = el("button", { class: "btn danger", type: "button" }, [options.confirmLabel]) as HTMLButtonElement;
      foot.append(cancelButton, confirmButton);
      modal.append(head, body, foot);
      overlay.appendChild(modal);

      let settled = false;
      const finish = (confirmed: boolean) => {
        if (settled) return;
        settled = true;
        clear(root);
        resolve(confirmed);
      };
      closeButton.addEventListener("click", () => finish(false));
      cancelButton.addEventListener("click", () => finish(false));
      confirmButton.addEventListener("click", () => finish(true));
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) finish(false);
      });
      modal.addEventListener("keydown", (event) => {
        if (event.key === "Escape") finish(false);
      });
      root.appendChild(overlay);
      cancelButton.focus();
    });
  }

  private async requestDeleteFile(relativePath: string) {
    if (this.fileActionInFlight) return;
    const confirmed = await this.confirmProjectFileAction({
      title: "Delete this project file?",
      description: `“${relativePath}” will be permanently removed from the active project. This cannot be undone.`,
      confirmLabel: "Delete file",
    });
    if (!confirmed) return;

    this.fileActionInFlight = true;
    this.updateFilesToolbar();
    try {
      await api.deleteProjectFile(relativePath);
      if (this.activePreview?.path === relativePath) this.closeViewer();
      this.addChange(relativePath, "deleted", "Deleted from project files");
      this.setFileNotice(`Deleted ${relativePath}.`);
      await this.refresh();
    } catch (error) {
      this.setFileNotice(`Could not delete ${relativePath}: ${String(error)}`, "error");
    } finally {
      this.fileActionInFlight = false;
      this.updateFilesToolbar();
    }
  }

  private async requestClearProjectFiles() {
    if (this.fileActionInFlight || !this.projectPath || !this.tree?.nodes.length) return;
    const confirmed = await this.confirmProjectFileAction({
      title: "Clear all project files?",
      description: "This permanently removes every file and folder in the active project. The project folder and its .git history stay in place. This cannot be undone.",
      confirmLabel: "Clear files",
    });
    if (!confirmed) return;

    this.fileActionInFlight = true;
    this.updateFilesToolbar();
    try {
      const removed = await api.clearProjectFiles();
      this.closeViewer();
      this.changes.clear();
      this.addChange("Project files", "deleted", `Cleared ${removed} project item${removed === 1 ? "" : "s"}`);
      this.setFileNotice(`Cleared ${removed} project item${removed === 1 ? "" : "s"}.`);
      await this.refresh();
    } catch (error) {
      this.setFileNotice(`Could not clear project files: ${String(error)}`, "error");
    } finally {
      this.fileActionInFlight = false;
      this.updateFilesToolbar();
    }
  }

  private activateTab(tab: InspectorTab) {
    this.inspector.querySelectorAll<HTMLButtonElement>("[data-inspector-tab]").forEach((button) => {
      const active = button.dataset.inspectorTab === tab;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    });
    this.filesPanel.hidden = tab !== "files";
    this.changesPanel.hidden = tab !== "changes";
    document.getElementById("console-panel")!.hidden = tab !== "console";
  }

  async beginRun() {
    if (!this.tree && this.projectPath) await this.refresh();
    this.baseline = flattenTree(this.tree?.nodes || []);
    this.changes.clear();
    this.pendingCalls.clear();
    this.renderChanges();
  }

  handleAgentEvent(event: AgentEvent) {
    if (event.kind === "tool_call") {
      this.pendingCalls.set(event.payload.id, { name: event.payload.name, args: event.payload.arguments || {} });
    } else if (event.kind === "tool_result") {
      const call = this.pendingCalls.get(event.payload.id);
      if (call && event.payload.ok) this.recordToolEffect(call);
      if (!event.payload.ok && call?.name === "run_command") this.activateTab("console");
    } else if (["done", "end", "cancelled"].includes(event.kind)) {
      void this.finishRun();
    }
  }

  private recordToolEffect(call: ToolCall) {
    if (call.name === "run_command") {
      this.addChange("Command activity", "command", "Workspace refreshed after shell execution");
      this.scheduleRefresh();
      return;
    }
    if (!MUTATING_TOOLS.has(call.name)) return;
    const paths = ["path", "file_path", "src", "dst", "source", "destination"]
      .map((key) => call.args[key])
      .filter((value): value is string => typeof value === "string")
      .map((path) => this.toProjectRelative(path))
      .filter((path): path is string => Boolean(path));
    for (const path of paths.length ? paths : [call.name]) this.addChange(path, "touched", call.name);
    this.scheduleRefresh();
  }

  private toProjectRelative(path: string): string | null {
    const normalized = path.replaceAll("\\", "/");
    const root = this.projectPath?.replaceAll("\\", "/").replace(/\/$/, "");
    if (root && normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return normalized.slice(root.length + 1);
    if (/^[a-zA-Z]:|^\/|^\.\./.test(normalized)) return null;
    return normalized.replace(/^\.\//, "");
  }

  private scheduleRefresh() {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => void this.refresh(), 350);
  }

  async finishRun() {
    if (!this.baseline || this.finishing) return;
    this.finishing = true;
    try {
      await this.refresh();
      const current = flattenTree(this.tree?.nodes || []);
      for (const [path, signature] of current) {
        if (!this.baseline.has(path)) this.addChange(path, "added", "Created during run");
        else if (this.baseline.get(path) !== signature) this.addChange(path, "modified", "Changed during run");
      }
      for (const path of this.baseline.keys()) if (!current.has(path)) this.addChange(path, "deleted", "Deleted during run");
      this.baseline = null;
      this.renderChanges();
    } finally {
      this.finishing = false;
    }
  }

  private addChange(path: string, kind: ChangeKind, detail: string) {
    this.changes.set(`${kind}:${path}`, { path, kind, detail });
    this.renderChanges();
  }

  private renderChanges() {
    clear(this.changesRoot);
    const items = [...this.changes.values()];
    if (!items.length) {
      this.changesRoot.appendChild(el("div", { class: "inspector-state" }, ["No workspace changes recorded yet."]));
      return;
    }
    const summary = el("div", { class: "changes-summary" }, [`${items.length} recorded change${items.length === 1 ? "" : "s"}`]);
    this.changesRoot.appendChild(summary);
    for (const item of items) {
      const button = el("button", { class: `change-item ${item.kind}`, title: item.detail });
      button.append(el("span", { class: "change-kind" }, [item.kind.slice(0, 1).toUpperCase()]));
      button.append(el("span", { class: "change-path" }, [item.path]));
      if (!["deleted", "command"].includes(item.kind)) button.addEventListener("click", () => void this.openFile(item.path));
      else button.setAttribute("aria-disabled", "true");
      this.changesRoot.appendChild(button);
    }
  }
}
