//! P-integration tests: cross-process locking + sidecar RPC roundtrip.
use memory_layer::model::*;
use memory_layer::persist::{Journal};
use memory_layer::store::StoreData;

#[test]
fn concurrent_writers_never_corrupt_journal() {
    let dir = std::env::temp_dir().join("memlayer-concurrent");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let jpath = dir.join("journal.jsonl");

    let handles: Vec<_> = (0..4).map(|w| {
        let p = jpath.clone();
        std::thread::spawn(move || {
            let mut j = Journal::open(&p).unwrap();
            for i in 0..25 {
                let op = Op::CreateNode { id: (w * 100 + i + 1) as u64,
                    kind: NodeKind::Aspect, label: format!("writer{w}-n{i}"),
                    at: 1_700_000_000_000 };
                // serialize the op ourselves only for counting; append does the real write
                j.append(&op).unwrap();
                std::thread::sleep(std::time::Duration::from_micros(200)); // widen race window
            }
        })
    }).collect();
    for h in handles { h.join().unwrap(); }

    let ops = Journal::read_all(&jpath).unwrap();
    assert_eq!(ops.len(), 100, "all appends must survive verbatim");
    // every line must replay cleanly
    let mut s = StoreData::new();
    for op in &ops { s.apply(op).expect("every journaled op must apply"); }
}

#[test]
fn memsrv_rpc_roundtrip() {
    let dir = std::env::temp_dir().join("memlayer-rpc");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let jpath = dir.join("journal.jsonl");

    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_memsrv"))
        .arg(&jpath)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null()) // banner must not pollute protocol
        .spawn()
        .expect("spawn memsrv");
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = child.stdout.take().unwrap();

    let mut send = |id: u32, method: &str, params: serde_json::Value| {
        use std::io::Write;
        writeln!(stdin, "{}", serde_json::json!({"id": id, "method": method, "params": params})).unwrap();
        stdin.flush().unwrap();
    };
    // one long-lived BufReader so buffered bytes are never lost between reads
    use std::io::BufRead;
    let mut reader = std::io::BufReader::new(stdout);
    fn read_line_json(reader: &mut std::io::BufReader<std::process::ChildStdout>) -> serde_json::Value {
        let mut line = String::new();
        reader.read_line(&mut line).expect("read rpc line");
        serde_json::from_str(line.trim()).expect("valid json response")
    }

    send(1, "ping", serde_json::json!({}));
    let r = read_line_json(&mut reader);
    assert_eq!(r["id"], 1);
    assert_eq!(r["ok"], true);
    assert_eq!(r["result"]["pong"], true);

    send(2, "create_node", serde_json::json!({"kind": "aspect", "label": "ingress annotations"}));
    let r = read_line_json(&mut reader);
    assert_eq!(r["ok"], true);
    let node_id = r["result"]["node"].as_u64().unwrap();

    send(3, "fact", serde_json::json!({"node": node_id, "key": "rewrite", "value": "nginx rewrite-target annotation routes paths"}));
    let r = read_line_json(&mut reader);
    assert_eq!(r["ok"], true);

    send(4, "episode", serde_json::json!({"label": "deploy checkout-svc"}));
    let r = read_line_json(&mut reader);
    let ep = r["result"]["episode"].as_u64().unwrap();

    send(5, "link", serde_json::json!({"src": node_id, "dst": ep}));
    let _ = read_line_json(&mut reader);

    send(6, "search", serde_json::json!({"query": "rewrite annotation routing", "k": 3}));
    let r = read_line_json(&mut reader);
    assert_eq!(r["ok"], true, "search failed: {}", r["error"]);
    let top = &r["result"]["results"][0];
    assert_eq!(top["node"], node_id, "expected ingress aspect as top hit");

    send(7, "steer", serde_json::json!({"episode": ep, "failure": "404 rewrite broken on cart"}));
    let r = read_line_json(&mut reader);
    assert_eq!(r["ok"], true, "steer failed: {}", r["error"]);
    assert_eq!(r["result"]["blamed_feeders"].as_array().unwrap().len(), 1);

    drop(stdin);
    let status = child.wait().unwrap();
    assert!(status.success() || status.code() == Some(0));

    // journal written by the server must fully replay
    let ops = Journal::read_all(&jpath).unwrap();
    let mut s = StoreData::new();
    for op in &ops { s.apply(op).unwrap(); }
    assert!(s.nodes.len() >= 2);
}
