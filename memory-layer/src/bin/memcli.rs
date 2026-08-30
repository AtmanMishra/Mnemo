//! Interactive memory-layer REPL.
//! Run: cargo run --bin memcli [-- path/to/journal.jsonl]
//! State persists across runs via the journal (full replay on start).
use memory_layer::model::*;
use memory_layer::persist::{self, Journal};
use memory_layer::search::{build_vectors, search};
use memory_layer::steering::{reinforce, steer, Correction};
use memory_layer::store::StoreData;
use memory_layer::remote::OpenRouterEmbedder;
use memory_layer::vec::{Embedder, HashingEmbedder};
use std::io::{BufRead, Write};

/// Load KEY=VALUE pairs from .env into the environment (tiny dotenv).
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

fn main() {
    load_dotenv();
    let args: Vec<String> = std::env::args().collect();

    // --embedder openrouter|hash  (default: openrouter if key present, else hash)
    let mut mode = std::env::var("OPENROUTER_API_KEY")
        .map(|k| if k.is_empty() { "hash" } else { "openrouter" }.to_string())
        .unwrap_or_else(|_| "hash".to_string());
    let mut jpath = "data/memcli-journal.jsonl".to_string();
    let mut it = args.iter().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--embedder" => { mode = it.next().cloned().unwrap_or(mode); }
            other => jpath = other.to_string(),
        }
    }

    let embedder: std::sync::Arc<dyn Embedder> = if mode == "openrouter" {
        match OpenRouterEmbedder::from_env(std::path::Path::new("data")) {
            Some(e) => {
                println!("embedder: OpenRouter ({}) with disk cache", e.model_name());
                std::sync::Arc::new(e)
            }
            None => {
                println!("embedder: OPENROUTER_API_KEY not set -> falling back to hashing");
                std::sync::Arc::new(HashingEmbedder)
            }
        }
    } else {
        println!("embedder: hashing (offline)");
        std::sync::Arc::new(HashingEmbedder)
    };

    let mut s = StoreData::new();
    let prior = Journal::read_all(&jpath).unwrap_or_default();
    let n_prior = prior.len();
    let mut max_seen: Millis = 0;
    for op in &prior {
        if let Err(e) = s.apply(op) { eprintln!("journal error: {e}"); }
        let at = match op {
            Op::CreateNode { at, .. } | Op::AddFact { at, .. }
            | Op::SupersedeFact { at, .. } | Op::SetArea { at, .. } | Op::DeleteNode { at, .. }
            | Op::Link { at, .. } | Op::Unlink { at, .. }
            | Op::Reweight { at, .. } | Op::RecordOutcome { at, .. }
            | Op::PushContext { at, .. } | Op::CommitLog { at, .. } => *at,
        };
        max_seen = max_seen.max(at);
    }
    let mut j = Journal::open(&jpath).expect("cannot open journal");
    println!("memory ready ({n_prior} ops replayed from {jpath}). type 'help'.");

    let stdin = std::io::stdin();
    let mut clock: Millis = (1_700_000_000_000).max(max_seen + 1);
    loop {
        print!("mem> "); std::io::stdout().flush().unwrap();
        let mut line = String::new();
        if stdin.lock().read_line(&mut line).unwrap_or(0) == 0 { break; }
        let line = line.trim();
        if line.is_empty() { continue; }
        clock += 1000;
        let toks: Vec<&str> = line.split_whitespace().collect();
        let rest = |i: usize| toks[i..].join(" ");
        match toks[0] {
            "quit" | "q" => break,
            "help" => println!("{}", HELP),
            "reindex" => {
                // re-derive all node vectors under the CURRENT embedder
                let vectors = build_vectors(&s, embedder.as_ref());
                println!("reindexed {} nodes with active embedder", vectors.len());
            }
            "dump" => {
                for n in s.nodes.values() {
                    println!("#{} {:?}/{:?} {} [{} facts, {} edges in]",
                        n.id, n.kind, n.area, n.label,
                        n.active_facts().count(),
                        s.feeders_of(n.id, clock).len());
                }
            }
            "new" if toks.len() >= 3 => {
                let kind = parse_kind(toks[1]);
                let id = s.next_node;
                apply(&mut s, &mut j, Op::CreateNode { id, kind, label: rest(2), at: clock });
                println!("node #{id}");
            }
            "episode" if toks.len() >= 2 => {
                let id = s.next_node;
                apply(&mut s, &mut j, Op::CreateNode { id, kind: NodeKind::TaskEpisode, label: rest(1), at: clock });
                println!("episode #{id}");
            }
            "fact" if toks.len() >= 4 => {
                let node: NodeId = toks[1].trim_start_matches('#').parse().unwrap_or(0);
                let fid = s.next_fact;
                apply(&mut s, &mut j, Op::AddFact { node, fact_id: fid,
                    key: toks[2].into(), value: rest(3), at: clock });
                println!("fact #{fid} added to #{node}");
            }
            "link" if toks.len() == 3 => {
                let src: NodeId = toks[1].trim_start_matches('#').parse().unwrap_or(0);
                let dst: NodeId = toks[2].trim_start_matches('#').parse().unwrap_or(0);
                let id = s.next_edge;
                apply(&mut s, &mut j, Op::Link { id, src, dst, kind: EdgeKind::SuppliesContext, at: clock });
                println!("edge #{id}: #{src} supplies-context -> #{dst}");
            }
            "state" if toks.len() == 2 => {
                let id: NodeId = toks[1].trim_start_matches('#').parse().unwrap_or(0);
                match s.state_of(id) { Ok(txt) => print!("{txt}"), Err(e) => println!("{e}") }
            }
            "search" if toks.len() >= 2 => {
                let vectors = build_vectors(&s, embedder.as_ref());
                for r in search(&s, &vectors, embedder.as_ref(), &rest(1), 5, clock, None) {
                    let lbl = s.nodes.get(&r.node).map(|n| n.label.as_str()).unwrap_or("?");
                    println!("  #{} {:<28} score={:.3}{}", r.node, lbl, r.score,
                        if r.via_graph {" (via graph)"} else {""});
                }
            }
            "steer" if toks.len() >= 3 => {
                let ep: NodeId = toks[1].trim_start_matches('#').parse().unwrap_or(0);
                let detail_toks: Vec<&str> = toks[2..].to_vec();
                // optional trailing --fix <node>:<fact>:<new value...>
                let mut detail_parts = Vec::new();
                let mut correction = None;
                let mut i = 0;
                while i < detail_toks.len() {
                    if detail_toks[i] == "--fix" && i + 2 < detail_toks.len() + 1 {
                        let spec = detail_toks.get(i+1).copied().unwrap_or("");
                        let val = detail_toks[i+2..].join(" ");
                        let mut it = spec.splitn(2, ':');
                        let n: NodeId = it.next().unwrap_or("0").parse().unwrap_or(0);
                        let f: u64 = it.next().unwrap_or("0").parse().unwrap_or(0);
                        correction = Some(Correction { node: n, old_fact: f,
                            new_key: "corrected".into(), new_value: val });
                        break;
                    }
                    detail_parts.push(detail_toks[i]);
                    i += 1;
                }
                match steer(&s, ep, &detail_parts.join(" "), correction.as_ref(), clock) {
                    Ok((ops, notes)) => {
                        for op in ops { apply(&mut s, &mut j, op); }
                        println!("steered: blamed={:?} superseded_on={:?} gap={:?}",
                            notes.blamed_feeders, notes.superseded_on, notes.gap_node);
                    }
                    Err(e) => println!("error: {e}"),
                }
            }
            "good" if toks.len() >= 2 => {
                let ep: NodeId = toks[1].trim_start_matches('#').parse().unwrap_or(0);
                match reinforce(&s, ep, &rest(2.min(toks.len())), clock) {
                    Ok(ops) => { for op in ops { apply(&mut s, &mut j, op); } println!("reinforced feeders"); }
                    Err(e) => println!("error: {e}"),
                }
            }
            other => println!("unknown command '{other}' (try help)"),
        }
    }
}

fn apply(s: &mut StoreData, j: &mut Journal, op: Op) {
    if let Err(e) = s.apply(&op) { println!("error: {e}"); return; }
    if let Err(e) = j.append(&op) { eprintln!("journal write failed: {e}"); }
}

fn parse_kind(k: &str) -> NodeKind {
    match k.to_ascii_lowercase().as_str() {
        "aspect" => NodeKind::Aspect,
        "entity" => NodeKind::Entity,
        "harness" => NodeKind::Harness,
        "outcome" => NodeKind::Outcome,
        _ => NodeKind::Aspect,
    }
}

const HELP: &str = "\
commands:
  new aspect|entity|harness|outcome <label>   create a node
  episode <label>                             create a task episode
  fact <#node> <key> <value...>               add a fact
  link <#src> <#dst>                          src supplies context to dst
  state <#node>                               show derived state
  search <query...>                           semantic search over nodes
  steer <#episode> <what failed...> [--fix <node>:<fact> <truth...>]
  good <#episode> <what worked...>            reinforce feeders
  dump                                        list all nodes
  quit";
