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