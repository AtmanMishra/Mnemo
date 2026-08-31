//! ML-3 integration: recall_brief + remember thin wrappers over a real
//! memsrv + temp journal. Deterministic: temp cwd (no .env in the chain) +
//! OPENROUTER_API_KEY removed from the child env -> hashing embedder.
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

fn spawn(jpath: &Path) -> (std::process::Child, std::process::ChildStdin, BufReader<std::process::ChildStdout>) {
    let work = std::env::temp_dir().join(format!("memlayer-wrapper-work-{}", std::process::id()));
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
    (child, stdin, reader)
}

fn send(stdin: &mut std::process::ChildStdin, id: u32, method: &str, params: serde_json::Value) {
    writeln!(stdin, "{}", serde_json::json!({"id": id, "method": method, "params": params})).unwrap();
    stdin.flush().unwrap();
}

fn read(reader: &mut BufReader<std::process::ChildStdout>) -> serde_json::Value {
    let mut line = String::new();
    reader.read_line(&mut line).expect("read rpc line");
    serde_json::from_str(line.trim()).expect("valid json response")
}

#[test]
fn recall_brief_returns_a_ready_to_inject_block_with_state_inlined() {
    let dir = std::env::temp_dir().join(format!("memlayer-rpc-brief-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let jpath: PathBuf = dir.join("journal.jsonl");

    let (mut child, mut stdin, mut reader) = spawn(&jpath);
    send(&mut stdin, 1, "create_node", serde_json::json!({"kind": "aspect", "label": "ingress annotations"}));
    let n1 = read(&mut reader)["result"]["node"].as_u64().unwrap();
    send(&mut stdin, 2, "fact", serde_json::json!({"node": n1, "key": "rewrite", "value": "nginx rewrite-target annotation routes paths"}));
    read(&mut reader);
    send(&mut stdin, 3, "create_node", serde_json::json!({"kind": "aspect", "label": "helm rollback"}));
    let n2 = read(&mut reader)["result"]["node"].as_u64().unwrap();
    send(&mut stdin, 4, "fact", serde_json::json!({"node": n2, "key": "rollback", "value": "helm rollback revision needs --wait"}));
    read(&mut reader);

    send(&mut stdin, 5, "recall_brief", serde_json::json!({"query": "rewrite annotation routing", "k": 3}));
    let r = read(&mut reader);
    assert_eq!(r["ok"], true, "recall_brief failed: {}", r["error"]);
    let block = r["result"]["block"].as_str().unwrap().to_string();

    // the block is a self-contained paste-able unit
    assert!(block.contains(r#"[memory recall "rewrite annotation routing"]"#),
        "block must open with the query, got:\n{block}");
    assert!(block.contains("routed areas: all"), "block must state routing:\n{block}");
    assert!(block.contains("(score 0.4") || block.contains("(score "), "hit headers carry score:\n{block}");
    // state INLINED — never a bare score (HANDOFF 6.6): the fact text must
    // be present in the block body
    assert!(block.contains("nginx rewrite-target annotation routes paths"),
        "block must inline the hit's state text:\n{block}");
    assert!(block.contains("facts:"), "inlined state must include facts:\n{block}");
    // one-line provenance with areas + newest-changed
    assert!(block.contains("provenance: recalled 1 node(s) from areas"),
        "provenance line missing:\n{block}");
    assert!(block.contains("newest changed node"), "provenance must name newest-changed:\n{block}");
    let _ = (n1, n2);

    drop(stdin);
    let _ = child.wait();
}

#[test]
fn remember_auto_routes_and_creates_node_fact_log_in_one_call() {
    let dir = std::env::temp_dir().join(format!("memlayer-rpc-remember-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let jpath: PathBuf = dir.join("journal.jsonl");

    let (mut child, mut stdin, mut reader) = spawn(&jpath);

    // a summary with a procedural cue lands in Procedural
    send(&mut stdin, 1, "remember", serde_json::json!({"summary": "how to run the lint harness with a timeout flag"}));
    let r = read(&mut reader);
    assert_eq!(r["ok"], true, "remember failed: {}", r["error"]);
    assert_eq!(r["result"]["area"], "Procedural", "route_query cue must pick the area");
    assert_eq!(r["result"]["routed"][0], "Procedural");
    let node = r["result"]["node"].as_u64().unwrap();

    // node exists with the summary fact and a remembered log entry
    send(&mut stdin, 2, "state", serde_json::json!({"node": node}));
    let st = read(&mut reader)["result"]["state"].as_str().unwrap().to_string();
    assert!(st.contains("how to run the lint harness with a timeout flag"),
        "summary fact must be on the node:\n{st}");
    assert!(st.contains("remembered"), "log entry kind must be remembered:\n{st}");

    // it is retrievable — the point of routing + one-call creation
    send(&mut stdin, 3, "search", serde_json::json!({"query": "lint harness timeout", "k": 3}));
    let hits = read(&mut reader)["result"]["results"].as_array().unwrap().clone();
    assert!(hits.iter().any(|h| h["node"] == node), "remembered node must be searchable");

    // no cue words -> the Semantic default
    send(&mut stdin, 4, "remember", serde_json::json!({"summary": "the deploy pipeline uses a two-stage gate"}));
    let r = read(&mut reader);
    assert_eq!(r["result"]["area"], "Semantic");
    let node2 = r["result"]["node"].as_u64().unwrap();

    drop(stdin);
    let _ = child.wait();

    // everything is journaled: a cold replay reproduces node + area + fact
    let ops = memory_layer::persist::Journal::read_all(&jpath).unwrap();
    let mut s = memory_layer::store::StoreData::new();
    for op in &ops { s.apply(op).unwrap(); }
    assert_eq!(s.nodes[&node].area, memory_layer::model::Area::Procedural);
    assert_eq!(s.nodes[&node2].area, memory_layer::model::Area::Semantic);
    assert!(s.nodes[&node].active_facts().any(|f| f.key == "summary"),
        "summary fact must survive replay");
}