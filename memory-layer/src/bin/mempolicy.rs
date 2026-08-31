//! 7.3: run the learned-steering-policy experiment over a journal and print
//! how the learned policy compares to the rule that ships today.
//!
//! Usage:
//!   cargo run --bin mempolicy [journal-path]
//!   cargo run --bin mempolicy -- --synth     (in-memory synthetic journal)
use memory_layer::persist::Journal;
use memory_layer::policy::{run_experiment, synthetic_journal_ops};

fn main() {
    let synth = std::env::args().any(|a| a == "--synth");
    let path = std::env::args().nth(1).filter(|a| a != "--synth");

    let (ops, label) = if synth {
        (synthetic_journal_ops(), "synthetic (generated in-memory)".to_string())
    } else {
        let p = path.clone().unwrap_or_else(|| "data/sea-agent-journal.jsonl".into());
        let ops = match Journal::read_all(&p) {
            Ok(ops) => ops,
            Err(e) => { eprintln!("cannot read {p}: {e}"); std::process::exit(1); }
        };
        (ops, p)
    };
    let exp = run_experiment(&ops);
    println!("journal: {label} ({} ops)", ops.len());
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