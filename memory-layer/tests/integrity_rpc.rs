//! Audit Phase A (research/self-evolution-audit.md): the three findings that
//! corrupted or hid memory, each reproduced against real sidecars on a temp
//! journal. Hashing embedder (no key, no .env) so the results are exact.
//!
//!   F1  two memsrv processes on one journal: each sees the other's writes
//!       and they never hand out the same id
//!   F2  a new node is found by a query that was already cached
//!   F9  a node's recent log renders as lines, not one line with "\n" in it
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

struct Srv {
    child: Child,
    stdin: ChildStdin,
    out: BufReader<ChildStdout>,
    next: u32,
}

impl Srv {
    fn spawn(jpath: &Path, work: &Path) -> Srv {
        let mut child = Command::new(env!("CARGO_BIN_EXE_memsrv"))
            .arg(jpath)
            .current_dir(work)
            .env_remove("OPENROUTER_API_KEY")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn memsrv");
        let stdin = child.stdin.take().unwrap();
        let out = BufReader::new(child.stdout.take().unwrap());
        Srv { child, stdin, out, next: 1 }
    }

    fn call(&mut self, method: &str, params: serde_json::Value) -> serde_json::Value {
        let id = self.next;
        self.next += 1;
        writeln!(self.stdin, "{}", serde_json::json!({"id": id, "method": method, "params": params})).unwrap();
        self.stdin.flush().unwrap();
        let mut line = String::new();
        self.out.read_line(&mut line).expect("read rpc line");
        let v: serde_json::Value = serde_json::from_str(line.trim()).expect("json");
        assert_eq!(v["ok"], true, "{method} failed: {v}");
        v["result"].clone()
    }

    fn close(mut self) {
        let _ = writeln!(self.stdin, "{}", serde_json::json!({"method": "exit"}));
        let _ = self.child.wait();
    }
}

fn temp(name: &str) -> (PathBuf, PathBuf) {
    let dir = std::env::temp_dir().join(format!("memlayer-integrity-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    (dir.join("journal.jsonl"), dir)
}

fn labels(dump: &serde_json::Value) -> Vec<(u64, String)> {
    let mut v: Vec<(u64, String)> = dump["nodes"].as_array().unwrap().iter()
        .map(|n| (n["id"].as_u64().unwrap(), n["label"].as_str().unwrap().to_string()))
        .collect();
    v.sort();
    v
}

#[test]
fn two_sidecars_on_one_journal_see_each_other_and_never_share_an_id() {
    let (journal, work) = temp("f1");
    let mut a = Srv::spawn(&journal, &work);
    let mut b = Srv::spawn(&journal, &work);
    a.call("ping", serde_json::json!({}));
    b.call("ping", serde_json::json!({}));

    let na = a.call("create_node", serde_json::json!({"kind": "entity", "label": "project shop"}))["node"].as_u64().unwrap();
    a.call("fact", serde_json::json!({"node": na, "key": "package manager", "value": "pnpm"}));

    // B never restarted, yet it reads A's node and fact …
    let state = b.call("state", serde_json::json!({"node": na}))["state"].as_str().unwrap().to_string();
    assert!(state.contains("package manager: pnpm"), "B must see A's write: {state}");

    // … and the next id it hands out is past A's.
    let nb = b.call("create_node", serde_json::json!({"kind": "aspect", "label": "from b"}))["node"].as_u64().unwrap();
    assert_ne!(nb, na, "B reused A's node id");
    let na2 = a.call("create_node", serde_json::json!({"kind": "aspect", "label": "from a again"}))["node"].as_u64().unwrap();
    assert!(na2 > nb, "A must allocate after B's node ({na2} vs {nb})");
    b.call("fact", serde_json::json!({"node": na2, "key": "seen by", "value": "b"}));

    // Both now agree with each other and with a fresh replay of the journal.
    let da = labels(&a.call("dump", serde_json::json!({})));
    let db = labels(&b.call("dump", serde_json::json!({})));
    assert_eq!(da, db);
    a.close();
    b.close();
    let ops = memory_layer::persist::Journal::read_all(&journal).unwrap();
    let mut s = memory_layer::store::StoreData::new();
    for op in &ops {
        s.apply(op).expect("every op replays: no id collisions");
    }
    assert_eq!(s.nodes.len(), 3);
    let fact = s.nodes[&na2].active_facts().next().unwrap();
    assert_eq!((fact.key.as_str(), fact.value.as_str()), ("seen by", "b"), "B's fact landed on A's node, as addressed");
}

#[test]
fn a_new_memory_is_found_by_a_query_that_was_already_cached() {
    let (journal, work) = temp("f2");
    let mut s = Srv::spawn(&journal, &work);
    s.call("remember", serde_json::json!({"summary": "the billing service listens on port 8081"}));
    let q = serde_json::json!({"query": "which port does billing use", "k": 3});
    let first = s.call("search", q.clone());
    assert_eq!(first["cache"], "miss");
    assert_eq!(s.call("search", q.clone())["cache"], "hit", "an unchanged store may serve from cache");

    s.call("remember", serde_json::json!({"summary": "billing port changed: billing now uses port 9090"}));
    let after = s.call("search", q);
    assert_eq!(after["cache"], "miss", "a write must invalidate");
    let found: Vec<&str> = after["results"].as_array().unwrap().iter().map(|r| r["label"].as_str().unwrap()).collect();
    assert!(found.iter().any(|l| l.contains("9090")), "the correction must be findable: {found:?}");
    s.close();
}

#[test]
fn a_write_from_another_process_also_invalidates_the_cache() {
    let (journal, work) = temp("f2b");
    let mut a = Srv::spawn(&journal, &work);
    let mut b = Srv::spawn(&journal, &work);
    a.call("remember", serde_json::json!({"summary": "deploys go through fly"}));
    let q = serde_json::json!({"query": "how do we deploy", "k": 3});
    a.call("search", q.clone());
    assert_eq!(a.call("search", q.clone())["cache"], "hit");
    b.call("remember", serde_json::json!({"summary": "deploy: run make deploy, never fly directly"}));
    let after = a.call("search", q);
    assert_eq!(after["cache"], "miss", "B's write must clear A's cache");
    a.close();
    b.close();
}

#[test]
fn the_recent_log_renders_as_separate_lines() {
    let (journal, work) = temp("f9");
    let mut s = Srv::spawn(&journal, &work);
    let n = s.call("episode", serde_json::json!({"label": "task: fix checkout"}))["episode"].as_u64().unwrap();
    s.call("commit_log", serde_json::json!({"node": n, "kind": "tool_call", "detail": "bash: ok"}));
    let state = s.call("state", serde_json::json!({"node": n}))["state"].as_str().unwrap().to_string();
    assert!(!state.contains("\\n"), "literal \\n in state: {state:?}");
    assert!(state.lines().any(|l| l.trim_start().starts_with('[') && l.ends_with("tool_call: bash: ok")), "{state}");
    s.close();
}

#[test]
fn a_scoped_search_never_returns_another_projects_memories() {
    let (journal, work) = temp("f10");
    let mut s = Srv::spawn(&journal, &work);
    let shop = s.call("create_node", serde_json::json!({"kind": "entity", "label": "project shop"}))["node"].as_u64().unwrap();
    let blog = s.call("create_node", serde_json::json!({"kind": "entity", "label": "project blog"}))["node"].as_u64().unwrap();
    let a = s.call("remember", serde_json::json!({"summary": "deploys use fly with the staging app first"}))["node"].as_u64().unwrap();
    let b = s.call("remember", serde_json::json!({"summary": "deploys use netlify from the main branch"}))["node"].as_u64().unwrap();
    let both = s.call("remember", serde_json::json!({"summary": "deploys are announced in the team channel"}))["node"].as_u64().unwrap();
    s.call("link", serde_json::json!({"src": a, "dst": shop, "kind": "part_of"}));
    s.call("link", serde_json::json!({"src": b, "dst": blog, "kind": "part_of"}));
    let ids = |r: &serde_json::Value| -> Vec<u64> { r["results"].as_array().unwrap().iter().map(|h| h["node"].as_u64().unwrap()).collect() };
    let q = |scope: Option<u64>| serde_json::json!({"query": "how do deploys work", "k": 10, "scope": scope});
    let in_shop = ids(&s.call("search", q(Some(shop))));
    assert!(in_shop.contains(&a) && !in_shop.contains(&b), "{in_shop:?}");
    assert!(in_shop.contains(&both), "unattached memories stay visible: {in_shop:?}");
    let in_blog = ids(&s.call("search", q(Some(blog))));
    assert!(in_blog.contains(&b) && !in_blog.contains(&a), "{in_blog:?}");
    let unscoped = ids(&s.call("search", q(None)));
    assert!(unscoped.contains(&a) && unscoped.contains(&b));
    s.close();
}

#[test]
fn a_recurring_failure_counts_on_one_marker_and_a_tool_error_makes_no_gap() {
    let (journal, work) = temp("f5");
    let mut s = Srv::spawn(&journal, &work);
    let mut pains = vec![];
    for (i, line) in [12, 40, 7].iter().enumerate() {
        let ep = s.call("episode", serde_json::json!({"label": format!("task {i}")}))["episode"].as_u64().unwrap();
        let r = s.call("steer", serde_json::json!({
            "episode": ep, "failure": format!("bash failed: vitest not found (line {line})"),
            "gap": false, "dedupe": true,
        }));
        assert!(r["gap_node"].is_null(), "no gap node for a tool error: {r}");
        assert_eq!(r["occurrences"].as_u64(), Some(i as u64 + 1));
        pains.push(r["pain_node"].as_u64().unwrap());
    }
    assert!(pains.iter().all(|p| *p == pains[0]), "one marker for one failure: {pains:?}");
    let state = s.call("state", serde_json::json!({"node": pains[0]}))["state"].as_str().unwrap().to_string();
    assert!(state.contains("occurrences: 3"), "{state}");
    // without the new params the planner behaves exactly as before
    let ep = s.call("episode", serde_json::json!({"label": "legacy"}))["episode"].as_u64().unwrap();
    let r = s.call("steer", serde_json::json!({"episode": ep, "failure": "bash failed: vitest not found (line 1)"}));
    assert_ne!(r["pain_node"].as_u64().unwrap(), pains[0]);
    assert!(r["gap_node"].is_u64());
    s.close();
}
