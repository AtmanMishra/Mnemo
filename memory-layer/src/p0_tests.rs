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
    fn superseding_a_key_retires_every_live_copy_and_replays_exact() {
        // #24: the write path used to append, so a journal can hold two live
        // values under one key — the ambiguity a model was handed. Superseding
        // is the repair: the new value is the only active one, the older copies
        // keep their text and name what replaced them, and replaying the same
        // ops lands in the same state.
        let mut s = StoreData::new();
        let t = now();
        let ops = vec![
            Op::CreateNode { id: 1, kind: NodeKind::Aspect, label: "repo conventions".into(), at: t },
            Op::AddFact { node: 1, fact_id: 1, key: "package manager".into(), value: "use npm".into(), at: t },
            Op::AddFact { node: 1, fact_id: 2, key: "package manager".into(), value: "use pnpm".into(), at: t + 1 },
            Op::SupersedeFact { node: 1, old_fact: 1, new_key: "package manager".into(),
                new_value: "use bun".into(), new_fact_id: 3, at: t + 2 },
        ];
        for op in &ops { s.apply(op).unwrap(); }

        let facts = &s.nodes[&1].facts;
        let live: Vec<&Fact> = s.nodes[&1].active_facts().collect();
        assert_eq!(live.len(), 1, "one value answers a query: {facts:?}");
        assert_eq!(live[0].value, "use bun");
        assert_eq!(facts.len(), 3, "supersede never deletes: {facts:?}");
        for f in facts.iter().filter(|f| f.status == FactStatus::Superseded) {
            assert_eq!(f.superseded_by, Some(3), "each retired value names its replacement: {f:?}");
        }

        let mut replayed = persist::replay(&ops).unwrap();
        assert_eq!(replayed.nodes[&1].active_facts().count(), 1);
        assert_eq!(replayed.state_of(1).unwrap(), s.state_of(1).unwrap(),
            "replay(ops) == state, supersession included");
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

    #[test]
    fn area_defaults_by_kind() {
        let mut s = StoreData::new();
        let t = now();
        let kinds = [
            (1, NodeKind::Aspect, Area::Semantic),
            (2, NodeKind::TaskEpisode, Area::Episodic),
            (3, NodeKind::Outcome, Area::Episodic),
            (4, NodeKind::Harness, Area::Procedural),
            (5, NodeKind::Entity, Area::Spatial),
        ];
        for (id, kind, _) in kinds {
            s.apply(&Op::CreateNode { id, kind, label: format!("n{id}"), at: t }).unwrap();
        }
        for (id, kind, want) in kinds {
            assert_eq!(s.nodes[&id].area, want, "{kind:?} must default to {want:?}");
            assert_eq!(Area::for_kind(kind), want);
        }
        // area is visible in the derived state the agent actually reads
        assert!(s.state_of(4).unwrap().contains("Procedural"));
    }

    #[test]
    fn set_area_survives_journal_replay() {
        let dir = std::env::temp_dir().join("memlayer-area-replay");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let jpath = dir.join("journal.jsonl");
        let t = now();
        let ops = vec![
            Op::CreateNode { id: 1, kind: NodeKind::Aspect, label: "ingress".into(), at: t },
            Op::SetArea { node: 1, area: Area::Salience, at: t + 1 },
        ];
        {
            let mut j = Journal::open(&jpath).unwrap();
            for op in &ops { j.append(op).unwrap(); }
        }
        let s = persist::load(None, &Journal::read_all(&jpath).unwrap()).unwrap();
        assert_eq!(s.nodes[&1].area, Area::Salience, "override must persist through the journal");
        assert!(s.nodes[&1].log.iter().any(|l| l.kind == "area_set"));

        let mut bad = StoreData::new();
        assert!(bad.apply(&Op::SetArea { node: 99, area: Area::Executive, at: t }).is_err());
    }

    #[test]
    fn snapshot_without_area_field_still_loads() {
        // nodes written before `area` existed must not break replay
        let legacy = serde_json::json!({
            "nodes": {"1": {
                "id": 1, "kind": "Aspect", "label": "old node",
                "facts": [], "log": [], "context": [],
                "created_at": now(), "deleted": false
            }},
            "edges": {}, "next_node": 2, "next_edge": 1, "next_fact": 1
        });
        let s: StoreData = serde_json::from_value(legacy).unwrap();
        assert_eq!(s.nodes[&1].area, Area::Semantic);
    }

    #[test]
    fn area_parse_round_trips() {
        for a in [Area::Episodic, Area::Semantic, Area::Procedural,
                  Area::Spatial, Area::Salience, Area::Executive] {
            assert_eq!(Area::parse(&format!("{a:?}")), Some(a));
        }
        assert_eq!(Area::parse("hippocampus"), None);
    }
}
