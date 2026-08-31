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

/// A synthetic failure journal with structure the shipped rule cannot see.
///
/// Scenario, honestly labelled by an ORACLE (a post-hoc true accounting, not
/// what `steer()` would have written): ONE troubled episode is fed by three
/// aspects. Every round the same silent feeder C is the real, recorded culprit
/// — yet its text shares zero tokens with the failure — while feeder A
/// lexically overlaps every failure without being the culprit (the rule's
/// standing false positive), and innocent B never appears at all. Because the
/// episode and its edges persist across rounds, C's failure history and edge
/// weight accumulate (and after enough blame its weight hits zero and the
/// edge dies, exactly like `alive_at` says). The only features that ever
/// point at C are that history and that collapse — the overlap rule cannot
/// see either.
///
/// Purpose: answer "can the pipeline learn at all?" If yes, the real
/// journal's 'nothing to learn from' is a DATA verdict, not a model one. The
/// comparison is still honest: both policies are scored on the same held-out
/// examples and the synthetic journal is flagged as synthetic in the output.
#[allow(clippy::needless_range_loop)]
pub fn synthetic_journal_ops() -> Vec<Op> {
    let mut s = StoreData::new();
    let mut ops = Vec::new();
    let t = 1_700_000_000_000u64;
    let push = |s: &mut StoreData, op: Op, ops: &mut Vec<Op>| {
        s.apply(&op).unwrap();
        ops.push(op);
    };

    // A: lexically overlapping, NEVER the culprit (rule cries wolf)
    push(&mut s, Op::CreateNode { id: 1, kind: NodeKind::Aspect,
        label: "ingress annotations".into(), at: t }, &mut ops);
    push(&mut s, Op::AddFact { node: 1, fact_id: 1, key: "rewrite".into(),
        value: "rewrite target annotation routes paths".into(), at: t }, &mut ops);
    // B: silent and blameless, never recorded
    push(&mut s, Op::CreateNode { id: 2, kind: NodeKind::Aspect,
        label: "helm release".into(), at: t }, &mut ops);
    push(&mut s, Op::AddFact { node: 2, fact_id: 2, key: "version".into(),
        value: "chart pinned to v3.2".into(), at: t }, &mut ops);
    // C: silent, repeatedly the recorded culprit, so its history accumulates
    push(&mut s, Op::CreateNode { id: 3, kind: NodeKind::Aspect,
        label: "mesh proxy".into(), at: t }, &mut ops);
    push(&mut s, Op::AddFact { node: 3, fact_id: 3, key: "retry".into(),
        value: "connection pooled, keepalive 30s".into(), at: t }, &mut ops);

    // ONE long-lived episode: its feeder edges carry the history across rounds
    let ep = s.next_node;
    push(&mut s, Op::CreateNode { id: ep, kind: NodeKind::TaskEpisode,
        label: "watch cluster".into(), at: t }, &mut ops);
    for src in [1u64, 2, 3] {
        let eid = s.next_edge;
        push(&mut s, Op::Link { id: eid, src, dst: ep,
            kind: EdgeKind::SuppliesContext, at: t }, &mut ops);
    }

    for r in 0..15u64 {
        let now = t + 100 + r * 1000;
        // the failure text always overlaps A (ingress jargon), never C
        push(&mut s, Op::CommitLog { node: ep, kind: "outcome".into(),
            detail: "rewrite annotation routes failed: ingress paths broke".into(),
            at: now }, &mut ops);
        // oracle: the silent feeder is the one recorded as failed
        let c_edge = s.edges.values()
            .find(|e| e.src == 3 && e.dst == ep).map(|e| e.id).unwrap();
        push(&mut s, Op::RecordOutcome { edge: c_edge, success: false, at: now + 1 }, &mut ops);
    }
    ops
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
    /// Per-feature mean/std over the TRAINING set, applied at score time.
    means: [f32; 6],
    stds: [f32; 6],
}

impl Policy {
    pub fn score(&self, f: &Features) -> f32 {
        let x = f.as_vec();
        let z: f32 = (0..6)
            .map(|k| self.weights[k] * ((x[k] - self.means[k]) / self.stds[k]))
            .sum::<f32>()
            + self.bias;
        1.0 / (1.0 + (-z).exp())
    }
    pub fn predict(&self, f: &Features) -> bool {
        self.score(f) >= 0.5
    }
}

/// Logistic regression by plain gradient descent. Features are standardised
/// first (per-feature mean/std over the training set), because raw counts and
/// 0..1 weights on one scale make the step size meaningless: a signal hiding
/// in a long-history counter would be washed out by a lexically loud feature.
pub fn train(examples: &[Example], epochs: usize, lr: f32) -> Policy {
    let mut policy = Policy { weights: [0.0; 6], bias: 0.0, means: [0.0; 6], stds: [1.0; 6] };
    if examples.is_empty() { return policy; }
    let n = examples.len() as f32;

    // standardise: statistics come from the training set ONLY
    let mut sums = [0f32; 6];
    for ex in examples {
        let x = ex.features.as_vec();
        for k in 0..6 { sums[k] += x[k]; }
    }
    let mut means = [0f32; 6];
    for k in 0..6 { means[k] = sums[k] / n; }
    let mut sq = [0f32; 6];
    for ex in examples {
        let x = ex.features.as_vec();
        for k in 0..6 { let d = x[k] - means[k]; sq[k] += d * d; }
    }
    let mut stds = [0f32; 6];
    for k in 0..6 { stds[k] = (sq[k] / n).sqrt().max(1e-6); }
    policy.means = means;
    policy.stds = stds;

    let norm = |x: &[f32; 6]| -> [f32; 6] {
        let mut out = [0f32; 6];
        for k in 0..6 { out[k] = (x[k] - means[k]) / stds[k]; }
        out
    };

    for _ in 0..epochs {
        let mut grad = [0.0f32; 6];
        let mut bias_grad = 0.0f32;
        for ex in examples {
            let err = policy.score(&ex.features) - if ex.label { 1.0 } else { 0.0 };
            let x = norm(&ex.features.as_vec());
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
