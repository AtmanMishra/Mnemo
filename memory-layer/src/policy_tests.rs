//! 7.3: does the journal contain enough signal to learn a steering policy?
#[cfg(test)]
mod p4 {
    use crate::model::*;
    use crate::policy::*;
    use crate::steering::steer;
    use crate::store::StoreData;

    fn t() -> Millis { 1_700_000_000_000 }

    /// A journal where the SAME feeder is repeatedly the culprit, and another
    /// feeder is repeatedly innocent — the signal a policy should find.
    fn journal_with_history(rounds: u64) -> Vec<Op> {
        let mut s = StoreData::new();
        let mut ops = Vec::new();
        let mut push = |s: &mut StoreData, op: Op, ops: &mut Vec<Op>| {
            s.apply(&op).unwrap();
            ops.push(op);
        };
        push(&mut s, Op::CreateNode { id: 1, kind: NodeKind::Aspect,
            label: "ingress annotations".into(), at: t() }, &mut ops);
        push(&mut s, Op::AddFact { node: 1, fact_id: 1, key: "rewrite".into(),
            value: "rewrite target annotation routes paths".into(), at: t() }, &mut ops);
        push(&mut s, Op::CreateNode { id: 2, kind: NodeKind::Aspect,
            label: "python venv".into(), at: t() }, &mut ops);
        push(&mut s, Op::AddFact { node: 2, fact_id: 2, key: "venv".into(),
            value: "virtualenv pip requirements".into(), at: t() }, &mut ops);

        for r in 0..rounds {
            let now = t() + r * 1000;
            // ids come from the store, exactly as memsrv allocates them —
            // hardcoding them collides with the gap nodes steer() creates
            let ep = s.next_node;
            push(&mut s, Op::CreateNode { id: ep, kind: NodeKind::TaskEpisode,
                label: format!("deploy {r}"), at: now }, &mut ops);
            for src in [1u64, 2] {
                let eid = s.next_edge;
                push(&mut s, Op::Link { id: eid, src, dst: ep,
                    kind: EdgeKind::SuppliesContext, at: now }, &mut ops);
            }
            let (plan, _) = steer(&s, ep, "rewrite annotation routes broke with a 404", None, now + 1).unwrap();
            for op in plan { push(&mut s, op, &mut ops); }
        }
        ops
    }

    #[test]
    fn training_examples_are_extracted_and_labelled_from_the_journal() {
        let ops = journal_with_history(4);
        let examples = examples_from_journal(&ops);
        assert!(!examples.is_empty(), "a journal with failures must yield examples");

        let positives = examples.iter().filter(|e| e.label).count();
        assert!(positives > 0, "the blamed feeder must be labelled positive");
        assert!(positives < examples.len(), "the innocent feeder must be labelled negative");

        // the positives really are the ones that share vocabulary with the failure
        let pos_overlap: f32 = examples.iter().filter(|e| e.label)
            .map(|e| e.features.overlap).sum();
        let neg_overlap: f32 = examples.iter().filter(|e| !e.label)
            .map(|e| e.features.overlap).sum();
        assert!(pos_overlap > neg_overlap, "labels look scrambled: {pos_overlap} vs {neg_overlap}");
    }

    #[test]
    fn a_journal_with_no_failures_yields_nothing_to_learn_from() {
        let mut s = StoreData::new();
        let ops = vec![
            Op::CreateNode { id: 1, kind: NodeKind::TaskEpisode, label: "ok run".into(), at: t() },
            Op::CommitLog { node: 1, kind: "outcome".into(), detail: "all green".into(), at: t() },
        ];
        for op in &ops { s.apply(op).unwrap(); }
        assert!(examples_from_journal(&ops).is_empty(),
            "a success is not a training example for a blame policy");
    }

    #[test]
    fn features_capture_more_than_the_current_rule_does() {
        let ops = journal_with_history(3);
        let examples = examples_from_journal(&ops);
        let f = examples[0].features;
        // the heuristic only ever looks at this one number
        assert!(f.overlap >= 0.0);
        // the policy can also see how trusted the edge already is and its history
        assert!(f.weight > 0.0, "edge weight should be populated");
        assert!(f.fact_count > 0.0, "fact count should be populated");
        assert!(f.overlap_ratio >= 0.0 && f.overlap_ratio <= 1.0);
    }

    #[test]
    fn a_learned_policy_at_least_matches_the_shipped_heuristic() {
        let ops = journal_with_history(12);
        let exp = run_experiment(&ops);
        assert!(exp.examples >= 20, "not enough history to say anything: {}", exp.examples);
        assert!(exp.positives > 0);
        // the honest bar for an experiment: it must not be WORSE than the rule
        // it would replace, on the same held-out examples
        assert!(exp.learned.accuracy >= exp.heuristic.accuracy - 0.01,
            "learned {:?} lost to heuristic {:?}", exp.learned, exp.heuristic);
        assert_eq!(exp.learned.n, exp.heuristic.n, "both must be scored on the same set");
    }

    #[test]
    fn the_split_is_deterministic_and_disjoint() {
        let ops = journal_with_history(8);
        let examples = examples_from_journal(&ops);
        let (a, b) = split(&examples, 4);
        assert_eq!(a.len() + b.len(), examples.len());
        assert_eq!(b.len(), (examples.len() + 3) / 4);
        // same input, same split, every time
        let (a2, b2) = split(&examples, 4);
        assert_eq!(a.len(), a2.len());
        assert_eq!(b.len(), b2.len());
    }

    #[test]
    fn training_moves_the_weights_and_scoring_is_bounded() {
        let ops = journal_with_history(10);
        let examples = examples_from_journal(&ops);
        let policy = train(&examples, 400, 0.5);
        assert!(policy.weights.iter().any(|w| w.abs() > 1e-4), "nothing was learned at all");
        for ex in &examples {
            let p = policy.score(&ex.features);
            assert!((0.0..=1.0).contains(&p), "score out of range: {p}");
        }
        // an untrained policy is a coin flip, not a crash
        let empty = train(&[], 100, 0.5);
        assert_eq!(empty.score(&examples[0].features), 0.5);
    }

    #[test]
    fn scoring_reports_precision_and_recall_not_just_accuracy() {
        let f = |overlap: f32| Features {
            overlap, overlap_ratio: 0.0, weight: 0.5,
            prior_failures: 0.0, prior_successes: 0.0, fact_count: 1.0,
        };
        let examples = vec![
            Example { features: f(1.0), label: true },
            Example { features: f(1.0), label: false },  // false positive
            Example { features: f(0.0), label: true },   // false negative
            Example { features: f(0.0), label: false },
        ];
        let s = evaluate(&examples, heuristic_predict);
        assert_eq!(s.n, 4);
        assert_eq!(s.accuracy, 0.5);
        assert_eq!(s.precision, 0.5);
        assert_eq!(s.recall, 0.5);
    }

    #[test]
    fn synthetic_journal_has_both_labels_and_nonzero_examples() {
        let ops = synthetic_journal_ops();
        let examples = examples_from_journal(&ops);
        // rounds 0..5: 3 feeders each (C survives six blames); rounds 6..14:
        // C's weight hit zero and the edge died, so only A and B remain
        assert_eq!(examples.len(), 36);
        let positives = examples.iter().filter(|e| e.label).count();
        assert_eq!(positives, 6, "one recorded culprit per surviving round, always C");
        // the overlap rule can see past examples only: positives must include
        // zero-overlap culprits (that is the whole point of the fixture)
        let silent_positives = examples.iter()
            .filter(|e| e.label && e.features.overlap == 0.0).count();
        assert_eq!(silent_positives, 6, "every positive is a silent culprit");
        // and C's history DID accumulate before the edge died: mid-round
        // culprits carry failures and a collapsed weight, the features the
        // shipped rule never looks at
        let with_history = examples.iter()
            .filter(|e| e.label && (e.features.prior_failures > 0.0 || e.features.weight < 0.5))
            .count();
        assert!(with_history >= 4, "repeated oracle blames must build history");
    }

    #[test]
    fn learned_beats_the_lexical_rule_on_the_synthetic_journal() {
        // the synthetic journal records blame the overlap rule cannot see:
        // the honest bar is that the pipeline CAN learn it (and demonstrably
        // better than the rule it would replace)
        let exp = run_experiment(&synthetic_journal_ops());
        assert!(exp.learned.accuracy > exp.heuristic.accuracy + 0.2,
            "learned {:?} should clearly beat heuristic {:?}",
            exp.learned, exp.heuristic);
        // and it must actually CATCH culprits, not just stay quiet: a policy
        // with zero recall is not a win, it is the majority class
        assert!(exp.learned.recall > exp.heuristic.recall,
            "learned recall {:?} must beat heuristic recall {:?}",
            exp.learned.recall, exp.heuristic.recall);
    }

    #[test]
    fn the_lexical_rule_is_blind_to_silent_culprits() {
        // sanity pin: on this fixture the shipped rule never finds the
        // culprit (it can only see overlap), so its recall is zero
        let ops = synthetic_journal_ops();
        let examples = examples_from_journal(&ops);
        let scored = evaluate(&examples, heuristic_predict);
        assert_eq!(scored.recall, 0.0, "overlap-only rule cannot recall silent culprits");
        assert!(scored.accuracy < 0.5, "and its accuracy is below chance");
    }
}
