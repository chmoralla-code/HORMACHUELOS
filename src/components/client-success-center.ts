import { icon } from "./icons";
import { redactChatCredentials } from "./session";
import { clear, el } from "./util";

const STORAGE_KEY = "ai-forge:client-success-center:v1";
const FIELD_LIMIT = 1_200;

export type OutcomeBrief = {
  goal: string;
  audience: string;
  nonNegotiables: string;
  done: string;
  updatedAt: number;
};

export type DeliveryChecklist = {
  brief: boolean;
  build: boolean;
  qa: boolean;
  handoff: boolean;
};

export type ProjectSuccessState = {
  version: 1;
  brief: OutcomeBrief;
  checklist: DeliveryChecklist;
  updatedAt: number;
};

export type ClientSuccessDispatch =
  | "sent"
  | "queued"
  | "needs_project"
  | "usage_exhausted"
  | "stopping";

export type ClientPackExportResult = {
  zipPath: string;
  filesCount: number;
};

type RecipeId = "blueprint" | "build" | "qa" | "handoff";

type ClientSuccessHandlers = {
  getProjectPath: () => string | null;
  onRunRecipe: (prompt: string) => ClientSuccessDispatch | Promise<ClientSuccessDispatch>;
  onExportClientPack: (handoffSummary: string) => Promise<ClientPackExportResult | null>;
};

type BriefInputs = {
  goal: HTMLTextAreaElement;
  audience: HTMLInputElement;
  nonNegotiables: HTMLTextAreaElement;
  done: HTMLTextAreaElement;
};

const recipeDetails: Record<RecipeId, { title: string; eyebrow: string; description: string; iconName: "planList" | "spark" | "bug" | "export"; checklist: keyof DeliveryChecklist }> = {
  blueprint: {
    title: "Blueprint",
    eyebrow: "Clarify scope",
    description: "Inspect the project and produce a practical build plan, risks, and acceptance checks before implementation.",
    iconName: "planList",
    checklist: "brief",
  },
  build: {
    title: "Build & prove",
    eyebrow: "Ship with evidence",
    description: "Implement the outcome, run the right checks, and keep working until the result can be demonstrated.",
    iconName: "spark",
    checklist: "build",
  },
  qa: {
    title: "QA & repair",
    eyebrow: "Quality gate",
    description: "Exercise the real project, inspect the preview, repair failures, and report what was verified.",
    iconName: "bug",
    checklist: "qa",
  },
  handoff: {
    title: "Client handoff",
    eyebrow: "Ready to deliver",
    description: "Prepare concise launch notes, setup instructions, and a client-safe project package without secrets.",
    iconName: "export",
    checklist: "handoff",
  },
};

function projectKey(path: string): string {
  return String(path || "")
    .trim()
    .replace(/[\\/]+$/, "")
    .toLocaleLowerCase();
}

function projectName(path: string): string {
  const parts = String(path || "").replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.at(-1) || "Current project";
}

function cleanText(value: unknown, max = FIELD_LIMIT): string {
  return redactChatCredentials(String(value || ""))
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, max);
}

function emptyState(): ProjectSuccessState {
  return {
    version: 1,
    brief: { goal: "", audience: "", nonNegotiables: "", done: "", updatedAt: 0 },
    checklist: { brief: false, build: false, qa: false, handoff: false },
    updatedAt: 0,
  };
}

function normalizeState(value: unknown): ProjectSuccessState {
  const raw = value && typeof value === "object" ? value as Partial<ProjectSuccessState> : {};
  const rawBrief = raw.brief && typeof raw.brief === "object" ? raw.brief as Partial<OutcomeBrief> : {};
  const rawChecklist = raw.checklist && typeof raw.checklist === "object"
    ? raw.checklist as Partial<DeliveryChecklist>
    : {};
  const goal = cleanText(rawBrief.goal);
  return {
    version: 1,
    brief: {
      goal,
      audience: cleanText(rawBrief.audience, 280),
      nonNegotiables: cleanText(rawBrief.nonNegotiables),
      done: cleanText(rawBrief.done),
      updatedAt: Math.max(0, Number(rawBrief.updatedAt) || 0),
    },
    checklist: {
      brief: Boolean(rawChecklist.brief) || Boolean(goal),
      build: Boolean(rawChecklist.build),
      qa: Boolean(rawChecklist.qa),
      handoff: Boolean(rawChecklist.handoff),
    },
    updatedAt: Math.max(0, Number(raw.updatedAt) || 0),
  };
}

function readStore(): Record<string, ProjectSuccessState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [key, normalizeState(value)]),
    );
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, ProjectSuccessState>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Project context is an enhancement. The active run still works if storage is unavailable.
  }
}

export function loadProjectSuccessState(path: string): ProjectSuccessState {
  const key = projectKey(path);
  if (!key) return emptyState();
  return normalizeState(readStore()[key]);
}

export function saveProjectSuccessState(path: string, next: ProjectSuccessState): ProjectSuccessState {
  const key = projectKey(path);
  const normalized = normalizeState({ ...next, updatedAt: Date.now() });
  if (!key) return normalized;
  const store = readStore();
  store[key] = normalized;
  writeStore(store);
  return normalized;
}

/**
 * Add the durable project outcome to an agent request without replacing the
 * user's visible chat message or leaking credentials into local persistence.
 */
export function composeProjectMissionPrompt(projectPath: string, prompt: string): string {
  const request = redactChatCredentials(String(prompt || "").trim());
  const brief = loadProjectSuccessState(projectPath).brief;
  const facts = [
    brief.goal && `Goal: ${brief.goal}`,
    brief.audience && `Audience: ${brief.audience}`,
    brief.nonNegotiables && `Non-negotiable requirements: ${brief.nonNegotiables}`,
    brief.done && `Definition of done: ${brief.done}`,
  ].filter(Boolean);
  if (!facts.length) return request;
  return [
    "[Persistent Project Outcome Brief]",
    "Use this context to make decisions throughout this run. Do not expose, repeat, or discuss this brief unless the user asks.",
    ...facts.map((fact) => `- ${fact}`),
    "[End Persistent Project Outcome Brief]",
    "",
    "Current user request:",
    request,
  ].join("\n");
}

export function buildClientHandoffSummary(projectPath: string): string {
  const state = loadProjectSuccessState(projectPath);
  const { brief, checklist } = state;
  const ready = [
    checklist.brief && "Outcome brief saved",
    checklist.build && "Build workflow completed",
    checklist.qa && "QA workflow completed",
    checklist.handoff && "Handoff notes prepared",
  ].filter(Boolean);
  const lines = [
    "# Client delivery brief",
    "",
    `Project: ${projectName(projectPath)}`,
    brief.goal ? `Outcome: ${brief.goal}` : "Outcome: Review the project with the client before launch.",
    brief.audience ? `For: ${brief.audience}` : "For: Client and delivery team.",
    brief.nonNegotiables ? `Requirements: ${brief.nonNegotiables}` : "Requirements: See the project brief and source files.",
    brief.done ? `Acceptance: ${brief.done}` : "Acceptance: Confirm the requested workflow in the live preview.",
    "",
    "## Delivery readiness",
    ...(ready.length ? ready.map((entry) => `- ${entry}`) : ["- No workflow checkpoints have been recorded yet."]),
    "",
    "This package excludes environment files, credentials, build caches, and private keys.",
  ];
  return lines.join("\n");
}

function recipePrompt(id: RecipeId): string {
  switch (id) {
    case "blueprint":
      return [
        "Run the Blueprint workflow for this project.",
        "Inspect the existing project first. Then produce a short, concrete implementation plan with the affected files, validation steps, risks, and acceptance criteria.",
        "Do not make unrelated changes. If essential information is missing, ask one focused question; otherwise proceed with the best evidence-based plan.",
      ].join("\n");
    case "build":
      return [
        "Run the Build & Prove workflow for this project.",
        "Inspect the current implementation, carry the requested outcome through to working code, and keep going across all required files. Use tools rather than merely describing the next step.",
        "Run the most relevant checks or preview verification before completion. Repair failures you can safely fix, preserve existing behavior, and finish with concise evidence of what works.",
      ].join("\n");
    case "qa":
      return [
        "Run the QA & Repair workflow for this project.",
        "Inspect the real project and preview, execute the most relevant tests or build checks, and verify the important user path. Fix failures, regressions, unreadable states, and obvious responsive issues you find.",
        "Do not stop at an observation. Keep working until the checked path is either verified or clearly blocked, then report the exact evidence and any remaining blocker.",
      ].join("\n");
    case "handoff":
      return [
        "Run the Client Handoff workflow for this project.",
        "Prepare the project for a non-technical client: concise README or launch notes, setup/run steps, what was verified, known limits, and a short change summary. Never include secrets, API keys, local machine paths, or generated build caches.",
        "Use the client-pack export tool when the project is ready, and report the delivered files and any client action still required.",
      ].join("\n");
  }
}

function dispatchMessage(result: ClientSuccessDispatch): string {
  switch (result) {
    case "queued":
      return "Workflow queued behind the current run. It will start automatically.";
    case "sent":
      return "Workflow sent to the active model with this project’s outcome brief.";
    case "usage_exhausted":
      return "This workflow could not start because the current plan has reached its usage limit.";
    case "stopping":
      return "The current run is stopping. Start this workflow once it is ready.";
    case "needs_project":
      return "Open a project before starting a workflow.";
  }
}

export class ClientSuccessCenter {
  private projectPath: string | null = null;
  private returnFocus: HTMLElement | null = null;
  private status = "";

  constructor(
    private root: HTMLElement,
    private handlers: ClientSuccessHandlers,
  ) {}

  open(): void {
    const path = this.handlers.getProjectPath();
    if (!path) return;
    this.projectPath = path;
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.status = "";
    this.render();
  }

  close(): void {
    clear(this.root);
    this.projectPath = null;
    this.returnFocus?.focus({ preventScroll: true });
    this.returnFocus = null;
  }

  private saveBrief(state: ProjectSuccessState, inputs: BriefInputs): ProjectSuccessState {
    if (!this.projectPath) return state;
    const goal = cleanText(inputs.goal.value);
    const next = saveProjectSuccessState(this.projectPath, {
      ...state,
      brief: {
        goal,
        audience: cleanText(inputs.audience.value, 280),
        nonNegotiables: cleanText(inputs.nonNegotiables.value),
        done: cleanText(inputs.done.value),
        updatedAt: Date.now(),
      },
      checklist: { ...state.checklist, brief: Boolean(goal) },
    });
    return next;
  }

  private async startRecipe(id: RecipeId, state: ProjectSuccessState, inputs: BriefInputs): Promise<void> {
    this.saveBrief(state, inputs);
    const result = await this.handlers.onRunRecipe(recipePrompt(id));
    this.status = dispatchMessage(result);
    this.render();
  }

  private async exportPack(state: ProjectSuccessState, inputs: BriefInputs): Promise<void> {
    const saved = this.saveBrief(state, inputs);
    if (!this.projectPath) return;
    this.status = "Creating a client-safe delivery package…";
    this.render();
    try {
      const result = await this.handlers.onExportClientPack(buildClientHandoffSummary(this.projectPath));
      if (!result) {
        this.status = "Client pack was not created because no active project is available.";
      } else {
        saveProjectSuccessState(this.projectPath, {
          ...saved,
          checklist: { ...saved.checklist, handoff: true },
        });
        this.status = `Client pack saved: ${result.zipPath} (${result.filesCount} files).`;
      }
    } catch (error) {
      this.status = `Client pack failed: ${String(error)}`;
    }
    this.render();
  }

  private render(): void {
    const path = this.projectPath;
    if (!path) return;
    const state = loadProjectSuccessState(path);
    clear(this.root);

    const overlay = el("div", { class: "modal-overlay client-success-overlay" });
    const modal = el("section", {
      class: "modal client-success-modal",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "client-success-title",
      tabindex: "-1",
      "data-client-success-center": "true",
    });

    const head = el("header", { class: "client-success-head" });
    const headCopy = el("div", { class: "client-success-title-wrap" });
    headCopy.append(
      el("div", { class: "client-success-eyebrow" }, ["CLIENT SUCCESS SYSTEM"]),
      el("h2", { class: "client-success-title", id: "client-success-title" }, ["Make this project easy to win and deliver"]),
      el("p", { class: "client-success-subtitle" }, ["A project-scoped outcome brief, delivery workflows, and handoff readiness that stay with this workspace."]),
    );
    const closeButton = el("button", {
      class: "client-success-close",
      type: "button",
      "aria-label": "Close Client Success Center",
      html: icon("close", 17),
    }) as HTMLButtonElement;
    closeButton.addEventListener("click", () => this.close());
    head.append(headCopy, closeButton);
    modal.appendChild(head);

    const body = el("div", { class: "client-success-body" });
    const projectStrip = el("div", { class: "client-success-project" });
    projectStrip.append(
      el("span", { class: "client-success-project-mark", html: icon("folder", 15) }),
      el("span", { class: "client-success-project-label" }, ["Active project"]),
      el("strong", { class: "client-success-project-name" }, [projectName(path)]),
    );
    body.appendChild(projectStrip);

    const completed = Object.values(state.checklist).filter(Boolean).length;
    const readiness = el("section", { class: "client-success-readiness", "aria-label": "Delivery readiness" });
    const readinessHead = el("div", { class: "client-success-section-head" });
    readinessHead.append(
      el("div", {}, [
        el("div", { class: "client-success-kicker" }, ["DELIVERY READINESS"]),
        el("h3", { class: "client-success-section-title" }, [`${completed}/4 signals in place`]),
      ]),
      el("span", { class: "client-success-score", "data-readiness-score": String(completed) }, [`${Math.round((completed / 4) * 100)}%`]),
    );
    readiness.appendChild(readinessHead);
    const meters = el("div", { class: "client-success-meters" });
    const labels: Record<keyof DeliveryChecklist, string> = {
      brief: "Outcome brief",
      build: "Build workflow",
      qa: "QA verified",
      handoff: "Client handoff",
    };
    (Object.keys(labels) as (keyof DeliveryChecklist)[]).forEach((key) => {
      const item = el("button", {
        class: `client-success-meter${state.checklist[key] ? " is-ready" : ""}`,
        type: "button",
        "aria-pressed": String(state.checklist[key]),
        "data-readiness-item": key,
      });
      item.append(
        el("span", { class: "client-success-meter-dot", "aria-hidden": "true" }),
        el("span", {}, [labels[key]]),
      );
      item.addEventListener("click", () => {
        if (!this.projectPath) return;
        saveProjectSuccessState(this.projectPath, {
          ...state,
          checklist: { ...state.checklist, [key]: !state.checklist[key] },
        });
        this.status = `${labels[key]} marked ${state.checklist[key] ? "not ready" : "ready"}.`;
        this.render();
      });
      meters.appendChild(item);
    });
    readiness.appendChild(meters);
    body.appendChild(readiness);

    const briefSection = el("section", { class: "client-success-brief", "aria-labelledby": "client-success-brief-title" });
    briefSection.append(
      el("div", { class: "client-success-section-head compact" }, [
        el("div", {}, [
          el("div", { class: "client-success-kicker" }, ["PROJECT MEMORY"]),
          el("h3", { class: "client-success-section-title", id: "client-success-brief-title" }, ["Outcome brief"]),
        ]),
        el("p", { class: "client-success-section-note" }, ["Used as durable agent context for this project."]),
      ]),
    );
    const form = el("div", { class: "client-success-form" });
    const goal = el("textarea", {
      class: "client-success-field client-success-goal",
      id: "client-success-goal",
      placeholder: "What should this project achieve for the client?",
      maxlength: String(FIELD_LIMIT),
      rows: "2",
      "data-client-brief": "goal",
    }) as HTMLTextAreaElement;
    goal.value = state.brief.goal;
    const audience = el("input", {
      class: "client-success-field",
      id: "client-success-audience",
      type: "text",
      placeholder: "Who is it for? e.g. restaurant owners on mobile",
      maxlength: "280",
      "data-client-brief": "audience",
    }) as HTMLInputElement;
    audience.value = state.brief.audience;
    const nonNegotiables = el("textarea", {
      class: "client-success-field",
      id: "client-success-requirements",
      placeholder: "Non-negotiables: brand, stack, security, deadlines, or constraints",
      maxlength: String(FIELD_LIMIT),
      rows: "2",
      "data-client-brief": "requirements",
    }) as HTMLTextAreaElement;
    nonNegotiables.value = state.brief.nonNegotiables;
    const done = el("textarea", {
      class: "client-success-field",
      id: "client-success-done",
      placeholder: "How will we know it is ready to hand over?",
      maxlength: String(FIELD_LIMIT),
      rows: "2",
      "data-client-brief": "done",
    }) as HTMLTextAreaElement;
    done.value = state.brief.done;
    const inputs: BriefInputs = { goal, audience, nonNegotiables, done };
    const fields = [
      ["Client outcome", goal],
      ["Audience", audience],
      ["Requirements", nonNegotiables],
      ["Definition of done", done],
    ] as const;
    for (const [label, field] of fields) {
      const labelNode = el("label", { class: "client-success-field-wrap", for: field.id });
      labelNode.append(el("span", { class: "client-success-field-label" }, [label]), field);
      form.appendChild(labelNode);
    }
    briefSection.appendChild(form);
    const briefActions = el("div", { class: "client-success-brief-actions" });
    const saveBrief = el("button", { class: "btn primary client-success-save", type: "button", "data-client-success-save": "true" }, ["Save outcome brief"]);
    saveBrief.addEventListener("click", () => {
      this.saveBrief(state, inputs);
      this.status = "Outcome brief saved. Future prompts for this project will carry it automatically.";
      this.render();
    });
    briefActions.append(
      el("span", { class: "client-success-field-hint" }, ["Credentials are automatically redacted before this brief is saved."]),
      saveBrief,
    );
    briefSection.appendChild(briefActions);
    body.appendChild(briefSection);

    const workflows = el("section", { class: "client-success-workflows", "aria-labelledby": "client-success-workflows-title" });
    workflows.appendChild(el("div", { class: "client-success-section-head compact" }, [
      el("div", {}, [
        el("div", { class: "client-success-kicker" }, ["ONE-CLICK WORKFLOWS"]),
        el("h3", { class: "client-success-section-title", id: "client-success-workflows-title" }, ["Turn intent into proof"]),
      ]),
      el("p", { class: "client-success-section-note" }, ["Uses the selected model and the normal queue rules."]),
    ]));
    const workflowGrid = el("div", { class: "client-success-workflow-grid" });
    (Object.keys(recipeDetails) as RecipeId[]).forEach((id) => {
      const recipe = recipeDetails[id];
      const card = el("article", { class: "client-success-workflow", "data-client-workflow": id });
      const cardTop = el("div", { class: "client-success-workflow-top" });
      cardTop.append(
        el("span", { class: "client-success-workflow-icon", html: icon(recipe.iconName, 16) }),
        el("span", { class: "client-success-workflow-eyebrow" }, [recipe.eyebrow]),
      );
      const run = el("button", {
        class: "client-success-workflow-run",
        type: "button",
        "data-run-workflow": id,
      }, ["Run"]);
      run.addEventListener("click", () => void this.startRecipe(id, state, inputs));
      card.append(
        cardTop,
        el("h4", { class: "client-success-workflow-title" }, [recipe.title]),
        el("p", { class: "client-success-workflow-copy" }, [recipe.description]),
        run,
      );
      workflowGrid.appendChild(card);
    });
    workflows.appendChild(workflowGrid);
    body.appendChild(workflows);

    const handoff = el("section", { class: "client-success-handoff", "aria-labelledby": "client-success-handoff-title" });
    const handoffCopy = el("div", { class: "client-success-handoff-copy" });
    handoffCopy.append(
      el("div", { class: "client-success-kicker" }, ["CLIENT-READY DELIVERY"]),
      el("h3", { class: "client-success-section-title", id: "client-success-handoff-title" }, ["Create a safe client pack"]),
      el("p", { class: "client-success-handoff-note" }, ["Includes a tailored delivery brief and excludes environment files, credentials, private keys, and build caches."]),
    );
    const packButton = el("button", {
      class: "btn client-success-pack",
      type: "button",
      "data-export-client-pack": "true",
    });
    packButton.append(el("span", { html: icon("export", 15) }), document.createTextNode("Create client pack"));
    packButton.addEventListener("click", () => void this.exportPack(state, inputs));
    handoff.append(handoffCopy, packButton);
    body.appendChild(handoff);

    if (this.status) {
      body.appendChild(el("p", { class: "client-success-status", role: "status", "data-client-success-status": "true" }, [this.status]));
    }
    modal.appendChild(body);
    overlay.appendChild(modal);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) this.close();
    });
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.close();
      }
    });
    this.root.appendChild(overlay);
    overlay.style.pointerEvents = "auto";
    window.setTimeout(() => goal.focus({ preventScroll: true }), 0);
  }
}
