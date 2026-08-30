//! memsrv: memory layer sidecar. Line-delimited JSON-RPC over stdio.
//! One request per line: {"id":1,"method":"search","params":{...}}
//! One response per line: {"id":1,"ok":true,"result":...} / {"id":1,"ok":false,"error":"..."}
//!
//! This is THE single integration surface for agents (pi extension spawns it).
//! All mutations go through the locked journal, so any number of clients are safe.
use memory_layer::model::*;
use memory_layer::persist::{self, Journal};
use memory_layer::remote::OpenRouterEmbedder;
use memory_layer::search::{build_vectors, route_query, search, SearchOpts};
use memory_layer::steering::{reinforce, steer, Correction};
use memory_layer::store::StoreData;
use memory_layer::vec::{Embedder, HashingEmbedder};
use serde_json::json;
use std::io::{BufRead, Write};
use std::path::Path;
use std::sync::Arc;

fn main() {
    let jpath = std::env::args().nth(1).unwrap_or_else(|| "data/memcli-journal.jsonl".into());
    load_dotenv();

    let mut s = StoreData::new();
    let ops = Journal::read_all(&jpath).unwrap_or_default();
    let mut clock: Millis = 1_700_000_000_000;
    for op in &ops {
        if s.apply(op).is_err() { eprintln!("[memsrv] skipping corrupt op"); }
        clock = clock.max(op_at(op) + 1);
    }
    let mut journal = match Journal::open(&jpath) {
        Ok(j) => j,
        Err(e) => { eprintln!("[memsrv] cannot open journal {jpath}: {e}"); std::process::exit(1); }
    };

    let embedder: Arc<dyn Embedder> = match OpenRouterEmbedder::from_env(Path::new("data")) {
        Some(e) => { eprintln!("[memsrv] embedder=openrouter ({})", e.model_name()); Arc::new(e) }
        None => { eprintln!("[memsrv] embedder=hashing (no OPENROUTER_API_KEY)"); Arc::new(HashingEmbedder) }
    };
    eprintln!("[memsrv] ready: {jpath} ({} ops)", ops.len());

    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = match line { Ok(l) => l, Err(_) => break };
        if line.trim().is_empty() { continue; }
        let req: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v, Err(e) => {
                write_err(&mut out, &serde_json::Value::Null, &format!("bad json: {e}"));
                continue;
            }
        };
        let id = req.get("id").cloned().unwrap_or(serde_json::Value::Null);
        let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("").to_string();
        if method == "exit" || method == "quit" { break; }
        let params = req.get("params").cloned().unwrap_or(json!({}));

        // bump logical clock so every op is strictly newer than the last
        clock += 1;
        let reply = handle(&method, &params, &mut s, &mut journal, embedder.as_ref(), &mut clock);
        match reply {
            Ok(result) => write_msg(&mut out, &id, true, &result),
            Err(err) => write_msg(&mut out, &id, false, &json!(err)),
        }
    }
}

fn write_msg(out: &mut dyn Write, id: &serde_json::Value, ok: bool, body: &serde_json::Value) {
    let msg = if ok { json!({"id": id, "ok": true, "result": body}) }
              else { json!({"id": id, "ok": false, "error": body}) };
    let _ = writeln!(out, "{msg}");
    let _ = out.flush();
}
fn write_err(out: &mut dyn Write, id: &serde_json::Value, err: &str) {
    write_msg(out, id, false, &json!(err));
}

fn op_at(op: &Op) -> Millis {
    match op {
        Op::CreateNode { at, .. } | Op::AddFact { at, .. } | Op::SupersedeFact { at, .. }
        | Op::SetArea { at, .. } | Op::DeleteNode { at, .. }
        | Op::Link { at, .. } | Op::Unlink { at, .. }
        | Op::Reweight { at, .. } | Op::RecordOutcome { at, .. }
        | Op::PushContext { at, .. } | Op::CommitLog { at, .. } => *at,
    }
}

fn load_dotenv() {
    for candidate in [".env", "../.env"] {
        if let Ok(txt) = std::fs::read_to_string(candidate) {
            for line in txt.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') { continue; }
                if let Some((k, v)) = line.split_once('=') {
                    std::env::set_var(k.trim(), v.trim());
                }
            }
            return;
        }
    }
}

fn p_node(params: &serde_json::Value, key: &str) -> Result<NodeId, String> {
    params.get(key).and_then(|v| v.as_u64())
        .ok_or_else(|| format!("missing numeric param '{key}'"))
}

/// `areas: ["semantic", ...]` search filter. Absent/empty = every area.
fn parse_areas(params: &serde_json::Value) -> Result<Vec<Area>, String> {
    let Some(list) = params.get("areas").and_then(|a| a.as_array()) else { return Ok(vec![]) };
    list.iter()
        .map(|v| v.as_str().ok_or_else(|| "areas must be strings".to_string())
            .and_then(|raw| Area::parse(raw).ok_or_else(|| format!("unknown area '{raw}'"))))
        .collect()
}

/// Optional `area` override on create_node/episode. Returns the node's area name.
fn set_area_param(
    s: &mut StoreData,
    j: &mut Journal,
    apply: &mut impl FnMut(&mut StoreData, &mut Journal, Op) -> Result<(), String>,
    node: NodeId,
    params: &serde_json::Value,
    at: Millis,
) -> Result<String, String> {
    if let Some(raw) = params.get("area").and_then(|a| a.as_str()) {
        let area = Area::parse(raw).ok_or_else(|| format!("unknown area '{raw}'"))?;
        apply(s, j, Op::SetArea { node, area, at })?;
    }
    Ok(format!("{:?}", s.nodes.get(&node).map(|n| n.area).unwrap_or_default()))
}

fn handle(
    method: &str,
    params: &serde_json::Value,
    s: &mut StoreData,
    j: &mut Journal,
    emb: &dyn Embedder,
    clock: &mut Millis,
) -> Result<serde_json::Value, String> {
    let mut apply = |s: &mut StoreData, j: &mut Journal, op: Op| -> Result<(), String> {
        s.apply(&op)?;
        j.append(&op).map_err(|e| format!("journal write failed: {e}"))
    };
    match method {
        "ping" => Ok(json!({"pong": true})),

        "dump" => {
            let nodes: Vec<serde_json::Value> = s.nodes.values().map(|n| json!({
                "id": n.id, "kind": n.kind, "area": n.area, "label": n.label,
                "facts": n.active_facts().count(),
                "feeders": s.feeders_of(n.id, *clock).len(),
            })).collect();
            Ok(json!({ "nodes": nodes }))
        }

        "state" => {
            let id = p_node(params, "node")?;
            Ok(json!({ "state": s.state_of(id)? }))
        }

        "create_node" => {
            let kind = params.get("kind").and_then(|k| k.as_str()).unwrap_or("aspect");
            let kind = match kind.to_ascii_lowercase().as_str() {
                "entity" => NodeKind::Entity, "harness" => NodeKind::Harness,
                "outcome" => NodeKind::Outcome, _ => NodeKind::Aspect,
            };
            let label = params.get("label").and_then(|l| l.as_str())
                .ok_or("missing 'label'")?.to_string();
            let id = s.next_node;
            apply(s, j, Op::CreateNode { id, kind, label, at: *clock })?;
            let area = set_area_param(s, j, &mut apply, id, params, *clock)?;
            Ok(json!({ "node": id, "area": area }))
        }

        "episode" => {
            let label = params.get("label").and_then(|l| l.as_str())
                .ok_or("missing 'label'")?.to_string();
            let id = s.next_node;
            apply(s, j, Op::CreateNode { id, kind: NodeKind::TaskEpisode, label, at: *clock })?;
            let area = set_area_param(s, j, &mut apply, id, params, *clock)?;
            Ok(json!({ "episode": id, "area": area }))
        }

        "fact" => {
            let node = p_node(params, "node")?;
            let key = params.get("key").and_then(|k| k.as_str()).ok_or("missing 'key'")?;
            let value = params.get("value").and_then(|v| v.as_str()).ok_or("missing 'value'")?;
            let fact_id = s.next_fact;
            apply(s, j, Op::AddFact { node, fact_id, key: key.into(), value: value.into(), at: *clock })?;
            Ok(json!({ "fact": fact_id }))
        }

        "link" => {
            let src = p_node(params, "src")?;
            let dst = p_node(params, "dst")?;
            let id = s.next_edge;
            apply(s, j, Op::Link { id, src, dst, kind: EdgeKind::SuppliesContext, at: *clock })?;
            Ok(json!({ "edge": id }))
        }

        "search" => {
            let query = params.get("query").and_then(|q| q.as_str()).ok_or("missing 'query'")?;
            let k = params.get("k").and_then(|k| k.as_u64()).unwrap_or(5) as usize;
            // explicit areas restrict the search; otherwise the router only
            // reports where it would look (biasing lands in 3.3)
            let asked = parse_areas(params)?;
            let routed = if asked.is_empty() { route_query(query) } else { asked.clone() };
            let opts = SearchOpts::areas(asked);
            let vectors = build_vectors(s, emb);
            let results = search(s, &vectors, emb, query, k, *clock, &opts);
            // enrich hits with label + derived state so the caller can READ
            // what was found (scores alone are useless to an LLM)
            let enriched: Vec<serde_json::Value> = results.iter().map(|r| {
                json!({
                    "node": r.node,
                    "score": r.score,
                    "via_graph": r.via_graph,
                    "label": s.nodes.get(&r.node).map(|n| n.label.clone()).unwrap_or_default(),
                    "kind": s.nodes.get(&r.node).map(|n| format!("{:?}", n.kind)).unwrap_or_default(),
                    "area": s.nodes.get(&r.node).map(|n| format!("{:?}", n.area)).unwrap_or_default(),
                    "state": s.state_of(r.node).unwrap_or_default(),
                })
            }).collect();
            Ok(json!({
                "results": enriched,
                "routed": routed.iter().map(|a| format!("{a:?}")).collect::<Vec<_>>(),
            }))
        }

        "steer" => {
            let episode = p_node(params, "episode")?;
            let failure = params.get("failure").and_then(|f| f.as_str())
                .ok_or("missing 'failure'")?;
            let correction = match params.get("fix") {
                Some(fix) => Some(Correction {
                    node: fix.get("node").and_then(|n| n.as_u64())
                        .ok_or("fix.node must be numeric")?,
                    old_fact: fix.get("fact").and_then(|f| f.as_u64())
                        .ok_or("fix.fact must be numeric")?,
                    new_key: fix.get("new_key").and_then(|k| k.as_str())
                        .unwrap_or("corrected").into(),
                    new_value: fix.get("new_value").and_then(|v| v.as_str())
                        .unwrap_or("").into(),
                }),
                None => None,
            };
            let (ops, notes) = steer(s, episode, failure, correction.as_ref(), *clock)?;
            for op in ops { apply(s, j, op)?; }
            Ok(json!({
                "blamed_feeders": notes.blamed_feeders,
                "superseded_on": notes.superseded_on,
                "gap_node": notes.gap_node,
                "switched_from": notes.switched_from,
            }))
        }

        "commit_log" => {
            let node = p_node(params, "node")?;
            let kind = params.get("kind").and_then(|k| k.as_str()).ok_or("missing 'kind'")?;
            let detail = params.get("detail").and_then(|d| d.as_str()).unwrap_or("");
            apply(s, j, Op::CommitLog { node, kind: kind.into(), detail: detail.into(), at: *clock })?;
            Ok(json!({ "logged": true }))
        }

        "good" => {
            let episode = p_node(params, "episode")?;
            let detail = params.get("detail").and_then(|d| d.as_str()).unwrap_or("success");
            let ops = reinforce(s, episode, detail, *clock)?;
            for op in ops { apply(s, j, op)?; }
            Ok(json!({ "reinforced": true }))
        }

        "set_area" => {
            let node = p_node(params, "node")?;
            let area = params.get("area").and_then(|a| a.as_str()).ok_or("missing 'area'")?;
            let area = Area::parse(area).ok_or_else(|| format!("unknown area '{area}'"))?;
            apply(s, j, Op::SetArea { node, area, at: *clock })?;
            Ok(json!({ "area": format!("{area:?}") }))
        }

        other => Err(format!("unknown method '{other}' (supported: ping dump state create_node episode fact link search set_area steer good)")),
    }
}
