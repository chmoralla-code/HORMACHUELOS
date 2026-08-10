import { api, type ProjectTemplate } from "../ipc";
import { clear, div, el } from "./util";
import { icon } from "./icons";

export class ProjectPicker {
  private templates: ProjectTemplate[] = [];
  private selectedTemplate = "blank";
  private checkToken = 0;

  constructor(
    private root: HTMLElement,
    private mode: "new" | "open",
    private onPick: (path: string, templateId?: string) => void,
    private onCancel: () => void,
    private onOpenParent?: (path: string) => void
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
    parentRow.appendChild(browseBtn);
    body.appendChild(parentLabel);
    body.appendChild(parentRow);

    // Warning shown only in the New build flow when the parent folder is itself
    // an existing source project — creating a blank project inside it is the
    // "empty project nested in the real one" trap. Offer a one-click fix.
    const warnRow = el("div", { class: "picker-project-warn", style: "display:none" });
    const warnText = el("span", { class: "picker-project-warn-text" });
    warnRow.appendChild(warnText);
    const openBtn = el("button", { class: "btn sm", type: "button" }, [
      "Open this folder instead",
    ]);
    openBtn.addEventListener("click", () => {
      const parent = parentInput.value.trim();
      if (parent && this.onOpenParent) {
        clear(this.root);
        this.onOpenParent(parent);
      }
    });
    warnRow.appendChild(openBtn);
    // Escape hatch for intentional sub-projects (e.g. under a monorepo root):
    // proceed with the creation despite the warning.
    const anywayBtn = el("button", { class: "btn sm", type: "button" }, [
      "Create anyway",
    ]);
    anywayBtn.addEventListener("click", () => {
      warnRow.style.display = "none";
      confirmBtn.disabled = false;
    });
    warnRow.appendChild(anywayBtn);
    body.appendChild(warnRow);

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
    confirmBtn.disabled = this.mode === "new";
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

    // Guard: when the parent directory is itself an existing project root,
    // warn and disable creation so the user does not nest an empty project in
    // the folder they actually mean to open. The open-project flow keeps its
    // existing parent-adoption repair, so this only guards New builds.
    const checkParent = () => {
      const parent = parentInput.value.trim();
      if (this.mode !== "new" || !parent) {
        warnRow.style.display = "none";
        confirmBtn.disabled = false;
        return;
      }
      confirmBtn.disabled = true; // pending — enable only once verified safe
      const token = ++this.checkToken;
      api
        .checkProjectParentIsExistingProject(parent)
        .then((isProjectRoot) => {
          if (token !== this.checkToken) return; // stale response
          if (isProjectRoot) {
            warnText.textContent =
              `This folder already contains a project (${parent}). ` +
              "Creating a new build here nests an empty project inside it — " +
              "open the folder instead to work with your existing files.";
            warnRow.style.display = "flex";
            confirmBtn.disabled = true;
          } else {
            warnRow.style.display = "none";
            confirmBtn.disabled = false;
          }
        })
        .catch(() => {
          warnRow.style.display = "none";
          confirmBtn.disabled = false;
        });
    };
    parentInput.addEventListener("input", checkParent);
    browseBtn.addEventListener("click", () => {
      void api.openFolderPicker().then((picked) => {
        if (picked) {
          parentInput.value = picked;
          checkParent();
        }
      });
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
    window.setTimeout(() => {
      parentInput.focus();
      checkParent();
    }, 0);
  }

  private cancel() {
    clear(this.root);
    this.onCancel();
  }
}
