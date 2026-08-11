use serde::Serialize;

/// Host-side execution policy. This is deliberately separate from permission
/// mode: Full/Auto decide what may run, while this profile decides how much
/// context, reasoning, validation, and rollback protection the run receives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionProfile {
    Fast,
    Balanced,
    Thorough,
    Safe,
}

impl ExecutionProfile {
    pub fn resolve(selected: Option<&str>, prompt: &str, task_profile: Option<&str>) -> Self {
        match selected
            .unwrap_or("auto")
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "fast" => return Self::Fast,
            "balanced" => return Self::Balanced,
            "thorough" => return Self::Thorough,
            "safe" | "safe_build" => return Self::Safe,
            _ => {}
        }

        if task_profile
            .unwrap_or_default()
            .trim()
            .eq_ignore_ascii_case("design_edit_fast")
        {
            return Self::Fast;
        }

        let request = prompt.trim().to_ascii_lowercase();
        if request.is_empty() {
            return Self::Balanced;
        }

        // Destructive or migration-shaped work benefits from command-level
        // protection even when the user leaves the selector on Auto.
        const SAFE_SIGNALS: [&str; 14] = [
            "delete all",
            "remove all",
            "clear project",
            "migration",
            "migrate database",
            "rename every",
            "move every",
            "replace every",
            "upgrade all",
            "convert the whole",
            "rewrite the project",
            "major refactor",
            "rollback",
            "roll back",
        ];
        if SAFE_SIGNALS.iter().any(|signal| request.contains(signal)) {
            return Self::Safe;
        }

        // Small, explicitly local changes should not pay for a full project
        // audit. Avoid classifying broad build requests as Fast even when they
        // contain words such as "fix" or "change".
        const LARGE_SIGNALS: [&str; 16] = [
            "website",
            "full stack",
            "full-stack",
            " apk",
            "android app",
            "ios app",
            "software",
            "architecture",
            "database",
            "deploy",
            "authentication",
            "payment",
            "entire project",
            "from scratch",
            "redesign",
            "multiple pages",
        ];
        const QUICK_SIGNALS: [&str; 18] = [
            "change the text",
            "change text",
            "fix the color",
            "fix color",
            "light mode",
            "dark mode",
            "spacing",
            "padding",
            "margin",
            "font size",
            "typo",
            "rename this",
            "hide this",
            "show this",
            "make this button",
            "one button",
            "selected element",
            "design mode",
        ];
        let looks_large = LARGE_SIGNALS.iter().any(|signal| request.contains(signal));
        let looks_quick = QUICK_SIGNALS.iter().any(|signal| request.contains(signal));
        if !looks_large && looks_quick && request.len() <= 1_200 {
            Self::Fast
        } else {
            Self::Balanced
        }
    }

    pub const fn wire_name(self) -> &'static str {
        match self {
            Self::Fast => "fast",
            Self::Balanced => "balanced",
            Self::Thorough => "thorough",
            Self::Safe => "safe",
        }
    }

    pub const fn is_fast(self) -> bool {
        matches!(self, Self::Fast)
    }

    pub const fn protects_command_changes(self) -> bool {
        matches!(self, Self::Safe)
    }

    pub const fn context_budget(self) -> usize {
        match self {
            Self::Fast => 4_000,
            Self::Balanced => 9_000,
            Self::Thorough | Self::Safe => 14_000,
        }
    }

    pub const fn repair_budget(self) -> u8 {
        match self {
            Self::Fast => 1,
            Self::Balanced | Self::Safe => 2,
            Self::Thorough => 4,
        }
    }

    pub fn model_effort(self, configured: &str) -> String {
        let configured = configured.trim().to_ascii_lowercase();
        match self {
            Self::Fast => "low".into(),
            Self::Balanced => {
                if configured.is_empty() {
                    "medium".into()
                } else {
                    configured
                }
            }
            Self::Thorough => match configured.as_str() {
                "xhigh" | "max" | "ultra" => configured,
                _ => "high".into(),
            },
            Self::Safe => match configured.as_str() {
                "" | "light" | "low" => "medium".into(),
                _ => configured,
            },
        }
    }

    pub const fn instructions(self) -> &'static str {
        match self {
            Self::Fast => {
                "\nFAST EXECUTION PROFILE:\n\
- Minimize time-to-result: use supplied source hints and cached project intelligence before broad discovery.\n\
- Make the smallest coherent change, run the cheapest relevant validator, and finish after one focused repair.\n\
- Do not add optional refactors, extra review passes, or unrelated improvements.\n"
            }
            Self::Balanced => {
                "\nBALANCED EXECUTION PROFILE:\n\
- Prefer focused discovery and deterministic validation. Escalate investigation only when concrete evidence or a failed check requires it.\n\
- Reuse the cached project map, prior successful build recipe, and running development server when available.\n"
            }
            Self::Thorough => {
                "\nTHOROUGH EXECUTION PROFILE:\n\
- Inspect dependency boundaries and edge cases before changing code, then run the strongest relevant local validation.\n\
- Use additional review or repair passes only when they can resolve a specific remaining risk.\n"
            }
            Self::Safe => {
                "\nSAFE BUILD EXECUTION PROFILE:\n\
- Keep changes inside the active project whenever possible. Direct file tools and relevant project files changed by shell commands are checkpoint-protected.\n\
- Avoid external side effects that cannot be rolled back. Explicitly surface deployments, database mutations, account changes, and other non-file effects before performing them.\n\
- Validate before delivery and preserve the checkpoint until the user chooses to keep or roll back the run.\n"
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ExecutionProfile;

    #[test]
    fn explicit_profile_wins_over_auto_routing() {
        assert_eq!(
            ExecutionProfile::resolve(Some("thorough"), "change the text", None),
            ExecutionProfile::Thorough
        );
    }

    #[test]
    fn fast_design_edits_auto_route_to_fast() {
        assert_eq!(
            ExecutionProfile::resolve(
                Some("auto"),
                "Update this selected control",
                Some("design_edit_fast")
            ),
            ExecutionProfile::Fast
        );
    }

    #[test]
    fn broad_builds_do_not_auto_route_to_fast() {
        assert_eq!(
            ExecutionProfile::resolve(Some("auto"), "Make a full-stack website from scratch", None),
            ExecutionProfile::Balanced
        );
    }

    #[test]
    fn destructive_requests_auto_route_to_safe() {
        assert_eq!(
            ExecutionProfile::resolve(
                Some("auto"),
                "Rewrite the project and migrate database",
                None
            ),
            ExecutionProfile::Safe
        );
    }

    #[test]
    fn effort_scales_with_profile() {
        assert_eq!(ExecutionProfile::Fast.model_effort("ultra"), "low");
        assert_eq!(ExecutionProfile::Balanced.model_effort("xhigh"), "xhigh");
        assert_eq!(ExecutionProfile::Thorough.model_effort("medium"), "high");
        assert_eq!(ExecutionProfile::Safe.model_effort("low"), "medium");
    }
}
