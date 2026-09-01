//! Tolerant journal load (ab99acb1): one damaged line must cost that line
//! only — never the whole history. Damaged lines are quarantined to
//! `<journal>.corrupt` and counted, so amnesia is always observable.
#[cfg(test)]
mod tolerant_load_tests {
    use crate::model::*;
    use crate::persist::Journal;
    use crate::store::StoreData;
    use std::path::PathBuf;

    fn t() -> Millis { 1_700_000_000_000 }

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("memlayer-persist-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write_ops(jpath: &PathBuf, ops: &[Op]) {
        let mut j = Journal::open(jpath).unwrap();
        for op in ops { j.append(op).unwrap(); }
    }

    fn sample_ops() -> Vec<Op> {
        vec![
            Op::CreateNode { id: 1, kind: NodeKind::Aspect, label: "ingress".into(), at: t() },
            Op::AddFact { node: 1, fact_id: 1, key: "rewrite".into(),
                value: "nginx rewrite-target annotation".into(), at: t() + 1 },
            Op::CreateNode { id: 2, kind: NodeKind::Aspect, label: "secrets".into(), at: t() + 2 },
        ]
    }

    #[test]
    fn one_mangled_line_midfile_costs_that_line_only() {
        let dir = temp_dir("mangled");
        let jpath = dir.join("journal.jsonl");
        write_ops(&jpath, &sample_ops());

        // mangle line 2 (the AddFact) in place: valid, garbage, valid
        let raw = std::fs::read_to_string(&jpath).unwrap();
        let mut lines: Vec<String> = raw.lines().map(str::to_string).collect();
        assert_eq!(lines.len(), 3);
        lines[1] = "{\"AddFact\":{\"node\":1,\"fact_id\":1,\"key\":\"rewr".into(); // torn JSON
        std::fs::write(&jpath, lines.join("\n") + "\n").unwrap();

        let report = Journal::read_all_reported(&jpath).unwrap();
        assert_eq!(report.skipped, 1, "exactly the mangled line is skipped");
        assert_eq!(report.ops.len(), 2, "the valid ops around it still load");
        assert!(matches!(report.ops[0], Op::CreateNode { id: 1, .. }));
        assert!(matches!(report.ops[1], Op::CreateNode { id: 2, .. }));

        // the mangled content is preserved in the quarantine file, reported — not zeroed
        let q = std::fs::read_to_string(dir.join("journal.corrupt")).unwrap();
        assert!(q.contains("rewr"), "quarantine must carry the damaged raw line");
        assert!(q.contains("\"reason\""), "quarantine records must say why");

        // and the surviving ops replay into a usable store
        let s = crate::persist::replay(&report.ops).unwrap();
        assert_eq!(s.nodes.len(), 2);
    }

    #[test]
    fn torn_final_line_without_newline_is_quarantined_not_fatal() {
        let dir = temp_dir("torn");
        let jpath = dir.join("journal.jsonl");
        write_ops(&jpath, &sample_ops());
        // simulate crash mid-append: truncate the last line, no trailing \n
        let raw = std::fs::read_to_string(&jpath).unwrap();
        let torn: String = raw.chars().take(raw.len() - 20).collect();
        std::fs::write(&jpath, &torn).unwrap();

        let report = Journal::read_all_reported(&jpath).unwrap();
        assert_eq!(report.skipped, 1);
        assert_eq!(report.ops.len(), 2, "history before the torn write survives");
        assert!(dir.join("journal.corrupt").exists());
    }

    #[test]
    fn non_utf8_journal_line_is_quarantined_not_fatal() {
        let dir = temp_dir("utf8");
        let jpath = dir.join("journal.jsonl");
        write_ops(&jpath, &sample_ops());
        // splice a non-UTF8 byte sequence as line 2
        let raw = std::fs::read(&jpath).unwrap();
        let mut mangled = raw.clone();
        // insert after the first newline: bytes [0xFF, 0xFE] are invalid UTF-8
        let nl = raw.iter().position(|&b| b == b'\n').unwrap();
        let mut junk: Vec<u8> = vec![0xFF, 0xFE];
        junk.push(b'\n');
        mangled.splice(nl + 1..nl + 1, junk);
        std::fs::write(&jpath, mangled).unwrap();

        let report = Journal::read_all_reported(&jpath).unwrap();
        assert_eq!(report.skipped, 1, "the non-UTF8 line is skipped, not fatal");
        assert_eq!(report.ops.len(), 3, "every valid op around it still loads");

        let q = std::fs::read_to_string(dir.join("journal.corrupt")).unwrap();
        assert!(q.contains("invalid utf-8"), "quarantine names the reason");
    }

    #[test]
    fn quarantine_survives_repeated_loads_without_duplicating_valid_ops() {
        let dir = temp_dir("repeat");
        let jpath = dir.join("journal.jsonl");
        write_ops(&jpath, &sample_ops());
        std::fs::write(&dir.join("journal.jsonl"),
            format!("{}\nGARBAGE NOT JSON\n", serde_json::to_string(&sample_ops()[0]).unwrap())).unwrap();

        let first = Journal::read_all_reported(&jpath).unwrap();
        let second = Journal::read_all_reported(&jpath).unwrap();
        assert_eq!(first.ops.len(), second.ops.len());
        assert_eq!(first.skipped, second.skipped);
        // two quarantine appends = two records (an audit trail, not a bug)
        let q = std::fs::read_to_string(dir.join("journal.corrupt")).unwrap();
        assert_eq!(q.lines().count(), 2);
    }

    #[test]
    fn oversize_corrupt_line_is_truncated_in_quarantine() {
        let dir = temp_dir("oversize");
        let jpath = dir.join("journal.jsonl");
        write_ops(&jpath, &sample_ops());
        // a multi-KB non-op blob as the middle line
        let blob = "x".repeat(50_000);
        let raw = std::fs::read_to_string(&jpath).unwrap();
        let lines: Vec<&str> = raw.lines().collect();
        std::fs::write(&jpath, format!("{}\n{}\n{}\n", lines[0], blob, lines[2])).unwrap();

        let report = Journal::read_all_reported(&jpath).unwrap();
        assert_eq!(report.skipped, 1);
        let q = std::fs::read(dir.join("journal.corrupt")).unwrap();
        assert!(q.len() < 10_000, "quarantine must not copy an unbounded blob");
        let qtxt = String::from_utf8_lossy(&q);
        assert!(qtxt.contains("truncated"), "the record says it was cut");
    }

    #[test]
    fn clean_journal_reports_zero_skipped_and_no_quarantine_file() {
        let dir = temp_dir("clean");
        let jpath = dir.join("journal.jsonl");
        write_ops(&jpath, &sample_ops());
        let report = Journal::read_all_reported(&jpath).unwrap();
        assert_eq!(report.skipped, 0);
        assert_eq!(report.ops.len(), 3);
        assert!(!dir.join("journal.corrupt").exists());
        // read_all (the simple wrapper) returns just the ops
        assert_eq!(Journal::read_all(&jpath).unwrap().len(), 3);
        // blank lines are padding, not corruption
        std::fs::write(&dir.join("journal.jsonl"), format!("\n{}\n\n", serde_json::to_string(&sample_ops()[0]).unwrap())).unwrap();
        let report = Journal::read_all_reported(&jpath).unwrap();
        assert_eq!(report.skipped, 0, "blank lines are skipped silently");
    }

    #[test]
    fn read_all_blocks_while_a_writer_holds_the_journal_lock() {
        // dbfee81a: without the fd-lock, a reader racing a writer could see
        // the writer's in-flight partial line and quarantine an op that was
        // about to complete. read_all must wait for the same lock append()
        // takes, so the reader only ever sees complete lines.
        use std::sync::mpsc;
        use std::time::Duration;

        let dir = temp_dir("lock");
        let jpath = dir.join("journal.jsonl");
        write_ops(&jpath, &sample_ops()[..1]); // one complete op on disk

        // a writer takes the lock exactly the way Journal::append does
        let lock_file = std::fs::OpenOptions::new().create(true).write(true)
            .open(dir.join("journal.lock")).unwrap();
        let mut lock = fd_lock::RwLock::new(lock_file);
        let guard = lock.write().unwrap();

        let (tx, rx) = mpsc::channel();
        let jpath2 = jpath.clone();
        let reader = std::thread::spawn(move || {
            let ops = Journal::read_all(&jpath2).unwrap();
            tx.send(ops.len()).unwrap();
        });

        // while the writer holds the lock, read_all must NOT complete
        assert!(rx.recv_timeout(Duration::from_millis(400)).is_err(),
            "read_all must wait for the writer's fd-lock instead of reading a torn line");
        drop(guard); // writer done: the line on disk is complete
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), 1,
            "read_all resumes after the writer releases and sees the complete op");
        reader.join().unwrap();
    }

    #[test]
    fn replay_of_tolerantly_loaded_ops_is_exact_for_survivors() {
        // end-to-end: damaged journal -> load -> replay == live store minus
        // exactly the damaged op's effect (the AddFact), never zero nodes
        let dir = temp_dir("replay");
        let jpath = dir.join("journal.jsonl");
        let ops = sample_ops();
        write_ops(&jpath, &ops);
        let mut live = StoreData::new();
        for op in &ops { live.apply(op).unwrap(); }

        let raw = std::fs::read_to_string(&jpath).unwrap();
        let lines: Vec<&str> = raw.lines().collect();
        std::fs::write(&jpath, format!("{}\nBROKEN\n{}\n", lines[0], lines[2])).unwrap();

        let report = Journal::read_all_reported(&jpath).unwrap();
        let s = crate::persist::replay(&report.ops).unwrap();
        assert_eq!(s.nodes.len(), live.nodes.len(), "no amnesia: both nodes survive");
        assert_eq!(s.nodes[&1].facts.len(), 0, "only the mangled AddFact is lost");
        assert_eq!(live.nodes[&1].facts.len(), 1);
    }
}
