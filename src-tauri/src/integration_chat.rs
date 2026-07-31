use crate::llm::ToolCall;
use regex::Regex;
use serde_json::{json, Value};
use std::sync::OnceLock;

const CREDENTIAL_REDACTION: &str =
    "[credential removed — paste it in the Connect card or Settings → Integrations]";

fn prefixed_secret_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r"(?i)\b(?:gh[pousr]_[a-z0-9_]{16,}|github_pat_[a-z0-9_]{16,}|glpat-[a-z0-9_-]{16,}|sbp_[a-z0-9]{16,}|supabase[_-]?[a-z0-9_-]{16,}|vercel_[a-z0-9_-]{16,}|sk-[a-z0-9_-]{16,}|eyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,})\b",
        )
        .expect("credential prefix regex")
    })
}

fn contextual_secret_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r#"(?i)\b((?:access[\s_-]*)?token|api[\s_-]*key|client[\s_-]*secret|secret|password|bearer)\b(\s*(?:is|=|:)?\s*["']?)[a-z0-9._~+/=-]{12,}["']?"#,
        )
        .expect("contextual credential regex")
    })
}

/// Remove credential-shaped values before chat text reaches a provider or transcript.
pub fn redact_sensitive_text(text: &str, known_secrets: &[String]) -> String {
    let prefixed = prefixed_secret_pattern()
        .replace_all(text, CREDENTIAL_REDACTION)
        .into_owned();
    let mut redacted = contextual_secret_pattern()
        .replace_all(&prefixed, |captures: &regex::Captures<'_>| {
            format!(
                "{}{}{}",
                captures.get(1).map_or("", |value| value.as_str()),
                captures.get(2).map_or("", |value| value.as_str()),
                CREDENTIAL_REDACTION
            )
        })
        .into_owned();

    for secret in known_secrets {
        let secret = secret.trim();
        if secret.len() >= 8 && redacted.contains(secret) {
            redacted = redacted.replace(secret, CREDENTIAL_REDACTION);
        }
    }
    redacted
}

/// Redact string leaves recursively while preserving a tool argument's JSON shape.
pub fn redact_sensitive_value(value: &Value, known_secrets: &[String]) -> Value {
    match value {
        Value::String(text) => Value::String(redact_sensitive_text(text, known_secrets)),
        Value::Array(values) => Value::Array(
            values
                .iter()
                .map(|value| redact_sensitive_value(value, known_secrets))
                .collect(),
        ),
        Value::Object(values) => Value::Object(
            values
                .iter()
                .map(|(key, value)| (key.clone(), redact_sensitive_value(value, known_secrets)))
                .collect(),
        ),
        _ => value.clone(),
    }
}

fn normalized_words(text: &str) -> String {
    let words = text
        .chars()
        .map(|character| {
            if character.is_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>();
    format!(
        " {} ",
        words.split_whitespace().collect::<Vec<_>>().join(" ")
    )
}

fn has_phrase(words: &str, phrase: &str) -> bool {
    words.contains(&format!(" {phrase} "))
}

fn has_any_phrase(words: &str, phrases: &[&str]) -> bool {
    phrases.iter().any(|phrase| has_phrase(words, phrase))
}

fn service_from_words(words: &str) -> Option<&'static str> {
    let aliases: &[(&str, &[&str])] = &[
        ("github", &["github", "git hub"]),
        ("supabase", &["supabase"]),
        ("vercel", &["vercel"]),
        ("netlify", &["netlify"]),
        ("cloudflare", &["cloudflare", "cloud flare"]),
        ("railway", &["railway"]),
        ("render", &["render"]),
        ("fly", &["fly io", "fly"]),
    ];
    aliases.iter().find_map(|(service, names)| {
        names
            .iter()
            .any(|name| has_phrase(words, name))
            .then_some(*service)
    })
}

/// Route explicit integration auth requests before a model can incorrectly claim no tool exists.
///
/// This intentionally accepts only the built-in service catalog. Arbitrary MCP URLs and
/// provider identifiers are left to the model, which is instructed to explain that no generic
/// remote MCP runtime exists yet.
///
/// Status / “is it connected?” questions always win over connect — never open the Connect card
/// for those prompts.
pub fn auth_tool_for_prompt(prompt: &str) -> Option<ToolCall> {
    let words = normalized_words(prompt);
    let service = service_from_words(&words);
    let wants_live_check =
        has_any_phrase(&words, &["verify", "test", "check", "who am i", "validate"]);
    let status_words = has_any_phrase(
        &words,
        &[
            "status",
            "connected",
            "logged in",
            "signed in",
            "authenticated",
            "authed",
            "authorized",
        ],
    );
    let catalog_scope = has_any_phrase(
        &words,
        &[
            "integration",
            "integrations",
            "account",
            "accounts",
            "mcp",
            "server",
            "servers",
            "service",
            "services",
            "logged in",
        ],
    );
    let is_question = has_any_phrase(
        &words,
        &[
            "is", "are", "any", "which", "what", "do i", "have i", "am i", "how many",
        ],
    );
    let wants_status = wants_live_check
        || status_words
        || (is_question
            && catalog_scope
            && !has_any_phrase(
                &words,
                &[
                    "connect",
                    "login",
                    "log in",
                    "sign in",
                    "authenticate",
                    "authorize",
                    "link",
                ],
            ));

    // Explicit connect verbs — "auth" alone only counts when not a status question
    let wants_connect = has_any_phrase(
        &words,
        &[
            "connect",
            "login",
            "log in",
            "sign in",
            "authenticate",
            "authorize",
            "link",
        ],
    ) || (has_phrase(&words, "auth") && !wants_status && !is_question)
        || (has_phrase(&words, "authentication") && !wants_status && !is_question)
        || (has_phrase(&words, "save")
            && has_any_phrase(&words, &["token", "api key", "credential", "secret"]));

    // Status inquiries always take priority — never force connect_account / Connect card
    if wants_status {
        if service.is_none() && !catalog_scope && !status_words && !wants_live_check {
            return None;
        }
        let mut arguments = json!({ "verify": wants_live_check && service.is_some() });
        if let Some(service) = service {
            arguments["service"] = Value::String(service.to_string());
        }
        return Some(ToolCall {
            id: format!("auth_status_{}", uuid::Uuid::new_v4().simple()),
            name: "integration_status".into(),
            arguments,
        });
    }

    if wants_connect {
        let service = service?;
        return Some(ToolCall {
            id: format!("auth_connect_{}", uuid::Uuid::new_v4().simple()),
            name: "connect_account".into(),
            arguments: json!({ "service": service }),
        });
    }

    None
}

/// True when the user is asking about connection state — not requesting a new login.
/// Used to suppress the in-chat Connect card and rewrite mistaken connect_account calls.
pub fn prompt_is_status_inquiry(prompt: &str) -> bool {
    matches!(
        auth_tool_for_prompt(prompt)
            .as_ref()
            .map(|call| call.name.as_str()),
        Some("integration_status")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_vercel_login_and_token_save_to_secure_connect_tool() {
        for prompt in [
            "Log in to Vercel for me",
            "Auth Vercel",
            "Save my Vercel token: abcdefghijklmnopqrstuvwxyz",
        ] {
            let call = auth_tool_for_prompt(prompt).expect("auth request should route");
            assert_eq!(call.name, "connect_account");
            assert_eq!(call.arguments["service"], "vercel");
            assert!(call.arguments.get("token").is_none());
        }
    }

    #[test]
    fn routes_github_verification_to_live_status_tool() {
        let call =
            auth_tool_for_prompt("Verify my GitHub login").expect("status request should route");
        assert_eq!(call.name, "integration_status");
        assert_eq!(call.arguments["service"], "github");
        assert_eq!(call.arguments["verify"], true);
    }

    #[test]
    fn routes_mcp_auth_status_questions_to_status_not_connect() {
        for prompt in [
            "is any mcp server authed",
            "are any mcp servers authenticated?",
            "which integrations are connected",
            "do I have any accounts logged in",
            "is supabase connected",
        ] {
            let call = auth_tool_for_prompt(prompt).expect("status request should route");
            assert_eq!(call.name, "integration_status", "prompt={prompt}");
            assert!(prompt_is_status_inquiry(prompt));
        }
        assert!(!prompt_is_status_inquiry("Connect Supabase"));
        assert!(!prompt_is_status_inquiry("Auth Vercel"));
    }

    #[test]
    fn does_not_treat_arbitrary_mcp_servers_as_builtin_integrations() {
        assert!(auth_tool_for_prompt("Connect https://evil.example/mcp").is_none());
        assert!(auth_tool_for_prompt("Authenticate my GitLab MCP server").is_none());
    }

    #[test]
    fn redacts_prefixed_and_contextual_credentials() {
        let github = "ghp_abcdefghijklmnopqrstuvwxyz123456";
        let vercel = "abcdefghijklmnopqrstuvwx";
        let text = format!("GitHub {github}; Vercel token: {vercel}");
        let redacted = redact_sensitive_text(&text, &[]);
        assert!(!redacted.contains(github));
        assert!(!redacted.contains(vercel));
        assert_eq!(redacted.matches(CREDENTIAL_REDACTION).count(), 2);
    }

    #[test]
    fn redacts_stored_secrets_from_nested_tool_arguments() {
        let secret = "stored-secret-value-123".to_string();
        let value = json!({
            "command": format!("Write-Output {secret}"),
            "nested": [secret.clone()]
        });
        let redacted = redact_sensitive_value(&value, &[secret.clone()]);
        let encoded = redacted.to_string();
        assert!(!encoded.contains(&secret));
        assert!(encoded.contains("credential removed"));
    }
}
