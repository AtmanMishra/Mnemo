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
fn oversize_frame_is_rejected_drained_and_loop_survives() {
    // f7c2c763: a >1 MiB frame must be answered with a structured error,
    // DRAINED (so the stream resynchronises), and the sidecar keeps serving.
    let jpath = temp_journal("oversize");
    let (mut child, mut stdin, mut reader) = spawn(&jpath);

    // 1.5 MiB of payload with no newline until the end — one giant frame
    let huge = vec![b'a'; (3 << 19) + 100]; // 1.5 MiB
    stdin.write_all(&huge).unwrap();
    stdin.write_all(b"\n").unwrap();
    stdin.flush().unwrap();
    let err = read(&mut reader);
    assert_eq!(err["ok"], false, "oversize frame must be answered with an error");
    assert!(err["error"].as_str().unwrap().contains("too large"),
        "error must name the cause: {}", err["error"]);

    // the stream must be resynchronised on the NEXT newline: ping works
    send(&mut stdin, 1, "ping", serde_json::json!({}));
    assert_eq!(read(&mut reader)["result"]["pong"], true);

    drop(stdin);
    assert!(child.wait().unwrap().success(),
        "the sidecar must still exit cleanly after serving an oversize frame");
}

#[test]
fn oversize_frame_without_trailing_newline_does_not_eat_the_next_request() {
    // drain must resync even when the giant frame's newline arrives in a
    // later write — the next well-formed request still gets its reply
    let jpath = temp_journal("oversize-late-nl");
    let (mut child, mut stdin, mut reader) = spawn(&jpath);

    let huge = vec![b'x'; (2 << 20) + 5]; // just over 2 MiB, newline comes after
    stdin.write_all(&huge).unwrap();
    stdin.write_all(b"\n").unwrap();
    stdin.flush().unwrap();
    let err = read(&mut reader);
    assert_eq!(err["ok"], false);

    send(&mut stdin, 7, "ping", serde_json::json!({}));
    let pong = read(&mut reader);
    assert_eq!(pong["id"], 7);
    assert_eq!(pong["result"]["pong"], true);

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
