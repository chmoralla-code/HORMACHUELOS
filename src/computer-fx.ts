import "./app.css";
import { listen } from "@tauri-apps/api/event";
import type { ComputerUseFxEvent } from "./ipc";

const cursor = document.getElementById("fx-cursor") as HTMLDivElement;
const clickRing = document.getElementById("fx-click") as HTMLDivElement;
const typing = document.getElementById("fx-typing") as HTMLDivElement;
const typingText = document.getElementById("fx-typing-text") as HTMLSpanElement;
const typingProgress = document.getElementById("fx-typing-progress") as HTMLSpanElement;
const trail = document.getElementById("fx-trail") as HTMLDivElement;

let hideTimer: number | null = null;
let typingTimer: number | null = null;
let lastX = 0;
let lastY = 0;

function place(el: HTMLElement, x: number, y: number) {
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
}

function showCursor(x: number, y: number) {
  lastX = x;
  lastY = y;
  cursor.hidden = false;
  place(cursor, x, y);
  cursor.classList.remove("is-click", "is-drag", "is-scroll");
}

function pulseClick(x: number, y: number) {
  showCursor(x, y);
  cursor.classList.add("is-click");
  clickRing.hidden = false;
  place(clickRing, x, y);
  clickRing.classList.remove("play");
  void clickRing.offsetWidth;
  clickRing.classList.add("play");
}

function showTyping(
  x: number,
  y: number,
  text: string,
  done: boolean,
  charIndex?: number,
  totalChars?: number,
) {
  showCursor(x, y);
  typing.hidden = false;
  place(typing, x + 18, y - 42);
  typingText.textContent = text;
  typing.classList.toggle("is-done", done);
  if (typingProgress) {
    if (totalChars && totalChars > 0) {
      const current = (charIndex ?? totalChars - 1) + 1;
      typingProgress.textContent = `${current}/${totalChars}`;
      typingProgress.hidden = false;
    } else {
      typingProgress.hidden = true;
    }
  }
  if (typingTimer != null) window.clearTimeout(typingTimer);
  if (done) {
    typingTimer = window.setTimeout(() => {
      typing.hidden = true;
    }, 900);
  }
}

function addTrail(x: number, y: number) {
  const dot = document.createElement("span");
  dot.className = "fx-trail-dot";
  dot.style.left = `${x}px`;
  dot.style.top = `${y}px`;
  trail.appendChild(dot);
  window.setTimeout(() => dot.remove(), 420);
  while (trail.childElementCount > 24) {
    trail.firstElementChild?.remove();
  }
}

function clearFx() {
  cursor.hidden = true;
  clickRing.hidden = true;
  typing.hidden = true;
  trail.replaceChildren();
  if (hideTimer != null) window.clearTimeout(hideTimer);
  if (typingTimer != null) window.clearTimeout(typingTimer);
}

function scheduleIdleHide() {
  if (hideTimer != null) window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    cursor.hidden = true;
    clickRing.hidden = true;
  }, 1400);
}

function handleFx(event: ComputerUseFxEvent) {
  const { kind, x, y, text, charIndex, totalChars } = event;
  switch (kind) {
    case "clear":
      clearFx();
      return;
    case "cursor_move":
      showCursor(x, y);
      addTrail(x, y);
      scheduleIdleHide();
      return;
    case "click":
      pulseClick(x, y);
      scheduleIdleHide();
      return;
    case "scroll":
      showCursor(x, y);
      cursor.classList.add("is-scroll");
      scheduleIdleHide();
      return;
    case "drag":
      showCursor(x, y);
      cursor.classList.add("is-drag");
      addTrail(x, y);
      scheduleIdleHide();
      return;
    case "type_char":
      showTyping(x, y, text ?? "", false, charIndex ?? undefined, totalChars ?? undefined);
      return;
    case "type_done":
      showTyping(x, y, text ?? "", true, charIndex ?? undefined, totalChars ?? undefined);
      scheduleIdleHide();
      return;
    default:
      showCursor(x ?? lastX, y ?? lastY);
      scheduleIdleHide();
  }
}

listen<ComputerUseFxEvent>("computer-use-fx", (ev) => handleFx(ev.payload)).catch(console.error);
