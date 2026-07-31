import { clear, div, el } from "./util";
import { icon } from "./icons";

export class ConsolePanel {
  private static readonly MAX_LINES = 1_200;
  node: HTMLElement;
  body: HTMLElement;
  toggle: HTMLButtonElement;
  /** Tool ids / names currently receiving live streamed lines */
  private streamingActive = false;
  private lineCount = 0;
  private scrollFrame: number | null = null;

  constructor() {
    this.node = document.getElementById("console-panel")!;
    clear(this.node);
    const head = el("div", { class: "console-head" });
    head.appendChild(div("console-title", "Console"));
    const clearBtn = el("button", { class: "console-clear", type: "button" }, ["Clear"]);
    clearBtn.addEventListener("click", () => this.clear());
    head.appendChild(clearBtn);
    this.toggle = el("button", {
      class: "console-toggle", type: "button", "aria-label": "Collapse console",
      "aria-expanded": "true", "aria-controls": "console-output", html: icon("chevron", 12),
    }) as HTMLButtonElement;
    this.toggle.style.transform = "rotate(90deg)";
    this.toggle.addEventListener("click", () => this.toggleCollapse());
    head.appendChild(this.toggle);
    this.node.appendChild(head);
    this.body = el("div", { class: "console-body", id: "console-output", role: "log" });
    this.node.appendChild(this.body);
  }

  toggleCollapse() {
    const collapsed = this.node.classList.toggle("collapsed");
    this.toggle.style.transform = collapsed ? "rotate(0deg)" : "rotate(90deg)";
    this.toggle.setAttribute("aria-expanded", String(!collapsed));
    this.toggle.setAttribute("aria-label", collapsed ? "Expand console" : "Collapse console");
  }

  clear() {
    if (this.scrollFrame !== null) {
      cancelAnimationFrame(this.scrollFrame);
      this.scrollFrame = null;
    }
    clear(this.body);
    this.lineCount = 0;
    this.streamingActive = false;
  }

  appendLine(text: string, cls: string = "") {
    this.appendLines([text], cls);
  }

  private appendLines(lines: string[], cls: string = "") {
    if (lines.length === 0) return;
    const fragment = document.createDocumentFragment();
    for (const text of lines) {
      fragment.appendChild(el("div", { class: "console-line " + cls }, [text]));
    }
    this.body.appendChild(fragment);
    this.lineCount += lines.length;
    this.trimOldLines();
    this.scheduleScrollToBottom();
  }

  private trimOldLines() {
    let overflow = this.lineCount - ConsolePanel.MAX_LINES;
    while (overflow > 0) {
      const first = this.body.firstElementChild;
      if (!first) break;
      first.remove();
      this.lineCount -= 1;
      overflow -= 1;
    }
  }

  private scheduleScrollToBottom() {
    if (this.scrollFrame !== null) return;
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = null;
      this.body.scrollTop = this.body.scrollHeight;
    });
  }

  appendCommand(cmd: string) {
    this.appendLine(`> ${cmd}`, "cmd");
  }

  appendOutput(text: string) {
    this.appendLines(text.split(/\r?\n/));
  }

  appendError(text: string) {
    this.appendLines(text.split(/\r?\n/), "err");
  }

  handleToolCall(name: string, args: any) {
    if (name === "run_command") {
      const cmd = args?.command;
      if (typeof cmd === "string") this.appendCommand(cmd);
      this.streamingActive = true;
    } else if (name.startsWith("git_")) {
      this.appendCommand(`git ${name.replace("git_", "")}`);
      this.streamingActive = true;
    }
  }

  /** Live line from a running command. */
  handleConsoleChunk(stream: string, text: string) {
    this.streamingActive = true;
    const cls = stream === "stderr" ? "err" : "";
    this.appendLines(text.split(/\r?\n/), cls);
  }

  handleToolResult(name: string, ok: boolean, content: string, streamed = false) {
    if (name === "run_command" || name.startsWith("git_")) {
      // If we already streamed live output, only show a compact status trailer.
      if (streamed && this.streamingActive) {
        this.appendLine(ok ? "✓ exit ok" : `✗ ${content.split("\n")[0] || "failed"}`, ok ? "dim" : "err");
        this.appendLine("", "dim");
      } else {
        if (ok) this.appendOutput(content);
        else this.appendError(content);
        this.appendLine("", "dim");
      }
      this.streamingActive = false;
    }
  }
}
