//! Demo: the spec section-4 story. A kubernetes-deploy aspect cluster,
//! a task episode fed by two predecessors, a failure, then rule-based steering:
//! down-weight bad feeder -> supersede implicated stale fact -> switch edge.
use memory_layer::model::*;
use memory_layer::persist::{self, Journal};
use memory_layer::store::StoreData;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dir = "data/demo";
    let _ = std::fs::remove_dir_all(dir);
    let mut s = StoreData::new();
    let mut j = Journal::open(format!("{dir}/journal.jsonl"))?;
    let mut t: Millis = 1_700_000_000_000;
    let apply = |s: &mut StoreData, j: &mut Journal, op: Op| -> Result<(), String> {
        s.apply(&op)?;
        j.append(&op).map_err(|e| e.to_string())
    };

    // --- build the domain cluster ---
    for (id, label) in [
        (1, "helm basics"), (2, "ingress annotations"), (3, "resource limits"),
    ] {
        apply(&mut s, &mut j, Op::CreateNode { id, kind: NodeKind::Aspect, label: label.into(), at: t })?;
    }
    // stale fact living in node 2
    apply(&mut s, &mut j, Op::AddFact { node: 2, fact_id: 1,
        key: "rewrite-target".into(), value: "use rewrite-target annotation v1".into(), at: t })?;
    apply(&mut s, &mut j, Op::AddFact { node: 3, fact_id: 2,
        key: "limits".into(), value: "always set cpu/mem requests".into(), at: t })?;

    // task episode fed by aspects 2 and 3
    apply(&mut s, &mut j, Op::CreateNode { id: 10, kind: NodeKind::TaskEpisode, label: "deploy checkout-svc".into(), at: t })?;
    apply(&mut s, &mut j, Op::Link { id: 100, src: 2, dst: 10, kind: EdgeKind::SuppliesContext, at: t })?;
    apply(&mut s, &mut j, Op::Link { id: 101, src: 3, dst: 10, kind: EdgeKind::SuppliesContext, at: t })?;
    apply(&mut s, &mut j, Op::PushContext { to: 10, chunk: ContextChunk {
        from: 2, dim: 4, vec: vec![0.9, 0.1, 0.0, 0.0], note: "ingress ctx (stale v1)".into() }, at: t })?;
    apply(&mut s, &mut j, Op::PushContext { to: 10, chunk: ContextChunk {
        from: 3, dim: 4, vec: vec![0.0, 0.2, 0.8, 0.5], note: "limits ctx".into() }, at: t })?;

    println!("== before deploy ==");
    print!("{}", s.state_of(10)?);
    println!("feeders of episode: {:?}\n",
        s.feeders_of(10, t).iter().map(|e| (e.id, e.src, e.weight)).collect::<Vec<_>>());

    // --- deploy fails; the STEERING ENGINE handles blame + correction ---
    t += 60_000;
    let correction = memory_layer::steering::Correction {
        node: 2, old_fact: 1,
        new_key: "rewrite-target".into(),
        new_value: "v1 annotation removed in networking.k8s.io/v1; use path rewrites in middleware".into(),
    };
    let (ops, notes) = memory_layer::steering::steer(&s, 10,
        "deploy failed: 404 on /cart, rewrite annotation v1 broken",
        Some(&correction), t)?;
    println!("steering notes: blamed={:?} superseded_on={:?}\n",
        notes.blamed_feeders, notes.superseded_on);
    for op in ops { apply(&mut s, &mut j, op)?; }

    println!("== after failed deploy + steering ==");
    println!("edge 100 weight: {} (was 0.5)", s.edges[&100].weight);
    println!("{}", s.state_of(2)?);

    // persistence proof: reopen from journal alone, compare
    let ops = Journal::read_all(format!("{dir}/journal.jsonl"))?;
    let reopened = persist::replay(&ops)?;
    let same = serde_json::to_value(&s)? == serde_json::to_value(&reopened)?;
    println!("\njournal replay reproduces store exactly: {same}");
    assert!(same);

    // --- P1: semantic search over the steered graph ---
    let emb = memory_layer::vec::HashingEmbedder;
    let vectors = memory_layer::search::build_vectors(&s, &emb);
    println!("\n== search: 'path rewrite 404 routing' ==");
    for r in memory_layer::search::search(&s, &vectors, &emb, "path rewrite 404 routing", 3, t, None) {
        let label = s.nodes.get(&r.node).map(|n| n.label.as_str()).unwrap_or("?");
        println!("  #{} {:<24} score={:.3} via_graph={}", r.node, label, r.score, r.via_graph);
    }
    Ok(())
}
