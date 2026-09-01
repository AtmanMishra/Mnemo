//! memsrv robustness over the wire: a malformed frame (non-UTF8, oversize,
//! garbage JSON) must be answered with a structured error and the sidecar
//! must KEEP SERVING. One bad byte stream used to kill the whole loop
//! (e8e7d9e2) — the pi extension would then own a dead child silently.
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

fn spawn(jpath: &Path) -> (std::process::Child, std::process::ChildStdin, BufReader<std::process::ChildStdout>) {
    let work = std::env::temp_dir().join(format!("memlayer-robust-work-{}", std::process::id()));
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

fn temp_journal(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("memlayer-robust-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("journal.jsonl")
}

#[test]
fn non_utf8_frame_is_rejected_with_error_and_loop_survives() {
    let jpath = temp_journal("utf8");
    let (mut child, mut stdin, mut reader) = spawn(&jpath);

    // warm up: a normal ping works
    send(&mut stdin, 1, "ping", serde_json::json!({}));
    assert_eq!(read(&mut reader)["result"]["pong"], true);

    // a non-UTF8 frame: raw bytes 0xFF 0xFE are never valid UTF-8
    stdin.write_all(&[0xFF, 0xFE, 0xC3, b'\n']).unwrap();
    stdin.flush().unwrap();
    let err = read(&mut reader);
    assert_eq!(err["ok"], false, "the bad frame must be answered, not ignored");
    assert!(err["error"].as_str().unwrap().contains("utf-8"),
        "error must name the cause: {}", err["error"]);

    // the sidecar must still be serving the NEXT line — this is the whole fix
    send(&mut stdin, 2, "ping", serde_json::json!({}));
    let pong = read(&mut reader);
    assert_eq!(pong["id"], 2, "id must survive the rejected frame before it");
    assert_eq!(pong["result"]["pong"], true, "memsrv must keep serving after a non-UTF8 frame");

    // and it still works end-to-end afterwards
    send(&mut stdin, 3, "create_node", serde_json::json!({"kind": "aspect", "label": "after garbage"}));
    let node = read(&mut reader)["result"]["node"].as_u64().unwrap();
    assert_eq!(node, 1);

    drop(stdin);
    assert!(child.wait().unwrap().success());
}

#[test]
fn garbage_json_frame_is_rejected_with_error_and_loop_survives() {
    let jpath = temp_journal("badjson");
    let (mut child, mut stdin, mut reader) = spawn(&jpath);

    stdin.write_all(b"this is not json at all\n").unwrap();
    stdin.flush().unwrap();
    let err = read(&mut reader);
    assert_eq!(err["ok"], false);
    assert!(err["error"].as_str().unwrap().contains("bad json"));

    send(&mut stdin, 1, "ping", serde_json::json!({}));
    assert_eq!(read(&mut reader)["result"]["pong"], true);

    drop(stdin);
    assert!(child.wait().unwrap().success());
}
