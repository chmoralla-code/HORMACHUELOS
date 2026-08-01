import type { ComputerUseFxEvent } from "../ipc";

export type PrivateTypingStatus = {
  mask: string;
  progress: string;
  detail: string;
};

function nonNegativeInteger(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

/**
 * Build typing feedback exclusively from non-sensitive progress metadata.
 * Deliberately never reads event.text so legacy events cannot reveal typed content.
 */
export function privateTypingStatus(event: ComputerUseFxEvent): PrivateTypingStatus {
  const total = nonNegativeInteger(event.totalChars);
  const index = nonNegativeInteger(event.charIndex);
  const rawCurrent = event.kind === "type_done" ? (total ?? 0) : (index ?? -1) + 1;
  const current = total == null ? rawCurrent : Math.min(rawCurrent, total);
  const visibleBullets = Math.max(1, Math.min(current || total || 3, 12));
  const mask = `${"•".repeat(visibleBullets)}${current > visibleBullets ? "…" : ""}`;
  const progress = total != null ? `${current}/${total}` : current > 0 ? `${current}` : "";
  const detail =
    event.kind === "type_done"
      ? total == null
        ? "Text entered"
        : `${total} ${total === 1 ? "character" : "characters"} entered`
      : total == null
        ? "Entering text"
        : `Character ${current} of ${total}`;

  return { mask, progress, detail };
}

let hud: HTMLElement | null = null;
let labelEl: HTMLElement | null = null;
let detailEl: HTMLElement | null = null;
let hideTimer: number | null = null;

function ensureHud(): HTMLElement {
  if (hud) return hud;
  hud = document.createElement("div");
  hud.className = "computer-use-hud";
  hud.setAttribute("role", "status");
  hud.setAttribute("aria-live", "polite");
  hud.hidden = true;
  hud.innerHTML =
    '<div class="computer-use-hud-head"><span class="computer-use-hud-dot"></span><span class="computer-use-hud-title">Computer use</span></div>' +
    '<div class="computer-use-hud-label"></div>' +
    '<div class="computer-use-hud-detail"></div>' +
    '<div class="computer-use-hud-typing"><span class="computer-use-hud-caret"></span><span class="computer-use-hud-typed"></span></div>';
  labelEl = hud.querySelector(".computer-use-hud-label");
  detailEl = hud.querySelector(".computer-use-hud-detail");
  document.body.appendChild(hud);
  return hud;
}

function describe(event: ComputerUseFxEvent): { label: string; detail: string } {
  switch (event.kind) {
    case "click":
      return { label: "Clicking", detail: `${event.text ?? "left"} at ${event.x}, ${event.y}` };
    case "scroll":
      return { label: "Scrolling", detail: `At ${event.x}, ${event.y}` };
    case "drag":
      return { label: "Dragging", detail: `To ${event.x}, ${event.y}` };
    case "type_char":
    case "type_done":
      return {
        label: event.kind === "type_done" ? "Typed" : "Typing",
        detail: privateTypingStatus(event).detail,
      };
    default:
      return { label: "Moving cursor", detail: `${event.x}, ${event.y}` };
  }
}

export function mountComputerUseHud() {
  ensureHud();
}

export function updateComputerUseHud(event: ComputerUseFxEvent) {
  const root = ensureHud();
  if (event.kind === "clear") {
    root.hidden = true;
    return;
  }
  root.hidden = false;
  const { label, detail } = describe(event);
  if (labelEl) labelEl.textContent = label;
  if (detailEl) detailEl.textContent = detail;

  const typingRow = root.querySelector(".computer-use-hud-typing") as HTMLElement | null;
  const typed = root.querySelector(".computer-use-hud-typed") as HTMLElement | null;
  if (typingRow && typed) {
    const isTyping = event.kind === "type_char" || event.kind === "type_done";
    typingRow.hidden = !isTyping;
    if (isTyping) {
      const status = privateTypingStatus(event);
      typed.textContent = status.progress ? `${status.mask} (${status.progress})` : status.mask;
    }
  }

  if (hideTimer != null) window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    if (root) root.hidden = true;
  }, event.kind.startsWith("type") ? 1800 : 1200);
}

export function clearComputerUseHud() {
  if (hud) hud.hidden = true;
}
