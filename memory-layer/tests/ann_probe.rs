//! TEMPORARY probe (deleted before finishing): measures
//!   1. ANN-vs-brute top-1 agreement across seeds (to pick the quality bound
//!      the flaky test will assert), and
//!   2. per-query cost of the brute scan vs HNSW search at several node
//!      counts (to pick ANN_MIN_NODES).
//! Not a test of the product; run with --nocapture.
use memory_layer::ann::AnnIndex;
use memory_layer::model::*;
use memory_layer::search::{build_vectors, search, search_ann, SearchOpts};
use memory_layer::store::StoreData;
use memory_layer::vec::HashingEmbedder;
use std::collections::HashMap;
use std::time::Instant;

fn t() -> Millis { 1_700_000_000_000 }

/// Deterministic LCG (splitmix-ish); no external RNG dep.
fn lcg(seed: u64) -> impl FnMut() -> u64 {
    let mut s = seed.wrapping_mul(2).wrapping_add(1);
    move || {
        s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        s >> 33
    }
}

const VOCAB: &[&str] = &[
    "ingress", "annotation", "rewrite", "path", "routing", "nginx", "helm", "rollback",
    "revision", "wait", "chart", "values", "python", "venv", "virtualenv", "pip",
    "requirements", "pytest", "fixture", "scope", "async", "await", "gather", "coroutine",
    "alembic", "migration", "downgrade", "schema", "vite", "aliases", "tsconfig", "chunk",
    "bundle", "redux", "slice", "zustand", "component", "grid", "flexbox", "toolbar",
    "container", "queries", "aria", "label", "focus", "trap", "modal", "contrast",
    "logging", "json", "request", "span", "tracing", "parent", "sampling", "alert",
    "symptom", "runbook", "latency", "percentile", "dashboard", "average", "cluster",
    "ingressclass", "sealed", "kubeseal", "manifest", "probe", "liveness", "timeout",
];

/// Build a deterministic store of `n` aspect nodes, each with one fact of
/// `fact_words` tokens from VOCAB, and return queries derived from first-3
/// fact words of sampled nodes (plus one single-word distractor query).
fn gen_store(seed: u64, n: usize, fact_words: usize, n_queries: usize) -> (StoreData, Vec<String>) {
    let mut rng = lcg(seed);
    let mut s = StoreData::new();
    let mut facts: Vec<String> = Vec::new();
    for i in 0..n {
        let id = i as u64 + 1;
        let lw: Vec<&str> = (0..3).map(|_| VOCAB[(rng() % VOCAB.len() as u64) as usize]).collect();
        s.apply(&Op::CreateNode { id, kind: NodeKind::Aspect,
            label: format!("node{i} {} {} {}", lw[0], lw[1], lw[2]), at: t() }).unwrap();
        let fw: Vec<&str> = (0..fact_words).map(|_| VOCAB[(rng() % VOCAB.len() as u64) as usize]).collect();
        let ftext = format!("topic {}", fw.join(" "));
        s.apply(&Op::AddFact { node: id, fact_id: id, key: "topic".into(),
            value: ftext.clone(), at: t() }).unwrap();
        facts.push(fw.join(" "));
    }
    let mut queries = Vec::new();
    for _ in 0..n_queries {
        let pick = (rng() % n as u64) as usize;
        let words: Vec<&str> = facts[pick].split_whitespace().take(3).collect();
        queries.push(words.join(" "));
    }
    queries.push(VOCAB[(rng() % VOCAB.len() as u64) as usize].to_string());
    (s, queries)
}

fn ann_index(vectors: &HashMap<NodeId, Vec<f32>>) -> AnnIndex<'static> {
    let map: HashMap<u64, Vec<f32>> = vectors.iter().map(|(k, v)| (*k as u64, v.clone())).collect();
    AnnIndex::build(&map)
}

#[test]
fn probe_quality_across_seeds() {
    let emb = HashingEmbedder;
    let mut total = 0usize;
    let mut agree = 0usize;
    let mut contain = 0usize;
    let mut worst_seed = (1.0f64, 0u64);
    for seed in 0..12u64 {
        let (s, queries) = gen_store(seed + 1, 200, 8, 20);
        let vectors = build_vectors(&s, &emb);
        let index = ann_index(&vectors);
        let (mut a, mut c, mut n) = (0usize, 0usize, 0usize);
        for q in &queries {
            let brute = search(&s, &vectors, &emb, q, 3, t(), &SearchOpts::default());
            let ann = search_ann(&s, &index, &emb, q, 3, t(), &SearchOpts::default());
            if brute.is_empty() || ann.is_empty() { continue; }
            n += 1;
            total += 1;
            if brute[0].node == ann[0].node { agree += 1; a += 1; }
            let in_top3 = brute.iter().any(|r| r.node == ann[0].node);
            if in_top3 { contain += 1; c += 1; }
            if brute[0].node != ann[0].node {
                println!("seed {seed}: top1 differs: ann={} brute={} (brute top3 {:?}, ann in top3: {}) q={q:?}",
                    ann[0].node, brute[0].node,
                    brute.iter().map(|r| (r.node, r.score)).collect::<Vec<_>>(),
                    in_top3);
            }
        }
        let ratio = a as f64 / n.max(1) as f64;
        println!("seed {seed}: agreement {a}/{n}, contain {c}/{n}");
        if ratio < worst_seed.0 { worst_seed = (ratio, seed); }
    }
    println!("TOTAL agreement {agree}/{total} = {:.3}, containment {contain}/{total} = {:.3}, worst seed {worst_seed:?}",
        agree as f64 / total as f64, contain as f64 / total as f64);
}

#[test]
fn probe_quality_sweep() {
    let emb = HashingEmbedder;
    for (n, seeds, per_seed) in [(200usize, 40u64, 20usize), (800, 20, 20), (2000, 8, 15)] {
        let mut total = 0usize;
        let mut agree = 0usize;
        let mut contain = 0usize;
        let mut worst = 1.0f64;
        for seed in 0..seeds {
            let (s, queries) = gen_store(seed + 1, n, 8, per_seed);
            let vectors = build_vectors(&s, &emb);
            let index = ann_index(&vectors);
            let (mut a, mut c, mut m) = (0usize, 0usize, 0usize);
            for q in &queries {
                let brute = search(&s, &vectors, &emb, q, 3, t(), &SearchOpts::default());
                let ann = search_ann(&s, &index, &emb, q, 3, t(), &SearchOpts::default());
                if brute.is_empty() || ann.is_empty() { continue; }
                m += 1; total += 1;
                if brute[0].node == ann[0].node { a += 1; agree += 1; }
                if brute.iter().any(|r| r.node == ann[0].node) { c += 1; contain += 1; }
                else {
                    println!("CONTAINMENT VIOLATION n={n} seed={seed}: ann={} brute={:?} q={q:?}",
                        ann[0].node, brute.iter().map(|r| (r.node, r.score)).collect::<Vec<_>>());
                }
            }
            let r = a as f64 / m as f64;
            if r < worst { worst = r; }
        }
        println!("n={n} seeds={seeds}: agreement {agree}/{total} = {:.3} (worst seed {:.3}), containment {contain}/{total} = {:.3}",
            agree as f64 / total as f64, worst, contain as f64 / total as f64);
    }
}

#[test]
fn probe_quality_variance() {
    // same corpus, 5 fresh HNSW builds: how much does the aggregate move?
    let emb = HashingEmbedder;
    for run in 0..5 {
        let mut total = 0usize;
        let mut agree = 0usize;
        let mut contain = 0usize;
        for seed in 0..20u64 {
            let (s, queries) = gen_store(seed + 1, 500, 8, 20);
            let vectors = build_vectors(&s, &emb);
            let index = ann_index(&vectors);
            for q in &queries {
                let brute = search(&s, &vectors, &emb, q, 3, t(), &SearchOpts::default());
                let ann = search_ann(&s, &index, &emb, q, 3, t(), &SearchOpts::default());
                if brute.is_empty() || ann.is_empty() { continue; }
                total += 1;
                if brute[0].node == ann[0].node { agree += 1; }
                if brute.iter().any(|r| r.node == ann[0].node) { contain += 1; }
            }
        }
        println!("n=500 run {run}: agreement {agree}/{total} = {:.4}, containment {contain}/{total} = {:.4}",
            agree as f64 / total as f64, contain as f64 / total as f64);
    }
}

#[test]
fn probe_cost_crossover() {
    let emb = HashingEmbedder;
    for n in [500usize, 1000, 2000, 4000] {
        let (s, queries) = gen_store(4242, n, 8, 30);
        let t0 = Instant::now();
        let vectors = build_vectors(&s, &emb);
        let build_vec = t0.elapsed();
        let t1 = Instant::now();
        let index = ann_index(&vectors);
        let build_idx = t1.elapsed();
        let t2 = Instant::now();
        for q in &queries {
            let _ = search(&s, &vectors, &emb, q, 5, t(), &SearchOpts::default());
        }
        let brute = t2.elapsed() / queries.len() as u32;
        let t3 = Instant::now();
        for q in &queries {
            let _ = search_ann(&s, &index, &emb, q, 5, t(), &SearchOpts::default());
        }
        let ann = t3.elapsed() / queries.len() as u32;
        println!("n={n}: build_vectors={build_vec:?} build_index={build_idx:?} per-query brute={brute:?} ann={ann:?}");
    }
}
