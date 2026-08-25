//! Client for memsrv (memory-layer sidecar): line-JSON-RPC over stdio.

use serde_json::json;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq)]
pub struct MemHit {
    pub node: u64,
    pub score: f32,
    pub via_graph: bool,
}

pub fn memsrv_bin() -> PathBuf {
    if let Ok(p) = std::env::var("MEMSRV_BIN") {
        return PathBuf::from(p);
    }
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../memory-layer/target/debug/memsrv")
}

pub fn default_journal() -> PathBuf {
    if let Ok(p) = std::env::var("SEA_MEM_JOURNAL") {
        return PathBuf::from(p);
    }
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../memory-layer/data/sea-agent-journal.jsonl")
}

/// Run one `search` query against a fresh memsrv process.
pub fn query(journal: &Path, q: &str, k: usize, timeout: Duration) -> Result<Vec<MemHit>, String> {
    let bin = memsrv_bin();
    let mut child = Command::new(&bin)
        .arg(journal)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("cannot spawn {}: {e}", bin.display()))?;
    {
        let mut stdin = child.stdin.take().expect("stdin piped");
        let _ = writeln!(
            stdin,
            "{}",
            json!({"id": 1, "method": "search", "params": {"query": q, "k": k}})
        );
        let _ = writeln!(stdin, "{}", json!({"id": 2, "method": "exit"}));
    }
    // Read the reply on a worker thread so we can enforce a timeout.
    let mut stdout = child.stdout.take().expect("stdout piped");
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let reader = BufReader::new(&mut stdout);
        for line in reader.lines().map_while(Result::ok) {
            let is_exit_reply = line.contains("\"id\":2") || line.contains("\"id\": 2");
            if tx.send(line).is_err() || is_exit_reply {
                break;
            }
        }
        let _ = child.wait();
    });
    loop {
        match rx.recv_timeout(timeout) {
            Ok(line) => {
                let v: serde_json::Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => continue, // stderr noise would be on stderr; skip non-JSON anyway
                };
                if v.get("id").and_then(|i| i.as_u64()) != Some(1) {
                    continue;
                }
                if v.get("ok").and_then(|o| o.as_bool()) != Some(true) {
                    return Err(format!(
                        "memsrv error: {}",
                        v.get("error").map(|e| e.to_string()).unwrap_or_default()
                    ));
                }
                return parse_hits(&v);
            }
            Err(_) => return Err("memory query timed out".into()),
        }
    }
}

fn parse_hits(reply: &serde_json::Value) -> Result<Vec<MemHit>, String> {
    let arr = reply
        .pointer("/result/results")
        .and_then(|r| r.as_array())
        .ok_or_else(|| "malformed search reply".to_string())?;
    Ok(arr
        .iter()
        .filter_map(|h| {
            Some(MemHit {
                node: h.get("node")?.as_u64()?,
                score: h.get("score")?.as_f64()? as f32,
                via_graph: h.get("via_graph").and_then(|g| g.as_bool()).unwrap_or(false),
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_hits_from_reply_shape() {
        let reply = serde_json::json!({
            "id": 1, "ok": true,
            "result": {"results": [
                {"node": 7, "score": 0.91, "via_graph": false},
                {"node": 3, "score": 0.42, "via_graph": true}
            ]}
        });
        let hits = parse_hits(&reply).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0], MemHit { node: 7, score: 0.91, via_graph: false });
        assert!(hits[1].via_graph);
    }
}
