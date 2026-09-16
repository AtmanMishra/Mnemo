//! 7.3: run the learned-steering-policy experiment over a journal and print
//! how the learned policy compares to the rule that ships today.
//!
//! Usage:
//!   cargo run --bin mempolicy [--json] [journal-path]
//!   cargo run --bin mempolicy -- --synth     (in-memory synthetic journal)
//!
//! --json emits the training-row report as ONE JSON object on stdout, the
//! same contract memeval's --json has, so a script/CI job can consume the
//! numbers without parsing the human table. The "nothing to learn from"
//! case is machine-readable too: `"learnable": false` plus a `reason`.
use memory_layer::persist::Journal;
use memory_layer::policy::{run_experiment, synthetic_journal_ops, Experiment, Score};
use std::path::{Path, PathBuf};

fn main() {
    // Flags may appear anywhere; the first non-flag argument is the journal.
    // (The old parser took args.nth(1), so `mempolicy --json journal.jsonl`
    // silently ignored the path.)
    let args: Vec<String> = std::env::args().skip(1).collect();
    let synth = args.iter().any(|a| a == "--synth");
    let json = args.iter().any(|a| a == "--json");
    let path_arg = args.iter().find(|a| !a.starts_with("--")).cloned();

    let (ops, journal_label, synthetic): (Vec<_>, String, bool) = if synth {
        (synthetic_journal_ops(), "synthetic (generated in-memory)".to_string(), true)
    } else {
        let p = path_arg.map(PathBuf::from).unwrap_or_else(default_journal_path);
        match Journal::read_all(&p) {
            Ok(ops) => (ops, p.display().to_string(), false),
            Err(e) => { eprintln!("cannot read {}: {e}", p.display()); std::process::exit(1); }
        }
    };

    let exp = run_experiment(&ops);

    if json {
        println!("{}", report_json(&journal_label, synthetic, ops.len(), &exp));
        return;
    }

    println!("journal: {journal_label} ({} ops)", ops.len());
    println!("examples: {} ({} blamed, {} not)",
        exp.examples, exp.positives, exp.examples - exp.positives);
    if exp.examples == 0 {
        println!("\nnothing to learn from: this journal records no failures with feeders.");
        return;
    }
    println!("held out: {}\n", exp.learned.n);
    println!("{:<12} {:>9} {:>10} {:>8}", "policy", "accuracy", "precision", "recall");
    for (name, s) in [("heuristic", exp.heuristic), ("learned", exp.learned)] {
        println!("{name:<12} {:>8.0}% {:>9.0}% {:>7.0}%",
            100.0 * s.accuracy, 100.0 * s.precision, 100.0 * s.recall);
    }
    println!("\nlearned weights: overlap={:.2} ratio={:.2} weight={:.2} \
              fails={:.2} wins={:.2} facts={:.2} bias={:.2}",
        exp.policy.weights[0], exp.policy.weights[1], exp.policy.weights[2],
        exp.policy.weights[3], exp.policy.weights[4], exp.policy.weights[5],
        exp.policy.bias);
    println!("\nThis is an experiment, not a shipped policy: steer() still uses\n\
              the lexical-overlap rule. Replace it only if `learned` beats\n\
              `heuristic` on a journal with real history, not a synthetic one.");
}

/// The --json report: one object, unrounded numbers, stable key names.
/// `learnable: false` + `reason` is the machine-readable form of the
/// "nothing to learn from" case — a script can branch on it instead of
/// grep-ing English prose. Metrics are nested per policy (heuristic/learned)
/// with the same key names memeval uses.
fn report_json(label: &str, synthetic: bool, ops: usize, exp: &Experiment) -> serde_json::Value {
    let mut out = serde_json::json!({
        "journal": label,
        "synthetic": synthetic,
        "ops": ops,
        "examples": exp.examples,
        "positives": exp.positives,
        "negatives": exp.examples - exp.positives,
        "learnable": exp.examples > 0,
    });
    if exp.examples == 0 {
        out["reason"] = serde_json::json!(
            "this journal records no failures with feeders: no (failure, feeder) rows to train or score");
    } else {
        out["held_out"] = serde_json::json!(exp.learned.n);
        out["heuristic"] = score_json(exp.heuristic);
        out["learned"] = score_json(exp.learned);
        // feature order matches policy::Features::as_vec / the paper trail
        out["policy_weights"] = serde_json::json!({
            "overlap": exp.policy.weights[0],
            "overlap_ratio": exp.policy.weights[1],
            "weight": exp.policy.weights[2],
            "prior_failures": exp.policy.weights[3],
            "prior_successes": exp.policy.weights[4],
            "fact_count": exp.policy.weights[5],
            "bias": exp.policy.bias,
        });
    }
    out
}

fn score_json(s: Score) -> serde_json::Value {
    serde_json::json!({
        "accuracy": s.accuracy, "precision": s.precision, "recall": s.recall, "n": s.n,
    })
}

/// Resolve the journal the way the agent side already does
/// (`resolveMemsrvPaths` in agent/src/hooks/memory.ts), instead of the old
/// CWD-relative `data/sea-agent-journal.jsonl` — a THIRD convention for the
/// same file. The journal is the single source of truth for memory state, so
/// a wrong default does not fail loudly: mempolicy would read an empty or
/// stale file and report "nothing to learn from" while the agent writes to
/// its real journal elsewhere. Precedence, identical to the agent helper:
///
///   1. MNEMO_MEMORY_JOURNAL (legacy SEA_MEMORY_JOURNAL) — an explicit
///      override wins even when the file does not exist (the caller asked
///      for that path; the error must name it);
///   2. $MNEMO_HOME/journal.jsonl (default ~/.mnemo/journal.jsonl) when it
///      exists — the installed layout;
///   3. <source checkout>/memory-layer/data/sea-agent-journal.jsonl,
///      DEVELOPMENT ONLY and only when it exists — for a dev checkout that
///      has an existing journal in the tree;
///   4. the home path again, so when nothing exists yet the error/report
///      points at the installed layout memsrv would create.
fn default_journal_path() -> PathBuf {
    let env = |k: &str| std::env::var(k).ok();
    let home = mnemo_home(&env);
    resolve_journal(&env, home.as_deref(), Path::new(env!("CARGO_MANIFEST_DIR")), &|p| p.exists())
}

/// $MNEMO_HOME when set (non-blank), else the per-user Mnemo home
/// (~/.mnemo; USERPROFILE on Windows, HOME elsewhere — os.homedir()'s own
/// order). None when no home is resolvable at all.
fn mnemo_home(env: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
    if let Some(h) = env("MNEMO_HOME").map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        return Some(PathBuf::from(h));
    }
    ["USERPROFILE", "HOME"].iter()
        .filter_map(|k| env(k).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
        .next()
        .map(|h| PathBuf::from(h).join(".mnemo"))
}

/// Pure resolver behind `default_journal_path`, so the precedence is tested
/// without touching the process environment or the filesystem.
fn resolve_journal(
    env: &dyn Fn(&str) -> Option<String>,
    home: Option<&Path>,
    manifest_dir: &Path,
    exists: &dyn Fn(&Path) -> bool,
) -> PathBuf {
    let explicit = env("MNEMO_MEMORY_JOURNAL").or_else(|| env("SEA_MEMORY_JOURNAL"));
    if let Some(v) = explicit.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        return PathBuf::from(v);
    }
    let home_journal = home.map(|h| h.join("journal.jsonl"));
    let dev_journal = manifest_dir.join("data").join("sea-agent-journal.jsonl");
    match home_journal {
        Some(home) if exists(&home) => home,
        _ if exists(&dev_journal) => dev_journal,
        Some(home) => home,
        None => dev_journal,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_of<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |k: &str| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string())
    }

    #[test]
    fn explicit_env_override_wins_even_when_missing() {
        let env = env_of(&[("MNEMO_MEMORY_JOURNAL", "/var/j.jsonl")]);
        let got = resolve_journal(&env, Some(Path::new("/home/u/.mnemo")),
            Path::new("/repo/memory-layer"), &|_| true);
        assert_eq!(got, PathBuf::from("/var/j.jsonl"));
        // legacy alias, same weight
        let env = env_of(&[("SEA_MEMORY_JOURNAL", "legacy.jsonl")]);
        let got = resolve_journal(&env, None, Path::new("/repo/memory-layer"), &|_| true);
        assert_eq!(got, PathBuf::from("legacy.jsonl"));
    }

    #[test]
    fn home_journal_beats_the_checkout_when_it_exists() {
        let env = env_of(&[]);
        let home = Path::new("/home/u/.mnemo");
        // both exist -> home (installed layout)
        let got = resolve_journal(&env, Some(home), Path::new("/repo/memory-layer"), &|_| true);
        assert_eq!(got, home.join("journal.jsonl"));
        // only the checkout journal exists -> dev fallback
        let exists_dev_only = |p: &Path| p.starts_with("/repo/memory-layer");
        let got = resolve_journal(&env, Some(home), Path::new("/repo/memory-layer"), &exists_dev_only);
        assert_eq!(got, PathBuf::from("/repo/memory-layer/data/sea-agent-journal.jsonl"));
    }

    #[test]
    fn nothing_exists_returns_the_home_path_so_errors_point_at_the_install() {
        let env = env_of(&[]);
        let got = resolve_journal(&env, Some(Path::new("/home/u/.mnemo")),
            Path::new("/repo/memory-layer"), &|_| false);
        assert_eq!(got, PathBuf::from("/home/u/.mnemo/journal.jsonl"));
        // no home resolvable at all -> the dev path is all we have
        let got = resolve_journal(&env, None, Path::new("/repo/memory-layer"), &|_| false);
        assert_eq!(got, PathBuf::from("/repo/memory-layer/data/sea-agent-journal.jsonl"));
    }

    #[test]
    fn mnemo_home_prefers_env_then_userprofile_then_home() {
        let env = env_of(&[("MNEMO_HOME", " /srv/mnemo ")]);
        assert_eq!(mnemo_home(&env), Some(PathBuf::from("/srv/mnemo")));
        let env = env_of(&[("USERPROFILE", "C:/Users/u"), ("HOME", "/home/u")]);
        assert_eq!(mnemo_home(&env), Some(PathBuf::from("C:/Users/u").join(".mnemo")));
        let env = env_of(&[("HOME", "/home/u")]);
        assert_eq!(mnemo_home(&env), Some(PathBuf::from("/home/u").join(".mnemo")));
        let env = env_of(&[]);
        assert_eq!(mnemo_home(&env), None);
    }

    #[test]
    fn json_report_marks_the_nothing_to_learn_case() {
        let exp = run_experiment(&[]);
        let v = report_json("empty.jsonl", false, 0, &exp);
        assert_eq!(v["learnable"], false);
        assert_eq!(v["examples"], 0);
        assert!(v["reason"].as_str().unwrap().contains("no failures"));
        assert!(v.get("learned").is_none(), "no metrics without rows");
        assert_eq!(v["journal"], "empty.jsonl");
        assert_eq!(v["synthetic"], false);
    }

    #[test]
    fn json_report_carries_metrics_and_weights_when_there_is_signal() {
        let ops = synthetic_journal_ops();
        let exp = run_experiment(&ops);
        assert!(exp.examples > 0, "synthetic journal must be learnable");
        let v = report_json("synthetic (generated in-memory)", true, ops.len(), &exp);
        assert_eq!(v["learnable"], true);
        assert_eq!(v["examples"], exp.examples);
        assert_eq!(v["positives"], exp.positives);
        assert_eq!(v["held_out"], exp.learned.n);
        for policy in ["heuristic", "learned"] {
            for key in ["accuracy", "precision", "recall", "n"] {
                assert!(v[policy][key].is_number(), "{policy}.{key} missing: {v}");
            }
        }
        for key in ["overlap", "overlap_ratio", "weight", "prior_failures",
                    "prior_successes", "fact_count", "bias"] {
            assert!(v["policy_weights"][key].is_number(), "policy_weights.{key} missing: {v}");
        }
        assert!(v.get("reason").is_none(), "no reason key when learnable");
    }
}
