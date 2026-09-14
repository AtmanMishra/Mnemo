//! memeval: retrieval-quality benchmark over a synthetic-but-realistic graph.
//! Measures Hit@1, Hit@3, MRR for whichever embedder is configured
//! (OPENROUTER_API_KEY set -> OpenRouter, else hashing). Run twice to compare.
//!
//! This is the no-LLM part of phase 3: it proves/disproves that the memory
//! layer RETRIEVES the right knowledge. Task-success evals come later.
//! --hash stays offline; --json emits the unrounded metrics for CI.
use memory_layer::model::*;
use memory_layer::remote::OpenRouterEmbedder;
use memory_layer::search::{build_vectors, route_query, search, SearchOpts};
use memory_layer::store::StoreData;
use memory_layer::vec::{Embedder, HashingEmbedder};

fn t() -> Millis { 1_700_000_000_000 }

/// Three domains x aspects, facts, cross-links, one superseded fact.
fn build_graph(s: &mut StoreData) {
    // The fixture is entirely in memory; opening a journal adds no evidence
    // and /dev/null is not a portable path on Windows.
    let apply = |s: &mut StoreData, op: Op| { s.apply(&op).unwrap(); };
    let mut nid = 0u64;

    let domains: &[(&str, &[(&str, &str)])] = &[
        ("kubernetes", &[
            ("ingress annotations", "rewrite-target annotation routes paths; nginx ingress class"),
            ("helm rollback", "helm rollback revision needs wait flag; values overrides per env"),
            ("resource limits", "always set cpu and mem requests; liveness probe timeouts"),
            ("secrets management", "sealed secrets need kubeseal; never commit raw manifests"),
        ]),
        ("frontend", &[
            ("react state", "redux slices per feature; zustand for local component state"),
            ("css layout", "grid for page shells; flexbox for toolbars; container queries"),
            ("bundler config", "vite aliases mirror tsconfig paths; chunk splitting manual"),
            ("a11y", "aria labels on icon buttons; focus trap in modals; contrast 4.5"),
        ]),
        ("python-backend", &[
            ("venv setup", "create virtualenv python3 -m venv; pin requirements.txt"),
            ("async patterns", "await inside async def only; gather for concurrency"),
            ("db migrations", "alembic revision autogenerate; downgrade tested always"),
            ("testing", "pytest fixtures scope session; mock httpx with respx"),
        ]),
        // 7.2: a fourth domain, so the corpus is not three clusters the
        // embedder can separate by vocabulary alone
        ("observability", &[
            ("structured logging", "one json object per line; request id on every span"),
            ("tracing spans", "parent span id links child work; sample head not tail"),
            ("alert routing", "page on symptom not cause; runbook link in every alert"),
            ("dashboards", "latency percentiles p50 p95 p99; never average a latency"),
        ]),
    ];
    let mut domain_root: Vec<(u64, Vec<u64>)> = Vec::new();
    for (domain, aspects) in domains {
        let root = { nid += 1; nid };
        apply(s, Op::CreateNode { id: root, kind: NodeKind::Entity,
            label: domain.to_string(), at: t() });
        let mut kids = Vec::new();
        for (label, fact_text) in aspects.iter() {
            nid += 1;
            let id = nid;
            apply(s, Op::CreateNode { id, kind: NodeKind::Aspect, label: label.to_string(), at: t() });
            let fid = s.next_fact;
            apply(s, Op::AddFact { node: id, fact_id: fid, key: "knowledge".into(),
                value: fact_text.to_string(), at: t() });
            let eid = s.next_edge;
            apply(s, Op::Link { id: eid, src: id, dst: root, kind: EdgeKind::PartOf, at: t() });
            kids.push(id);
        }
        domain_root.push((root, kids));
    }

    // task episode fed by two aspects (k8s + frontend)
    let ep = { nid += 1; nid };
    apply(s, Op::CreateNode { id: ep, kind: NodeKind::TaskEpisode,
        label: "deploy checkout web app".into(), at: t() });
    let k8s_ingress = domain_root[0].1[0];
    let fe_bundler = domain_root[1].1[2];
    for src in [k8s_ingress, fe_bundler] {
        let eid = s.next_edge;
        apply(s, Op::Link { id: eid, src, dst: ep, kind: EdgeKind::SuppliesContext, at: t() });
    }

    // stale-fact story: v1 rewrite annotation was superseded
    let old_fid = s.nodes[&k8s_ingress].facts[0].id;
    let new_fid = s.next_fact;
    apply(s, Op::SupersedeFact { node: k8s_ingress, old_fact: old_fid,
        new_key: "corrected".into(),
        new_value: "v1 annotation removed in networking.k8s.io/v1".into(),
        new_fact_id: new_fid, at: t() + 100 });

    // 7.2: brain areas in the corpus, so retrieval is measured against the
    // routing that landed in Area 3 rather than a flat semantic graph
    let pain = { nid += 1; nid };
    apply(s, Op::CreateNode { id: pain, kind: NodeKind::Aspect,
        label: "pain: cart deploy 404 after ingress change".into(), at: t() + 110 });
    apply(s, Op::SetArea { node: pain, area: Area::Salience, at: t() + 110 });
    let fid = s.next_fact;
    apply(s, Op::AddFact { node: pain, fact_id: fid, key: "failure".into(),
        value: "cart returned 404 when the rewrite-target annotation was dropped".into(),
        at: t() + 110 });

    let runbook = { nid += 1; nid };
    apply(s, Op::CreateNode { id: runbook, kind: NodeKind::Harness,
        label: "helm rollback runbook".into(), at: t() + 111 });
    let fid = s.next_fact;
    apply(s, Op::AddFact { node: runbook, fact_id: fid, key: "steps".into(),
        value: "run helm history, pick the last good revision, roll back with wait".into(),
        at: t() + 111 });

}

fn main() {
    let force_hash = std::env::args().any(|a| a == "--hash");
    let json = std::env::args().any(|a| a == "--json");
    let mut s = StoreData::new();
    build_graph(&mut s);
    if !force_hash { load_dotenv(); }
    let embedder_name;
    let emb: std::sync::Arc<dyn Embedder> = if force_hash {
        embedder_name = "hashing".to_string();
        if !json { println!("embedder: hashing (--hash)"); }
        std::sync::Arc::new(HashingEmbedder)
    } else {
        match OpenRouterEmbedder::from_env(std::path::Path::new("data")) {
            Some(e) => {
                embedder_name = format!("OpenRouter {}", e.model_name());
                if !json { println!("embedder: {embedder_name}"); }
                std::sync::Arc::new(e)
            }
            None => {
                embedder_name = "hashing".to_string();
                if !json { println!("embedder: hashing"); }
                std::sync::Arc::new(HashingEmbedder)
            }
        }
    };

    // (query, any-of expected top-1 label substrings). Most cases have one
    // right answer; a few became genuinely ambiguous once steer() started
    // writing SALIENCE pain markers (3.4), and those list both.
    let cases: &[(&str, &[&str])] = &[
        ("how do I route paths through nginx ingress", &["ingress annotations"]),
        ("rollback a bad helm release", &["helm rollback"]),
        ("pods getting OOM killed", &["resource limits"]),
        ("store api keys safely in cluster", &["secrets management"]),
        ("global state management in components", &["react state"]),
        ("page grid and toolbar layout", &["css layout"]),
        ("vite build chunks slow", &["bundler config"]),
        ("modal focus keyboard trap", &["a11y"]),
        ("isolated python environment setup", &["venv setup"]),
        ("run coroutines concurrently", &["async patterns"]),
        ("database schema change rollback", &["db migrations"]),
        ("fixture scope for integration tests", &["testing"]),
        // both are defensible: the aspect explains the mechanism, the pain
        // marker records that it actually bit us
        ("deploy failed 404 on rewritten path", &["ingress annotations", "pain: cart deploy 404"]),   // episode context
        ("what fixed the rewrite 404 last time", &["ingress annotations"]),  // post-supersede recall
        ("split vendor bundle manually", &["bundler config"]),
        // 7.2: the fourth domain
        ("one json object per log line", &["structured logging"]),
        ("link child work to a parent span", &["tracing spans"]),
        ("who gets paged when latency spikes", &["alert routing"]),
        ("p95 latency chart", &["dashboards"]),
        // and two more angles on existing knowledge
        ("kubeseal encrypted manifest", &["secrets management"]),
        ("focus trap keyboard accessibility", &["a11y"]),
        ("cpu and memory requests for a pod", &["resource limits"]),
    ];

    let vectors = build_vectors(&s, emb.as_ref());
    let mut hits1 = 0; let mut hits3 = 0; let mut rr_sum = 0.0;
    if !json { println!("{:<42} {:<22} {}", "query", "top hit", "rank"); }
    for (q, wants) in cases {
        // same path memsrv takes: kind filter + routed area preference
        let opts = SearchOpts::kind(NodeKind::Aspect).prefer(route_query(q));
        let results = search(&s, &vectors, emb.as_ref(), q, 5, t() + 200, &opts);
        let labels: Vec<String> = results.iter()
            .filter_map(|r| s.nodes.get(&r.node).map(|n| n.label.clone())).collect();
        let rank = labels.iter()
            .position(|l| wants.iter().any(|w| l.contains(w)))
            .map(|i| i + 1)
            .unwrap_or(999);
        if rank == 1 { hits1 += 1; }
        if rank <= 3 { hits3 += 1; }
        rr_sum += 1.0 / rank as f32;
        if !json { println!("{:<42} {:<22} {}", q, labels.first().map(String::as_str).unwrap_or("-"), rank); }
    }
    let n = cases.len() as f32;
    if json {
        println!("{}", serde_json::json!({
            "embedder": embedder_name, "n": cases.len(),
            "hits_at_1": hits1, "hits_at_3": hits3,
            "hit_at_1_percent": 100.0 * hits1 as f32 / n,
            "hit_at_3_percent": 100.0 * hits3 as f32 / n,
            "mrr": rr_sum / n,
        }));
    } else {
        println!("\nHit@1 {:.0}%  Hit@3 {:.0}%  MRR {:.3}  (n={})",
            100.0 * hits1 as f32 / n, 100.0 * hits3 as f32 / n, rr_sum / n, cases.len());
    }
}

fn load_dotenv() {
    for candidate in [".env", "../.env"] {
        if let Ok(txt) = std::fs::read_to_string(candidate) {
            for line in txt.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') { continue; }
                if let Some((k, v)) = line.split_once('=') { std::env::set_var(k.trim(), v.trim()); }
            }
            return;
        }
    }
}
