//! Which embedder memsrv picks, and the cheap `stats` count the app's footer
//! reads. Remote embeddings are opt-in through MNEMO_EMBED_URL: a provider key
//! in the environment (OPENROUTER_API_KEY, there for the model) must not send
//! every memory's text to a server, one blocking call per node under the
//! journal lock. The OpenRouter address here is a local listener that never
//! answers, so a memsrv that went to it would also stall the search.
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::Path;
use std::time::{Duration, Instant};

fn spawn(dir: &Path, env: &[(&str, &str)]) -> (std::process::Child, std::process::ChildStdin, BufReader<std::process::ChildStdout>) {
    let mut cmd = std::process::Command::new(env!("CARGO_BIN_EXE_memsrv"));
    cmd.arg(dir.join("journal.jsonl"))
        .current_dir(dir)
        // no $MNEMO_HOME/.env to read, and no embedder chosen by the caller's shell
        .env("MNEMO_HOME", dir)
        .env_remove("MNEMO_EMBED_URL")
        .env_remove("MNEMO_EMBED_MODEL")
        .env_remove("OPENROUTER_API_KEY")
        .env_remove("OPENROUTER_EMBED_URL")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    for (k, v) in env { cmd.env(k, v); }
    let mut child = cmd.spawn().expect("spawn memsrv");
    let stdin = child.stdin.take().unwrap();
    let reader = BufReader::new(child.stdout.take().unwrap());
    (child, stdin, reader)
}

fn call(stdin: &mut std::process::ChildStdin, reader: &mut BufReader<std::process::ChildStdout>, method: &str, params: serde_json::Value) -> serde_json::Value {
    writeln!(stdin, "{}", serde_json::json!({"id": 1, "method": method, "params": params})).unwrap();
    stdin.flush().unwrap();
    let mut line = String::new();
    reader.read_line(&mut line).expect("read rpc line");
    let v: serde_json::Value = serde_json::from_str(line.trim()).expect("valid json response");
    assert_eq!(v["ok"], true, "{method}: {v}");
    v["result"].clone()
}

fn tempdir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("memlayer-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn an_openrouter_key_alone_does_not_turn_on_remote_embeddings() {
    let dir = tempdir("embedder-key");
    let silent = TcpListener::bind("127.0.0.1:0").unwrap();
    silent.set_nonblocking(true).unwrap();
    let url = format!("http://127.0.0.1:{}/api/v1/embeddings", silent.local_addr().unwrap().port());
    let (mut child, mut stdin, mut reader) = spawn(&dir, &[
        ("OPENROUTER_API_KEY", "sk-or-test-not-a-key"),
        ("OPENROUTER_EMBED_URL", &url),
    ]);

    let started = Instant::now();
    call(&mut stdin, &mut reader, "remember", serde_json::json!({"summary": "the deploy script lives in ops/deploy.sh"}));
    let hits = call(&mut stdin, &mut reader, "search", serde_json::json!({"query": "deploy script", "k": 3}));
    assert!(!hits["results"].as_array().unwrap().is_empty(), "{hits}");
    assert!(started.elapsed() < Duration::from_secs(5), "took {:?}", started.elapsed());
    assert!(silent.accept().is_err(), "memsrv connected to the OpenRouter address");
    let stats = call(&mut stdin, &mut reader, "stats", serde_json::json!({}));
    assert_eq!(stats["embedder"], "hashing", "{stats}");

    drop(stdin);
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn mnemo_embed_url_is_the_opt_in_and_stats_names_it() {
    let dir = tempdir("embedder-url");
    let (mut child, mut stdin, mut reader) = spawn(&dir, &[
        ("MNEMO_EMBED_URL", "http://127.0.0.1:9/v1/embeddings"),
        ("MNEMO_EMBED_MODEL", "nomic-embed-text"),
    ]);
    let stats = call(&mut stdin, &mut reader, "stats", serde_json::json!({}));
    assert_eq!(stats["embedder"], "url", "{stats}");
    assert_eq!(stats["embed_model"], "nomic-embed-text", "{stats}");
    drop(stdin);
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn stats_counts_live_nodes_by_area_without_a_dump() {
    let dir = tempdir("embedder-stats");
    let (mut child, mut stdin, mut reader) = spawn(&dir, &[]);
    let a = call(&mut stdin, &mut reader, "create_node", serde_json::json!({"kind": "aspect", "label": "a"}))["node"].as_u64().unwrap();
    call(&mut stdin, &mut reader, "create_node", serde_json::json!({"kind": "entity", "label": "b"}));
    call(&mut stdin, &mut reader, "episode", serde_json::json!({"label": "c"}));
    call(&mut stdin, &mut reader, "forget", serde_json::json!({"node": a}));

    let stats = call(&mut stdin, &mut reader, "stats", serde_json::json!({}));
    assert_eq!(stats["nodes"], 2, "a forgotten node is not counted: {stats}");
    assert_eq!(stats["episodes"], 1, "{stats}");
    assert_eq!(stats["areas"], serde_json::json!({"Spatial": 1, "Episodic": 1}), "{stats}");
    assert_eq!(stats["embedder"], "hashing", "{stats}");
    drop(stdin);
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&dir);
}
