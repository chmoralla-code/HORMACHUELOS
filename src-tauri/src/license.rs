//! Subscription / license scaffolding for Hormachuelos.
//! Local file today; swap `refresh_from_server` for PayMongo-backed API later.
//!
//! Rate windows (provider-style):
//! - 4-hour burst window — resets every 4h
//! - Weekly window — resets every 7 days
//! - Plan period budget — hard cap until renew/top-up (no auto-reset)

use anyhow::{Context, Result};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

/// Serialize all license.json read-modify-write paths so concurrent sessions
/// (different models) cannot lose usage updates.
static LICENSE_LOCK: Mutex<()> = Mutex::new(());

/// Temporary dev bypass — disable all usage/rate limits (debug builds only).
pub fn usage_limits_disabled() -> bool {
    cfg!(debug_assertions)
        || std::env::var("AI_FORGE_DISABLE_USAGE_LIMIT")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false)
}

fn with_license_lock<F, T>(f: F) -> Result<T>
where
    F: FnOnce() -> Result<T>,
{
    let _guard = LICENSE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    f()
}

fn license_path() -> Result<PathBuf> {
    let proj = directories::ProjectDirs::from("com", "ai-forge", "AI-Forge")
        .context("could not determine config dir")?;
    let dir = proj.config_dir().to_path_buf();
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("license.json"))
}

/// Public plans: pro (₱999/mo) · pro+ (₱2499/mo) · max (₱5999/mo)
/// Lean ROI: ~80% of plan price → client usage (~₱400 of every ₱500 API),
/// ~20% keep. Pools sized for ~$2.50/1M full-burn near that budget.
fn plan_budget(plan: &str) -> u64 {
    match plan {
        // Pro (entry) — also legacy starter / 15-day
        "pro" | "starter" | "fifteen" | "15day" | "15-day" => 5_500_000, // Generous (1×)
        // Pro+
        "proplus" | "pro+" | "pro_plus" => 13_750_000, // ~2.5× Pro
        // Max tiers (5× / 10× / 20× Pro) — lean ROI pools
        "max5" | "max" | "ultra" | "agency" => 27_500_000,
        "max10" => 55_000_000,
        "max20" => 110_000_000,
        _ => 5_500_000,
    }
}

fn plan_period_days(_plan: &str) -> u64 {
    30
}

/// (4h budget, weekly budget) derived from plan pool.
/// Weekly ≈ fair share of plan over 7 days; 4h ≈ weekly/6 so ~6 full bursts
/// can exhaust the week (Cursor-style pacing).
fn window_budgets(plan: &str, token_budget: u64) -> (u64, u64) {
    if token_budget == 0 {
        return (0, 0);
    }
    let days = plan_period_days(plan).max(1);
    let weekly = ((token_budget as u128) * 7 / days as u128)
        .min(token_budget as u128)
        .max(1) as u64;
    let four_h = (weekly / 6).max(1);
    (four_h, weekly)
}

fn expires_in_days(days: i64) -> String {
    (Utc::now() + Duration::days(days))
        .date_naive()
        .format("%Y-%m-%d")
        .to_string()
}

/// Convert raw API tokens into plan-billable units.
/// Cheap models (DeepSeek Flash, Ollama, free OpenRouter) burn the meter slowly;
/// premium Cursor/Claude paths burn ~1:1 (estimates already include safety margin).
pub fn to_billable_tokens(provider: &str, model: &str, raw: u64) -> u64 {
    if raw == 0 {
        return 0;
    }
    let p = provider.trim().to_ascii_lowercase();
    let m = model.trim().to_ascii_lowercase();
    let weight: f64 = match p.as_str() {
        "deepseek" if m.contains("flash") => 0.10, // ~$0.18/1M vs ~$2.50 target
        "deepseek" => 0.30,                        // V4 Pro
        "ollama" => 0.05,
        "openrouter" if m.contains("free") || m.ends_with(":free") => 0.05,
        "openrouter" => 0.45,
        "glm" | "zhipu" => 0.35,
        "gemini" => 0.40,
        "anthropic" => 1.35,
        "cursor" | "openai" => 1.0, // Cursor bridge already over-estimates
        "pollinations" => 0.05,
        _ => 1.0,
    };
    let billable = ((raw as f64) * weight).ceil() as u64;
    billable.max(1)
}

fn now_rfc3339() -> String {
    Utc::now().to_rfc3339()
}

fn parse_rfc3339(s: &str) -> Option<DateTime<Utc>> {
    if s.trim().is_empty() {
        return None;
    }
    DateTime::parse_from_rfc3339(s.trim())
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

fn parse_expiry_date(value: &str) -> Option<NaiveDate> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .ok()
        .or_else(|| {
            DateTime::parse_from_rfc3339(value)
                .ok()
                .map(|date| date.date_naive())
        })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseStatus {
    /// pro | proplus | max | free | expired
    pub plan: String,
    pub active: bool,
    /// ISO date or empty
    pub expires_at: String,
    pub email: String,
    /// Included pooled tokens for hosted budget (0 = unlimited / BYOK-only)
    pub token_budget: u64,
    pub tokens_used: u64,
    /// Marketing / top-up URL (GCash checkout on website)
    pub top_up_url: String,
    pub message: String,

    // ── Rate windows (provider-style) ──────────────────────────────────
    #[serde(default)]
    pub window_4h_used: u64,
    /// RFC3339 start of current 4h window
    #[serde(default)]
    pub window_4h_started_at: String,
    /// Computed each load/record (also persisted for UI convenience)
    #[serde(default)]
    pub window_4h_budget: u64,
    #[serde(default)]
    pub window_4h_resets_at: String,

    #[serde(default)]
    pub window_week_used: u64,
    #[serde(default)]
    pub window_week_started_at: String,
    #[serde(default)]
    pub window_week_budget: u64,
    #[serde(default)]
    pub window_week_resets_at: String,

    /// Which limit is blocking: "" | "plan" | "4h" | "week"
    #[serde(default)]
    pub blocked_by: String,

    /// True when usage limits are bypassed (dev / env flag). Not persisted.
    #[serde(default, skip_serializing_if = "is_false")]
    pub limits_disabled: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl Default for LicenseStatus {
    fn default() -> Self {
        let mut s = Self {
            plan: "free".into(),
            // Until live billing ships, keep the desktop usable (BYOK).
            active: true,
            expires_at: String::new(),
            email: String::new(),
            token_budget: 5_500_000,
            tokens_used: 0,
            top_up_url: "https://hormachuelos.com/#/pricing".into(),
            message:
                "Free / BYOK mode. Subscribe with GCash when ready — live billing coming soon."
                    .into(),
            window_4h_used: 0,
            window_4h_started_at: String::new(),
            window_4h_budget: 0,
            window_4h_resets_at: String::new(),
            window_week_used: 0,
            window_week_started_at: String::new(),
            window_week_budget: 0,
            window_week_resets_at: String::new(),
            blocked_by: String::new(),
            limits_disabled: false,
        };
        s.refresh_rate_windows();
        s
    }
}

impl LicenseStatus {
    fn enforce_expiry_at(&mut self, today: NaiveDate) -> bool {
        if !self.active || self.plan.eq_ignore_ascii_case("free") {
            return false;
        }
        let Some(expires) = parse_expiry_date(&self.expires_at) else {
            return false;
        };
        // Date-only licenses remain usable throughout their displayed expiry day.
        if expires >= today {
            return false;
        }
        self.plan = "expired".into();
        self.active = false;
        self.token_budget = 0;
        self.blocked_by = "plan".into();
        self.message = format!(
            "License expired on {}. Renew the plan to start new agent runs.",
            self.expires_at
        );
        true
    }

    fn enforce_expiry(&mut self) -> bool {
        self.enforce_expiry_at(Utc::now().date_naive())
    }

    fn load_unlocked() -> Result<Self> {
        let p = license_path()?;
        if !p.exists() {
            let s = Self::default();
            s.save_unlocked()?;
            return Ok(s);
        }
        let raw = std::fs::read_to_string(&p)?;
        let mut s: Self = serde_json::from_str(&raw)?;
        let mut dirty = false;
        if s.enforce_expiry() {
            dirty = true;
        }
        // Lean ROI pools are larger — bump active seats so clients get more usage.
        if s.active && !s.plan.eq_ignore_ascii_case("free") {
            let expected = plan_budget(&s.plan);
            if s.token_budget > 0 && s.token_budget < expected {
                s.token_budget = expected;
                dirty = true;
            }
        }
        if s.refresh_rate_windows() {
            dirty = true;
        }
        if dirty {
            let _ = s.save_unlocked();
        }
        Ok(s)
    }

    fn save_unlocked(&self) -> Result<()> {
        let p = license_path()?;
        let raw = serde_json::to_string_pretty(self)?;
        std::fs::write(&p, raw)?;
        Ok(())
    }

    pub fn load() -> Result<Self> {
        with_license_lock(Self::load_unlocked)
    }

    pub fn save(&self) -> Result<()> {
        with_license_lock(|| self.save_unlocked())
    }

    pub fn remaining_tokens(&self) -> u64 {
        self.token_budget.saturating_sub(self.tokens_used)
    }

    pub fn remaining_percent(&self) -> u32 {
        if self.token_budget == 0 {
            return 100;
        }
        ((self.remaining_tokens() as f64 / self.token_budget as f64) * 100.0).round() as u32
    }

    fn reset_windows_fresh(&mut self) {
        let now = now_rfc3339();
        self.window_4h_used = 0;
        self.window_4h_started_at = now.clone();
        self.window_week_used = 0;
        self.window_week_started_at = now;
        self.blocked_by.clear();
        self.refresh_rate_windows();
    }

    /// Compatibility alias used by the run gate in `lib.rs`.
    pub fn refresh_plan_block(&mut self) -> bool {
        self.refresh_rate_windows()
    }

    /// Advance / reset 4h + weekly windows; recompute budgets + blocked_by.
    /// Returns true if persisted fields changed (caller should save).
    pub fn refresh_rate_windows(&mut self) -> bool {
        let now = Utc::now();
        let (b4, bw) = window_budgets(&self.plan, self.token_budget);
        let mut dirty = false;

        if self.window_4h_budget != b4 {
            self.window_4h_budget = b4;
            dirty = true;
        }
        if self.window_week_budget != bw {
            self.window_week_budget = bw;
            dirty = true;
        }

        // ── 4-hour window ──────────────────────────────────────────────
        let started_4 = parse_rfc3339(&self.window_4h_started_at).unwrap_or(now);
        if self.window_4h_started_at.trim().is_empty() {
            self.window_4h_started_at = now.to_rfc3339();
            self.window_4h_used = 0;
            dirty = true;
        } else {
            let mut cursor = started_4;
            let step = Duration::hours(4);
            let mut rolled = false;
            while cursor + step <= now {
                cursor += step;
                rolled = true;
            }
            if rolled {
                self.window_4h_started_at = cursor.to_rfc3339();
                self.window_4h_used = 0;
                dirty = true;
            }
        }
        let start_4 = parse_rfc3339(&self.window_4h_started_at).unwrap_or(now);
        let reset_4 = (start_4 + Duration::hours(4)).to_rfc3339();
        if self.window_4h_resets_at != reset_4 {
            self.window_4h_resets_at = reset_4;
            dirty = true;
        }

        // ── Weekly window ──────────────────────────────────────────────
        let started_w = parse_rfc3339(&self.window_week_started_at).unwrap_or(now);
        if self.window_week_started_at.trim().is_empty() {
            self.window_week_started_at = now.to_rfc3339();
            self.window_week_used = 0;
            dirty = true;
        } else {
            let mut cursor = started_w;
            let step = Duration::days(7);
            let mut rolled = false;
            while cursor + step <= now {
                cursor += step;
                rolled = true;
            }
            if rolled {
                self.window_week_started_at = cursor.to_rfc3339();
                self.window_week_used = 0;
                dirty = true;
            }
        }
        let start_w = parse_rfc3339(&self.window_week_started_at).unwrap_or(now);
        let reset_w = (start_w + Duration::days(7)).to_rfc3339();
        if self.window_week_resets_at != reset_w {
            self.window_week_resets_at = reset_w;
            dirty = true;
        }

        // ── Which limit blocks ─────────────────────────────────────────
        let blocked = if usage_limits_disabled() {
            ""
        } else if self.token_budget > 0 && self.tokens_used >= self.token_budget {
            "plan"
        } else if self.window_week_budget > 0 && self.window_week_used >= self.window_week_budget {
            "week"
        } else if self.window_4h_budget > 0 && self.window_4h_used >= self.window_4h_budget {
            "4h"
        } else {
            ""
        };
        if self.blocked_by != blocked {
            self.blocked_by = blocked.into();
            dirty = true;
        }

        dirty
    }

    pub fn is_rate_blocked(&self) -> bool {
        if usage_limits_disabled() {
            return false;
        }
        !self.blocked_by.is_empty()
    }

    /// Apply API-facing fields (clears blocks when limits are disabled).
    pub fn for_api(mut self) -> Self {
        if usage_limits_disabled() {
            self.limits_disabled = true;
            self.blocked_by.clear();
        }
        self
    }
}

/// Activate / update from a license key string (placeholder until server exists).
pub fn apply_license_key(key: &str) -> Result<LicenseStatus> {
    with_license_lock(|| {
        let key = key.trim();
        let mut status = LicenseStatus::load_unlocked().unwrap_or_default();
        if key.is_empty() {
            status.message = "Paste a license key from your GCash checkout receipt.".into();
            status.save_unlocked()?;
            return Ok(status);
        }
        // Prefix-only keys are intentionally restricted to explicit local
        // testing. Production builds must use a server-verified or signed
        // entitlement rather than trusting a user-editable desktop file.
        let local_test_keys_enabled = cfg!(debug_assertions)
            && std::env::var("AI_FORGE_ENABLE_TEST_LICENSES").as_deref() == Ok("1");
        if !local_test_keys_enabled {
            status.message = "Online license verification is not configured yet. Continuing in Free / BYOK mode; no paid entitlement was granted.".into();
            status.save_unlocked()?;
            return Ok(status);
        }
        let upper = key.to_ascii_uppercase();
        // Check Pro+ before Pro (prefix overlap)
        if upper.starts_with("HORMA-MAX20") {
            status.plan = "max20".into();
            status.active = true;
            status.token_budget = plan_budget("max20");
            status.tokens_used = 0;
            status.expires_at = expires_in_days(30);
            status.message =
                "Max 20× plan activated (local). 20× usage vs Pro · lean 80/20 · 30 days · 4h + weekly limits.".into();
            status.reset_windows_fresh();
        } else if upper.starts_with("HORMA-MAX10") {
            status.plan = "max10".into();
            status.active = true;
            status.token_budget = plan_budget("max10");
            status.tokens_used = 0;
            status.expires_at = expires_in_days(30);
            status.message =
                "Max 10× plan activated (local). 10× usage vs Pro · lean 80/20 · 30 days · 4h + weekly limits.".into();
            status.reset_windows_fresh();
        } else if upper.starts_with("HORMA-MAX")
            || upper.starts_with("HORMA-ULTRA")
            || upper.starts_with("HORMA-AGENCY")
        {
            status.plan = "max5".into();
            status.active = true;
            status.token_budget = plan_budget("max5");
            status.tokens_used = 0;
            status.expires_at = expires_in_days(30);
            status.message =
                "Max 5× plan activated (local). 5× usage vs Pro · lean 80/20 · 30 days · 4h + weekly limits.".into();
            status.reset_windows_fresh();
        } else if upper.starts_with("HORMA-PROPLUS")
            || upper.starts_with("HORMA-PRO+")
            || upper.starts_with("HORMA-PRO-PLUS")
            || upper.starts_with("HORMA-PRO_PLUS")
        {
            status.plan = "proplus".into();
            status.active = true;
            status.token_budget = plan_budget("proplus");
            status.tokens_used = 0;
            status.expires_at = expires_in_days(30);
            status.message =
                "Pro+ plan activated (local). ~2.5× usage vs Pro · lean 80/20 · 30 days · 4h + weekly limits."
                    .into();
            status.reset_windows_fresh();
        } else if upper.starts_with("HORMA-PRO")
            || upper.starts_with("HORMA-STARTER")
            || upper.starts_with("HORMA-15")
            || upper.starts_with("HORMA-FIFTEEN")
            || upper.starts_with("HORMA-599")
        {
            status.plan = "pro".into();
            status.active = true;
            status.token_budget = plan_budget("pro");
            status.tokens_used = 0;
            status.expires_at = expires_in_days(30);
            status.message =
                "Pro plan activated (local). Generous usage · lean 80/20 · 30 days · 4h + weekly limits.".into();
            status.reset_windows_fresh();
        } else if upper.starts_with("HORMA-") {
            status.plan = "pro".into();
            status.active = true;
            status.token_budget = plan_budget("pro");
            status.tokens_used = 0;
            status.expires_at = expires_in_days(30);
            status.message =
                "Pro plan activated (local). Connect PayMongo to verify online.".into();
            status.reset_windows_fresh();
        } else {
            status.message =
                "Unrecognized key. Use the key from hormachuelos.com after GCash payment.".into();
        }
        status.save_unlocked()?;
        Ok(status.for_api())
    })
}

/// Persist token burn against the active license (account-wide, not per project).
/// Safe under concurrent sessions — serialized via LICENSE_LOCK.
pub fn record_token_usage(tokens: u64) -> Result<LicenseStatus> {
    with_license_lock(|| {
        let mut status = LicenseStatus::load_unlocked().unwrap_or_default();
        if !status.active {
            return Ok(status.for_api());
        }
        status.refresh_rate_windows();
        if tokens > 0 {
            status.tokens_used = status.tokens_used.saturating_add(tokens);
            status.window_4h_used = status.window_4h_used.saturating_add(tokens);
            status.window_week_used = status.window_week_used.saturating_add(tokens);
            status.refresh_rate_windows();

            status.message = match status.blocked_by.as_str() {
                "plan" => format!(
                    "{} plan usage exhausted. Top up or upgrade to continue.",
                    status.plan
                ),
                "week" => {
                    "Weekly usage limit reached. Resets when the weekly window rolls over.".into()
                }
                "4h" => {
                    "4-hour usage limit reached. Resets when the 4-hour window rolls over.".into()
                }
                _ => status.message.clone(),
            };
            status.save_unlocked()?;
        }
        Ok(status.for_api())
    })
}

/// Record raw provider usage after converting to cost-weighted billable tokens.
pub fn record_provider_usage(
    provider: &str,
    model: &str,
    raw_tokens: u64,
) -> Result<LicenseStatus> {
    let billable = to_billable_tokens(provider, model, raw_tokens);
    record_token_usage(billable)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paid_license_is_deactivated_after_expiry() {
        let mut status = LicenseStatus {
            plan: "pro".into(),
            active: true,
            expires_at: "2026-07-14".into(),
            ..Default::default()
        };
        assert!(status.enforce_expiry_at(NaiveDate::from_ymd_opt(2026, 7, 15).unwrap()));
        assert!(!status.active);
        assert_eq!(status.plan, "expired");
        assert_eq!(status.token_budget, 0);
    }

    #[test]
    fn paid_license_remains_active_on_expiry_day() {
        let mut status = LicenseStatus {
            plan: "pro".into(),
            active: true,
            expires_at: "2026-07-15".into(),
            ..Default::default()
        };
        assert!(!status.enforce_expiry_at(NaiveDate::from_ymd_opt(2026, 7, 15).unwrap()));
        assert!(status.active);
    }
}
