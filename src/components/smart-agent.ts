import type { AgentEvent } from "../ipc";
import { clear, div, el } from "./util";
import {
  redactChatCredentials,
  sanitizeSmartAgentTaskState,
  type Session,
  type SmartAgentStepState,
  type SmartAgentTaskState,
} from "./session";

const FALLBACK_STEPS = [
  ["scope", "Understand the request"],
  ["inspect", "Inspect the workspace"],
  ["implement", "Implement the requested work"],
  ["validate", "Validate the result"],
  ["deliver", "Deliver the result"],
] as const;

function cleanText(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const text = redactChatCredentials(value.trim()).replace(/\s+/g, " ");
  return text.slice(0, 300) || fallback;
}

function stepState(value: unknown): SmartAgentStepState {
  return value === "active" || value === "completed" || value === "paused" ? value : "pending";
}

function makePlan(payload: Record<string, unknown>): SmartAgentTaskState {
  const supplied = Array.isArray(payload.steps) ? payload.steps : [];
  const steps = supplied.length
    ? supplied.map((candidate, index) => {
        const raw = candidate && typeof candidate === "object"
          ? candidate as Record<string, unknown>
          : {};
        const fallback = FALLBACK_STEPS[index] || ["implement", "Implement the requested work"];
        return {
          id: cleanText(raw.id, fallback[0]).toLowerCase(),
          label: cleanText(raw.label, fallback[1]),
          state: stepState(raw.state),
        };
      })
    : FALLBACK_STEPS.map(([id, label], index) => ({
        id,
        label,
        state: index === 0 ? "active" as const : "pending" as const,
      }));
  const activeStep = Math.max(0, Math.min(steps.length - 1, Math.floor(Number(payload.active_step) || 0)));
  return sanitizeSmartAgentTaskState({
    version: 1,
    title: cleanText(payload.title, "Smart Agent"),
    summary: cleanText(payload.summary),
    steps,
    activeStep,
    status: payload.status === "completed" || payload.status === "paused" ? payload.status : "working",
    detail: cleanText(payload.detail, "Preparing a focused task plan..."),
    updatedAt: Date.now(),
  }) || {
    version: 1,
    title: "Smart Agent",
    summary: "Keeping this task focused and verified.",
    steps: FALLBACK_STEPS.map(([id, label], index) => ({
      id,
      label,
      state: index === 0 ? "active" as const : "pending" as const,
    })),
    activeStep: 0,
    status: "working",
    detail: "Preparing a focused task plan...",
    updatedAt: Date.now(),
  };
}

function updateProgress(
  state: SmartAgentTaskState,
  payload: Record<string, unknown>,
): SmartAgentTaskState {
  const step = Math.max(0, Math.min(state.steps.length - 1, Math.floor(Number(payload.step) || 0)));
  const status = payload.status === "completed" || payload.status === "paused" ? payload.status : "working";
  const completeAll = payload.complete_all === true || status === "completed";
  const nextSteps = state.steps.map((entry, index) => {
    if (completeAll || index < step) return { ...entry, state: "completed" as const };
    if (index === step) {
      return {
        ...entry,
        state: status === "paused" ? "paused" as const : "active" as const,
      };
    }
    return entry.state === "completed" ? entry : { ...entry, state: "pending" as const };
  });
  return {
    ...state,
    steps: nextSteps,
    activeStep: completeAll ? nextSteps.length - 1 : step,
    status,
    detail: cleanText(payload.detail, state.detail),
    updatedAt: Date.now(),
  };
}

function complete(state: SmartAgentTaskState, detail: string): SmartAgentTaskState {
  return {
    ...state,
    steps: state.steps.map((step) => ({ ...step, state: "completed" as const })),
    activeStep: Math.max(0, state.steps.length - 1),
    status: "completed",
    detail,
    updatedAt: Date.now(),
  };
}

function pause(state: SmartAgentTaskState, detail: string): SmartAgentTaskState {
  const current = Math.max(0, Math.min(state.steps.length - 1, state.activeStep));
  return {
    ...state,
    steps: state.steps.map((step, index) => (
      index === current && step.state !== "completed"
        ? { ...step, state: "paused" as const }
        : step
    )),
    status: "paused",
    detail,
    updatedAt: Date.now(),
  };
}

/** Apply only public, bounded task state events to the owning session. */
export function applySmartAgentEvent(session: Session, event: AgentEvent): boolean {
  if (event.kind === "task_plan") {
    session.smartAgent = makePlan(event.payload as Record<string, unknown>);
    return true;
  }
  const current = sanitizeSmartAgentTaskState(session.smartAgent);
  if (!current) return false;
  if (event.kind === "task_progress") {
    session.smartAgent = updateProgress(current, event.payload as Record<string, unknown>);
    return true;
  }
  if (event.kind === "done") {
    session.smartAgent = complete(current, "Task complete and ready to deliver.");
    return true;
  }
  if (event.kind === "cancelled") {
    session.smartAgent = pause(current, "Stopped by the user. Session progress is preserved.");
    return true;
  }
  if (event.kind === "end") {
    const payload = event.payload as Record<string, unknown>;
    const reason = String(payload.reason || "").trim().toLowerCase();
    if (reason === "completed") {
      session.smartAgent = complete(current, "Task complete and ready to deliver.");
    } else if (current.status !== "completed") {
      session.smartAgent = pause(current, "Run stopped before the task was confirmed complete. Session progress is preserved.");
    }
    return true;
  }
  return false;
}

function statusLabel(status: SmartAgentTaskState["status"]): string {
  if (status === "completed") return "Verified";
  if (status === "paused") return "Paused";
  return "Working";
}

function stepMark(status: SmartAgentStepState): string {
  if (status === "completed") return "✓";
  if (status === "active") return "•";
  if (status === "paused") return "!";
  return "–";
}

/** Compact, session-scoped task ledger mounted above the chat transcript. */
export class SmartAgentPanel {
  private currentSessionId: string | null = null;
  private state: SmartAgentTaskState | undefined;

  constructor(private readonly node: HTMLElement) {
    this.node.hidden = true;
  }

  setSession(sessionId: string | null, state: SmartAgentTaskState | undefined): void {
    this.currentSessionId = sessionId;
    this.state = sanitizeSmartAgentTaskState(state);
    this.render();
  }

  private render(): void {
    const state = this.state;
    if (!this.currentSessionId || !state) {
      this.node.hidden = true;
      clear(this.node);
      return;
    }
    this.node.hidden = false;
    clear(this.node);
    const card = div(`smart-agent-card smart-agent-${state.status}`);
    const head = div("smart-agent-head");
    const title = div("smart-agent-title");
    title.appendChild(el("span", { class: "smart-agent-spark", "aria-hidden": "true" }, ["✦"]));
    title.appendChild(el("span", {}, [state.title || "Smart Agent"]));
    head.appendChild(title);
    head.appendChild(el("span", { class: `smart-agent-badge ${state.status}`, role: "status" }, [
      statusLabel(state.status),
    ]));
    card.appendChild(head);
    if (state.summary) card.appendChild(el("p", { class: "smart-agent-summary" }, [state.summary]));

    const list = el("ol", { class: "smart-agent-steps", "aria-label": "Task progress" });
    for (const step of state.steps) {
      const item = el("li", { class: `smart-agent-step ${step.state}` });
      item.appendChild(el("span", { class: "smart-agent-step-mark", "aria-hidden": "true" }, [stepMark(step.state)]));
      item.appendChild(el("span", { class: "smart-agent-step-label" }, [step.label]));
      list.appendChild(item);
    }
    card.appendChild(list);
    if (state.detail) card.appendChild(el("div", { class: "smart-agent-detail", role: "status" }, [state.detail]));
    this.node.appendChild(card);
  }
}
