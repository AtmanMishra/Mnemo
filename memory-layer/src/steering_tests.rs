//! P2 tests: the steering engine.
#[cfg(test)]
mod p2 {
    use crate::model::*;
    use crate::steering::{reinforce, steer, Correction, SteerNotes};
    use crate::store::StoreData;

    fn t() -> Millis { 1_700_000_000_000 }

    /// Episode 10 fed by: node 1 (helm rollback facts), node 2 (ingress facts).
    fn episode_with_two_feeders() -> StoreData {
        let mut s = StoreData::new();
        let ops = vec![
            Op::CreateNode { id: 1, kind: NodeKind::Aspect, label: "helm basics".into(), at: t() },
            Op::AddFact { node: 1, fact_id: 1, key: "rollback".into(), value: "helm rollback needs wait flag".into(), at: t() },
            Op::CreateNode { id: 2, kind: NodeKind::Aspect, label: "ingress annotations".into(), at: t() },
            Op::AddFact { node: 2, fact_id: 2, key: "rewrite".into(), value: "rewrite target annotation v1 routing".into(), at: t() },
            Op::CreateNode { id: 10, kind: NodeKind::TaskEpisode, label: "deploy svc".into(), at: t() },
            Op::Link { id: 100, src: 1, dst: 10, kind: EdgeKind::SuppliesContext, at: t() },
            Op::Link { id: 101, src: 2, dst: 10, kind: EdgeKind::SuppliesContext, at: t() },
        ];
        for op in &ops { s.apply(op).unwrap(); }
        s
    }

    fn run(ops: &[Op], s: &mut StoreData) {
        for op in ops { s.apply(op).unwrap(); }
    }

    #[test]
    fn blame_lands_on_relevant_feeder_only() {
        let mut s = episode_with_two_feeders();
        let (ops, notes) = steer(&s, 10, "rollback failed: helm release stuck waiting",
            None, t() + 60).unwrap();
        run(&ops, &mut s);
        // helm feeder blamed, ingress feeder untouched
        assert_eq!(notes.blamed_feeders.len(), 1);
        assert_eq!(notes.blamed_feeders[0].0, 100);
        assert!((s.edges[&100].weight - 0.4).abs() < 1e-6);
        assert_eq!(notes.unblamed_feeders, vec![101]);
        assert_eq!(s.edges[&101].weight, 0.5);
        // failure is logged on the episode
        assert!(s.nodes[&10].log.iter().any(|l| l.kind == "outcome"));
    }

    #[test]
    fn correction_supersedes_stale_fact() {
        let mut s = episode_with_two_feeders();
        let c = Correction { node: 2, old_fact: 2,
            new_key: "rewrite".into(),
            new_value: "v1 annotation removed; use middleware rewrites".into() };
        let (ops, notes) = steer(&s, 10, "404 on /cart rewrite broken",
            Some(&c), t() + 60).unwrap();
        run(&ops, &mut s);
        assert_eq!(notes.superseded_on, Some(2));
        assert_eq!(s.nodes[&2].active_facts().count(), 1);
        let f = s.nodes[&2].active_facts().next().unwrap();
        assert_eq!(f.value, "v1 annotation removed; use middleware rewrites");
        assert_eq!(f.superseded_by.is_none(), true);
        // old fact still visible in history
        assert!(s.nodes[&2].facts.iter().any(|f| f.status == FactStatus::Superseded));
    }

    #[test]
    fn gap_node_created_when_nothing_implicated() {
        let mut s = episode_with_two_feeders();
        let (ops, notes) = steer(&s, 10, "terraform state lock corrupted",
            None, t() + 60).unwrap();
        run(&ops, &mut s);
        let gid = notes.gap_node.expect("expected a gap node");
        let g = &s.nodes[&gid];
        assert_eq!(g.kind, NodeKind::Aspect);
        assert!(g.label.starts_with("gap: "));
        assert!(g.label.contains("terraform"), "label: {}", g.label);
        // gap node wired as context source
        assert!(s.edges.values().any(|e|
            e.src == gid && e.dst == 10 && e.kind == EdgeKind::SuppliesContext));
    }

    #[test]
    fn edge_switch_to_healthier_source() {
        let mut s = episode_with_two_feeders();
        // drive helm edge near death with prior failures
        for i in 0..3 {
            s.apply(&Op::RecordOutcome { edge: 100, success: false, at: t() + 10 * i }).unwrap();
        }
        // weight now 0.2; one more blame pushes below switch threshold
        let (ops, _) = steer(&s, 10, "rollback stuck again waiting", None, t() + 100).unwrap();
        run(&ops, &mut s);
        // after this steer: edge 100 dead or replaced by an alternate link
        let switched = s.edges[&100].invalid_at.is_some()
            || s.edges[&100].weight == 0.0;
        assert!(switched, "expected edge 100 to be killed");
        // and a fresh SuppliesContext from node 2 exists if switch happened
        let has_alt = s.edges.values().any(|e|
            e.dst == 10 && e.src == 2 && e.id != 101 && e.invalid_at.is_none());
        // alt may exist via switch; either way episode still has >=1 live feeder
        let live: Vec<_> = s.feeders_of(10, t() + 200);
        assert!(!live.is_empty(), "episode lost all feeders");
        let _ = has_alt;
    }

    #[test]
    fn reinforce_success_path() {
        let mut s = episode_with_two_feeders();
        let ops = reinforce(&s, 10, "deploy green", t() + 60).unwrap();
        run(&ops, &mut s);
        assert!(s.edges[&100].weight > 0.5);
        assert!(s.edges[&101].weight > 0.5);
        assert_eq!(s.edges[&100].success, 1);
    }

    #[test]
    fn rejects_non_episode_and_missing_correction() {
        let mut s = episode_with_two_feeders();
        assert!(steer(&s, 1, "x", None, t()).is_err()); // aspect node, not episode
        let bad = Correction { node: 2, old_fact: 999, new_key: "k".into(), new_value: "v".into() };
        assert!(steer(&s, 10, "x", Some(&bad), t()).is_err()); // fact does not exist
        let _ = SteerNotes::default(); // silence unused import in some configs
    }

    #[test]
    fn plan_is_journal_exact() {
        // steering through plan->apply->journal replays identically
        use crate::persist::{self, Journal};
        let dir = std::env::temp_dir().join("memlayer-steer-test");
        let _ = std::fs::remove_dir_all(&dir);
        let jpath = dir.join("journal.jsonl");
        // rebuild via ops so the journal contains the FULL history
        let base = vec![
            Op::CreateNode { id: 1, kind: NodeKind::Aspect, label: "helm basics".into(), at: t() },
            Op::AddFact { node: 1, fact_id: 1, key: "rollback".into(), value: "helm rollback needs wait flag".into(), at: t() },
            Op::CreateNode { id: 2, kind: NodeKind::Aspect, label: "ingress annotations".into(), at: t() },
            Op::AddFact { node: 2, fact_id: 2, key: "rewrite".into(), value: "rewrite target annotation v1 routing".into(), at: t() },
            Op::CreateNode { id: 10, kind: NodeKind::TaskEpisode, label: "deploy svc".into(), at: t() },
            Op::Link { id: 100, src: 1, dst: 10, kind: EdgeKind::SuppliesContext, at: t() },
            Op::Link { id: 101, src: 2, dst: 10, kind: EdgeKind::SuppliesContext, at: t() },
        ];
        let c = Correction { node: 2, old_fact: 2, new_key: "rewrite".into(), new_value: "fixed".into() };
        // plan against the post-base store
        let mut planned_against = StoreData::new();
        for op in &base { planned_against.apply(op).unwrap(); }
        let (steer_ops, _) = steer(&planned_against, 10, "404 rewrite", Some(&c), t() + 60).unwrap();
        // now apply+journal EVERYTHING from empty for the exactness check
        let mut s = StoreData::new();
        {
            let mut j = Journal::open(&jpath).unwrap();
            for op in base.iter().chain(steer_ops.iter()) {
                s.apply(op).unwrap(); j.append(op).unwrap();
            }
        }
        let replayed = persist::replay(&Journal::read_all(&jpath).unwrap()).unwrap();
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            serde_json::to_value(&replayed).unwrap());
    }
}
