//! P0 regression tests: lifecycle, supersede+steer-lite, journal persistence.
#[cfg(test)]
mod p0 {
    use crate::model::*;
    use crate::persist::{self, Journal};
    use crate::store::StoreData;

    fn now() -> Millis { 1_700_000_000_000 }

    #[test]
    fn cluster_lifecycle() {
        let mut s = StoreData::new();
        let t = now();
        // kubernetes-deploy domain = cluster of aspect nodes
        let ops = vec![
            Op::CreateNode { id: 1, kind: NodeKind::Aspect, label: "helm basics".into(), at: t },
            Op::CreateNode { id: 2, kind: NodeKind::Aspect, label: "ingress annotations".into(), at: t },
            Op::AddFact { node: 1, fact_id: 1, key: "rollback".into(), value: "helm rollback needs --wait".into(), at: t },
            Op::Link { id: 1, src: 2, dst: 1, kind: EdgeKind::SuppliesContext, at: t },
            Op::PushContext { to: 1, chunk: ContextChunk { from: 2, dim: 4, vec: vec![0.1, 0.2, 0.3, 0.4], note: "ingress summary".into() }, at: t },
        ];
        for op in &ops { s.apply(op).unwrap(); }
        assert_eq!(s.nodes[&1].facts.len(), 1);
        assert_eq!(s.feeders_of(1, t).len(), 1);
        assert!(s.state_of(1).unwrap().contains("ingress summary"));
    }

    #[test]
    fn supersede_and_steer_lite() {
        let mut s = StoreData::new();
        let t = now();
        let mk = [
            Op::CreateNode { id: 1, kind: NodeKind::Aspect, label: "a".into(), at: t },
            Op::CreateNode { id: 2, kind: NodeKind::TaskEpisode, label: "episode".into(), at: t },
            Op::AddFact { node: 1, fact_id: 1, key: "port".into(), value: "8080 free".into(), at: t },
            // stale fact corrected:
            Op::SupersedeFact { node: 1, old_fact: 1, new_key: "port".into(), new_value: "8080 taken by auth".into(), new_fact_id: 2, at: t + 5 },
            Op::Link { id: 10, src: 1, dst: 2, kind: EdgeKind::SuppliesContext, at: t },
        ];
        for op in &mk { s.apply(op).unwrap(); }
        // failure on the edge that supplied bad context -> weight drops
        s.apply(&Op::RecordOutcome { edge: 10, success: false, at: t + 10 }).unwrap();
        assert!((s.edges[&10].weight - 0.4).abs() < 1e-6);
        assert_eq!(s.nodes[&1].active_facts().count(), 1); // only the new fact is active
        // repeated failures decay the edge to death
        let mut at = t + 20;
        while s.edges[&10].weight > 0.0 {
            s.apply(&Op::RecordOutcome { edge: 10, success: false, at }).unwrap();
            at += 10;
        }
        assert_eq!(s.edges[&10].weight, 0.0);
        assert!(!s.edges[&10].alive_at(at));
    }

    #[test]
    fn journal_roundtrip_exact() {
        let dir = std::env::temp_dir().join("memlayer-test");
        let _ = std::fs::remove_dir_all(&dir);
        let jpath = dir.join("journal.jsonl");

        let mut s = StoreData::new();
        let t = now();
        let ops = vec![
            Op::CreateNode { id: 1, kind: NodeKind::Aspect, label: "ci".into(), at: t },
            Op::CreateNode { id: 2, kind: NodeKind::Harness, label: "lint-harness".into(), at: t },
            Op::AddFact { node: 1, fact_id: 1, key: "runner".into(), value: "ubuntu-latest".into(), at: t },
            Op::Link { id: 1, src: 2, dst: 1, kind: EdgeKind::SuppliesContext, at: t },
            Op::CommitLog { node: 2, kind: "tool_call".into(), detail: "ran lint".into(), at: t },
        ];
        {
            let mut j = Journal::open(&jpath).unwrap();
            for op in &ops { s.apply(op).unwrap(); j.append(op).unwrap(); }
        }
        persist::write_snapshot(&s, &dir.join("snap.json")).unwrap();

        // reload from snapshot + empty tail == reload from raw journal alone
        let from_journal = persist::load(None, &Journal::read_all(&jpath).unwrap()).unwrap();
        let from_snap = persist::load(Some(&dir.join("snap.json")), &[]).unwrap();
        // compare structurally: HashMap key order in JSON is not stable
        let a: serde_json::Value = serde_json::to_value(&from_journal).unwrap();
        let b: serde_json::Value = serde_json::to_value(&from_snap).unwrap();
        assert_eq!(a, b, "snapshot and journal replay must agree exactly");
        assert_eq!(from_journal.nodes.len(), 2);
    }
}
