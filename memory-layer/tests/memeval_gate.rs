//! Exercise the shipped binary: CI must fail if retrieval slips, not just if
//! an independently reconstructed search fixture happens to pass.
use std::process::Command;

fn hash_eval() -> serde_json::Value {
    let output = Command::new(env!("CARGO_BIN_EXE_memeval"))
        .args(["--hash", "--json"])
        .current_dir(std::env::temp_dir())
        // --hash must stay offline even on a developer machine with a key.
        .env("OPENROUTER_API_KEY", "offline-eval-must-ignore-this")
        .output().expect("run memeval");
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    serde_json::from_slice(&output.stdout).expect("--json must emit one JSON object, no prose")
}

#[test]
fn hash_retrieval_meets_pinned_floor() {
    let report = hash_eval();
    assert_eq!(report["embedder"], "hashing");
    assert_eq!(report["n"], 22);
    // Published pins use whole percentages and three-decimal MRR. In this
    // corpus 16/22 is the published 73%, not an unattainable fractional hit.
    assert!(report["hit_at_1_percent"].as_f64().unwrap().round() >= 73.0, "{report}");
    assert!(report["hit_at_3_percent"].as_f64().unwrap().round() >= 77.0, "{report}");
    assert!((report["mrr"].as_f64().unwrap() * 1000.0).round() >= 743.0, "{report}");
}

#[test]
fn hash_retrieval_json_is_deterministic() {
    assert_eq!(hash_eval(), hash_eval());
}
