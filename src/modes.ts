/**
 * Canonical user-facing execution modes.
 *
 * Older releases stored auto/full/multi_agent/research values. They remain
 * accepted by normalizePermissionMode so saved settings and transcripts can
 * be upgraded without becoming unusable, but new UI and wire values use only
 * these four modes.
 */
export const PERMISSION_MODES = ["auto", "plan", "debug", "build", "ask"] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** Every visible mode uses the maximum capability profile. */
export const MAX_CAPABILITY_MODE = "max" as const;

/** Normalize current and legacy values to canonical modes. */
export function normalizePermissionMode(
  value: unknown,
  autoApprove = false,
): PermissionMode {
  switch (String(value || "").trim().toLowerCase()) {
    case "auto":
      return "auto";
    case "plan":
      return "plan";
    case "debug":
    case "full":
      return "debug";
    case "build":
    // Multitask was the pre-Build label. Keep it as a migration alias so
    // existing settings and transcripts remain usable after the UI rename.
    case "multitask":
    case "multi_agent":
      return "build";
    case "ask":
    case "research":
      return "ask";
    default:
      return autoApprove ? "debug" : "plan";
  }
}

/** Legacy compatibility flag used by settings code written before modes were canonicalized. */
export function autoApproveForPermissionMode(mode: unknown): boolean {
  const normalized = String(mode || "").trim().toLowerCase();
  return ["auto", "debug", "full", "build", "multitask", "multi_agent"].includes(normalized);
}
