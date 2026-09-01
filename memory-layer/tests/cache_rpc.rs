//! ML-1 integration: memsrv search-result LRU over a real sidecar + temp
//! journal. Deterministic by construction: temp cwd (no .env anywhere in the
//! chain) + OPENROUTER_API_KEY removed from the child env -> hashing embedder.
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

fn spawn(jpath: &Path) -> (std::process::Child, std::process::ChildStdin, BufReader<std::process::ChildStdout>) {
    let work = std::env::temp_dir().join(format!("memlayer-cache-work-{}", std::process::id()));
    std::fs::create_dir_all(&work).unwrap();
    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_memsrv"))
        .arg(jpath)
        .current_dir(&work) // load_dotenv must find no .env here or in ..
        .env_remove("OPENROUTER_API_KEY")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null()) // banner must not pollute protocol
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
fn memsrv_search_cache_is_transparent_and_keyed_by_resolved_inputs() {
    let dir = std::env::temp_dir().join(format!("memlayer-rpc-cache-{}", std::process::id()));
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

    // 1st run: miss. 2nd identical run: hit, byte-identical results.
    send(&mut stdin, 5, "search", serde_json::json!({"query": "rewrite annotation routing", "k": 3}));
    let r1 = read(&mut reader);
    assert_eq!(r1["result"]["cache"], "miss");
    send(&mut stdin, 6, "search", serde_json::json!({"query": "rewrite annotation routing", "k": 3}));
    let r2 = read(&mut reader);
    assert_eq!(r2["result"]["cache"], "hit", "repeated query must hit the LRU");
    assert_eq!(r1["result"]["results"], r2["result"]["results"],
        "a cache hit must return exactly what the uncached path returns");

    // case/whitespace variants normalize onto the same key
    send(&mut stdin, 7, "search", serde_json::json!({"query": "  REWRITE  annotation routing ", "k": 3}));
    let r3 = read(&mut reader);
    assert_eq!(r3["result"]["cache"], "hit", "normalized query must reuse the entry");
    assert_eq!(r3["result"]["results"], r2["result"]["results"]);

    // k is part of the key
    send(&mut stdin, 8, "search", serde_json::json!({"query": "rewrite annotation routing", "k": 1}));
    let r4 = read(&mut reader);
    assert_eq!(r4["result"]["cache"], "miss", "k must be part of the key");
    assert_eq!(r4["result"]["results"].as_array().unwrap().len(), 1);

    // areas filter is part of the key
    send(&mut stdin, 9, "search", serde_json::json!({"query": "rewrite annotation routing", "k": 3, "areas": ["semantic"]}));
    let r5 = read(&mut reader);
    assert_eq!(r5["result"]["cache"], "miss", "areas filter must be part of the key");
    // the unfiltered key from id 6 is still cached (eviction is a unit-test concern)
    send(&mut stdin, 10, "search", serde_json::json!({"query": "rewrite annotation routing", "k": 3}));
    assert_eq!(read(&mut reader)["result"]["cache"], "hit");

    // different query, different key
    send(&mut stdin, 11, "search", serde_json::json!({"query": "helm rollback wait", "k": 3}));
    assert_eq!(read(&mut reader)["result"]["cache"], "miss");

    drop(stdin);
    let status = child.wait().unwrap();
    assert!(status.success() || status.code() == Some(0));

    // the sidecar's journal still replays cleanly (cache is invisible to disk)
    let ops = memory_layer::persist::Journal::read_all(&jpath).unwrap();
    let mut s = memory_layer::store::StoreData::new();
    for op in &ops { s.apply(op).unwrap(); }
    assert_eq!(s.nodes.len(), 2);
}
// cddd21c0: the search LRU must invalidate on edge ops (Unlink/Reweight/
// RecordOutcome) — they change edge liveness/weight, and cached hits carry
// score+via_graph from graph expansion over live edges. The ONLY mutation
// in this test is the edge op itself (unlink), so a stale cache hit would
// be the test failing — no other op can inadvertently invalidate.
#[test]
fn cache_invalidates_on_unlink_of_a_relevant_edge() {
    let dir = std::env::temp_dir().join(format!("memlayer-rpc-cache-inval-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let jpath: PathBuf = dir.join("journal.jsonl");

    let (mut child, mut stdin, mut reader) = spawn(&jpath);

    // aspect A is the only node matching the query text
    send(&mut stdin, 1, "create_node", serde_json::json!({"kind": "aspect", "label": "ingress annotations"}));
    let a = read(&mut reader)["result"]["node"].as_u64().unwrap();
    send(&mut stdin, 2, "fact", serde_json::json!({"node": a, "key": "rewrite", "value": "nginx rewrite-target annotation routes paths"}));
    read(&mut reader);

    // episode E shares ZERO query tokens -> only reachable via graph expansion
    send(&mut stdin, 3, "episode", serde_json::json!({"label": "shipped ingress fix"}));
    let e = read(&mut reader)["result"]["episode"].as_u64().unwrap();
    send(&mut stdin, 4, "link", serde_json::json!({"src": a, "dst": e}));
    let edge = read(&mut reader)["result"]["edge"].as_u64().unwrap();
    assert_eq!(edge, 1);

    // 1st run: miss; E appears purely via_graph (seed A expands to neighbor E)
    send(&mut stdin, 5, "search", serde_json::json!({"query": "rewrite annotation routing", "k": 3}));
    let r1 = read(&mut reader);
    assert_eq!(r1["result"]["cache"], "miss");
    let e1 = r1["result"]["results"].as_array().unwrap().iter()
        .find(|h| h["node"].as_u64() == Some(e))
        .expect("episode must be hit via graph expansion from aspect A");
    assert_eq!(e1["via_graph"], true);

    // 2nd identical run: cache hit, byte-identical
    send(&mut stdin, 6, "search", serde_json::json!({"query": "rewrite annotation routing", "k": 3}));
    let r2 = read(&mut reader);
    assert_eq!(r2["result"]["cache"], "hit");

    // unlink the edge A->E. ONLY this op runs; nothing else touches E or A.
    send(&mut stdin, 7, "unlink", serde_json::json!({"edge": edge}));
    assert_eq!(read(&mut reader)["result"]["unlinked"], edge);

    // 3rd identical run MUST be a miss (invalidation) and E must be GONE:
    // the edge is no longer alive, so graph expansion cannot surface E
    send(&mut stdin, 8, "search", serde_json::json!({"query": "rewrite annotation routing", "k": 3}));
    let r3 = read(&mut reader);
    assert_eq!(r3["result"]["cache"], "miss",
        "an unlink must invalidate cached entries referencing its endpoints");
    let r3_nodes: Vec<u64> = r3["result"]["results"].as_array().unwrap().iter()
        .filter_map(|h| h["node"].as_u64()).collect();
    assert!(!r3_nodes.contains(&e),
        "the unlinked episode must disappear from a fresh search result");

    drop(stdin);
    assert!(child.wait().unwrap().success());
}

// record_outcome (failure) also changes via_graph weight down; the cache
// must not serve a stale score for the endpoint.
#[test]
fn cache_invalidates_on_recordoutcome() {
    let dir = std::env::temp_dir().join(format!("memlayer-rpc-cache-inval-oc-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let jpath: PathBuf = dir.join("journal.jsonl");

    let (mut child, mut stdin, mut reader) = spawn(&jpath);

    send(&mut stdin, 1, "create_node", serde_json::json!({"kind": "aspect", "label": "ingress annotations"}));
    let a = read(&mut reader)["result"]["node"].as_u64().unwrap();
    send(&mut stdin, 2, "fact", serde_json::json!({"node": a, "key": "rewrite", "value": "nginx rewrite-target annotation routes paths"}));
    read(&mut reader);
    send(&mut stdin, 3, "episode", serde_json::json!({"label": "shipped ingress fix"}));
    let e = read(&mut reader)["result"]["episode"].as_u64().unwrap();
    send(&mut stdin, 4, "link", serde_json::json!({"src": a, "dst": e}));
    read(&mut reader);

    send(&mut stdin, 5, "search", serde_json::json!({"query": "rewrite annotation routing", "k": 3}));
    let r1 = read(&mut reader);
    let e1 = r1["result"]["results"].as_array().unwrap().iter()
        .find(|h| h["node"].as_u64() == Some(e)).unwrap().clone();
    assert_eq!(r1["result"]["cache"], "miss");

    // record_outcome(success=false): weight 0.5 -> 0.4, E's via_graph score drops
    send(&mut stdin, 6, "record_outcome", serde_json::json!({"edge": 1, "success": false}));
    assert_eq!(read(&mut reader)["result"]["edge"], 1);

    send(&mut stdin, 7, "search", serde_json::json!({"query": "rewrite annotation routing", "k": 3}));
    let r3 = read(&mut reader);
    assert_eq!(r3["result"]["cache"], "miss", "record_outcome must invalidate edge-endpoint entries");
    let e3 = r3["result"]["results"].as_array().unwrap().iter()
        .find(|h| h["node"].as_u64() == Some(e)).unwrap();
    assert_ne!(e1["score"], e3["score"],
        "the weakened edge must change the via_graph score: {} vs {}", e1["score"], e3["score"]);

    drop(stdin);
    assert!(child.wait().unwrap().success());
}
