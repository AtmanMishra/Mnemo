//! ML-2 integration: mark_useful over a real memsrv + temp journal.
//! Proves the whole loop live: vote -> counter -> cache invalidation ->
//! biased retrieval -> audit trail -> journal replay. Deterministic via
//! temp cwd + env-removed key (hashing embedder).
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

fn spawn(jpath: &Path) -> (std::process::Child, std::process::ChildStdin, BufReader<std::process::ChildStdout>) {
    let work = std::env::temp_dir().join(format!("memlayer-feedback-work-{}", std::process::id()));
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
fn mark_useful_persists_votes_invalidates_cache_and_biases_retrieval() {
    let dir = std::env::temp_dir().join(format!("memlayer-rpc-feedback-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let jpath: PathBuf = dir.join("journal.jsonl");

    let (mut child, mut stdin, mut reader) = spawn(&jpath);

    // two nodes with IDENTICAL text: their vectors are byte-equal, so raw
    // cosine scores are exactly equal — a true tie the votes must break
    send(&mut stdin, 1, "create_node", serde_json::json!({"kind": "aspect", "label": "rollback runbook"}));
    let a = read(&mut reader)["result"]["node"].as_u64().unwrap();
    send(&mut stdin, 2, "fact", serde_json::json!({"node": a, "key": "notes", "value": "helm rollback release notes"}));
    read(&mut reader);
    send(&mut stdin, 3, "create_node", serde_json::json!({"kind": "aspect", "label": "rollback runbook"}));
    let b = read(&mut reader)["result"]["node"].as_u64().unwrap();
    send(&mut stdin, 4, "fact", serde_json::json!({"node": b, "key": "notes", "value": "helm rollback release notes"}));
    read(&mut reader);

    // warm the search cache (miss), then vote the alpha node useful 5x
    send(&mut stdin, 5, "search", serde_json::json!({"query": "helm rollback release", "k": 5}));
    let r = read(&mut reader);
    assert_eq!(r["result"]["cache"], "miss");
    let seen: Vec<u64> = r["result"]["results"].as_array().unwrap().iter()
        .map(|h| h["node"].as_u64().unwrap()).collect();
    assert!(seen.contains(&a) && seen.contains(&b), "both near-tie nodes must be hits: {seen:?}");

    for i in 0..5u32 {
        send(&mut stdin, 100 + i, "mark_useful", serde_json::json!({"node": a}));
        let r = read(&mut reader);
        assert_eq!(r["ok"], true, "mark_useful failed: {}", r["error"]);
        assert_eq!(r["result"]["useful"], i + 1, "counter must accumulate");
        assert_eq!(r["result"]["unhelpful"], 0);
    }

    // the identical query must MISS the cache (the vote touched node a, and
    // the cached key referenced it) and now rank the voted node first
    send(&mut stdin, 6, "search", serde_json::json!({"query": "helm rollback release", "k": 5}));
    let r = read(&mut reader);
    assert_eq!(r["result"]["cache"], "miss",
        "a vote touching a cached hit must invalidate the cached key");
    let top = r["result"]["results"][0]["node"].as_u64().unwrap();
    assert_eq!(top, a, "5 useful votes must break the tie toward the voted node");

    // thumbs-down on the other node: counters + audit trail in state text
    send(&mut stdin, 7, "mark_useful", serde_json::json!({"node": b, "useful": false}));
    let r = read(&mut reader);
    assert_eq!(r["result"]["useful"], 0);
    assert_eq!(r["result"]["unhelpful"], 1);
    send(&mut stdin, 8, "state", serde_json::json!({"node": b}));
    let st = read(&mut reader)["result"]["state"].as_str().unwrap().to_string();
    assert!(st.contains("usefulness votes: 0 useful / 1 unhelpful"),
        "votes must be model-visible in state text (without touching the log/embedding):\n{st}");

    // invalid node -> error, and the bias is capped per vote (not per query)
    send(&mut stdin, 9, "mark_useful", serde_json::json!({"node": 999}));
    let r = read(&mut reader);
    assert_eq!(r["ok"], false, "unknown node must be rejected");

    drop(stdin);
    let _ = child.wait();

    // journal replay reproduces the counters exactly
    let ops = memory_layer::persist::Journal::read_all(&jpath).unwrap();
    let mut s = memory_layer::store::StoreData::new();
    for op in &ops { s.apply(op).unwrap(); }
    assert_eq!(s.nodes[&a].useful, 5, "useful votes must survive replay");
    assert_eq!(s.nodes[&a].unhelpful, 0);
    assert_eq!(s.nodes[&b].useful, 0);
    assert_eq!(s.nodes[&b].unhelpful, 1);

    // and a replayed store ranks identically (voting bias is derived from
    // the counters, not from some in-memory side state)
    let emb = memory_layer::vec::HashingEmbedder;
    let vectors = memory_layer::search::build_vectors(&s, &emb);
    let r = memory_layer::search::search(&s, &vectors, &emb, "helm rollback release", 5,
        1_700_000_000_000, &memory_layer::search::SearchOpts::default());
    assert_eq!(r[0].node, a, "replayed counters must bias retrieval identically");
}