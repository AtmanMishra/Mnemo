//! ML-1 tests: search-result LRU + state_of memoization.
#[cfg(test)]
mod lru_tests {
    use crate::cache::{normalize_query, SearchCache, SearchKey};
    use crate::model::*;

    fn key(q: &str, areas: &[Area], k: usize) -> SearchKey {
        SearchKey { query: normalize_query(q), areas: areas.to_vec(), k }
    }

    #[test]
    fn lru_evicts_least_recently_used() {
        let mut c = SearchCache::new(2);
        c.put(key("a", &[], 1), "A");
        c.put(key("b", &[], 1), "B");
        c.put(key("c", &[], 1), "C"); // evicts "a"
        assert_eq!(c.get(&key("a", &[], 1)), None);
        assert_eq!(c.get(&key("b", &[], 1)), Some(&"B"));
        assert_eq!(c.get(&key("c", &[], 1)), Some(&"C"));
        assert_eq!(c.len(), 2);
    }

    #[test]
    fn get_touches_recency() {
        let mut c = SearchCache::new(2);
        c.put(key("a", &[], 1), "A");
        c.put(key("b", &[], 1), "B");
        c.get(&key("a", &[], 1)); // "a" is now most recent
        c.put(key("c", &[], 1), "C"); // evicts "b", keeps "a"
        assert_eq!(c.get(&key("b", &[], 1)), None);
        assert_eq!(c.get(&key("a", &[], 1)), Some(&"A"));
    }

    #[test]
    fn put_refreshes_existing_key_without_growing() {
        let mut c = SearchCache::new(2);
        c.put(key("a", &[], 1), "A1");
        c.put(key("b", &[], 1), "B");
        c.put(key("a", &[], 1), "A2"); // refresh moves to front, no growth
        assert_eq!(c.len(), 2);
        c.put(key("c", &[], 1), "C"); // evicts "b", keeps refreshed "a"
        assert_eq!(c.get(&key("a", &[], 1)), Some(&"A2"));
        assert_eq!(c.get(&key("b", &[], 1)), None);
        assert_eq!(c.get(&key("c", &[], 1)), Some(&"C"));
    }

    #[test]
    fn retain_drops_only_matching_entries() {
        let mut c = SearchCache::new(8);
        c.put(key("a", &[], 1), vec![1u64]);
        c.put(key("b", &[], 1), vec![2u64]);
        c.put(key("c", &[], 1), vec![1u64, 3u64]);
        c.retain(|ids| !ids.contains(&1)); // invalidate keys touching node 1
        assert_eq!(c.get(&key("a", &[], 1)), None);
        assert_eq!(c.get(&key("b", &[], 1)), Some(&vec![2u64]));
        assert_eq!(c.get(&key("c", &[], 1)), None);
        assert_eq!(c.len(), 1);
    }

    #[test]
    fn touched_nodes_maps_every_op_variant() {
        // cddd21c0: edge-only ops resolve their endpoints through the store,
        // because they change via_graph scores that cached hits carry.
        use crate::cache::touched_nodes;
        use crate::store::StoreData;
        let t = 1_700_000_000_000u64;
        let mut s = StoreData::new();
        s.apply(&Op::CreateNode { id: 7, kind: NodeKind::Aspect, label: "x".into(), at: t }).unwrap();
        s.apply(&Op::CreateNode { id: 8, kind: NodeKind::TaskEpisode, label: "y".into(), at: t }).unwrap();
        s.apply(&Op::Link { id: 9, src: 7, dst: 8, kind: EdgeKind::SuppliesContext, at: t }).unwrap();

        assert_eq!(touched_nodes(&s, &Op::CreateNode { id: 7, kind: NodeKind::Aspect, label: "x".into(), at: t }), vec![7]);
        assert_eq!(touched_nodes(&s, &Op::AddFact { node: 7, fact_id: 1, key: "k".into(), value: "v".into(), at: t }), vec![7]);
        assert_eq!(touched_nodes(&s, &Op::SupersedeFact { node: 7, old_fact: 1, new_key: "k".into(), new_value: "v".into(), new_fact_id: 2, at: t }), vec![7]);
        assert_eq!(touched_nodes(&s, &Op::SetArea { node: 7, area: Area::Salience, at: t }), vec![7]);
        assert_eq!(touched_nodes(&s, &Op::DeleteNode { node: 7, hard: false, at: t }), vec![7]);
        let mut both = touched_nodes(&s, &Op::Link { id: 10, src: 7, dst: 8, kind: EdgeKind::PartOf, at: t });
        both.sort();
        assert_eq!(both, vec![7, 8]);
        // edge-only ops now map to BOTH endpoints (resolved via the store)
        let mut ends = touched_nodes(&s, &Op::Unlink { edge: 9, at: t });
        ends.sort();
        assert_eq!(ends, vec![7, 8], "Unlink changes via_graph scores of both endpoints");
        let mut ends = touched_nodes(&s, &Op::Reweight { edge: 9, delta: 0.1, at: t });
        ends.sort();
        assert_eq!(ends, vec![7, 8], "Reweight changes via_graph scores of both endpoints");
        let mut ends = touched_nodes(&s, &Op::RecordOutcome { edge: 9, success: true, at: t });
        ends.sort();
        assert_eq!(ends, vec![7, 8], "RecordOutcome nudges edge weight -> both endpoints");
        // unknown edge id degrades to no invalidation, not an error
        assert_eq!(touched_nodes(&s, &Op::Unlink { edge: 999, at: t }), Vec::<u64>::new());
        assert_eq!(touched_nodes(&s, &Op::PushContext { to: 7, chunk: ContextChunk { from: 8, dim: 4, vec: vec![], note: "n".into() }, at: t }), vec![7]);
        assert_eq!(touched_nodes(&s, &Op::CommitLog { node: 7, kind: "k".into(), detail: "d".into(), at: t }), vec![7]);
        assert_eq!(touched_nodes(&s, &Op::RecordUsefulness { node: 7, useful: true, at: t }), vec![7]);
    }

    #[test]
    fn normalization_collapses_case_and_whitespace() {
        assert_eq!(normalize_query("  Helm  Rollback "), "helm rollback");
        assert_eq!(normalize_query("Helm Rollback"), "helm rollback");
        // meaningfully different queries are different keys
        assert_ne!(normalize_query("helm rollback"), normalize_query("helm rollback wait"));
    }

    #[test]
    fn key_distinguishes_areas_and_k() {
        assert_ne!(key("q", &[], 1), key("q", &[Area::Salience], 1));
        assert_ne!(key("q", &[], 1), key("q", &[], 2));
        assert_ne!(key("q", &[Area::Salience], 2), key("q", &[Area::Semantic], 2));
        // same normalized inputs -> same key
        assert_eq!(key("Q", &[Area::Salience], 2), key("q", &[Area::Salience], 2));
    }
}

#[cfg(test)]
mod state_memo_tests {
    use crate::model::*;
    use crate::store::StoreData;

    fn t() -> Millis { 1_700_000_000_000 }

    fn base() -> StoreData {
        let mut s = StoreData::new();
        s.apply(&Op::CreateNode { id: 1, kind: NodeKind::Aspect, label: "ingress".into(), at: t() }).unwrap();
        s.apply(&Op::AddFact { node: 1, fact_id: 1, key: "rewrite".into(),
            value: "nginx rewrite-target annotation".into(), at: t() }).unwrap();
        s
    }

    #[test]
    fn repeated_state_of_returns_identical_text() {
        let mut s = base();
        assert_eq!(s.state_of(1).unwrap(), s.state_of(1).unwrap());
    }

    #[test]
    fn journal_op_touching_node_invalidates_memo() {
        let mut s = base();
        let before = s.state_of(1).unwrap();
        assert!(before.contains("nginx rewrite-target"));

        // AddFact must be visible on the next read
        s.apply(&Op::AddFact { node: 1, fact_id: 2, key: "tls".into(),
            value: "cert-manager".into(), at: t() + 1 }).unwrap();
        let after = s.state_of(1).unwrap();
        assert!(after.contains("cert-manager"));
        assert_ne!(before, after, "a stale memo would return the old snapshot");

        // SetArea
        s.apply(&Op::SetArea { node: 1, area: Area::Salience, at: t() + 2 }).unwrap();
        assert!(s.state_of(1).unwrap().contains("Salience"));

        // CommitLog
        s.apply(&Op::CommitLog { node: 1, kind: "outcome".into(),
            detail: "rewritten path 404'd".into(), at: t() + 3 }).unwrap();
        assert!(s.state_of(1).unwrap().contains("rewritten path 404'd"));

        // PushContext
        s.apply(&Op::PushContext { to: 1, chunk: ContextChunk { from: 2, dim: 4,
            vec: vec![], note: "ingress summary".into() }, at: t() + 4 }).unwrap();
        assert!(s.state_of(1).unwrap().contains("ingress summary"));
    }

    #[test]
    fn supersede_invalidates_the_memo_too() {
        // #24: superseding moves a value OUT of the facts block, so a memo left
        // warm from before the write would keep handing the model the value it
        // just replaced — the exact staleness the issue is about, one layer up.
        let mut s = base();
        let before = s.state_of(1).unwrap();
        assert!(before.contains("nginx rewrite-target annotation"));

        s.apply(&Op::SupersedeFact { node: 1, old_fact: 1,
            new_key: "rewrite".into(), new_value: "middleware path rewrites only".into(),
            new_fact_id: 2, at: t() + 5 }).unwrap();
        let after = s.state_of(1).unwrap();

        assert!(after.contains("middleware path rewrites only"), "{after}");
        assert!(!after.contains("nginx rewrite-target annotation"),
            "the retired value must leave the rendered state: {after}");
        assert!(after.contains("1 retired value"), "{after}");
    }

    #[test]
    fn edge_only_ops_do_not_invalidate_state() {
        // state_of reads facts/log/context only; edge rows are not part of
        // the derived text, so Link/unlink/reweight must leave it identical.
        let mut s = base();
        s.apply(&Op::CreateNode { id: 2, kind: NodeKind::TaskEpisode,
            label: "episode".into(), at: t() }).unwrap();
        let before = s.state_of(1).unwrap();
        s.apply(&Op::Link { id: 10, src: 1, dst: 2, kind: EdgeKind::SuppliesContext, at: t() }).unwrap();
        s.apply(&Op::RecordOutcome { edge: 10, success: true, at: t() + 1 }).unwrap();
        s.apply(&Op::Reweight { edge: 10, delta: 0.1, at: t() + 2 }).unwrap();
        assert_eq!(s.state_of(1).unwrap(), before,
            "edge-only ops must not change a node's derived state");
    }

    #[test]
    fn memo_never_leaks_into_snapshots_or_replay() {
        let mut s = base();
        s.state_of(1).unwrap(); // warm the memo
        let v = serde_json::to_value(&s).unwrap();
        assert!(v.get("state_memo").is_none(), "memo is derived scratch state, not data");
        let mut back: StoreData = serde_json::from_value(v).unwrap();
        assert!(back.state_memo.is_empty());
        // and the memoized read still works after the round-trip
        assert!(back.state_of(1).unwrap().contains("nginx rewrite-target"));
    }
}