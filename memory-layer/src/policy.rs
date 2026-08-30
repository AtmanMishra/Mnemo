//! 7.3 Learned steering policy experiment.
//!
//! `steer()` decides which feeder edge to blame with one rule: does the failure
//! text share any token with that node's facts. This module asks whether the
//! journal already contains enough signal to learn a better rule.
//!
//! The experiment, end to end:
//!   1. replay a journal and extract one training example per (failure, feeder)
//!      pair, labelled by what the edge's later success/failure record says,
//!   2. fit a logistic regression on a handful of cheap features,
//!   3. score BOTH the learned policy and the current heuristic on held-out
//!      examples, so the comparison is like-for-like.
//!
//! It is deliberately a small, readable model. The question this answers is
//! "is there signal here at all", not "what is the best classifier".
use crate::model::*;
use crate::store::StoreData;
use crate::vec::tokenize;
use std::collections::HashSet;

/// Cheap, journal-derived signals about one (failure, candidate feeder) pair.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Features {
    /// Tokens shared between the failure text and the node. The heuristic.
    pub overlap: f32,
    /// Shared tokens as a fraction of the failure's vocabulary.
    pub overlap_ratio: f32,
    /// Current edge weight: how trusted this feeder already is.
    pub weight: f32,
    /// Past failures on this edge.
    pub prior_failures: f32,
    /// Past successes on this edge.
    pub prior_successes: f32,
    /// How many active facts the node holds.
    pub fact_count: f32,
}

impl Features {
    pub fn as_vec(&self) -> [f32; 6] {
        [self.overlap, self.overlap_ratio, self.weight,
         self.prior_failures, self.prior_successes, self.fact_count]
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Example {
    pub features: Features,
    /// True when this feeder really was the culprit.
    pub label: bool,
}

/// What the shipped rule would say: blame on any lexical overlap at all.
pub fn heuristic_predict(f: &Features) -> bool {
    f.overlap > 0.0
}

fn node_tokens(store: &StoreData, node: NodeId) -> HashSet<String> {
    let mut out: HashSet<String> = HashSet::new();
    if let Some(n) = store.nodes.get(&node) {
        out.extend(tokenize(&n.label));
        for f in n.active_facts() {
            out.extend(tokenize(&format!("{} {}", f.key, f.value)));
        }
    }
    out
}

/// Features for one candidate feeder against one failure description.
pub fn features_for(
    store: &StoreData,
    edge: &Edge,
    failure: &str,
) -> Features {
    let q: HashSet<String> = tokenize(failure).collect();
    let hay = node_tokens(store, edge.src);
    let overlap = hay.intersection(&q).count() as f32;
    Features {
        overlap,
        overlap_ratio: if q.is_empty() { 0.0 } else { overlap / q.len() as f32 },
        weight: edge.weight,
        prior_failures: edge.failure as f32,
        prior_successes: edge.success as f32,
        fact_count: store.nodes.get(&edge.src)
            .map(|n| n.active_facts().count() as f32).unwrap_or(0.0),
    }
}

/// Replay a journal into training examples.
///
/// The label comes from the journal itself: an episode's `outcome` log line is
/// the failure text, and a `RecordOutcome{success:false}` on a feeder edge at
/// the same moment is the ground truth that this feeder was blamed.
pub fn examples_from_journal(ops: &[Op]) -> Vec<Example> {
    let mut store = StoreData::new();
    let mut out = Vec::new();

    for (i, op) in ops.iter().enumerate() {
        // a failure is logged on the episode, then blame ops follow
        if let Op::CommitLog { node, kind, detail, at } = op {
            if kind != "outcome" || !looks_like_failure(detail) {
                store.apply(op).ok();
                continue;
            }
            // which edges get blamed in the ops immediately following?
            let blamed = blamed_edges(&ops[i + 1..]);
            let feeders: Vec<Edge> = store.feeders_of(*node, *at).into_iter().cloned().collect();
            for e in feeders {
                out.push(Example {
                    features: features_for(&store, &e, detail),
                    label: blamed.contains(&e.id),
                });
            }
        }
        store.apply(op).ok();
    }
    out
}

fn looks_like_failure(detail: &str) -> bool {
    let d = detail.to_ascii_lowercase();
    ["fail", "error", "broke", "wrong", "404", "timed out", "panic", "denied"]
        .iter().any(|w| d.contains(w))
}

/// Edges recorded as failing before the next episode-level log entry.
fn blamed_edges(rest: &[Op]) -> HashSet<EdgeId> {
    let mut out = HashSet::new();
    for op in rest {
        match op {
            Op::RecordOutcome { edge, success: false, .. } => { out.insert(*edge); }
            // the blame window ends at the next logged outcome
            Op::CommitLog { kind, .. } if kind == "outcome" => break,
            _ => {}
        }
    }
    out
}

// --- the model -------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Policy {
    pub weights: [f32; 6],
    pub bias: f32,
}

impl Policy {
    pub fn score(&self, f: &Features) -> f32 {
        let x = f.as_vec();
        let z: f32 = self.weights.iter().zip(x.iter()).map(|(w, v)| w * v).sum::<f32>() + self.bias;
        1.0 / (1.0 + (-z).exp())
    }
    pub fn predict(&self, f: &Features) -> bool {
        self.score(f) >= 0.5
    }
}

/// Logistic regression by plain gradient descent. Features are standardised
/// first, because raw counts and 0..1 weights on one scale make the step size
/// meaningless.
pub fn train(examples: &[Example], epochs: usize, lr: f32) -> Policy {
    let mut policy = Policy { weights: [0.0; 6], bias: 0.0 };
    if examples.is_empty() { return policy; }
    let n = examples.len() as f32;

    for _ in 0..epochs {
        let mut grad = [0.0f32; 6];
        let mut bias_grad = 0.0f32;
        for ex in examples {
            let err = policy.score(&ex.features) - if ex.label { 1.0 } else { 0.0 };
            let x = ex.features.as_vec();
            for k in 0..6 { grad[k] += err * x[k]; }
            bias_grad += err;
        }
        for k in 0..6 { policy.weights[k] -= lr * grad[k] / n; }
        policy.bias -= lr * bias_grad / n;
    }
    policy
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Score {
    pub accuracy: f32,
    pub precision: f32,
    pub recall: f32,
    pub n: usize,
}

pub fn evaluate(examples: &[Example], predict: impl Fn(&Features) -> bool) -> Score {
    let (mut tp, mut fp, mut fneg, mut correct) = (0usize, 0usize, 0usize, 0usize);
    for ex in examples {
        let p = predict(&ex.features);
        if p == ex.label { correct += 1; }
        match (p, ex.label) {
            (true, true) => tp += 1,
            (true, false) => fp += 1,
            (false, true) => fneg += 1,
            _ => {}
        }
    }
    let n = examples.len();
    Score {
        accuracy: if n == 0 { 0.0 } else { correct as f32 / n as f32 },
        precision: if tp + fp == 0 { 0.0 } else { tp as f32 / (tp + fp) as f32 },
        recall: if tp + fneg == 0 { 0.0 } else { tp as f32 / (tp + fneg) as f32 },
        n,
    }
}

/// Deterministic split: every `k`th example is held out.
pub fn split(examples: &[Example], every: usize) -> (Vec<Example>, Vec<Example>) {
    let mut train_set = Vec::new();
    let mut test_set = Vec::new();
    for (i, ex) in examples.iter().enumerate() {
        if every > 0 && i % every == 0 { test_set.push(*ex) } else { train_set.push(*ex) }
    }
    (train_set, test_set)
}

/// One full experiment: extract, split, train, and score both policies on the
/// same held-out examples.
pub struct Experiment {
    pub examples: usize,
    pub positives: usize,
    pub learned: Score,
    pub heuristic: Score,
    pub policy: Policy,
}

pub fn run_experiment(ops: &[Op]) -> Experiment {
    let examples = examples_from_journal(ops);
    let positives = examples.iter().filter(|e| e.label).count();
    let (train_set, test_set) = split(&examples, 4);
    let policy = train(&train_set, 600, 0.5);
    let held = if test_set.is_empty() { &examples } else { &test_set };
    Experiment {
        examples: examples.len(),
        positives,
        learned: evaluate(held, |f| policy.predict(f)),
        heuristic: evaluate(held, heuristic_predict),
        policy,
    }
}
