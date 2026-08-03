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

/// Public plans: starter (₱299) · pro (₱999) · max 5×/10×/20×
///
/// Budgets are sized from official model list prices (see website/api/_lib/plans.js):
/// GPT 5.6 Sol / Grok 4.5 @ $2/$6 → $2.80/1M blended (80% in / 20% out).
/// 2× markup ⇒ 50% of PHP price funds that COGS (₱58/$). Keep website + Rust
/// numbers identical.
fn plan_budget(plan: &str) -> u64 {
    match plan {
        "starter" => 920_567,
        "pro" | "fifteen" | "15day" | "15-day" => 3_075_739,
        "proplus" | "pro+" | "pro_plus" => 7_693_966,
        "max5" | "max" | "ultra" | "agency" => 7_693_966,
        "max10" => 15_391_010,
        "max20" => 30_785_099,
        _ => 920_567,
    }
}

/// (4h budget, weekly budget) derived from plan pool.
/// Generous pacing caps so a session is never blocked while the plan pool
/// still has meaningful remaining capacity (e.g. 72% left):
/// - weekly ≈ 50% of the plan pool
/// - 4h    ≈ 20% of the plan pool
/// Previously these were tiny fractions (weekly ≈ plan/4.3, 4h ≈ weekly/6),
/// which let the burst windows exhaust long before the plan pool and made
/// sessions "suddenly" hit a usage limit while the UI still showed plenty of
/// plan remaining.
fn window_budgets(plan: &str, token_budget: u64) -> (u64, u64) {
    if token_budget == 0 {
        return (0, 0);
    }
    let _ = plan;
    let weekly = ((token_budget as u128) / 2).max(1) as u64;
    let four_h = ((token_budget as u128) / 5).max(1) as u64;
    (four_h, weekly)
}

fn expires_in_days(days: i64) -> String {
    (Utc::now() + Duration::days(days))
        .date_naive()
        .format("%Y-%m-%d")
        .to_string()
}

/// Convert raw API tokens into plan-billable units using official list-price
/// blends relative to Grok 4.5 / GPT 5.6 Sol ($2.80/1M @ 80/20 mix).
pub fn to_billable_tokens(provider: &str, model: &str, raw: u64) -> u64 {
    if raw == 0 {
        return 0;
    }
    let p = provider.trim().to_ascii_lowercase();
    let m = model.trim().to_ascii_lowercase();
    let ref_blend = 2.8_f64;
    let weight: f64 = match p.as_str() {
        // DeepSeek V4 Flash $0.14/$0.28 → $0.168 blend
        "deepseek" if m.contains("flash") => 0.168 / ref_blend,
        // DeepSeek V4 Pro $0.435/$0.87 → $0.522 blend
        "deepseek" => 0.522 / ref_blend,
        "hormachuelos_free" => 0.168 / ref_blend,
        "ollama" | "pollinations" => 0.05 / ref_blend,
        "openrouter" if m.contains("free") || m.ends_with(":free") => 0.05 / ref_blend,
        "openrouter" => 0.45,
        // GLM 5.2 $1.40/$4.40 → $2.00 blend
        "glm" | "zhipu" => 2.0 / ref_blend,
        // Gemini 3.1 Pro $2/$12 → $4.00 blend
        "gemini" => 4.0 / ref_blend,
        // Claude Opus-class $5/$25 → $9.00 blend
        "anthropic" => 9.0 / ref_blend,
        // Cursor / OpenAI aliases — Sol = Grok 4.5; Luna = Composer 2.5 Fast
        "cursor" | "openai" | "xai" => {
            if m.contains("composer") || m.contains("luna") {
                5.4 / ref_blend
            } else if m.contains("terra") {
                4.0 / ref_blend
            } else {
                1.0
            }
        }
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

    /// Server-issued key (HORMA-…). Used as Bearer token for the hosted proxy.
    #[serde(default)]
    pub license_key: String,

    /// True when entitlement was verified against the hosted API.
    #[serde(default)]
    pub hosted: bool,

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
            top_up_url: "https://hormachuelos.vercel.app/#/pricing".into(),
            message:
                "Free / BYOK mode. Buy a plan at hormachuelos.vercel.app for hosted models, or paste your own provider key."
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
            license_key: String::new(),
            hosted: false,
            limits_disabled: false,
        };
        s.refresh_rate_windows();
        s
    }
}

/// Public hosted API origin (Vercel). Override with `AI_FORGE_HOSTED_API`.
pub fn hosted_api_base() -> String {
    std::env::var("AI_FORGE_HOSTED_API")
        .ok()
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://hormachuelos.vercel.app".into())
}

pub fn hosted_chat_base_url() -> String {
    format!("{}/api/v1", hosted_api_base())
}

/// When true, agent runs should call the Hormachuelos proxy with the license key.
pub fn should_use_hosted(status: &LicenseStatus) -> bool {
    if !status.hosted || status.license_key.trim().is_empty() {
        return false;
    }
    if !status.active || status.plan.eq_ignore_ascii_case("free") {
        return false;
    }
    if usage_limits_disabled() {
        return true;
    }
    if status.token_budget > 0 && status.tokens_used >= status.token_budget {
        return false;
    }
    if status.is_rate_blocked() {
        return false;
    }
    true
}

/// Whether a selected provider should be routed through the hosted proxy.
/// Ollama always uses its configured local host. Cursor always uses its local
/// SDK because Cursor model ids are not OpenAI-compatible proxy model ids.
pub fn should_use_hosted_for_provider(status: &LicenseStatus, provider: &str) -> bool {
    !provider.eq_ignore_ascii_case("ollama")
        && !provider.eq_ignore_ascii_case("cursor")
        && should_use_hosted(status)
}

impl LicenseStatus {
    fn enforce_expiry_at(&mut self, _today: NaiveDate) -> bool {
        // Pay-as-you-go plans are gated by usage wallet only — no calendar expiry.
        false
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
        // 2×-margin pools are smaller than the old lean-ROI grants — clamp
        // oversized seats down so active licenses match the current sheet.
        if s.active && !s.plan.eq_ignore_ascii_case("free") {
            let expected = plan_budget(&s.plan);
            if s.token_budget > 0 && s.token_budget != expected {
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostedActivateResponse {
    #[allow(dead_code)]
    ok: Option<bool>,
    plan: Option<String>,
    active: Option<bool>,
    expires_at: Option<String>,
    email: Option<String>,
    token_budget: Option<u64>,
    tokens_used: Option<u64>,
    license_key: Option<String>,
    top_up_url: Option<String>,
    message: Option<String>,
    #[allow(dead_code)]
    hosted: Option<bool>,
    error: Option<String>,
}

/// Activate / refresh a license against the hosted Hormachuelos API.
pub async fn apply_license_key(key: &str) -> Result<LicenseStatus> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return with_license_lock(|| {
            let mut status = LicenseStatus::load_unlocked().unwrap_or_default();
            status.message = "Paste a license key from your GCash checkout receipt.".into();
            status.save_unlocked()?;
            Ok(status.for_api())
        });
    }

    let url = format!("{}/api/license/activate", hosted_api_base());
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()?;
    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "key": key }))
        .send()
        .await;

    match response {
        Ok(res) => {
            let status_code = res.status();
            let body = match res.json::<HostedActivateResponse>().await {
                Ok(b) => b,
                Err(_) => HostedActivateResponse {
                    ok: None,
                    plan: None,
                    active: None,
                    expires_at: None,
                    email: None,
                    token_budget: None,
                    tokens_used: None,
                    license_key: None,
                    top_up_url: None,
                    message: None,
                    hosted: None,
                    error: Some(format!("License server returned {status_code}")),
                },
            };
            if status_code.is_success() && body.active.unwrap_or(false) {
                return with_license_lock(|| {
                    let mut status = LicenseStatus::load_unlocked().unwrap_or_default();
                    status.license_key = body.license_key.unwrap_or(key.clone());
                    status.plan = body.plan.unwrap_or_else(|| "pro".into());
                    status.active = true;
                    status.hosted = true;
                    status.email = body.email.unwrap_or_default();
                    status.token_budget = body
                        .token_budget
                        .unwrap_or_else(|| plan_budget(&status.plan));
                    status.tokens_used = body.tokens_used.unwrap_or(0);
                    status.expires_at = body.expires_at.unwrap_or_default();
                    status.top_up_url = body
                        .top_up_url
                        .unwrap_or_else(|| format!("{}/#/pricing", hosted_api_base()));
                    status.message = body.message.unwrap_or_else(|| {
                        "Hosted plan activated. Models run through Hormachuelos server.".into()
                    });
                    status.reset_windows_fresh();
                    status.save_unlocked()?;
                    Ok(status.for_api())
                });
            }
            let err = body
                .error
                .or(body.message)
                .unwrap_or_else(|| "License activation failed.".into());
            // Fall through to local test keys only when explicitly enabled.
            if !local_test_licenses_enabled() {
                return with_license_lock(|| {
                    let mut status = LicenseStatus::load_unlocked().unwrap_or_default();
                    status.license_key = key;
                    status.hosted = false;
                    status.active = status.plan.eq_ignore_ascii_case("free");
                    status.message = err;
                    status.save_unlocked()?;
                    Ok(status.for_api())
                });
            }
        }
        Err(e) => {
            if !local_test_licenses_enabled() {
                return with_license_lock(|| {
                    let mut status = LicenseStatus::load_unlocked().unwrap_or_default();
                    status.message = format!(
                        "Could not reach license server ({e}). Check your network, or use BYOK in Settings."
                    );
                    status.save_unlocked()?;
                    Ok(status.for_api())
                });
            }
        }
    }

    apply_license_key_local(&key)
}

fn local_test_licenses_enabled() -> bool {
    cfg!(debug_assertions) && std::env::var("AI_FORGE_ENABLE_TEST_LICENSES").as_deref() == Ok("1")
}

/// Dev-only prefix activation (requires AI_FORGE_ENABLE_TEST_LICENSES=1).
fn apply_license_key_local(key: &str) -> Result<LicenseStatus> {
    with_license_lock(|| {
        let mut status = LicenseStatus::load_unlocked().unwrap_or_default();
        let upper = key.to_ascii_uppercase();
        status.license_key = key.to_string();
        status.hosted = false;
        if upper.starts_with("HORMA-MAX20") {
            status.plan = "max20".into();
            status.active = true;
            status.token_budget = plan_budget("max20");
            status.tokens_used = 0;
            status.expires_at = String::new();
            status.message =
                "Max 20× plan activated (local test). Pay-as-you-go usage wallet.".into();
            status.reset_windows_fresh();
        } else if upper.starts_with("HORMA-MAX10") {
            status.plan = "max10".into();
            status.active = true;
            status.token_budget = plan_budget("max10");
            status.tokens_used = 0;
            status.expires_at = String::new();
            status.message =
                "Max 10× plan activated (local test). Pay-as-you-go usage wallet.".into();
            status.reset_windows_fresh();
        } else if upper.starts_with("HORMA-MAX")
            || upper.starts_with("HORMA-ULTRA")
            || upper.starts_with("HORMA-AGENCY")
        {
            status.plan = "max5".into();
            status.active = true;
            status.token_budget = plan_budget("max5");
            status.tokens_used = 0;
            status.expires_at = String::new();
            status.message =
                "Max 5× plan activated (local test). Pay-as-you-go usage wallet.".into();
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
            status.expires_at = String::new();
            status.message =
                "Pro+ plan activated (local test). Pay-as-you-go usage wallet.".into();
            status.reset_windows_fresh();
        } else if upper.starts_with("HORMA-PRO")
            || upper.starts_with("HORMA-STARTER")
            || upper.starts_with("HORMA-15")
            || upper.starts_with("HORMA-FIFTEEN")
            || upper.starts_with("HORMA-599")
            || upper.starts_with("HORMA-")
        {
            status.plan = "pro".into();
            status.active = true;
            status.token_budget = plan_budget("pro");
            status.tokens_used = 0;
            status.expires_at = String::new();
            status.message = "Pro plan activated (local test). Pay-as-you-go usage wallet.".into();
            status.reset_windows_fresh();
        } else {
            status.message =
                "Unrecognized key. Buy a plan at hormachuelos.vercel.app then paste the key here."
                    .into();
        }
        status.save_unlocked()?;
        Ok(status.for_api())
    })
}

/// Refresh hosted usage counters from the server (best-effort).
pub async fn refresh_from_server() -> Result<LicenseStatus> {
    let key = with_license_lock(|| {
        let s = LicenseStatus::load_unlocked().unwrap_or_default();
        Ok(s.license_key)
    })?;
    if key.trim().is_empty() {
        return LicenseStatus::load().map(|s| s.for_api());
    }
    apply_license_key(&key).await
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

    fn hosted_pro_status() -> LicenseStatus {
        LicenseStatus {
            plan: "pro".into(),
            active: true,
            license_key: "HORMA-TEST".into(),
            hosted: true,
            ..Default::default()
        }
    }

    #[test]
    fn ollama_always_uses_its_configured_local_host() {
        let status = hosted_pro_status();
        assert!(should_use_hosted(&status));
        assert!(!should_use_hosted_for_provider(&status, "ollama"));
        assert!(!should_use_hosted_for_provider(&status, "OLLAMA"));
    }

    #[test]
    fn cursor_always_uses_its_local_sdk() {
        let status = hosted_pro_status();
        assert!(should_use_hosted(&status));
        assert!(!should_use_hosted_for_provider(&status, "cursor"));
        assert!(!should_use_hosted_for_provider(&status, "CURSOR"));
    }

    #[test]
    fn hosted_plan_still_proxies_supported_cloud_providers() {
        let status = hosted_pro_status();
        assert!(should_use_hosted_for_provider(&status, "deepseek"));
        assert!(should_use_hosted_for_provider(&status, "openrouter"));
        assert!(should_use_hosted_for_provider(&status, "xai"));
    }

    #[test]
    fn payg_license_ignores_calendar_expiry() {
        let mut status = LicenseStatus {
            plan: "pro".into(),
            active: true,
            expires_at: "2026-07-14".into(),
            ..Default::default()
        };
        assert!(!status.enforce_expiry_at(NaiveDate::from_ymd_opt(2026, 7, 15).unwrap()));
        assert!(status.active);
        assert_eq!(status.plan, "pro");
    }

    #[test]
    fn payg_license_remains_active_with_or_without_expiry_date() {
        let mut status = LicenseStatus {
            plan: "pro".into(),
            active: true,
            expires_at: "2026-07-15".into(),
            ..Default::default()
        };
        assert!(!status.enforce_expiry_at(NaiveDate::from_ymd_opt(2026, 7, 15).unwrap()));
        assert!(status.active);
        status.expires_at.clear();
        assert!(!status.enforce_expiry_at(NaiveDate::from_ymd_opt(2099, 1, 1).unwrap()));
        assert!(status.active);
    }

    #[test]
    fn burst_windows_are_generous_relative_to_plan_pool() {
        // Pro plan pool = 3,075,739 tokens.
        let (four_h, weekly) = window_budgets("pro", plan_budget("pro"));
        // 4h ≈ 20% of the pool, weekly ≈ 50% of the pool.
        assert_eq!(four_h, plan_budget("pro") / 5);
        assert_eq!(weekly, plan_budget("pro") / 2);
        // The 4h window must be far larger than the old weekly/6 pacing cap
        // (which was ~119k for pro) so it no longer blocks a session that
        // still has most of its plan pool left.
        assert!(four_h > 300_000);
    }

    #[test]
    fn session_with_72_percent_remaining_is_not_blocked_by_burst_windows() {
        // User has used 28% of a pro plan (72% remaining) but only a modest
        // amount in the current 4h window. This must NOT be rate-blocked.
        let mut status = LicenseStatus {
            plan: "pro".into(),
            active: true,
            token_budget: plan_budget("pro"),
            tokens_used: (plan_budget("pro") as f64 * 0.28) as u64,
            ..Default::default()
        };
        status.refresh_rate_windows();
        // 4h usage well under the 20% burst cap.
        status.window_4h_used = plan_budget("pro") / 10;
        status.window_week_used = plan_budget("pro") / 4;
        status.refresh_rate_windows();
        assert_eq!(status.blocked_by, "");
        assert!(!status.is_rate_blocked());
        assert_eq!(status.remaining_percent(), 72);
    }
}
