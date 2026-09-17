//! The `fact` write path after #24: a key has one current value.
//!
//! The constraint probe asserts the recall half (what a model is handed after a
//! constraint changes). This asserts the write mechanics around it: the explicit
//! opt-out for a genuinely set-valued key, and convergence of a key that
//! accumulated two live values before the write path superseded.
//!
//! Deterministic like the rest: temp cwd with no .env in the chain and
//! OPENROUTER_API_KEY removed, so the hashing embedder runs.
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

type Srv = (std::process::Child, std::process::ChildStdin, BufReader<std::process::ChildStdout>);

fn spawn(jpath: &Path) -> Srv {
    let work = std::env::temp_dir().join(format!("memlayer-factwrite-work-{}", std::process::id()));
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
    let v: serde_json::Value = serde_json::from_str(line.trim()).expect("valid json response");
    assert_eq!(v["ok"], true, "{v}");
    v["result"].clone()
}

fn journal(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("memlayer-factwrite-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("journal.jsonl")
}

/// A harness's tool list is a SET: several values under one key, none of which
/// replaces another. `append` is the explicit opt-out for that shape — and only
/// that shape; the single-value default is what a constraint needs.
#[test]
fn append_keeps_a_set_valued_key() {
    let jpath = journal("append");
    let (mut child, mut stdin, mut reader) = spawn(&jpath);

    send(&mut stdin, 1, "create_node", serde_json::json!({"kind": "harness", "label": "k8s-debug"}));
    let n = read(&mut reader)["node"].as_u64().unwrap();

    send(&mut stdin, 2, "fact", serde_json::json!({
        "node": n, "key": "tool", "value": "kubectl_watch", "append": true }));
    let first = read(&mut reader);
    assert_eq!(first["superseded"], serde_json::Value::Null,
        "the first write under a key supersedes nothing");

    send(&mut stdin, 3, "fact", serde_json::json!({
        "node": n, "key": "tool", "value": "helm_status", "append": true }));
    let second = read(&mut reader);
    assert_eq!(second["superseded"], serde_json::Value::Null,
        "append must not touch the value already under the key: {second}");

    send(&mut stdin, 4, "state", serde_json::json!({"node": n}));
    let st = read(&mut reader)["state"].as_str().unwrap().to_string();
    assert!(st.contains("kubectl_watch") && st.contains("helm_status"),
        "both tools must still be listed: {st}");
    assert!(!st.contains("retired"), "nothing was superseded here: {st}");

    let _ = writeln!(stdin, "{}", serde_json::json!({"id": 9, "method": "exit"}));
    let _ = stdin.flush();
    let _ = child.wait();
}

/// The pre-#24 shape: a journal where the same key accumulated two live values
/// because the write path appended. One ordinary write under that key has to
/// converge it — one current answer, both earlier values kept as history.
#[test]
fn a_legacy_duplicate_pair_converges_to_one_current_value() {
    let jpath = journal("converge");
    let (mut child, mut stdin, mut reader) = spawn(&jpath);

    send(&mut stdin, 1, "create_node", serde_json::json!({"kind": "aspect", "label": "repo conventions"}));
    let n = read(&mut reader)["node"].as_u64().unwrap();

    // what the old write path did: two live values, nothing marking which is current
    for (id, value) in [(2u32, "use npm in this repo"), (3, "use pnpm in this repo")] {
        send(&mut stdin, id, "fact", serde_json::json!({
            "node": n, "key": "package manager", "value": value, "append": true }));
        read(&mut reader);
    }
    send(&mut stdin, 4, "state", serde_json::json!({"node": n}));
    let before = read(&mut reader)["state"].as_str().unwrap().to_string();
    assert!(before.contains("use npm in this repo") && before.contains("use pnpm in this repo"),
        "the legacy shape is two live values: {before}");

    // one ordinary write: the key gets one current value, and both old ones are
    // retired rather than deleted
    send(&mut stdin, 5, "fact", serde_json::json!({
        "node": n, "key": "package manager", "value": "use bun in this repo" }));
    let applied = read(&mut reader);
    assert!(applied["superseded"].as_u64().is_some(),
        "the write supersedes a value that was there: {applied}");

    send(&mut stdin, 6, "state", serde_json::json!({"node": n}));
    let after = read(&mut reader)["state"].as_str().unwrap().to_string();
    assert!(after.contains("use bun in this repo"), "{after}");
    assert!(!after.contains("use npm in this repo") && !after.contains("use pnpm in this repo"),
        "neither retired value may answer as current: {after}");
    assert!(after.contains("2 retired values"), "{after}");

    send(&mut stdin, 7, "history", serde_json::json!({"node": n}));
    let hist = read(&mut reader);
    let facts = hist["facts"].as_array().unwrap();
    assert_eq!(facts.len(), 3, "all three values survive: {hist}");
    let live: Vec<&serde_json::Value> = facts.iter().filter(|f| f["status"] == "active").collect();
    assert_eq!(live.len(), 1, "exactly one current value: {hist}");
    assert!(live[0]["value"].as_str().unwrap().contains("use bun"));
    assert!(facts.iter().filter(|f| f["status"] == "superseded")
        .all(|f| f["superseded_by"] == live[0]["id"]),
        "every retired value points at what replaced it: {hist}");

    let _ = writeln!(stdin, "{}", serde_json::json!({"id": 9, "method": "exit"}));
    let _ = stdin.flush();
    let _ = child.wait();
}
