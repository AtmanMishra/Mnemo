//! 3.5: consolidation (Episodic/Salience replay -> Semantic lessons).
#[cfg(test)]
mod p3 {
    use crate::consolidate::{
        consolidate, min_sources_from, min_sources_for_theme, Lesson,
        DEFAULT_MIN_SOURCES_FOR_THEME,
    };
    use crate::model::*;
    use crate::steering::steer;
    use crate::store::StoreData;

    fn t() -> Millis { 1_700_000_000_000 }

    /// Two episodes that both failed on the same helm rollback theme.
    fn store_with_repeated_failures() -> StoreData {
        let mut s = StoreData::new();
        for (id, label) in [(1u64, "deploy checkout"), (2, "deploy cart")] {
            s.apply(&Op::CreateNode { id, kind: NodeKind::TaskEpisode,
                label: label.into(), at: t() }).unwrap();
        }
        for (i, (ep, detail)) in [
            (1u64, "helm rollback timed out on checkout"),
            (2, "helm rollback timed out on cart"),
        ].iter().enumerate() {
            let (ops, _) = steer(&s, *ep, detail, None, t() + 10 + i as u64).unwrap();
            for op in &ops { s.apply(op).unwrap(); }
        }
        s
    }

    fn apply_all(s: &mut StoreData, ops: &[Op]) {
        for op in ops { s.apply(op).unwrap(); }
    }

    #[test]
    fn recurring_theme_becomes_a_semantic_lesson() {
        let mut s = store_with_repeated_failures();
        let (ops, lessons) = consolidate(&s, t() + 100);
        assert!(!lessons.is_empty(), "two failures on one theme must distil a lesson");
        apply_all(&mut s, &ops);

        let lesson: &Lesson = &lessons[0];
        let node = s.nodes.get(&lesson.node.unwrap()).unwrap();
        assert_eq!(node.area, Area::Semantic, "lessons live in the semantic area");
        assert!(node.label.starts_with("lesson: "));
        assert!(node.label.contains("helm") || node.label.contains("rollback"),
            "lesson should name the shared theme, got {}", node.label);
        assert!(lesson.occurrences >= min_sources_for_theme());
        // the distilled fact points back at the evidence
        let sources = node.active_facts().find(|f| f.key == "sources").unwrap();
        for src in &lesson.sources {
            assert!(sources.value.contains(&format!("#{src}")));
        }
    }

    #[test]
    fn consolidation_is_idempotent() {
        let mut s = store_with_repeated_failures();
        let (ops, _) = consolidate(&s, t() + 100);
        apply_all(&mut s, &ops);
        let after_first = s.nodes.len();

        let (ops2, lessons2) = consolidate(&s, t() + 200);
        assert!(ops2.is_empty(), "second pass must emit nothing, got {ops2:?}");
        assert!(!lessons2.is_empty(), "but it still reports the standing lessons");
        apply_all(&mut s, &ops2);
        assert_eq!(s.nodes.len(), after_first, "no duplicate lesson nodes");
    }

    #[test]
    fn new_evidence_supersedes_the_old_lesson_fact() {
        let mut s = store_with_repeated_failures();
        let (ops, _) = consolidate(&s, t() + 100);
        apply_all(&mut s, &ops);
        let lesson_id = s.nodes.values()
            .find(|n| n.label.starts_with("lesson: ")).unwrap().id;

        // a third failure on the same theme
        s.apply(&Op::CreateNode { id: 90, kind: NodeKind::TaskEpisode,
            label: "deploy payments".into(), at: t() + 150 }).unwrap();
        let (sops, _) = steer(&s, 90, "helm rollback timed out on payments", None, t() + 160).unwrap();
        apply_all(&mut s, &sops);

        let (ops2, lessons2) = consolidate(&s, t() + 200);
        assert!(!ops2.is_empty(), "new evidence must update the lesson");
        apply_all(&mut s, &ops2);
        let node = &s.nodes[&lesson_id];
        assert_eq!(node.active_facts().filter(|f| f.key == "sources").count(), 1,
            "exactly one active sources fact after supersede");
        assert!(node.facts.iter().any(|f| f.status == FactStatus::Superseded));
        assert_eq!(lessons2.iter().find(|l| l.node == Some(lesson_id)).unwrap().occurrences, 3);
    }

    #[test]
    fn one_off_failures_are_not_consolidated() {
        let mut s = StoreData::new();
        s.apply(&Op::CreateNode { id: 1, kind: NodeKind::TaskEpisode,
            label: "deploy checkout".into(), at: t() }).unwrap();
        let (ops, _) = steer(&s, 1, "helm rollback timed out".into(), None, t() + 10).unwrap();
        apply_all(&mut s, &ops);
        let (ops2, lessons) = consolidate(&s, t() + 100);
        assert!(lessons.is_empty() && ops2.is_empty(),
            "a single episode is not a pattern: {lessons:?}");
    }

    #[test]
    fn semantic_nodes_are_not_replayed_into_themselves() {
        // aspects already hold distilled knowledge; only lived experience
        // (Episodic/Salience) feeds consolidation
        let mut s = StoreData::new();
        for id in 1u64..=3 {
            s.apply(&Op::CreateNode { id, kind: NodeKind::Aspect,
                label: "helm rollback wait flag".into(), at: t() }).unwrap();
        }
        let (ops, lessons) = consolidate(&s, t() + 100);
        assert!(ops.is_empty() && lessons.is_empty(),
            "semantic nodes must not be re-consolidated: {lessons:?}");
    }

    #[test]
    fn min_sources_override_parses_or_falls_back() {
        // The process-wide value (min_sources_for_theme) is cached on first
        // use, so what is pinned here is the parse: any positive integer
        // wins, everything else keeps the default — a mistyped override must
        // not disable every lesson.
        assert_eq!(min_sources_from(None), DEFAULT_MIN_SOURCES_FOR_THEME);
        assert_eq!(min_sources_from(Some(" 4 ")), 4);
        assert_eq!(min_sources_from(Some("0")), DEFAULT_MIN_SOURCES_FOR_THEME);
        assert_eq!(min_sources_from(Some("junk")), DEFAULT_MIN_SOURCES_FOR_THEME);
        assert_eq!(min_sources_from(Some("")), DEFAULT_MIN_SOURCES_FOR_THEME);
        assert_eq!(min_sources_for_theme(),
            min_sources_from(std::env::var("MNEMO_MIN_OCCURRENCES").ok().as_deref()),
            "the process value must agree with the parser for this environment");
    }
}
