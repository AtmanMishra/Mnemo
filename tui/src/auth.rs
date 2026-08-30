//! 8.2 Auth store, in the runtime.
//!
//! Reads and writes the SAME ~/.mnemo/auth.json the agent reads, so logging in
//! from inside `mnemo-agent` is indistinguishable from having run the old CLI
//! wizard. The schema is mirrored from agent/src/auth/store.ts — if that
//! changes, `auth_matches_the_agent_schema` in the tests is what catches it.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Providers Mnemo can authenticate. These ids are pi's own ids.
pub const PROVIDERS: [&str; 5] = ["anthropic", "openai", "openrouter", "opencode", "opencode-go"];

/// The env var each provider's key is exported as.
pub fn env_key_for(provider: &str) -> &'static str {
    match provider {
        "anthropic" => "ANTHROPIC_API_KEY",
        "openai" => "OPENAI_API_KEY",
        "openrouter" => "OPENROUTER_API_KEY",
        _ => "OPENCODE_API_KEY",
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ProviderAuth {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(rename = "defaultModel", skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AuthFile {
    pub version: u32,
    pub providers: BTreeMap<String, ProviderAuth>,
    #[serde(rename = "defaultProvider", skip_serializing_if = "Option::is_none")]
    pub default_provider: Option<String>,
}

impl Default for AuthFile {
    fn default() -> Self {
        Self { version: 1, providers: BTreeMap::new(), default_provider: None }
    }
}

impl AuthFile {
    /// Providers with a usable credential, in rail order.
    pub fn logged_in(&self) -> Vec<&str> {
        PROVIDERS.iter().copied()
            .filter(|p| self.providers.get(*p).map(|a| a.key.as_deref().unwrap_or("").len() >= 8).unwrap_or(false))
            .collect()
    }

    pub fn is_configured(&self) -> bool {
        !self.logged_in().is_empty()
    }

    /// The provider a new session should use: the stored default if it is
    /// still logged in, otherwise the first one that is.
    pub fn effective_provider(&self) -> Option<&str> {
        let live = self.logged_in();
        match &self.default_provider {
            Some(d) if live.contains(&d.as_str()) => live.into_iter().find(|p| *p == d),
            _ => live.into_iter().next(),
        }
    }

    pub fn default_model_for(&self, provider: &str) -> Option<&str> {
        self.providers.get(provider)?.default_model.as_deref()
    }

    /// Every (provider, model) pair the user could pick for an agent (8.7).
    pub fn available_models(&self) -> Vec<(String, String)> {
        self.logged_in().into_iter()
            .filter_map(|p| self.default_model_for(p).map(|m| (p.to_string(), m.to_string())))
            .collect()
    }
}

pub fn auth_path(home: &Path) -> PathBuf {
    home.join(".mnemo").join("auth.json")
}

/// A missing or unreadable file means "not logged in", never an error: the
/// onboarding screen is the answer to both.
pub fn load(home: &Path) -> AuthFile {
    std::fs::read_to_string(auth_path(home))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save(home: &Path, auth: &AuthFile) -> Result<(), String> {
    let path = auth_path(home);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    let body = serde_json::to_string_pretty(auth).map_err(|e| e.to_string())?;
    std::fs::write(&path, body + "\n").map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    restrict(&path)
}

/// Credentials are user-only, matching what the agent's store writes.
fn restrict(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("cannot chmod {}: {e}", path.display()))?;
    }
    let _ = path;
    Ok(())
}

/// Record a key for one provider. Returns an error the UI can show verbatim.
pub fn set_key(
    home: &Path,
    provider: &str,
    key: &str,
    default_model: Option<&str>,
    now: u64,
) -> Result<AuthFile, String> {
    if !PROVIDERS.contains(&provider) {
        return Err(format!("unknown provider '{provider}'"));
    }
    let key = key.trim();
    if key.len() < 8 {
        return Err("that key looks too short — paste the whole thing".into());
    }
    let mut auth = load(home);
    auth.providers.insert(provider.to_string(), ProviderAuth {
        kind: "api_key".into(),
        key: Some(key.to_string()),
        default_model: default_model.map(str::to_string),
        updated_at: now,
    });
    auth.default_provider.get_or_insert_with(|| provider.to_string());
    save(home, &auth)?;
    Ok(auth)
}

pub fn set_default_model(home: &Path, provider: &str, model: &str) -> Result<AuthFile, String> {
    let mut auth = load(home);
    let entry = auth.providers.get_mut(provider)
        .ok_or_else(|| format!("not logged in to {provider}"))?;
    entry.default_model = Some(model.to_string());
    // do NOT repoint default_provider here: choosing a model while logging in
    // to a SECOND provider would silently switch which one new sessions use.
    // Changing the default is its own deliberate action.
    auth.default_provider.get_or_insert_with(|| provider.to_string());
    save(home, &auth)?;
    Ok(auth)
}

/// Deliberately change which provider new sessions use.
pub fn set_default_provider(home: &Path, provider: &str) -> Result<AuthFile, String> {
    let mut auth = load(home);
    if !auth.logged_in().contains(&provider) {
        return Err(format!("not logged in to {provider}"));
    }
    auth.default_provider = Some(provider.to_string());
    save(home, &auth)?;
    Ok(auth)
}

pub fn logout(home: &Path, provider: &str) -> Result<AuthFile, String> {
    let mut auth = load(home);
    auth.providers.remove(provider);
    if auth.default_provider.as_deref() == Some(provider) {
        auth.default_provider = auth.logged_in().first().map(|p| p.to_string());
    }
    save(home, &auth)?;
    Ok(auth)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mnemo-auth-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn not_logged_in_is_a_state_not_an_error() {
        let home = tmp("empty");
        let auth = load(&home);
        assert!(!auth.is_configured());
        assert!(auth.logged_in().is_empty());
        assert_eq!(auth.effective_provider(), None);

        // a corrupt file is the same state: onboarding, not a crash
        std::fs::create_dir_all(home.join(".mnemo")).unwrap();
        std::fs::write(auth_path(&home), "{{ not json").unwrap();
        assert!(!load(&home).is_configured());
    }

    #[test]
    fn a_key_round_trips_and_stays_private() {
        let home = tmp("roundtrip");
        let auth = set_key(&home, "opencode-go", "sk-test-value-1234", Some("claude-opus-5"), 42).unwrap();
        assert_eq!(auth.default_provider.as_deref(), Some("opencode-go"));
        assert_eq!(auth.default_model_for("opencode-go"), Some("claude-opus-5"));

        let reloaded = load(&home);
        assert_eq!(reloaded, auth, "what we wrote is what we read back");
        assert!(reloaded.is_configured());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(auth_path(&home)).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "credentials must not be world-readable");
        }
    }

    #[test]
    fn the_file_matches_the_agent_schema() {
        // the agent reads this exact file; the field names are the contract
        let home = tmp("schema");
        set_key(&home, "openrouter", "sk-or-abcdefghij", Some("kimi"), 1).unwrap();
        let raw = std::fs::read_to_string(auth_path(&home)).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["version"], 1);
        assert_eq!(v["defaultProvider"], "openrouter", "camelCase, as the agent expects");
        assert_eq!(v["providers"]["openrouter"]["kind"], "api_key");
        assert_eq!(v["providers"]["openrouter"]["defaultModel"], "kimi");
        assert!(v["providers"]["openrouter"]["updated_at"].is_number());
    }

    #[test]
    fn short_keys_and_unknown_providers_are_refused_with_a_readable_reason() {
        let home = tmp("bad");
        let err = set_key(&home, "opencode-go", "abc", None, 1).unwrap_err();
        assert!(err.contains("too short"), "{err}");
        let err = set_key(&home, "not-a-provider", "sk-long-enough-key", None, 1).unwrap_err();
        assert!(err.contains("unknown provider"), "{err}");
        assert!(!load(&home).is_configured(), "a refused login must not half-write the file");
    }

    #[test]
    fn the_effective_provider_survives_a_stale_default() {
        let home = tmp("stale");
        set_key(&home, "openrouter", "sk-or-abcdefghij", Some("kimi"), 1).unwrap();
        set_key(&home, "anthropic", "sk-ant-abcdefghij", Some("claude-opus-5"), 2).unwrap();
        let mut auth = load(&home);
        assert_eq!(auth.effective_provider(), Some("openrouter"), "first login stays the default");

        // a default pointing at a provider we logged out of must not strand us
        auth.default_provider = Some("openai".into());
        assert_eq!(auth.effective_provider(), Some("anthropic"),
            "falls back to a provider that IS logged in, in rail order");
    }

    #[test]
    fn logout_clears_the_provider_and_moves_the_default() {
        let home = tmp("logout");
        set_key(&home, "openrouter", "sk-or-abcdefghij", Some("kimi"), 1).unwrap();
        set_key(&home, "anthropic", "sk-ant-abcdefghij", Some("claude-opus-5"), 2).unwrap();
        let auth = logout(&home, "openrouter").unwrap();
        assert_eq!(auth.logged_in(), vec!["anthropic"]);
        assert_eq!(auth.default_provider.as_deref(), Some("anthropic"),
            "logging out of the default must pick another, not leave a dangling one");
    }

    #[test]
    fn available_models_are_what_a_subagent_may_be_given() {
        let home = tmp("models");
        set_key(&home, "anthropic", "sk-ant-abcdefghij", Some("claude-opus-5"), 1).unwrap();
        set_key(&home, "opencode-go", "sk-oc-abcdefghij", Some("kimi-k2.6"), 2).unwrap();
        // a provider with a key but no chosen model offers nothing to pick yet
        set_key(&home, "openai", "sk-oa-abcdefghij", None, 3).unwrap();

        let models = load(&home).available_models();
        assert_eq!(models, vec![
            ("anthropic".to_string(), "claude-opus-5".to_string()),
            ("opencode-go".to_string(), "kimi-k2.6".to_string()),
        ]);
    }

    #[test]
    fn choosing_a_model_does_not_repoint_the_default_provider() {
        let home = tmp("default");
        set_key(&home, "anthropic", "sk-ant-abcdefghij", Some("claude-opus-5"), 1).unwrap();
        set_key(&home, "opencode-go", "sk-oc-abcdefghij", None, 2).unwrap();
        let auth = set_default_model(&home, "opencode-go", "kimi-k2.6").unwrap();
        assert_eq!(auth.default_provider.as_deref(), Some("anthropic"),
            "picking a model for another provider is not a request to switch");

        // switching is available, just deliberate
        let auth = set_default_provider(&home, "opencode-go").unwrap();
        assert_eq!(auth.effective_provider(), Some("opencode-go"));
        assert!(set_default_provider(&home, "openai").is_err(), "cannot default to a provider with no key");
    }

    #[test]
    fn env_var_names_match_the_agent() {
        assert_eq!(env_key_for("anthropic"), "ANTHROPIC_API_KEY");
        assert_eq!(env_key_for("openai"), "OPENAI_API_KEY");
        assert_eq!(env_key_for("openrouter"), "OPENROUTER_API_KEY");
        // both opencode flavours share one key, as the agent's store does
        assert_eq!(env_key_for("opencode"), "OPENCODE_API_KEY");
        assert_eq!(env_key_for("opencode-go"), "OPENCODE_API_KEY");
    }
}
