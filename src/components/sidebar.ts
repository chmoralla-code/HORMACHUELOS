import { api } from "../ipc";
import { icon } from "./icons";
import { clear, div, el, displayPlanLabel } from "./util";
import { SESSION_TOKEN_BUDGET, type Session } from "./session";

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
  onOpenSettings: () => void;
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
  private usageMeta: UsageDisplayMeta = {};
  private usageRoot: HTMLElement | null = null;
  private accountRoot: HTMLElement | null = null;
  private accountStatus: AccountStatusState = { state: "checking" };

  constructor(handlers: {
    onNewProject: () => void;
    onOpenProject: () => void;
    onOpenSettings: () => void;
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
    this.onOpenSettings = handlers.onOpenSettings;
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

    // Project path/name stays off the left sandwich drawer (composer chip + New/Open cover it)

    const actions = el("div", { class: "sb-actions" });
    actions.appendChild(this.actionBtn("new", "New Build", this.onNewProject));
    actions.appendChild(this.actionBtn("open", "Open Project", this.onOpenProject));
    actions.appendChild(this.actionBtn("export", "Client Pack", this.onExportClientPack));
    actions.appendChild(this.actionBtn("settings", "Settings", this.onOpenSettings));
    this.node.appendChild(actions);

    // Sessions section
    const sessionSection = el("div", { class: "sb-section" });
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
    this.node.appendChild(sessionSection);

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

  /** Keep project path in sync (UI lives on the composer chip, not the left drawer). */
  setProject(path: string | null) {
    this.projectPath = path;
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

  private formatTokens(n: number): string {
    const v = Math.max(0, Math.floor(Number(n) || 0));
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(v >= 100_000 ? 0 : 1)}k`;
    return String(v);
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
    const used = Math.max(0, Math.floor(Number(m.tokensUsed) || 0));
    const budget = Math.max(0, Math.floor(Number(m.tokenBudget) || 0));

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
        active
          ? `${clampedPct}% remaining (${this.formatTokens(used)} / ${this.formatTokens(budget)} used)`
          : "No active plan",
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
        hint.textContent = `Used ${this.formatTokens(used)} / ${this.formatTokens(budget)} · Mag-load`;
      } else if (exp) {
        hint.textContent = `${this.formatTokens(used)} / ${this.formatTokens(budget)} used · ends ${exp}`;
      } else {
        hint.textContent = `${this.formatTokens(used)} / ${this.formatTokens(budget)} used`;
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
      ? `${name} · ${clampedPct}% left · ${this.formatTokens(used)}/${this.formatTokens(budget)}`
      : "No active plan — Mag-load via GCash";
  }
  private actionBtn(
    iconName: "new" | "open" | "settings" | "export",
    label: string,
    onClick: () => void,
  ): HTMLElement {
    const btn = el("button", { class: "sb-action", html: icon(iconName) + `<span>${label}</span>` });
    btn.addEventListener("click", onClick);
    return btn;
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
