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
use memory_layer::cache::{normalize_query, touched_nodes, SearchCache, SearchKey, SEARCH_CACHE_CAP};
use memory_layer::consolidate::consolidate;
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
    // ab99acb1: tolerant load. A corrupt/partial line costs that line only;
    // the damage is reported, never silently zeroed. Only a genuine I/O
    // error on the journal file itself starts empty (and says so loudly).
    let report = match Journal::read_all_reported(&jpath) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[memsrv] journal read failed ({e}); starting from EMPTY memory");
            Default::default()
        }
    };
    let mut clock: Millis = 1_700_000_000_000;
    let mut skipped_apply = 0usize;
    for op in &report.ops {
        if let Err(e) = s.apply(op) {
            eprintln!("[memsrv] skipping unappliable op: {e}");
            skipped_apply += 1;
        }
        clock = clock.max(op_at(op) + 1);
    }
    if report.skipped > 0 {
        eprintln!("[memsrv] quarantined {} corrupt journal line(s) to {jpath}.corrupt — check it, never silent amnesia", report.skipped);
    }
    if skipped_apply > 0 {
        eprintln!("[memsrv] skipped {} unappliable op(s) (id collisions / missing refs)", skipped_apply);
    }
    let mut journal = match Journal::open(&jpath) {
        Ok(j) => j,
        Err(e) => { eprintln!("[memsrv] cannot open journal {jpath}: {e}"); std::process::exit(1); }
    };

    let embedder: Arc<dyn Embedder> = match OpenRouterEmbedder::from_env(Path::new("data")) {
        Some(e) => { eprintln!("[memsrv] embedder=openrouter ({})", e.model_name()); Arc::new(e) }
        None => { eprintln!("[memsrv] embedder=hashing (no OPENROUTER_API_KEY)"); Arc::new(HashingEmbedder) }
    };
    eprintln!("[memsrv] ready: {jpath} ({} ops)", report.ops.len());

    let stdin = std::io::stdin();
    let mut reader = stdin.lock();
    let mut out = std::io::stdout();
    // ML-1: in-memory LRU for search results. Keyed on the resolved inputs
    // (normalized query, area filter, k); bounded; no TTL. A hit returns
    // exactly what the uncached path would — it sits after scoring. The
    // value carries the hit node ids so journal ops touching a node can
    // invalidate the keys that reference it (stale reads ARE the trigger
    // ML-1 names; mark_useful must be observable on the next identical query).
    let mut search_cache: SearchCache<(Vec<serde_json::Value>, Vec<NodeId>)> =
        SearchCache::new(SEARCH_CACHE_CAP);
    // e8e7d9e2: read BYTES, not lines. `lines()` yields Err on a non-UTF8
    // frame and the old loop `break`-ed on any Err — one bad byte stream
    // killed the sidecar (the pi extension then owns a dead child). Here a
    // non-UTF8 frame is rejected with a structured error and the loop keeps
    // serving the next line.
    loop {
        let mut frame: Vec<u8> = Vec::new();
        let n = match reader.read_until(b'\n', &mut frame) {
            Ok(n) => n,
            Err(e) => {
                eprintln!("[memsrv] stdin read error: {e}");
                break;
            }
        };
        if n == 0 { break; } // EOF: parent closed stdin
        let line = match String::from_utf8(frame) {
            Ok(l) => l,
            Err(e) => {
                let ue = e.utf8_error();
                write_err(&mut out, &serde_json::Value::Null,
                    &format!("invalid utf-8 request frame (first bad byte at {} of the line); frame rejected", ue.valid_up_to()));
                continue;
            }
        };
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
        let reply = handle(&method, &params, &mut s, &mut journal, embedder.as_ref(), &mut clock, &mut search_cache);
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
        | Op::PushContext { at, .. } | Op::CommitLog { at, .. }
        | Op::RecordUsefulness { at, .. } => *at,
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
    cache: &mut SearchCache<(Vec<serde_json::Value>, Vec<NodeId>)>,
) -> Result<serde_json::Value, String> {
    let mut apply = |s: &mut StoreData, j: &mut Journal, op: Op| -> Result<(), String> {
        s.apply(&op)?;
        j.append(&op).map_err(|e| format!("journal write failed: {e}"))?;
        // ML-1 invalidation: an op touching a node drops every cached search
        // result that references it, so re-running the same query observes
        // the mutation (votes included — feedback is immediate).
        for node in touched_nodes(&op) {
            cache.retain(|(_, nodes)| !nodes.contains(&node));
        }
        Ok(())
    };
    match method {
        "ping" => Ok(json!({"pong": true})),

        "stats" => {
            // cheap counters for lifecycle decisions (e.g. "enough new
            // episodes to consolidate"). No deref, no heavy scan beyond count.
            let episodes = s.nodes.values()
                .filter(|n| !n.deleted && matches!(n.kind, NodeKind::TaskEpisode))
                .count();
            Ok(json!({"episodes": episodes}))
        }

        "dump" => {
            // A forgotten memory is gone from the listing even though its
            // ops stay in the journal. The journal is the history; dump is
            // the present.
            let nodes: Vec<serde_json::Value> = s.nodes.values().filter(|n| !n.deleted).map(|n| json!({
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
            // explicit areas restrict the search; otherwise the router picks
            // areas to PREFER — out-of-area nodes are discounted, not dropped
            let asked = parse_areas(params)?;
            let routed = if asked.is_empty() { route_query(query) } else { asked.clone() };
            // ML-1: LRU key on the resolved inputs. `prefer` is derived from
            // the query/filter, so (query, areas, k) fully determines the
            // result. A hit skips routing+embed+scoring entirely.
            let key = SearchKey { query: normalize_query(query), areas: asked.clone(), k };
            let (results, from_cache) = match cache.get(&key) {
                Some((hits, _)) => (hits.clone(), "hit"),
                None => {
                    let opts = SearchOpts::areas(asked).prefer(routed.clone());
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
                    let ids: Vec<NodeId> = enriched.iter()
                        .filter_map(|h| h["node"].as_u64()).collect();
                    cache.put(key, (enriched.clone(), ids));
                    (enriched, "miss")
                }
            };
            Ok(json!({
                "results": results,
                "routed": routed.iter().map(|a| format!("{a:?}")).collect::<Vec<_>>(),
                "cache": from_cache,
            }))
        }

        "recall_brief" => {
            // ML-3: ready-to-inject memory block. Thin wrapper over the same
            // search + state path — state text inlined, never bare scores.
            let query = params.get("query").and_then(|q| q.as_str()).ok_or("missing 'query'")?;
            let k = params.get("k").and_then(|k| k.as_u64()).unwrap_or(5) as usize;
            let asked = parse_areas(params)?;
            let routed = if asked.is_empty() { route_query(query) } else { asked.clone() };
            let block = recall_brief(s, emb, query, k, &asked, &routed, *clock)?;
            Ok(json!({
                "block": block,
                "routed": routed.iter().map(|a| format!("{a:?}")).collect::<Vec<_>>(),
            }))
        }

        "remember" => {
            // ML-3: one-call remember. Auto-routes the summary to a brain
            // area with the same keyword heuristic search uses, then creates
            // node + summary fact + log entry atomically.
            let summary = params.get("summary").and_then(|sm| sm.as_str())
                .ok_or("missing 'summary'")?;
            let routed = route_query(summary);
            let area = routed.first().copied().unwrap_or(Area::Semantic);
            let label = params.get("label").and_then(|l| l.as_str()).map(str::to_string)
                .unwrap_or_else(|| truncate(summary, 60));
            let node = s.next_node;
            // Aspect holds prose; a routed Procedural/Episodic/Salience area
            // is an override, NOT a kind change (a Harness is a generated
            // bundle, not prose)
            apply(s, j, Op::CreateNode { id: node, kind: NodeKind::Aspect, label: label.clone(), at: *clock })?;
            if area != Area::Semantic {
                apply(s, j, Op::SetArea { node, area, at: *clock })?;
            }
            let fact_id = s.next_fact;
            apply(s, j, Op::AddFact { node, fact_id, key: "summary".into(),
                value: summary.into(), at: *clock })?;
            apply(s, j, Op::CommitLog { node, kind: "remembered".into(),
                detail: format!("remembered: {label}"), at: *clock })?;
            Ok(json!({
                "node": node,
                "area": format!("{area:?}"),
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
                "pain_node": notes.pain_node,
                "blamed_feeders": notes.blamed_feeders,
                "superseded_on": notes.superseded_on,
                "gap_node": notes.gap_node,
                "switched_from": notes.switched_from,
            }))
        }

        "consolidate" => {
            let (ops, lessons) = consolidate(s, *clock);
            let applied = ops.len();
            for op in ops { apply(s, j, op)?; }
            Ok(json!({ "applied": applied, "lessons": lessons }))
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

        "mark_useful" => {
            // ML-2: record a retrieval-usefulness vote (agent recall hook /
            // TUI thumbs). Counters only — the search score bias they feed
            // lives in search.rs (USEFULNESS_BIAS).
            let node = p_node(params, "node")?;
            let useful = params.get("useful").and_then(|u| u.as_bool()).unwrap_or(true);
            apply(s, j, Op::RecordUsefulness { node, useful, at: *clock })?;
            let (u, un) = s.nodes.get(&node)
                .map(|n| (n.useful, n.unhelpful)).unwrap_or((0, 0));
            Ok(json!({ "node": node, "useful": u, "unhelpful": un }))
        }

        "forget" => {
            let node = p_node(params, "node")?;
            // Soft by default. The journal is append-only and replay must be
            // exact, so forgetting appends a tombstone rather than removing
            // history — `hard` drops the node from the live store too, but
            // the op that created it is still on disk either way.
            let hard = params.get("hard").and_then(|h| h.as_bool()).unwrap_or(false);
            let label = s.nodes.get(&node).map(|n| n.label.clone()).unwrap_or_default();
            apply(s, j, Op::DeleteNode { node, hard, at: *clock })?;
            Ok(json!({ "forgot": node, "label": label }))
        }

        other => Err(format!("unknown method '{other}' (supported: ping stats dump state create_node episode fact link search recall_brief remember set_area forget steer good consolidate mark_useful)")),
    }
}

/// ML-3: ready-to-inject memory block. Composes the existing search + state
/// path — no new engine, no new storage. State text is ALWAYS inlined: an
/// LLM cannot act on a bare similarity score (this was a real contract bug
/// once).
fn recall_brief(
    s: &mut StoreData,
    emb: &dyn Embedder,
    query: &str,
    k: usize,
    asked: &[Area],
    routed: &[Area],
    now: Millis,
) -> Result<String, String> {
    let opts = SearchOpts::areas(asked.to_vec()).prefer(routed.to_vec());
    let vectors = build_vectors(s, emb);
    let results = search(s, &vectors, emb, query, k, now, &opts);

    let mut block = format!("[memory recall \"{query}\"]\n\n");
    block.push_str(&format!("routed areas: {}\n\n", area_names(routed)));
    for (i, r) in results.iter().enumerate() {
        let state = s.state_of(r.node).unwrap_or_default();
        let indented: String = state.lines().map(|l| format!("  {l}\n")).collect();
        block.push_str(&format!("hit {}/{} (score {:.3}{})\n",
            i + 1, results.len(), r.score,
            if r.via_graph { ", via graph" } else { "" }));
        block.push_str(&indented);
        if i + 1 < results.len() { block.push('\n'); }
    }
    // one-line provenance: which areas were searched + the newest change
    // among the returned nodes (the caller can judge freshness at a glance)
    let newest = results.iter().filter_map(|r| {
        s.nodes.get(&r.node).and_then(|n| n.log.iter().map(|l| l.at).max())
    }).max().unwrap_or(0);
    let newest_id = results.iter().find(|r| {
        s.nodes.get(&r.node).map(|n| n.log.iter().map(|l| l.at).max().unwrap_or(0)).unwrap_or(0)
            == newest
    }).map(|r| r.node);
    block.push_str(&format!("\nprovenance: recalled {} node(s) from areas {}; newest changed {}\n",
        results.len(), area_names(routed),
        newest_id.map(|i| format!("node {i} at {newest}")).unwrap_or_else(|| "-".into())));
    Ok(block)
}

fn area_names(areas: &[Area]) -> String {
    if areas.is_empty() { "all".into() }
    else { areas.iter().map(|a| format!("{a:?}")).collect::<Vec<_>>().join(", ") }
}

/// Truncate to a sensible label/headline length without splitting UTF-8.
fn truncate(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((i, _)) => format!("{}...", &s[..i]),
        None => s.to_string(),
    }
}
