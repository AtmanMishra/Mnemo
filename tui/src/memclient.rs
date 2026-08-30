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

// ---------------------------------------------------------------------------
// MemSession: one long-lived memsrv for the cockpit. The per-query `query()`
// above stays for the legacy seatui.
// ---------------------------------------------------------------------------

use std::process::{Child, ChildStdin};

/// A node as the cockpit shows it: identity AND content. Scores alone are
/// useless to a reader — see HANDOFF section 6, lesson 6.
#[derive(Debug, Clone, PartialEq)]
pub struct NodeRow {
    pub id: u64,
    pub kind: String,
    pub area: String,
    pub label: String,
    pub facts: u64,
}

pub struct MemSession {
    child: Child,
    stdin: ChildStdin,
    reader: BufReader<std::process::ChildStdout>,
    next_id: u64,
}

impl MemSession {
    pub fn open(journal: &Path) -> Result<Self, String> {
        let bin = memsrv_bin();
        let mut child = Command::new(&bin)
            .arg(journal)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("cannot spawn {}: {e}", bin.display()))?;
        let stdin = child.stdin.take().expect("stdin piped");
        let reader = BufReader::new(child.stdout.take().expect("stdout piped"));
        Ok(Self { child, stdin, reader, next_id: 1 })
    }

    /// One request/response round trip. Replies are strictly FIFO, so matching
    /// on the id is enough to stay in sync.
    pub fn request(&mut self, method: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        writeln!(self.stdin, "{}", json!({"id": id, "method": method, "params": params}))
            .and_then(|_| self.stdin.flush())
            .map_err(|e| format!("memsrv write failed: {e}"))?;
        loop {
            let mut line = String::new();
            match self.reader.read_line(&mut line) {
                Ok(0) => return Err("memsrv closed the connection".into()),
                Err(e) => return Err(format!("memsrv read failed: {e}")),
                Ok(_) => {}
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else { continue };
            if v.get("id").and_then(|i| i.as_u64()) != Some(id) { continue; }
            if v.get("ok").and_then(|o| o.as_bool()) == Some(true) {
                return Ok(v.get("result").cloned().unwrap_or(serde_json::Value::Null));
            }
            return Err(v.get("error").map(|e| e.to_string()).unwrap_or_else(|| "memsrv error".into()));
        }
    }

    pub fn dump(&mut self) -> Result<Vec<NodeRow>, String> {
        Ok(parse_rows(&self.request("dump", json!({}))?))
    }

    /// Search, optionally restricted to brain areas.
    pub fn search(&mut self, q: &str, k: usize, areas: &[String]) -> Result<Vec<NodeRow>, String> {
        let mut params = json!({"query": q, "k": k});
        if !areas.is_empty() { params["areas"] = json!(areas); }
        let res = self.request("search", params)?;
        Ok(res.get("results").map(parse_rows_from).unwrap_or_default())
    }

    pub fn state(&mut self, node: u64) -> Result<String, String> {
        Ok(self.request("state", json!({"node": node}))?
            .get("state").and_then(|s| s.as_str()).unwrap_or("").to_string())
    }

    pub fn stop(&mut self) {
        let _ = writeln!(self.stdin, "{}", json!({"id": 0, "method": "exit"}));
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for MemSession {
    fn drop(&mut self) { self.stop(); }
}

fn parse_rows(result: &serde_json::Value) -> Vec<NodeRow> {
    result.get("nodes").map(parse_rows_from).unwrap_or_default()
}

fn parse_rows_from(v: &serde_json::Value) -> Vec<NodeRow> {
    let s = |o: &serde_json::Value, k: &str| {
        o.get(k).map(|x| match x {
            serde_json::Value::String(s) => s.clone(),
            other => other.to_string().trim_matches('"').to_string(),
        }).unwrap_or_default()
    };
    v.as_array().map(|arr| arr.iter().filter_map(|o| Some(NodeRow {
        id: o.get("id").or_else(|| o.get("node"))?.as_u64()?,
        kind: s(o, "kind"),
        area: s(o, "area"),
        label: s(o, "label"),
        facts: o.get("facts").and_then(|f| f.as_u64()).unwrap_or(0),
    })).collect()).unwrap_or_default()
}

#[cfg(test)]
mod session_tests {
    use super::*;

    #[test]
    fn dump_and_search_replies_carry_content_not_just_ids() {
        // regression guard for HANDOFF lesson 6: a hit without label/area is
        // unreadable, and that once looked like a model failure
        let dump = json!({"nodes": [
            {"id": 4, "kind": "Aspect", "area": "Semantic", "label": "helm rollback", "facts": 2}
        ]});
        let rows = parse_rows(&dump);
        assert_eq!(rows, vec![NodeRow { id: 4, kind: "Aspect".into(), area: "Semantic".into(),
                                        label: "helm rollback".into(), facts: 2 }]);

        let hits = json!([{"node": 7, "score": 0.9, "kind": "Aspect", "area": "Salience",
                           "label": "pain: 404 on rewrite"}]);
        let rows = parse_rows_from(&hits);
        assert_eq!(rows[0].id, 7);
        assert_eq!(rows[0].area, "Salience");
        assert_eq!(rows[0].label, "pain: 404 on rewrite");
    }

    #[test]
    fn malformed_rows_are_skipped_not_fatal() {
        let rows = parse_rows(&json!({"nodes": [{"label": "no id"}, {"id": 1}]}));
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, 1);
        assert!(parse_rows(&json!({})).is_empty());
    }

    /// Real memsrv, real journal, real protocol.
    #[test]
    fn live_memsrv_round_trip() {
        if !memsrv_bin().exists() {
            eprintln!("skipping: memsrv not built");
            return;
        }
        let dir = std::env::temp_dir().join("cockpit-memsession");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut m = MemSession::open(&dir.join("journal.jsonl")).unwrap();

        m.request("create_node", json!({"kind": "aspect", "label": "helm rollback needs wait"})).unwrap();
        m.request("create_node", json!({"kind": "aspect", "label": "deploy broke prod", "area": "salience"})).unwrap();

        let rows = m.dump().unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().any(|r| r.area == "Salience"), "{rows:?}");
        assert!(rows.iter().all(|r| !r.label.is_empty()));

        let hits = m.search("helm rollback", 5, &[]).unwrap();
        assert!(!hits.is_empty() && !hits[0].label.is_empty(), "{hits:?}");

        let only = m.search("helm rollback", 5, &["salience".into()]).unwrap();
        assert!(only.iter().all(|r| r.area == "Salience"), "{only:?}");

        let state = m.state(rows[0].id).unwrap();
        assert!(state.contains('#'), "state text should render the node: {state}");
        assert!(m.state(9999).is_err(), "a missing node is an error, not empty text");
        m.stop();
    }
}
