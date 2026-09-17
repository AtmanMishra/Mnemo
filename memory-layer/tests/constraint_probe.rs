//! Constraint persistence, the recall half.
//!
//! `docs/archive/EVAL-RESEARCH.md` §3.3 names the scenario this file exists for:
//! a constraint stated once — the package manager, the port, a style rule — has
//! to still be there sessions later, and it has to survive being *changed*. The
//! two published analogues are LongMemEval's knowledge-update category (does new
//! information supersede old, or get treated as an addition) and τ-bench's
//! policy adherence (does a stated rule keep holding later).
//!
//! This is the half that can run on every commit: the graph is seeded, queried
//! and checked without a model. The other half — does the agent *behave*
//! correctly in a later session — needs one, and lives in
//! `scripts/eval-constraint-compliance.mjs` behind the nightly workflow.
//!
//! Deterministic by construction, like memeval: a temp cwd with no .env in the
//! chain and OPENROUTER_API_KEY removed, so the hashing embedder runs and the
//! numbers mean the same thing on every machine.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

struct Srv {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    reader: BufReader<std::process::ChildStdout>,
}

fn spawn(jpath: &Path) -> Srv {
    let work =
        std::env::temp_dir().join(format!("memlayer-constraint-work-{}", std::process::id()));
    std::fs::create_dir_all(&work).unwrap();
    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_memsrv"))
        .arg(jpath)
        .current_dir(&work)
        .env_remove("OPENROUTER_API_KEY")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn memsrv");
    let stdin = child.stdin.take().unwrap();
    let reader = BufReader::new(child.stdout.take().unwrap());
    Srv {
        child,
        stdin,
        reader,
    }
}

impl Srv {
    fn call(&mut self, id: u32, method: &str, params: serde_json::Value) -> serde_json::Value {
        writeln!(
            self.stdin,
            "{}",
            serde_json::json!({"id": id, "method": method, "params": params})
        )
        .unwrap();
        self.stdin.flush().unwrap();
        let mut line = String::new();
        self.reader.read_line(&mut line).expect("read rpc line");
        let v: serde_json::Value = serde_json::from_str(line.trim()).expect("valid json");
        assert_eq!(v["ok"], true, "{method} failed: {v}");
        v["result"].clone()
    }

    fn node(&mut self, id: u32, label: &str) -> u64 {
        self.call(
            id,
            "create_node",
            serde_json::json!({"kind": "aspect", "label": label}),
        )["node"]
            .as_u64()
            .unwrap()
    }

    fn fact(&mut self, id: u32, node: u64, key: &str, value: &str) {
        self.call(
            id,
            "fact",
            serde_json::json!({"node": node, "key": key, "value": value}),
        );
    }

    /// Labels of the top hits for a query, best first.
    fn search(&mut self, id: u32, q: &str, k: u32) -> Vec<String> {
        let res = self.call(id, "search", serde_json::json!({"query": q, "k": k}));
        res["results"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|h| h["label"].as_str().unwrap_or("").to_string())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Every fact the node ever had, current and retired, with the status and
    /// the `superseded_by` that say which is which.
    fn history(&mut self, id: u32, node: u64) -> serde_json::Value {
        self.call(id, "history", serde_json::json!({"node": node}))
    }

    /// The state text of the top hit — what a model would actually be handed.
    fn top_state(&mut self, id: u32, q: &str) -> String {
        let res = self.call(id, "search", serde_json::json!({"query": q, "k": 3}));
        res["results"]
            .as_array()
            .and_then(|a| a.first())
            .and_then(|h| h["state"].as_str())
            .unwrap_or("")
            .to_string()
    }
}

impl Drop for Srv {
    fn drop(&mut self) {
        let _ = writeln!(
            self.stdin,
            "{}",
            serde_json::json!({"id": 9999, "method": "exit"})
        );
        let _ = self.stdin.flush();
        let _ = self.child.wait();
    }
}

fn journal(tag: &str) -> PathBuf {
    let dir =
        std::env::temp_dir().join(format!("memlayer-constraint-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("journal.jsonl")
}

/// A constraint survives when it is stated once and asked for later in the
/// words a person would actually use.
#[test]
fn a_constraint_stated_once_is_recalled_later() {
    let mut s = spawn(&journal("stated-once"));
    const CASES: &[(&str, &str, &str)] = &[
        (
            "repo conventions",
            "package manager",
            "use pnpm in this repo; npm install is not allowed",
        ),
        (
            "service config",
            "port",
            "the dev server listens on 4111, not 3000",
        ),
        (
            "code style",
            "comments",
            "comments explain why, never what the code does",
        ),
    ];

    let mut ids = vec![];
    for (i, (label, key, value)) in CASES.iter().enumerate() {
        let n = s.node(10 + i as u32, label);
        s.fact(20 + i as u32, n, key, value);
        ids.push(n);
    }
    assert_eq!(ids.len(), CASES.len()); // every constraint really landed on a node

    // Queries are deliberately NOT the stored text — a probe that echoes the
    // fact back proves nothing about retrieval.
    const QUERIES: &[&str] = &[
        "which package manager should I use here",
        "what port does the dev server listen on",
        "how should code comments be written",
    ];

    let mut hits_at_1 = 0;
    let mut hits_at_3 = 0;
    for (i, q) in QUERIES.iter().enumerate() {
        let labels = s.search(30 + i as u32, q, 3);
        if labels.first().map(String::as_str) == Some(CASES[i].0) {
            hits_at_1 += 1;
        }
        if labels.iter().any(|l| l == CASES[i].0) {
            hits_at_3 += 1;
        } else {
            eprintln!("MISS {q:?} -> {labels:?}");
        }
    }

    // Pinned, like memeval's floor: a retrieval change that drops a constraint
    // out of the top three fails here rather than in a user's session.
    assert_eq!(
        hits_at_3, 3,
        "every stated constraint must be retrievable later"
    );
    assert!(
        hits_at_1 >= 2,
        "at least two of three must be the top hit, got {hits_at_1}"
    );
}

/// A constraint that is *changed* must come back as the new value, with the old
/// one visibly retired — the knowledge-update case, and the one a naive
/// append-only memory gets wrong by returning both.
///
/// The probe found this on its first run and filed it: `memsrv`'s `fact` op
/// appended, so after the constraint changed the state handed to the model was
///
///     facts:
///       - package manager: use npm in this repo; pnpm is not installed here
///       - package manager: use pnpm in this repo; the registry outage is over
///
/// — two live instructions, one of them wrong, and nothing marking which. The
/// write path now supersedes, as the steering path always did: one current
/// value answers a live query, and the retired one is kept (status superseded,
/// `superseded_by` pointing at what replaced it) rather than deleted, which is
/// what `history` returns and what the journal held all along.
#[test]
fn a_changed_constraint_returns_the_new_value_and_retires_the_old() {
    let jpath = journal("changed");
    let mut s = spawn(&jpath);
    let n = s.node(1, "repo conventions");
    let first = s.call(
        2,
        "fact",
        serde_json::json!({
            "node": n, "key": "package manager",
            "value": "use npm in this repo; pnpm is not installed here"
        }),
    )["fact"]
        .as_u64()
        .expect("the first write returns its fact id");

    // Same key, new value: supersession, not an append.
    let second = s.call(
        3,
        "fact",
        serde_json::json!({
            "node": n, "key": "package manager",
            "value": "use pnpm in this repo; the registry outage is over"
        }),
    );
    assert_eq!(
        second["superseded"].as_u64(),
        Some(first),
        "a same-key write must name the fact it supersedes: {second}"
    );

    let state = s.top_state(4, "which package manager should I use here");
    assert!(
        state.contains("pnpm"),
        "the current constraint must be in the state handed to the model: {state:?}"
    );
    assert!(
        !state.contains("use npm in this repo"),
        "the retired value must not be presented as a live instruction: {state:?}"
    );
    assert!(
        state.contains("retired") && state.contains("current"),
        "the answer must say which value is current and that the other is kept: {state:?}"
    );

    // Supersede, never delete: the old value is still there, marked retired and
    // pointing at what replaced it. Exactly one fact under the key is active.
    let hist = s.history(5, n);
    let facts = hist["facts"].as_array().expect("history lists facts");
    assert_eq!(facts.len(), 2, "both versions must survive: {hist}");
    let live: Vec<&serde_json::Value> = facts
        .iter()
        .filter(|f| f["status"] == "active")
        .collect();
    let retired: Vec<&serde_json::Value> = facts
        .iter()
        .filter(|f| f["status"] == "superseded")
        .collect();
    assert_eq!(live.len(), 1, "exactly one value answers a live query: {hist}");
    assert_eq!(retired.len(), 1, "the replaced value is kept as history: {hist}");
    assert_eq!(live[0]["id"].as_u64(), Some(second["fact"].as_u64().unwrap()));
    assert!(
        live[0]["value"].as_str().unwrap().contains("pnpm"),
        "the live value is the new one: {hist}"
    );
    assert_eq!(
        retired[0]["id"].as_u64(),
        Some(first),
        "the retired value keeps its own id: {hist}"
    );
    assert!(
        retired[0]["value"].as_str().unwrap().contains("use npm"),
        "the retired value keeps its text: {hist}"
    );
    assert_eq!(
        retired[0]["superseded_by"].as_u64(),
        live[0]["id"].as_u64(),
        "the retired value records what replaced it: {hist}"
    );

    // And the write is on the journal as a supersede, not an append: a cold
    // replay reproduces the same one-current-value graph, retired value and all.
    let ops = memory_layer::persist::Journal::read_all(&jpath).expect("read the journal");
    let mut replayed = memory_layer::store::StoreData::new();
    for op in &ops {
        replayed.apply(op).expect("replay");
    }
    let facts = &replayed.nodes[&n].facts;
    assert_eq!(
        replayed.nodes[&n].active_facts().count(),
        1,
        "replay must leave exactly one current value: {facts:?}"
    );
    assert_eq!(facts.len(), 2, "replay keeps both values: {facts:?}");
    assert!(
        ops.iter().any(|op| matches!(op, memory_layer::model::Op::SupersedeFact { .. })),
        "the change must be journaled as a supersede: {ops:?}"
    );
}

/// An unrelated question must not put the constraint first. Recall that always
/// fires is not recall — it is context the model has to filter, and finding M4
/// in the capability review is about exactly that cost.
///
/// The graph holds eight competing nodes, because with one node in it the
/// assertion would be about the graph's size, not about retrieval.
#[test]
fn an_unrelated_query_ranks_an_unrelated_node_first() {
    let mut s = spawn(&journal("unrelated"));
    let constraint = s.node(1, "repo conventions");
    s.fact(
        2,
        constraint,
        "package manager",
        "use pnpm in this repo; npm install is not allowed",
    );

    let topics: &[(&str, &str, &str)] = &[
        (
            "ingress annotations",
            "rewrite",
            "kubernetes ingress rewrite-target annotation routes paths under a prefix",
        ),
        (
            "helm releases",
            "rollback",
            "helm rollback waits for pods to become ready before returning",
        ),
        (
            "python packaging",
            "build",
            "python build backends and the pyproject metadata table",
        ),
        (
            "postgres indexing",
            "btree",
            "btree index selectivity decides whether the planner uses it",
        ),
        (
            "docker layers",
            "cache",
            "docker layer caching is invalidated by any change to a copied file",
        ),
        (
            "grafana alerts",
            "routing",
            "grafana alert routing by label matchers and contact points",
        ),
        (
            "rust lifetimes",
            "borrow",
            "borrowed values must outlive the references that point at them",
        ),
    ];
    for (i, (label, key, value)) in topics.iter().enumerate() {
        let n = s.node(10 + i as u32, label);
        s.fact(20 + i as u32, n, key, value);
    }

    let labels = s.search(
        40,
        "how do I configure a kubernetes ingress rewrite target",
        3,
    );
    assert!(
        !labels.is_empty(),
        "the unrelated question must still retrieve something"
    );
    assert!(
        labels.first().map(String::as_str) != Some("repo conventions"),
        "the constraint must not be the top hit for an unrelated question: {labels:?}"
    );
    assert!(
        labels.iter().any(|l| l == "ingress annotations"),
        "the on-topic node should win: {labels:?}"
    );
}
