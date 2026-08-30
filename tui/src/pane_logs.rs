//! 2.7 Logs pane: the journal op stream, tailed live, with filters.
//! Reads the same JSONL the memory layer writes, so it needs no sidecar.
use crate::cockpit::Pane;
use crate::pane::PaneView;
use crate::theme;
use crossterm::event::{KeyCode, KeyEvent};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq)]
pub struct OpLine {
    pub at: u64,
    pub kind: String,
    pub detail: String,
}

/// One journal op -> one readable line. Unknown ops still show their name
/// rather than vanishing.
pub fn format_op(v: &serde_json::Value) -> Option<OpLine> {
    let (kind, body) = v.as_object()?.iter().next()?;
    let at = body.get("at").and_then(|a| a.as_u64()).unwrap_or(0);
    let g = |k: &str| body.get(k).map(|x| match x {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }).unwrap_or_default();
    let detail = match kind.as_str() {
        "CreateNode" => format!("#{} {} \"{}\"", g("id"), g("kind"), g("label")),
        "SetArea" => format!("#{} -> {}", g("node"), g("area")),
        "AddFact" => format!("#{} {}={}", g("node"), g("key"), g("value")),
        "SupersedeFact" => format!("#{} fact {} -> {}", g("node"), g("old_fact"), g("new_fact_id")),
        "DeleteNode" => format!("#{} hard={}", g("node"), g("hard")),
        "Link" => format!("#{} -{}-> #{}", g("src"), g("kind"), g("dst")),
        "Unlink" => format!("edge {}", g("edge")),
        "Reweight" => format!("edge {} by {}", g("edge"), g("delta")),
        "RecordOutcome" => format!("edge {} success={}", g("edge"), g("success")),
        "PushContext" => format!("-> #{}", g("to")),
        "CommitLog" => format!("#{} {}: {}", g("node"), g("kind"), g("detail")),
        _ => String::new(),
    };
    Some(OpLine { at, kind: kind.clone(), detail })
}

fn byte_at(f: &mut std::fs::File, at: u64) -> Option<u8> {
    use std::io::Read;
    f.seek(SeekFrom::Start(at)).ok()?;
    let mut b = [0u8; 1];
    f.read_exact(&mut b).ok()?;
    Some(b[0])
}

/// Colour by what the op does: writes green, removals red, steering blue.
pub fn op_color(kind: &str) -> ratatui::style::Color {
    match kind {
        "CreateNode" | "AddFact" | "Link" => theme::GREEN,
        "DeleteNode" | "Unlink" => theme::RED,
        "SupersedeFact" | "Reweight" | "RecordOutcome" | "SetArea" => theme::BLUE,
        "CommitLog" => theme::WHITE,
        _ => theme::GREY,
    }
}

#[derive(Debug, Clone, Default)]
pub struct LogsPane {
    pub ops: Vec<OpLine>,
    /// Substring filter over kind and detail.
    pub filter: String,
    pub filtering: bool,
    /// Bytes already consumed, so a tail only reads what is new.
    offset: u64,
    path: Option<PathBuf>,
    pub error: Option<String>,
}

impl LogsPane {
    pub fn new(path: &Path) -> Self {
        Self { path: Some(path.to_path_buf()), ..Default::default() }
    }

    /// Read whatever has been appended since the last call.
    pub fn tail(&mut self) {
        let Some(path) = self.path.clone() else { return };
        let Ok(mut f) = std::fs::File::open(&path) else {
            self.error = Some(format!("no journal at {}", path.display()));
            return;
        };
        self.error = None;
        // A journal can be truncated or replaced under us (compaction). Size
        // alone does not prove it — the replacement may be longer. The byte
        // before our offset must still be the newline we stopped after.
        let len = f.metadata().map(|m| m.len()).unwrap_or(0);
        let resumable = self.offset == 0
            || (len >= self.offset && byte_at(&mut f, self.offset - 1) == Some(b'\n'));
        if !resumable {
            self.offset = 0;
            self.ops.clear(); // those ops are not in this journal any more
        }
        if f.seek(SeekFrom::Start(self.offset)).is_err() { return; }
        let mut read = self.offset;
        for line in BufReader::new(&mut f).lines() {
            let Ok(line) = line else { break };
            read += line.len() as u64 + 1;
            if line.trim().is_empty() { continue; }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                if let Some(op) = format_op(&v) { self.ops.push(op); }
            }
        }
        self.offset = read;
    }

    pub fn visible(&self) -> Vec<&OpLine> {
        let f = self.filter.to_ascii_lowercase();
        self.ops.iter()
            .filter(|o| f.is_empty()
                || o.kind.to_ascii_lowercase().contains(&f)
                || o.detail.to_ascii_lowercase().contains(&f))
            .collect()
    }
}

impl PaneView for LogsPane {
    fn id(&self) -> Pane { Pane::Logs }

    fn tick(&mut self) { self.tail(); }

    fn lines(&self, height: usize) -> Vec<Line<'static>> {
        let mut out: Vec<Line<'static>> = Vec::new();
        if self.filtering {
            out.push(Line::from(vec![
                Span::styled("filter ", Style::default().fg(theme::GREY)),
                Span::styled(self.filter.clone(), Style::default().fg(theme::YELLOW)),
                Span::styled("▌", Style::default().fg(theme::YELLOW)),
            ]));
        }
        if let Some(e) = &self.error {
            out.push(Line::from(Span::styled(format!("✖ {e}"), Style::default().fg(theme::RED))));
            return out;
        }
        let rows = self.visible();
        if rows.is_empty() {
            out.push(Line::from(Span::styled("(no journal ops)", Style::default().fg(theme::GREY))));
            return out;
        }
        // tail-anchored: the newest op is always on screen
        let budget = height.saturating_sub(out.len());
        let start = if budget > 0 && rows.len() > budget { rows.len() - budget } else { 0 };
        for o in &rows[start..] {
            out.push(Line::from(vec![
                Span::styled(format!("{:<14} ", o.kind),
                    Style::default().fg(op_color(&o.kind)).add_modifier(Modifier::BOLD)),
                Span::styled(o.detail.clone(), Style::default().fg(theme::WHITE)),
            ]));
        }
        out
    }

    fn on_key(&mut self, key: KeyEvent, _h: usize) -> bool {
        if self.filtering {
            match key.code {
                KeyCode::Esc => { self.filtering = false; self.filter.clear(); true }
                KeyCode::Backspace => { self.filter.pop(); true }
                KeyCode::Char(c) => { self.filter.push(c); true }
                _ => false,
            }
        } else if key.code == KeyCode::Char('/') {
            self.filtering = true;
            self.filter.clear();
            true
        } else {
            false
        }
    }

    fn status(&self) -> String {
        let shown = self.visible().len();
        if self.filter.is_empty() {
            format!("{} ops", self.ops.len())
        } else {
            format!("{shown}/{} ops · /{}", self.ops.len(), self.filter)
        }
    }

    fn help(&self) -> Vec<(&'static str, &'static str)> {
        vec![("/", "filter ops"), ("esc", "clear filter")]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::KeyModifiers;
    use std::io::Write;

    fn text(l: &Line) -> String { l.spans.iter().map(|s| s.content.to_string()).collect() }

    fn journal(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cockpit-logs-{name}"));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.join("journal.jsonl")
    }
    fn append(p: &Path, lines: &[&str]) {
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(p).unwrap();
        for l in lines { writeln!(f, "{l}").unwrap(); }
    }

    #[test]
    fn every_op_kind_renders_something_readable() {
        let cases = [
            (r#"{"CreateNode":{"id":1,"kind":"Aspect","label":"helm","at":10}}"#, "CreateNode", "#1"),
            (r#"{"SetArea":{"node":1,"area":"Salience","at":11}}"#, "SetArea", "Salience"),
            (r#"{"AddFact":{"node":1,"fact_id":1,"key":"k","value":"v","at":12}}"#, "AddFact", "k=v"),
            (r#"{"Link":{"id":1,"src":1,"dst":2,"kind":"SuppliesContext","at":13}}"#, "Link", "#2"),
            (r#"{"CommitLog":{"node":1,"kind":"outcome","detail":"done","at":14}}"#, "CommitLog", "done"),
        ];
        for (raw, kind, needle) in cases {
            let op = format_op(&serde_json::from_str(raw).unwrap()).unwrap();
            assert_eq!(op.kind, kind);
            assert!(op.detail.contains(needle), "{kind}: {:?}", op.detail);
        }
        // an op added by a future memory-layer version still shows its name
        let op = format_op(&serde_json::json!({"BrandNewOp": {"at": 1}})).unwrap();
        assert_eq!(op.kind, "BrandNewOp");
    }

    #[test]
    fn tail_reads_only_what_is_new() {
        let p = journal("tail");
        append(&p, &[r#"{"CreateNode":{"id":1,"kind":"Aspect","label":"a","at":1}}"#]);
        let mut pane = LogsPane::new(&p);
        pane.tail();
        assert_eq!(pane.ops.len(), 1);
        pane.tail();
        assert_eq!(pane.ops.len(), 1, "a second tail with no new bytes adds nothing");
        append(&p, &[r#"{"CreateNode":{"id":2,"kind":"Aspect","label":"b","at":2}}"#]);
        pane.tail();
        assert_eq!(pane.ops.len(), 2);
    }

    #[test]
    fn a_truncated_journal_is_reread_from_the_start() {
        let p = journal("truncate");
        append(&p, &[r#"{"CreateNode":{"id":1,"kind":"Aspect","label":"a","at":1}}"#]);
        let mut pane = LogsPane::new(&p);
        pane.tail();
        std::fs::write(&p, "").unwrap();
        append(&p, &[r#"{"CreateNode":{"id":9,"kind":"Aspect","label":"fresh","at":9}}"#]);
        pane.tail();
        assert!(pane.ops.iter().any(|o| o.detail.contains("fresh")), "{:?}", pane.ops);
        assert!(!pane.ops.iter().any(|o| o.detail.contains("\"a\"")),
            "ops from the replaced journal must be dropped: {:?}", pane.ops);
    }

    #[test]
    fn corrupt_lines_are_skipped_not_fatal() {
        let p = journal("corrupt");
        append(&p, &["not json at all", r#"{"CreateNode":{"id":1,"kind":"Aspect","label":"ok","at":1}}"#]);
        let mut pane = LogsPane::new(&p);
        pane.tail();
        assert_eq!(pane.ops.len(), 1);
        assert!(pane.error.is_none());
    }

    #[test]
    fn a_missing_journal_reports_instead_of_crashing() {
        let mut pane = LogsPane::new(Path::new("/nonexistent/journal.jsonl"));
        pane.tail();
        assert!(pane.error.is_some());
        assert!(text(&pane.lines(10)[0]).contains("no journal"));
    }

    #[test]
    fn filter_narrows_the_stream_and_the_status_says_so() {
        let mut pane = LogsPane::default();
        pane.ops = vec![
            OpLine { at: 1, kind: "CreateNode".into(), detail: "#1 Aspect \"helm\"".into() },
            OpLine { at: 2, kind: "SetArea".into(), detail: "#1 -> Salience".into() },
        ];
        assert_eq!(pane.status(), "2 ops");
        assert!(pane.on_key(KeyEvent::new(KeyCode::Char('/'), KeyModifiers::NONE), 20));
        for c in "salience".chars() {
            pane.on_key(KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE), 20);
        }
        assert_eq!(pane.visible().len(), 1);
        assert_eq!(pane.status(), "1/2 ops · /salience");
        pane.on_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE), 20);
        assert_eq!(pane.visible().len(), 2);
    }

    #[test]
    fn newest_ops_stay_on_screen() {
        let mut pane = LogsPane::default();
        pane.ops = (0..50).map(|i| OpLine { at: i, kind: "AddFact".into(), detail: format!("op {i}") }).collect();
        let shown: Vec<String> = pane.lines(5).iter().map(text).collect();
        assert_eq!(shown.len(), 5);
        assert!(shown.last().unwrap().contains("op 49"), "{shown:?}");
    }
}
