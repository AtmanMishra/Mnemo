//! P1 tests: vector search, cluster expansion, embedding determinism.
#[cfg(test)]
mod p1 {
    use crate::model::*;
    use crate::search::{build_vectors, search};
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
        let r = search(&s, &vectors, &emb, "path rewrite annotation broken", 5, t(), None);
        assert!(!r.is_empty());
        assert_eq!(r[0].node, 1, "expected ingress node top, got {:?}", r.iter().map(|x| (x.node, x.score)).collect::<Vec<_>>());
        // unrelated query hits python node
        let r2 = search(&s, &vectors, &emb, "virtualenv python environment", 5, t(), None);
        assert_eq!(r2[0].node, 3, "expected venv node top, got {:?}", r2.iter().map(|x| x.node).collect::<Vec<_>>());
    }

    #[test]
    fn cluster_expansion_pulls_graph_neighbors() {
        let s = store_with(&[]);
        let emb = HashingEmbedder;
        let vectors = build_vectors(&s, &emb);
        // query about helm rollback: node 2 is direct hit; its PartOf neighbor 1
        // should appear via graph even though it talks about ingress
        let r = search(&s, &vectors, &emb, "helm rollback wait", 5, t(), None);
        assert_eq!(r[0].node, 2);
        assert!(r.iter().any(|x| x.node == 1 && x.via_graph), "cluster neighbor not expanded: {:?}", r);
    }

    #[test]
    fn dead_edge_stops_expansion() {
        let s = store_with(&[Op::Unlink { edge: 10, at: t() + 100 }]);
        let emb = HashingEmbedder;
        let vectors = build_vectors(&s, &emb);
        let now = t() + 200;
        let r = search(&s, &vectors, &emb, "helm rollback wait", 5, now, None);
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
            Some(NodeKind::TaskEpisode));
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
            let brute = search(&s, &vectors, &emb, q, 3, t(), None);
            let ann = crate::search::search_ann(&s, &index, &emb, q, 3, t(), None);
            // top-1 must agree; ANN is approximate so full order may vary
            assert_eq!(brute[0].node, ann[0].node,
                "query {q}: ann top1 {} != brute top1 {}", ann[0].node, brute[0].node);
        }
    }
}
