import { api } from "../ipc";
import { icon } from "./icons";
import { clear, div, el, displayPlanLabel } from "./util";
import { SESSION_TOKEN_BUDGET, type Session } from "./session";
import type { ProjectWorkspace } from "./projects";

export type UsageDisplayMeta = {
  /** Remaining plan % (for aria / empty styling). */
  percent?: number;
  poolLabel?: string;
  resetsIn?: string;
  blockedBy?: string;
  planRemaining?: number;
  planExpiresAt?: string;
  planName?: string;
  planActive?: boolean;
  tokensUsed?: number;
  tokenBudget?: number;
};

export type AccountStatusState =
  | { state: "checking" }
  | { state: "synced"; email: string; name?: string; plan?: string | null }
  | { state: "offline"; email?: string; detail?: string }
  | { state: "signed_out"; detail?: string };

export class Sidebar {
  node: HTMLElement;
  onNewProject: () => void;
  onOpenProject: () => void;
  onSelectProject: (path: string) => void;
  onAddAnotherProject: () => void;
  onOpenSettings: () => void;
  /** Check the hosted release feed and offer the latest installer. */
  onCheckForUpdates: () => void;
  onNewSession: () => void;
  onSelectSession: (id: string) => void;
  onDeleteAllSessions: () => void;
  onDeleteSession: (id: string) => void;
  onRenameSession: (id: string, title: string) => void;
  /** Export client pack zip for freelancers. */
  onExportClientPack: () => void;
  /** Open GCash top-up / pricing. */
  onTopUp: () => void;
  /** Open website account / re-link desktop login. */
  onManageAccount: () => void;
  /** Refresh website sync status. */
  onRefreshAccount: () => void;
  /** Current project path (composer chip shows it; left drawer does not). */
  private projectPath: string | null = null;
  private projectWorkspaces: ProjectWorkspace[] = [];
  private activeProjectPath: string | null = null;
  private runningProjectPaths = new Set<string>();
  private usageMeta: UsageDisplayMeta = {};
  private usageRoot: HTMLElement | null = null;
  private accountRoot: HTMLElement | null = null;
  private accountStatus: AccountStatusState = { state: "checking" };
  private updateButton: HTMLButtonElement | null = null;
  private updateAvailable = false;
  private updateVersion = "";

  constructor(handlers: {
    onNewProject: () => void;
    onOpenProject: () => void;
    onSelectProject: (path: string) => void;
    onAddAnotherProject: () => void;
    onOpenSettings: () => void;
    onCheckForUpdates: () => void;
    onNewSession: () => void;
    onSelectSession: (id: string) => void;
    onDeleteAllSessions: () => void;
    onDeleteSession: (id: string) => void;
    onRenameSession: (id: string, title: string) => void;
    onExportClientPack: () => void;
    onTopUp: () => void;
    onManageAccount: () => void;
    onRefreshAccount: () => void;
  }) {
    this.onNewProject = handlers.onNewProject;
    this.onOpenProject = handlers.onOpenProject;
    this.onSelectProject = handlers.onSelectProject;
    this.onAddAnotherProject = handlers.onAddAnotherProject;
    this.onOpenSettings = handlers.onOpenSettings;
    this.onCheckForUpdates = handlers.onCheckForUpdates;
    this.onNewSession = handlers.onNewSession;
    this.onSelectSession = handlers.onSelectSession;
    this.onDeleteAllSessions = handlers.onDeleteAllSessions;
    this.onDeleteSession = handlers.onDeleteSession;
    this.onRenameSession = handlers.onRenameSession;
    this.onExportClientPack = handlers.onExportClientPack;
    this.onTopUp = handlers.onTopUp;
    this.onManageAccount = handlers.onManageAccount;
    this.onRefreshAccount = handlers.onRefreshAccount;
    this.node = document.getElementById("sidebar")!;
    this.render();
  }
  async render(sessions: Session[] = [], activeSessionId?: string | null, runningIds: Set<string> = new Set()) {
    const version = await api.appVersion().catch(() => "0.1.0");

    clear(this.node);
    this.usageRoot = null;

    this.node.appendChild(div("sb-brand",
      `<div class="sb-logo">H</div><div class="sb-title">Hormachuelos</div><div class="sb-version">v${version}</div>`));

    const actions = el("div", { class: "sb-actions" });
    const updateBtn = this.actionBtn("refresh", "Update", this.onCheckForUpdates);
    updateBtn.classList.add("sb-update-action");
    this.updateButton = updateBtn;
    this.paintUpdateNotification();
    actions.appendChild(updateBtn);
    // Keep the workspace list as the primary part of the sidebar. Less
    // frequent setup actions live in a compact, keyboard-accessible menu so
    // projects, sessions, and usage do not get pushed below the fold. The
    // update control remains above it, so it is never hidden by the menu.
    actions.appendChild(this.buildWorkspaceActionsMenu());
    this.node.appendChild(actions);

    const workspaceSections = el("div", { class: "sb-workspace-sections" });
    workspaceSections.appendChild(this.buildProjectsSection());

    // Sessions section
    const sessionSection = el("div", { class: "sb-section sb-sessions-section" });
    const sessionHeader = el("div", { class: "sb-section-row" });
    sessionHeader.appendChild(el("div", { class: "sb-section-label" }, ["Sessions"]));
    const sessionActions = el("div", { class: "sb-session-actions" });
    const newSessionBtn = el("button", { class: "sb-new-session", type: "button", "aria-label": "New session", title: "New session", html: icon("new", 15) });
    newSessionBtn.addEventListener("click", () => this.onNewSession());
    sessionActions.appendChild(newSessionBtn);
    if (sessions.length > 0) {
      const delAllBtn = el("button", { class: "sb-del-all-sessions", type: "button", "aria-label": "Delete all sessions", title: "Delete all sessions", html: icon("trash", 15) });
      delAllBtn.addEventListener("click", () => this.onDeleteAllSessions());
      sessionActions.appendChild(delAllBtn);
    }
    sessionHeader.appendChild(sessionActions);
    sessionSection.appendChild(sessionHeader);
    const sessionList = el("div", { class: "sb-recent" });
    if (sessions.length === 0) {
      sessionList.appendChild(el("div", { class: "sb-recent-item empty" }, ["No sessions yet"]));
    } else {
      for (const s of sessions) {
        const isRunning = runningIds.has(s.id);
        const item = el("div", {
          class:
            "sb-recent-item sb-session-item" +
            (s.id === activeSessionId ? " active" : "") +
            (isRunning ? " running" : ""),
          title: isRunning
            ? `${s.title} — running (you can switch sessions)`
            : `${s.title} — double-click name to rename`,
          "aria-current": s.id === activeSessionId ? "page" : "false",
          role: "button",
          tabindex: "0",
        });
        item.appendChild(div("dot" + (isRunning ? " live" : "")));
        const label = el("span", { class: "sb-session-title" }, [s.title]);
        if (isRunning) {
          item.appendChild(el("span", { class: "sb-session-running", title: "Running" }, ["●"]));
        }
        label.title = "Double-click to rename";
        item.appendChild(label);

        const renameBtn = el("button", {
          class: "sb-session-rename",
          type: "button",
          "aria-label": "Rename session",
          title: "Rename",
          html: "✎",
        }) as HTMLButtonElement;
        renameBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.beginRename(s.id, s.title, label, item);
        });
        item.appendChild(renameBtn);

        const delBtn = el("button", {
          class: "sb-session-del", type: "button", "aria-label": "Delete session", title: "Delete session",
          html: "&times;",
        }) as HTMLButtonElement;
        delBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.onDeleteSession(s.id);
        });
        item.appendChild(delBtn);

        const select = () => this.onSelectSession(s.id);
        item.addEventListener("click", (ev) => {
          if ((ev.target as HTMLElement).closest("button")) return;
          if ((ev.target as HTMLElement).closest(".sb-session-rename-input")) return;
          select();
        });
        item.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            select();
          }
          if (ev.key === "F2") {
            ev.preventDefault();
            this.beginRename(s.id, s.title, label, item);
          }
        });
        label.addEventListener("dblclick", (ev) => {
          ev.stopPropagation();
          this.beginRename(s.id, s.title, label, item);
        });
        sessionList.appendChild(item);
      }
    }
    sessionSection.appendChild(sessionList);
    workspaceSections.appendChild(sessionSection);
    this.node.appendChild(workspaceSections);

    // Usage limit — below sessions in the left sandwich drawer
    this.node.appendChild(this.buildUsageSection());

    // Website account sync status (hormachuelos.vercel.app)
    this.node.appendChild(this.buildAccountSection());

    const footer = el("div", { class: "sb-footer" });
    footer.appendChild(el("div", { class: "sb-status", id: "status-indicator", role: "status", "aria-live": "polite", html: `<span class="pulse"></span><span id="status-text">Ready</span>` }));
    this.node.appendChild(footer);

    this.paintUsage();
    this.paintAccount();
  }

  setAccountStatus(status: AccountStatusState) {
    this.accountStatus = status;
    this.paintAccount();
  }

  /** Show a durable sidebar notification when the hosted release feed has a newer build. */
  setUpdateNotification(available: boolean, version?: string | null) {
    this.updateAvailable = available;
    this.updateVersion = available
      ? String(version || "").trim().replace(/^v/i, "")
      : "";
    this.paintUpdateNotification();
  }

  private paintUpdateNotification() {
    const button = this.updateButton;
    if (!button) return;
    button.querySelector(".sb-update-badge")?.remove();
    button.classList.toggle("has-update", this.updateAvailable);
    button.dataset.updateAvailable = this.updateAvailable ? "true" : "false";
    // `icon()` also returns a span. Target the label explicitly so a status
    // update never overwrites the icon and leaves two visible Update labels.
    const label = button.querySelector<HTMLElement>(":scope > .sb-action-label");

    if (!this.updateAvailable) {
      if (label) label.textContent = "Update";
      button.removeAttribute("aria-label");
      button.setAttribute("title", "Check for updates");
      return;
    }

    const versionLabel = this.updateVersion ? `v${this.updateVersion}` : "New";
    if (label) label.textContent = "Update";
    button.setAttribute("aria-label", `Update available: ${versionLabel}. Install and restart`);
    button.setAttribute("title", `Install ${versionLabel} inside Hormachuelos and restart`);
    button.appendChild(
      el("span", {
        class: "sb-update-badge",
        role: "status",
        "aria-live": "polite",
        "aria-label": `New software update ${versionLabel}`,
      }, [`NEW · ${versionLabel}`]),
    );
  }

  /** Keep project path in sync (UI lives on the composer chip, not the left drawer). */
  setProject(path: string | null) {
    this.projectPath = path;
    this.activeProjectPath = path;
  }

  /** Render an active workspace plus every other project already open in the app. */
  setProjectWorkspaces(
    workspaces: ProjectWorkspace[],
    activePath: string | null,
    runningPaths: Iterable<string> = [],
  ) {
    this.projectWorkspaces = [...workspaces];
    this.activeProjectPath = activePath;
    this.runningProjectPaths = new Set(
      [...runningPaths]
        .filter(Boolean)
        .map((path) => String(path).replace(/[\\/]+$/, "").toLocaleLowerCase()),
    );
  }

  private buildProjectsSection(): HTMLElement {
    const section = el("div", { class: "sb-section sb-projects-section" });
    const header = el("div", { class: "sb-section-row sb-projects-head" });
    header.appendChild(el("div", { class: "sb-section-label" }, ["Projects"]));
    const add = el(
      "button",
      {
        class: "sb-add-project",
        type: "button",
        title: "Add another project",
        "aria-label": "Add another project",
      },
      ["+ Add another project"],
    ) as HTMLButtonElement;
    add.addEventListener("click", () => this.onAddAnotherProject());
    header.appendChild(add);
    section.appendChild(header);

    const list = el("div", { class: "sb-projects-list", role: "list", "aria-label": "Open projects" });
    if (this.projectWorkspaces.length === 0) {
      list.appendChild(el("div", { class: "sb-project-empty" }, ["Create or open a project to keep it here."]));
    } else {
      const activeKey = String(this.activeProjectPath || "").replace(/[\\/]+$/, "").toLocaleLowerCase();
      for (const workspace of this.projectWorkspaces) {
        const key = workspace.path.replace(/[\\/]+$/, "").toLocaleLowerCase();
        const active = key === activeKey;
        const running = this.runningProjectPaths.has(key);
        const item = el(
          "button",
          {
            class: `sb-project-workspace${active ? " active" : ""}${running ? " running" : ""}`,
            type: "button",
            title: `${workspace.path}${running ? "\nAgent run in progress" : ""}`,
            "aria-current": active ? "page" : "false",
            role: "listitem",
          },
        ) as HTMLButtonElement;
        item.appendChild(el("span", { class: "sb-project-mark", "aria-hidden": "true" }, [(workspace.name[0] || "P").toUpperCase()]));
        const copy = el("span", { class: "sb-project-copy" });
        copy.appendChild(el("strong", {}, [workspace.name]));
        copy.appendChild(el("span", {}, [active ? "Active workspace" : running ? "Running in background" : "Ready"]));
        item.appendChild(copy);
        if (running) item.appendChild(el("span", { class: "sb-project-live", title: "Agent run in progress" }, ["●"]));
        item.addEventListener("click", () => this.onSelectProject(workspace.path));
        list.appendChild(item);
      }
    }
    section.appendChild(list);
    return section;
  }

  /**
   * Plan-period usage % (no hourly / weekly windows).
   * `tokens` / `contextLimit` kept for call-site compatibility; display uses meta.
   */
  setSessionUsage(
    _tokens: number,
    _contextLimit: number = SESSION_TOKEN_BUDGET,
    meta: UsageDisplayMeta = {},
  ) {
    this.usageMeta = meta || {};
    this.paintUsage();
  }

  private buildAccountSection(): HTMLElement {
    const section = el("div", { class: "sb-section sb-account-section" });
    const labelRow = el("div", { class: "sb-usage-label-row" });
    labelRow.appendChild(el("div", { class: "sb-section-label", style: "margin:0" }, ["Account"]));
    const refreshBtn = el("button", {
      class: "sb-account-refresh",
      type: "button",
      title: "Refresh website sync",
      "aria-label": "Refresh website sync",
    }, ["↻"]) as HTMLButtonElement;
    refreshBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onRefreshAccount();
    });
    labelRow.appendChild(refreshBtn);
    section.appendChild(labelRow);

    this.accountRoot = el("div", {
      class: "sb-account",
      role: "status",
      "aria-live": "polite",
      "aria-label": "Website account status",
    });
    this.accountRoot.addEventListener("click", () => this.onManageAccount());
    section.appendChild(this.accountRoot);
    return section;
  }

  private paintAccount() {
    if (!this.accountRoot) return;
    const s = this.accountStatus;
    clear(this.accountRoot);
    this.accountRoot.classList.remove("is-synced", "is-offline", "is-signed-out", "is-checking");

    const row = (title: string, subtitle: string) => {
      const wrap = el("div", { class: "sb-account-row" });
      wrap.appendChild(el("span", { class: "sb-account-dot" }));
      const copy = el("div", { class: "sb-account-copy" });
      copy.appendChild(el("strong", {}, [title]));
      const sub = el("span", {}, [subtitle]);
      sub.title = subtitle;
      copy.appendChild(sub);
      wrap.appendChild(copy);
      return wrap;
    };

    if (s.state === "checking") {
      this.accountRoot.classList.add("is-checking");
      this.accountRoot.appendChild(row("Checking sync…", "hormachuelos.vercel.app"));
      return;
    }

    if (s.state === "synced") {
      const who = s.name?.trim() || s.email;
      this.accountRoot.classList.add("is-synced");
      this.accountRoot.appendChild(row("Synced · signed in", who));
      this.accountRoot.appendChild(el("div", { class: "sb-account-meta" }, ["Website account linked"]));
      return;
    }

    if (s.state === "offline") {
      this.accountRoot.classList.add("is-offline");
      this.accountRoot.appendChild(
        row("Can't verify sync", s.email || "Saved session · website unreachable"),
      );
      this.accountRoot.appendChild(
        el("div", { class: "sb-account-meta" }, [s.detail || "Click to open website"]),
      );
      return;
    }

    this.accountRoot.classList.add("is-signed-out");
    this.accountRoot.appendChild(
      row("Not signed in", s.detail || "Sign in on hormachuelos.vercel.app"),
    );
    this.accountRoot.appendChild(
      el("div", { class: "sb-account-meta" }, ["Click to link website account"]),
    );
  }

  private buildUsageSection(): HTMLElement {
    const section = el("div", { class: "sb-section sb-usage-section" });
    const labelRow = el("div", { class: "sb-usage-label-row" });
    labelRow.appendChild(el("div", { class: "sb-section-label", style: "margin:0" }, ["Usage"]));
    section.appendChild(labelRow);

    this.usageRoot = el("div", {
      class: "sb-usage",
      role: "group",
      "aria-label": "Subscription and usage limits",
    });

    // Subscription the client currently has
    const sub = el("div", { class: "sb-usage-sub", "data-sub": "1" });
    sub.appendChild(
      el("div", { class: "sb-usage-sub-top" }, [
        el("span", { class: "sb-usage-sub-name", "data-sub-name": "1" }, ["—"]),
        el("span", { class: "sb-usage-sub-badge", "data-sub-badge": "1" }, ["—"]),
      ]),
    );
    sub.appendChild(el("div", { class: "sb-usage-sub-meta", "data-sub-meta": "1" }, ["—"]));

    // Single plan-period meter
    const row = el("div", { class: "sb-usage-row", "data-window": "plan" });
    row.appendChild(
      el("div", { class: "sb-usage-row-head" }, [
        el("span", { class: "sb-usage-row-label", "data-row-label": "plan" }, ["Period"]),
        el("span", { class: "sb-usage-row-pct", "data-pct": "plan" }, ["—"]),
      ]),
    );
    const track = el("div", {
      class: "sb-usage-meter",
      role: "progressbar",
      "aria-label": "Hosted usage remaining",
      "aria-valuemin": "0",
      "aria-valuemax": "100",
    });
    track.appendChild(el("div", { class: "sb-usage-meter-fill", "data-fill": "plan" }));
    row.appendChild(track);
    row.appendChild(el("div", { class: "sb-usage-row-hint", "data-hint": "plan", "data-plan": "1" }, ["—"]));

    const status = el("div", { class: "sb-usage-status", "data-status": "1" }, [""]);

    const topUp = el("button", {
      class: "sb-usage-topup",
      type: "button",
      title: "Mag-load more usage via GCash",
    }, ["Mag-load via GCash"]) as HTMLButtonElement;
    topUp.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onTopUp();
    });

    this.usageRoot.appendChild(sub);
    this.usageRoot.appendChild(row);
    this.usageRoot.appendChild(status);
    this.usageRoot.appendChild(topUp);
    section.appendChild(this.usageRoot);
    return section;
  }

  private formatPlanExpiry(isoDate: string): string {
    const raw = (isoDate || "").trim();
    if (!raw) return "";
    const t = Date.parse(raw.length <= 10 ? `${raw}T12:00:00Z` : raw);
    if (!Number.isFinite(t)) return raw;
    try {
      return new Date(t).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      });
    } catch {
      return raw;
    }
  }

  private paintUsage() {
    if (!this.usageRoot) return;
    const m = this.usageMeta;
    const planPct = typeof m.planRemaining === "number"
      ? m.planRemaining
      : typeof m.percent === "number"
        ? m.percent
        : 100;
    const blocked = m.blockedBy || "";
    const planId = m.planName || "free";
    const name = displayPlanLabel(planId);
    const active = m.planActive === true && !["free", "expired", ""].includes(planId.toLowerCase());
    const clampedPct = Math.max(0, Math.min(100, planPct));

    this.usageRoot.classList.toggle("usage-low", active && planPct <= 20 && planPct > 5);
    this.usageRoot.classList.toggle("usage-critical", active && planPct <= 5 && planPct > 0);
    this.usageRoot.classList.toggle("usage-empty", active && planPct <= 0);
    this.usageRoot.classList.toggle("is-free", !active);

    const fill = this.usageRoot.querySelector('[data-fill="plan"]') as HTMLElement | null;
    const pctEl = this.usageRoot.querySelector('[data-pct="plan"]');
    const hint = this.usageRoot.querySelector('[data-hint="plan"]');
    const row = this.usageRoot.querySelector('[data-window="plan"]');
    const rowLabel = this.usageRoot.querySelector('[data-row-label="plan"]');
    const meter = this.usageRoot.querySelector(".sb-usage-meter");
    if (fill) fill.style.width = active ? `${clampedPct}%` : "0%";
    if (pctEl) pctEl.textContent = active ? `${clampedPct}% left` : "—";
    if (rowLabel) rowLabel.textContent = active ? "Usage left" : "Plan";
    if (meter) {
      meter.setAttribute("aria-valuenow", active ? String(clampedPct) : "0");
      meter.setAttribute(
        "aria-valuetext",
        active ? `${clampedPct}% remaining this period` : "No active plan",
      );
    }
    if (hint) {
      const exp = this.formatPlanExpiry(m.planExpiresAt || "");
      if (!active) {
        hint.textContent =
          planId.toLowerCase() === "expired"
            ? "Plan expired · Mag-load to renew"
            : "No plan yet · Mag-load via GCash";
      } else if (planPct <= 0) {
        hint.textContent = "Period used up · Mag-load to continue";
      } else if (exp) {
        hint.textContent = `${clampedPct}% left · ends ${exp}`;
      } else {
        hint.textContent = `${clampedPct}% left this period`;
      }
    }
    row?.classList.toggle("is-byok", !active);
    row?.classList.toggle("is-empty", active && planPct <= 0);
    row?.classList.toggle("is-low", active && planPct <= 20 && planPct > 0);

    const nameEl = this.usageRoot.querySelector("[data-sub-name]");
    const badgeEl = this.usageRoot.querySelector("[data-sub-badge]");
    const metaEl = this.usageRoot.querySelector("[data-sub-meta]");
    if (nameEl) nameEl.textContent = active ? name : planId.toLowerCase() === "expired" ? "Expired" : "No plan";
    if (badgeEl) {
      badgeEl.textContent = active ? "Active" : planId.toLowerCase() === "expired" ? "Expired" : "None";
      badgeEl.classList.toggle("is-free", !active);
    }
    if (metaEl) {
      if (!active) {
        metaEl.textContent = "Buy or renew a plan to unlock hosted usage";
      } else {
        metaEl.textContent = `${clampedPct}% remaining this period`;
      }
    }

    const status = this.usageRoot.querySelector("[data-status]");
    if (status) {
      if (blocked === "plan" || (active && planPct <= 0)) {
        status.textContent = "Paused · plan usage used up · Mag-load to continue";
      } else {
        status.textContent = "";
      }
    }

    const topUp = this.usageRoot.querySelector(".sb-usage-topup") as HTMLButtonElement | null;
    if (topUp) {
      topUp.textContent = active ? "Mag-load / upgrade" : "Mag-load via GCash";
    }

    this.usageRoot.title = active
      ? `${name} · ${clampedPct}% left this period`
      : "No active plan — Mag-load via GCash";
  }
  private actionBtn(
    iconName: "new" | "open" | "settings" | "export" | "refresh",
    label: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const btn = el("button", {
      class: "sb-action",
      type: "button",
      html: icon(iconName) + `<span class="sb-action-label">${label}</span>`,
    }) as HTMLButtonElement;
    btn.addEventListener("click", onClick);
    return btn;
  }

  /**
   * Collapsible secondary workspace controls.  The update control intentionally
   * stays outside this menu: it must remain visible whenever a release is ready.
   */
  private buildWorkspaceActionsMenu(): HTMLDetailsElement {
    const menu = el("details", { class: "sb-action-menu" }) as HTMLDetailsElement;
    const toggle = el("summary", {
      class: "sb-action sb-actions-toggle",
      title: "Show workspace actions",
      "aria-label": "Workspace actions",
      "aria-expanded": "false",
      html:
        icon("menu") +
        '<span class="sb-action-label">Workspace actions</span>' +
        `<span class="sb-action-menu-chevron">${icon("chevronDown", 13)}</span>`,
    });
    const panel = el("div", {
      class: "sb-action-menu-panel",
      role: "group",
      "aria-label": "Workspace actions",
    });

    const addAction = (
      iconName: "new" | "open" | "settings" | "export",
      label: string,
      onClick: () => void,
    ) => {
      const action = this.actionBtn(iconName, label, () => {
        // Close before a picker or dialog receives focus, keeping the sidebar
        // clean when the user returns to their workspace.
        menu.open = false;
        onClick();
      });
      action.classList.add("sb-menu-action");
      panel.appendChild(action);
    };

    addAction("new", "New Build", this.onNewProject);
    addAction("open", "Open Project", this.onOpenProject);
    addAction("export", "Client Pack", this.onExportClientPack);
    addAction("settings", "Settings", this.onOpenSettings);

    const updateToggleState = () => {
      const open = menu.open;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("title", open ? "Hide workspace actions" : "Show workspace actions");
    };
    menu.addEventListener("toggle", updateToggleState);
    menu.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !menu.open) return;
      event.preventDefault();
      menu.open = false;
      (toggle as HTMLElement).focus();
    });

    menu.appendChild(toggle);
    menu.appendChild(panel);
    return menu;
  }

  /** Inline rename: replace title with an input, commit on Enter/blur. */
  private beginRename(id: string, currentTitle: string, label: HTMLElement, item: HTMLElement) {
    if (item.querySelector(".sb-session-rename-input")) return;

    const input = el("input", {
      class: "sb-session-rename-input field",
      type: "text",
      value: currentTitle,
      "aria-label": "Session name",
      maxlength: "80",
    }) as HTMLInputElement;

    label.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      if (commit && next && next !== currentTitle) {
        this.onRenameSession(id, next);
      } else {
        // Restore label if cancelled or empty
        const restored = el("span", { class: "sb-session-title" }, [currentTitle]);
        restored.title = "Double-click to rename";
        input.replaceWith(restored);
        restored.addEventListener("dblclick", (ev) => {
          ev.stopPropagation();
          this.beginRename(id, currentTitle, restored, item);
        });
      }
    };

    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") {
        ev.preventDefault();
        finish(true);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("click", (ev) => ev.stopPropagation());
  }

  setStatus(text: string, live: boolean = false) {
    const ind = document.getElementById("status-indicator");
    if (!ind) return;
    ind.classList.toggle("live", live);
    const txt = ind.querySelector("#status-text");
    if (txt) txt.textContent = text;
  }
}
