import { api, type ProjectTemplate } from "../ipc";
import { clear, div, el } from "./util";
import { icon } from "./icons";

export class ProjectPicker {
  private templates: ProjectTemplate[] = [];
  private selectedTemplate = "blank";

  constructor(
    private root: HTMLElement,
    private mode: "new" | "open",
    private onPick: (path: string, templateId?: string) => void,
    private onCancel: () => void
  ) {}

  async render() {
    clear(this.root);
    if (this.mode === "new") {
      this.templates = await api.listProjectTemplates().catch(() => [
        { id: "blank", label: "Blank", blurb: "Empty folder" },
      ]);
    }

    const overlay = el("div", { class: "modal-overlay" });
    const modal = el("div", {
      class: "modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "project-picker-title", tabindex: "-1",
    });

    const head = el("div", { class: "modal-head" });
    head.appendChild(el("div", { class: "modal-title", id: "project-picker-title" }, [this.mode === "new" ? "Start a new build" : "Open a project"]));
    const closeBtn = el("button", { class: "modal-close", type: "button", "aria-label": "Close project picker", html: icon("close", 16) });
    closeBtn.addEventListener("click", () => this.cancel());
    head.appendChild(closeBtn);
    modal.appendChild(head);

    const body = el("div", { class: "modal-body" });

    if (this.mode === "new" && this.templates.length) {
      body.appendChild(el("div", { class: "label" }, ["PH template"]));
      const grid = el("div", { class: "template-grid" });
      for (const t of this.templates) {
        const chip = el("button", {
          class: `template-chip${t.id === this.selectedTemplate ? " is-selected" : ""}`,
          type: "button",
          "data-id": t.id,
          title: t.blurb,
        }) as HTMLButtonElement;
        chip.appendChild(el("strong", {}, [t.label]));
        chip.appendChild(el("span", {}, [t.blurb]));
        chip.addEventListener("click", () => {
          this.selectedTemplate = t.id;
          grid.querySelectorAll(".template-chip").forEach((n) => n.classList.remove("is-selected"));
          chip.classList.add("is-selected");
        });
        grid.appendChild(chip);
      }
      body.appendChild(grid);
    }

    const parentLabel = el("label", { class: "label", for: "project-parent" }, [this.mode === "new" ? "Parent directory" : "Project directory"]);
    const parentRow = el("div", { class: "set-key-row" });
    const parentInput = el("input", {
      class: "field", id: "project-parent", type: "text", value: "", placeholder: "Choose a folder…", autocomplete: "off",
    }) as HTMLInputElement;
    parentRow.appendChild(parentInput);
    const browseBtn = el("button", { class: "btn sm" }, ["Browse"]);
    browseBtn.addEventListener("click", async () => {
      const picked = await api.openFolderPicker();
      if (picked) parentInput.value = picked;
    });
    parentRow.appendChild(browseBtn);
    body.appendChild(parentLabel);
    body.appendChild(parentRow);

    let nameInput: HTMLInputElement | null = null;
    if (this.mode === "new") {
      body.appendChild(el("label", { class: "label", for: "project-name", style: "margin-top:12px" }, ["Project name"]));
      nameInput = el("input", { class: "field", id: "project-name", type: "text", placeholder: "my-website", value: "", autocomplete: "off" }) as HTMLInputElement;
      body.appendChild(nameInput);
    }

    modal.appendChild(body);

    const foot = el("div", { class: "modal-foot" });
    const cancelBtn = el("button", { class: "btn", type: "button" }, ["Cancel"]);
    cancelBtn.addEventListener("click", () => this.cancel());
    const confirmBtn = el("button", { class: "btn primary", type: "button" }, [this.mode === "new" ? "Create project" : "Open project"]);
    confirmBtn.addEventListener("click", () => {
      const parent = parentInput.value.trim();
      if (!parent) {
        parentInput.setAttribute("aria-invalid", "true");
        parentInput.focus();
        return;
      }
      if (this.mode === "new") {
        const name = (nameInput!.value.trim() || "untitled").replace(/[\\/:*?"<>|]/g, "-");
        const full = `${parent.replace(/[\\/]+$/, "")}\\${name}`;
        this.onPick(full, this.selectedTemplate);
      } else {
        this.onPick(parent);
      }
    });
    foot.appendChild(cancelBtn);
    foot.appendChild(confirmBtn);
    modal.appendChild(foot);

    overlay.appendChild(modal);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.cancel();
    });
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.cancel();
      if (event.key === "Enter" && event.target !== browseBtn) confirmBtn.click();
    });
    this.root.appendChild(overlay);
    (overlay as HTMLElement).style.pointerEvents = "auto";
    window.setTimeout(() => parentInput.focus(), 0);
  }

  private cancel() {
    clear(this.root);
    this.onCancel();
  }
}
