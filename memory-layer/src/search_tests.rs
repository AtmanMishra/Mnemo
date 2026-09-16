//! P1 tests: vector search, cluster expansion, embedding determinism.
#[cfg(test)]
mod p1 {
    use crate::model::*;
    use crate::search::{build_vectors, route_query, search, SearchOpts};
    use crate::store::StoreData;
    use crate::vec::{cosine, Embedder, HashingEmbedder};

    fn t() -> Millis { 1_700_000_000_000 }

    fn k8s_ops(t: Millis) -> Vec<Op> {
        vec![
            Op::CreateNode { id: 1, kind: NodeKind::Aspect, label: "ingress annotations".into(), at: t },
            Op::AddFact { node: 1, fact_id: 1, key: "rewrite".into(),
                value: "nginx rewrite-target annotation routes paths".into(), at: t },
            Op::CreateNode { id: 2, kind: NodeKind::Aspect, label: "helm rollback".into(), at: t },
            Op::AddFact { node: 2, fact_id: 2, key: "rollback".into(),
                value: "helm rollback revision needs --wait flag".into(), at: t },
            Op::CreateNode { id: 3, kind: NodeKind::Aspect, label: "python venv setup".into(), at: t },
            Op::AddFact { node: 3, fact_id: 3, key: "venv".into(),
                value: "create virtualenv with python3 -m venv".into(), at: t },
            Op::Link { id: 10, src: 1, dst: 2, kind: EdgeKind::PartOf, at: t }, // same domain cluster
        ]
    }

    fn store_with(extra: &[Op]) -> StoreData {
        let mut s = StoreData::new();
        for op in k8s_ops(t()).iter().chain(extra.iter()) {
            s.apply(op).unwrap();
        }
        s
    }

    #[test]
    fn embedder_is_deterministic_and_normalized() {
        let e = HashingEmbedder;
        let a = e.embed("helm rollback revision");
        let b = e.embed("helm rollback revision");
        assert_eq!(a, b);
        let n: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((n - 1.0).abs() < 1e-4);
    }

    #[test]
    fn search_finds_relevant_aspect_not_unrelated() {
        let s = store_with(&[]);
        let emb = HashingEmbedder;
        let vectors = build_vectors(&s, &emb);
        // query about broken path routing should hit ingress node first
        let r = search(&s, &vectors, &emb, "path rewrite annotation broken", 5, t(), &SearchOpts::default());
        assert!(!r.is_empty());
        assert_eq!(r[0].node, 1, "expected ingress node top, got {:?}", r.iter().map(|x| (x.node, x.score)).collect::<Vec<_>>());
        // unrelated query hits python node
        let r2 = search(&s, &vectors, &emb, "virtualenv python environment", 5, t(), &SearchOpts::default());
        assert_eq!(r2[0].node, 3, "expected venv node top, got {:?}", r2.iter().map(|x| x.node).collect::<Vec<_>>());
    }

    #[test]
    fn cluster_expansion_pulls_graph_neighbors() {
        let s = store_with(&[]);
        let emb = HashingEmbedder;
        let vectors = build_vectors(&s, &emb);
        // query about helm rollback: node 2 is direct hit; its PartOf neighbor 1
        // should appear via graph even though it talks about ingress
        let r = search(&s, &vectors, &emb, "helm rollback wait", 5, t(), &SearchOpts::default());
        assert_eq!(r[0].node, 2);
        assert!(r.iter().any(|x| x.node == 1 && x.via_graph), "cluster neighbor not expanded: {:?}", r);
    }

    #[test]
    fn dead_edge_stops_expansion() {
        let s = store_with(&[Op::Unlink { edge: 10, at: t() + 100 }]);
        let emb = HashingEmbedder;
        let vectors = build_vectors(&s, &emb);
        let now = t() + 200;
        let r = search(&s, &vectors, &emb, "helm rollback wait", 5, now, &SearchOpts::default());
        assert_eq!(r[0].node, 2);
        assert!(!r.iter().any(|x| x.node == 1 && x.via_graph),
            "dead edge must not propagate: {:?}", r);
    }

    #[test]
    fn type_filter_narrows_hits() {
        let s = store_with(&[Op::CreateNode { id: 9, kind: NodeKind::TaskEpisode,
            label: "debugged nginx rewrite annotation issue".into(), at: t() }]);
        let emb = HashingEmbedder;
        let vectors = build_vectors(&s, &emb);
        let r = search(&s, &vectors, &emb, "nginx rewrite annotation", 5, t(),
            &SearchOpts::kind(NodeKind::TaskEpisode));
        assert!(r.iter().all(|x| s.nodes[&x.node].kind == NodeKind::TaskEpisode));
        assert_eq!(r[0].node, 9);
    }

    #[test]
    fn superseded_fact_leaves_embedding_text() {
        // after supersede, old value must NOT influence the node vector
        let s = store_with(&[Op::SupersedeFact { node: 1, old_fact: 1,
            new_key: "rewrite".into(), new_value: "middleware path rewrites only".into(),
            new_fact_id: 99, at: t() + 50 }]);
        let emb = HashingEmbedder;
        let before = emb.embed("nginx rewrite-target annotation routes paths");
        let vectors = build_vectors(&s, &emb);
        let nv = &vectors[&1];
        assert!(cosine(&before, nv) < 0.999, "old fact text still dominates vector");
        assert!(nv.iter().any(|&x| x != 0.0));
    }

    #[test]
    fn hnsw_ann_matches_brute_on_seeds() {
        use crate::ann::AnnIndex;
        let s = store_with(&[]);
        let emb = HashingEmbedder;
        let vectors = build_vectors(&s, &emb);
        let index = AnnIndex::build(&vectors.iter().map(|(k, v)| (*k as u64, v.clone())).collect());
        let queries = ["path rewrite annotation broken", "helm rollback wait", "virtualenv python environment"];
        let mut agreed = 0;
        for q in queries {
            let brute = search(&s, &vectors, &emb, q, 3, t(), &SearchOpts::default());
            let ann = crate::search::search_ann(&s, &index, &emb, q, 3, t(), &SearchOpts::default());
            // Issue #12: this used to assert `brute[0].node == ann[0].node` for
            // every query. Approximate search does not promise that — it
            // promises to be *close* — so the test failed whenever the graph
            // walk happened to order two near-tied neighbours the other way
            // (it did, once, in CI, and passed either side). Asserting the
            // quality bound instead: the ANN top hit must always be one the
            // exact search would also have surfaced, and it must be the SAME
            // first hit for most queries. Both numbers are pinned; a real
            // regression in the graph still fails here.
            if brute[0].node == ann[0].node {
                agreed += 1;
            }
            assert!(
                brute.iter().any(|h| h.node == ann[0].node),
                "query {q}: ann top1 {} is not in brute-force top3 {:?}",
                ann[0].node,
                brute.iter().map(|h| h.node).collect::<Vec<_>>()
            );
        }
        assert!(
            agreed * 3 >= queries.len() * 2,
            "ANN top-1 must agree with brute force on at least two thirds of queries, agreed on {agreed}/{}",
            queries.len()
        );
    }

    #[test]
    fn area_filter_narrows_hits() {
        // same text, different areas: the filter must pick the right one
        let s = store_with(&[
            Op::CreateNode { id: 20, kind: NodeKind::Aspect, label: "helm rollback pain".into(), at: t() },
            Op::SetArea { node: 20, area: Area::Salience, at: t() + 1 },
        ]);
        let emb = HashingEmbedder;
        let vectors = build_vectors(&s, &emb);

        let all = search(&s, &vectors, &emb, "helm rollback", 5, t() + 2, &SearchOpts::default());
        assert!(all.len() > 1, "unfiltered search should see both areas");

        let only = search(&s, &vectors, &emb, "helm rollback", 5, t() + 2,
            &SearchOpts::areas(vec![Area::Salience]));
        assert!(!only.is_empty(), "salience node must still be reachable");
        assert!(only.iter().all(|r| s.nodes[&r.node].area == Area::Salience),
            "area filter leaked other areas: {only:?}");
    }

    #[test]
    fn router_maps_keywords_to_areas() {
        assert_eq!(route_query("the deploy failed with a 500 error")[0], Area::Salience);
        assert_eq!(route_query("how to run the lint harness")[0], Area::Procedural);
        assert_eq!(route_query("which repo holds the checkout service")[0], Area::Spatial);
        assert_eq!(route_query("what did we do last time we deployed")[0], Area::Episodic);
        assert_eq!(route_query("what is a rewrite-target annotation")[0], Area::Semantic);
        assert_eq!(route_query("plan the migration strategy")[0], Area::Executive);
        // no cue words -> no routing, search everywhere
        assert!(route_query("nginx ingress").is_empty());
        // never guesses more than two areas
        assert!(route_query("plan how to fix the failed build in the repo last time").len() <= 2);
    }

    #[test]
    fn preferred_area_wins_ties_without_excluding_others() {
        // two near-identical nodes, one Procedural, one Semantic
        let s = store_with(&[
            Op::CreateNode { id: 30, kind: NodeKind::Aspect, label: "helm rollback runbook".into(), at: t() },
            Op::SetArea { node: 30, area: Area::Procedural, at: t() + 1 },
        ]);
        let emb = HashingEmbedder;
        let vectors = build_vectors(&s, &emb);
        let now = t() + 2;

        let neutral = search(&s, &vectors, &emb, "helm rollback", 5, now, &SearchOpts::default());
        let score_of = |r: &Vec<crate::search::SearchResult>, id| {
            r.iter().find(|x| x.node == id).map(|x| x.score)
        };
        let base = score_of(&neutral, 2).expect("semantic node must be found");

        let routed = search(&s, &vectors, &emb, "helm rollback", 5, now,
            &SearchOpts::default().prefer(vec![Area::Procedural]));
        // the out-of-area node is still returned, just discounted
        let discounted = score_of(&routed, 2).expect("cross-area nodes must NOT be excluded");
        assert!(discounted < base, "preference must discount out-of-area nodes");
        assert!((discounted - base * crate::search::CROSS_AREA_DISCOUNT).abs() < 1e-4);
        assert_eq!(score_of(&routed, 30), score_of(&neutral, 30),
            "in-area nodes keep their full score");
    }

    #[test]
    fn misrouted_query_still_finds_the_right_node() {
        // router guesses Salience; nothing lives there. A hard filter would
        // return nothing — the discount must leave ranking intact instead.
        let s = store_with(&[]);
        let emb = HashingEmbedder;
        let vectors = build_vectors(&s, &emb);
        let opts = SearchOpts::default().prefer(vec![Area::Salience]);
        let r = search(&s, &vectors, &emb, "helm rollback wait", 5, t(), &opts);
        assert!(!r.is_empty(), "mis-routed query must not come back empty");
        assert_eq!(r[0].node, 2, "ranking must survive a wrong route");
    }

    #[test]
    fn filters_survive_graph_expansion() {
        // node 1 and 2 are linked, so a hit on one pulls the other in. A kind
        // or area filter must still hold for the expanded neighbour.
        let s = store_with(&[
            Op::CreateNode { id: 40, kind: NodeKind::TaskEpisode, label: "deploy run".into(), at: t() },
            Op::Link { id: 50, src: 2, dst: 40, kind: EdgeKind::SuppliesContext, at: t() },
            Op::SetArea { node: 2, area: Area::Salience, at: t() },
        ]);
        let emb = HashingEmbedder;
        let vectors = build_vectors(&s, &emb);
        let now = t() + 10;

        let r = search(&s, &vectors, &emb, "helm rollback", 5, now,
            &SearchOpts::areas(vec![Area::Salience]));
        assert!(!r.is_empty());
        assert!(r.iter().all(|x| s.nodes[&x.node].area == Area::Salience),
            "area filter leaked through expansion: {:?}",
            r.iter().map(|x| (x.node, s.nodes[&x.node].area)).collect::<Vec<_>>());

        let r = search(&s, &vectors, &emb, "helm rollback", 5, now,
            &SearchOpts::kind(NodeKind::Aspect));
        assert!(r.iter().all(|x| s.nodes[&x.node].kind == NodeKind::Aspect),
            "kind filter leaked through expansion: {r:?}");
    }
}

/// ML-2: retrieval-usefulness votes feed a small bias into the retrieval
/// score (two counters, one multiplier — NOT a learning-to-rank system).
#[cfg(test)]
mod p5_feedback {
    use crate::model::*;
    use crate::search::{build_vectors, search, USEFULNESS_BIAS, SearchOpts};
    use crate::store::StoreData;
    use crate::vec::HashingEmbedder;

    fn t() -> Millis { 1_700_000_000_000 }

    /// Two nodes with IDENTICAL text (their vectors are byte-equal, so raw
    /// cosine scores are exactly equal — a true tie) + a clearly unrelated
    /// node.
    fn near_tie_store() -> (StoreData, NodeId, NodeId, NodeId) {
        let mut s = StoreData::new();
        s.apply(&Op::CreateNode { id: 1, kind: NodeKind::Aspect,
            label: "rollback runbook".into(), at: t() }).unwrap();
        s.apply(&Op::AddFact { node: 1, fact_id: 1, key: "notes".into(),
            value: "helm rollback release notes".into(), at: t() }).unwrap();
        s.apply(&Op::CreateNode { id: 2, kind: NodeKind::Aspect,
            label: "rollback runbook".into(), at: t() }).unwrap();
        s.apply(&Op::AddFact { node: 2, fact_id: 2, key: "notes".into(),
            value: "helm rollback release notes".into(), at: t() }).unwrap();
        s.apply(&Op::CreateNode { id: 3, kind: NodeKind::Aspect,
            label: "python venv setup".into(), at: t() }).unwrap();
        s.apply(&Op::AddFact { node: 3, fact_id: 3, key: "venv".into(),
            value: "create virtualenv with python3".into(), at: t() }).unwrap();
        (s, 1, 2, 3)
    }

    fn search_top2(s: &StoreData, query: &str) -> (f32, f32) {
        let emb = HashingEmbedder;
        let vectors = build_vectors(s, &emb);
        let r = search(s, &vectors, &emb, query, 5, t() + 1, &SearchOpts::default());
        let a = r.iter().find(|x| x.node == 1).map(|x| x.score).unwrap_or(0.0);
        let b = r.iter().find(|x| x.node == 2).map(|x| x.score).unwrap_or(0.0);
        (a, b)
    }

    #[test]
    fn zero_votes_leave_retrieval_exactly_unchanged() {
        let (s, ..) = near_tie_store();
        let (a, b) = search_top2(&s, "helm rollback release");
        assert!((a - b).abs() < 1e-6, "no votes -> no bias: {a} vs {b}");
    }

    #[test]
    fn useful_votes_break_a_near_tie_toward_the_voted_node() {
        let (mut s, a, b, _) = near_tie_store();
        for i in 0..5u32 {
            s.apply(&Op::RecordUsefulness { node: a, useful: true, at: t() + 10 + i as u64 }).unwrap();
        }
        let (sa, sb) = search_top2(&s, "helm rollback release");
        assert!(sa > sb, "voted node must win the tie: {sa} vs {sb}");
        assert!((sa - sb - 5.0 * USEFULNESS_BIAS).abs() < 1e-4,
            "bias must be exactly (useful - unhelpful) * multiplier: {sa} vs {sb}");
    }

    #[test]
    fn unhelpful_votes_push_a_near_tie_down() {
        let (mut s, a, b, _) = near_tie_store();
        for i in 0..5u32 {
            s.apply(&Op::RecordUsefulness { node: b, useful: false, at: t() + 10 + i as u64 }).unwrap();
        }
        let (sa, sb) = search_top2(&s, "helm rollback release");
        assert!(sa > sb, "voted-down node must lose the tie: {sa} vs {sb}");
    }

    #[test]
    fn a_handful_of_votes_cannot_hijack_a_clear_winner() {
        let (mut s, a, _, _) = near_tie_store();
        // vote the UNRELATED node useful a few times: it gains bias but the
        // genuine match must still win
        s.apply(&Op::RecordUsefulness { node: 3, useful: true, at: t() + 10 }).unwrap();
        s.apply(&Op::RecordUsefulness { node: 3, useful: true, at: t() + 11 }).unwrap();
        let emb = HashingEmbedder;
        let vectors = build_vectors(&s, &emb);
        let r = search(&s, &vectors, &emb, "helm rollback release", 5, t() + 12, &SearchOpts::default());
        assert!(r[0].node == a || r[0].node == 2,
            "a couple of votes on junk must not outrank the real match: {r:?}");
    }

    #[test]
    fn votes_are_journaled_and_replay_exact() {
        let (mut s, a, b, _) = near_tie_store();
        s.apply(&Op::RecordUsefulness { node: a, useful: true, at: t() + 10 }).unwrap();
        s.apply(&Op::RecordUsefulness { node: b, useful: false, at: t() + 11 }).unwrap();
        // a fresh store replaying the same ops reaches identical counters
        let mut s2 = StoreData::new();
        let ops: Vec<Op> = vec![
            Op::CreateNode { id: 1, kind: NodeKind::Aspect, label: "rollback runbook".into(), at: t() },
            Op::CreateNode { id: 2, kind: NodeKind::Aspect, label: "rollback runbook".into(), at: t() },
            Op::RecordUsefulness { node: 1, useful: true, at: t() + 10 },
            Op::RecordUsefulness { node: 2, useful: false, at: t() + 11 },
        ];
        for op in &ops { s2.apply(op).unwrap(); }
        assert_eq!(s2.nodes[&1].useful, s.nodes[&a].useful);
        assert_eq!(s2.nodes[&2].unhelpful, s.nodes[&b].unhelpful);
        // votes must NEVER touch the node log: node_text embeds the last-3
        // log entries, and vote noise would dilute the very content the
        // vote rewards (this was a real bug found by the crafted corpus)
        assert!(!s2.nodes[&1].log.iter().any(|l| l.kind == "useful"));
        // the counters are model-visible through state text instead
        let st = s2.state_of(1).unwrap();
        assert!(st.contains("usefulness votes: 1 useful / 0 unhelpful"));
    }
}
