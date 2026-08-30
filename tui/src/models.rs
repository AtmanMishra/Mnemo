//! The model catalog: which models the logged-in providers actually offer.
//!
//! Before this, choosing a model meant typing its name from memory — the
//! onboarding step and `/model` both asked for a string and rejected anything
//! they did not recognise, which is only usable if you already know the
//! answer. `mnemo --list-models` resolves the real list from pi's provider
//! catalog using the stored credentials, so that is where the list comes from.
//!
//! Parsing is a pure function over the command's output, so the table format
//! is pinned by tests without running node.
use std::path::Path;
use std::process::Command;

/// One offering: which provider, which model.
pub type Model = (String, String);

/// Parse the `mnemo --list-models` table.
///
/// The command prints unrelated startup chatter ("skills: 27 loaded") before a
/// header row, so parsing starts at the header rather than at line 0 — and a
/// missing header means no models, not a panic.
pub fn parse_list_models(out: &str) -> Vec<Model> {
    let mut models = Vec::new();
    let mut seen_header = false;
    for line in out.lines() {
        let mut fields = line.split_whitespace();
        let (Some(a), Some(b)) = (fields.next(), fields.next()) else { continue };
        if !seen_header {
            // the header is the row naming the two columns we care about
            if a == "provider" && b == "model" { seen_header = true; }
            continue;
        }
        models.push((a.to_string(), b.to_string()));
    }
    models
}

/// Ask the agent for the catalog. Takes about half a second.
///
/// Returns an error string rather than an empty list so the caller can tell
/// "this provider offers nothing" apart from "we could not ask" — the second
/// must not look like the first, or a network blip reads as a broken account.
pub fn fetch_models(repo_root: &Path) -> Result<Vec<Model>, String> {
    let entry = repo_root.join("agent").join("bin").join("mnemo.ts");
    let out = Command::new("node")
        .arg(&entry)
        .arg("--list-models")
        .current_dir(repo_root)
        .output()
        .map_err(|e| format!("could not run the agent: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let tail = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("no output");
        return Err(format!("--list-models failed: {tail}"));
    }
    Ok(parse_list_models(&String::from_utf8_lossy(&out.stdout)))
}

/// Rows matching a filter, as `provider/model` substrings, case-insensitive.
///
/// One filter over both halves: "opus" and "anthropic" both narrow the list,
/// which is what someone typing into a picker expects.
pub fn filter_models(models: &[Model], needle: &str) -> Vec<Model> {
    let needle = needle.trim().to_lowercase();
    if needle.is_empty() { return models.to_vec() }
    models.iter()
        .filter(|(p, m)| format!("{p}/{m}").to_lowercase().contains(&needle))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const REAL: &str = "\
skills: 27 loaded
provider     model                            context  max-out  thinking  images
opencode     claude-opus-5                    1M       128K     yes       yes
opencode     gpt-5.5                          1.1M     128K     yes       yes
opencode-go  kimi-k2.6                        256K     32K      yes       no
";

    #[test]
    fn the_real_table_parses_to_provider_and_model() {
        let models = parse_list_models(REAL);
        assert_eq!(models, vec![
            ("opencode".to_string(), "claude-opus-5".to_string()),
            ("opencode".to_string(), "gpt-5.5".to_string()),
            ("opencode-go".to_string(), "kimi-k2.6".to_string()),
        ]);
    }

    #[test]
    fn startup_chatter_before_the_header_is_not_a_model() {
        // "skills: 27 loaded" has two fields and would otherwise parse as one
        let models = parse_list_models(REAL);
        assert!(!models.iter().any(|(p, _)| p == "skills:"), "{models:?}");
        assert!(!models.iter().any(|(p, _)| p == "provider"), "the header is not a row");
    }

    #[test]
    fn no_header_means_no_models_rather_than_garbage() {
        assert!(parse_list_models("").is_empty());
        assert!(parse_list_models("error: not logged in\n").is_empty(),
            "an error message must not be mistaken for a catalog");
    }

    #[test]
    fn the_filter_matches_either_half_of_provider_slash_model() {
        let models = parse_list_models(REAL);
        assert_eq!(filter_models(&models, "opus").len(), 1);
        assert_eq!(filter_models(&models, "OPUS").len(), 1, "case does not matter");
        assert_eq!(filter_models(&models, "opencode").len(), 3, "and a prefix of two providers");
        assert_eq!(filter_models(&models, "opencode-go").len(), 1);
        assert_eq!(filter_models(&models, "  ").len(), 3, "an empty filter hides nothing");
        assert!(filter_models(&models, "llama").is_empty());
    }

    #[test]
    fn a_failed_command_is_an_error_not_an_empty_catalog() {
        // "we could not ask" must not read as "this provider offers nothing"
        let missing = std::path::Path::new("/definitely/not/a/repo");
        match fetch_models(missing) {
            Err(e) => assert!(!e.is_empty()),
            Ok(models) => assert!(models.is_empty(), "no repo, no models: {models:?}"),
        }
    }
}
