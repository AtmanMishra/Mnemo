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
        for q in ["path rewrite annotation broken", "helm rollback wait", "virtualenv python environment"] {
            let brute = search(&s, &vectors, &emb, q, 3, t(), &SearchOpts::default());
            let ann = crate::search::search_ann(&s, &index, &emb, q, 3, t(), &SearchOpts::default());
            // top-1 must agree; ANN is approximate so full order may vary
            assert_eq!(brute[0].node, ann[0].node,
                "query {q}: ann top1 {} != brute top1 {}", ann[0].node, brute[0].node);
        }
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
