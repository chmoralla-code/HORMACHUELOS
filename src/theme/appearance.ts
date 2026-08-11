/**
 * Persistent desktop appearance preferences.  The color tokens live in
 * tokens.css; this module owns selecting a token set and keeping the native
 * window chrome in step with the document.
 */
export const APPEARANCE_STORAGE_KEY = "ai-forge:appearance";
export const APPEARANCE_CHANGE_EVENT = "ai-forge:appearance-change";

export const APPEARANCE_MODES = ["light", "dark", "gray"] as const;
export type AppearanceMode = (typeof APPEARANCE_MODES)[number];

type AppearanceMeta = {
  label: string;
  themeColor: string;
  colorScheme: "light" | "dark";
};

const APPEARANCE_META: Record<AppearanceMode, AppearanceMeta> = {
  light: { label: "Light", themeColor: "#f4f7fb", colorScheme: "light" },
  dark: { label: "Dark", themeColor: "#1e1e1e", colorScheme: "dark" },
  gray: { label: "Gray", themeColor: "#2a2d32", colorScheme: "dark" },
};

export function normalizeAppearance(value: unknown): AppearanceMode {
  return typeof value === "string" && (APPEARANCE_MODES as readonly string[]).includes(value)
    ? value as AppearanceMode
    : "dark";
}

export function savedAppearance(): AppearanceMode {
  try {
    return normalizeAppearance(localStorage.getItem(APPEARANCE_STORAGE_KEY));
  } catch {
    return "dark";
  }
}

function updateMetaColor(meta: AppearanceMeta) {
  const colorScheme = document.querySelector('meta[name="color-scheme"]');
  colorScheme?.setAttribute("content", meta.colorScheme);
  const themeColor = document.querySelector('meta[name="theme-color"]');
  themeColor?.setAttribute("content", meta.themeColor);
}

async function updateNativeWindow(mode: AppearanceMode) {
  // Static pages, harnesses, and browser tests have no Tauri bridge.  Do not
  // import the window API unless we are in the real desktop webview.
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTheme(mode === "light" ? "light" : "dark");
  } catch (error) {
    // Appearance must never fail just because a platform does not expose a
    // configurable title bar. The document tokens remain authoritative.
    console.debug("Native window appearance could not be updated", error);
  }
}

export function applyAppearance(value: unknown, persist = true): AppearanceMode {
  const mode = normalizeAppearance(value);
  const meta = APPEARANCE_META[mode];
  const root = document.documentElement;
  root.dataset.appearance = mode;
  root.style.colorScheme = meta.colorScheme;
  updateMetaColor(meta);

  if (persist) {
    try {
      localStorage.setItem(APPEARANCE_STORAGE_KEY, mode);
    } catch {
      // A locked-down webview still gets the selected theme for this session.
    }
  }

  document.dispatchEvent(new CustomEvent<AppearanceMode>(APPEARANCE_CHANGE_EVENT, { detail: mode }));
  void updateNativeWindow(mode);
  return mode;
}

/** Apply the saved choice before the interactive UI starts loading. */
export function initializeAppearance(): AppearanceMode {
  return applyAppearance(savedAppearance(), false);
}

/**
 * Mount the compact three-button control used in the global header.  Returning
 * a cleanup function makes the control safe to reuse in preview harnesses.
 */
export function mountAppearanceControl(host: HTMLElement | null): () => void {
  if (!host) return () => {};

  host.replaceChildren();
  host.className = "appearance-control";
  host.setAttribute("role", "group");
  host.setAttribute("aria-label", "Appearance mode");

  const label = document.createElement("span");
  label.className = "appearance-label";
  label.textContent = "Appearance";
  host.appendChild(label);

  const buttons = new Map<AppearanceMode, HTMLButtonElement>();
  for (const mode of APPEARANCE_MODES) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "appearance-mode";
    button.dataset.appearanceMode = mode;
    button.setAttribute("aria-label", `Use ${APPEARANCE_META[mode].label} appearance`);
    button.title = `${APPEARANCE_META[mode].label} appearance`;

    const swatch = document.createElement("span");
    swatch.className = "appearance-swatch";
    swatch.setAttribute("aria-hidden", "true");
    button.appendChild(swatch);

    const text = document.createElement("span");
    text.className = "appearance-mode-label";
    text.textContent = APPEARANCE_META[mode].label;
    button.appendChild(text);
    button.addEventListener("click", () => applyAppearance(mode));
    buttons.set(mode, button);
    host.appendChild(button);
  }

  const refresh = () => {
    const active = normalizeAppearance(document.documentElement.dataset.appearance);
    for (const [mode, button] of buttons) {
      button.setAttribute("aria-pressed", String(mode === active));
    }
  };
  const onAppearanceChange = () => refresh();
  document.addEventListener(APPEARANCE_CHANGE_EVENT, onAppearanceChange);
  refresh();

  return () => document.removeEventListener(APPEARANCE_CHANGE_EVENT, onAppearanceChange);
}
