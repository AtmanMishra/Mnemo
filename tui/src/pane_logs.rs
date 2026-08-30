//! 2.7 Logs pane: the journal op stream, tailed live, with filters.
//! Reads the same JSONL the memory layer writes, so it needs no sidecar.
//!
//! 5.6: `s` switches the same pane to the agent's trace store
//! (~/.mnemo/logs/<date>.jsonl), so tool calls, model round trips and
//! subagent spans are visible next to the memory ops they produced.
use crate::cockpit::Pane;
use crate::pane::PaneView;
use crate::theme;
use crossterm::event::{KeyCode, KeyEvent};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// Which stream the pane is tailing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Source {
    #[default]
    Journal,
    Traces,
}

impl Source {
    pub fn label(self) -> &'static str {
        match self { Source::Journal => "journal", Source::Traces => "traces" }
    }
    fn toggled(self) -> Source {
        match self { Source::Journal => Source::Traces, Source::Traces => Source::Journal }
    }
}

/// One trace span, rendered the same way the CLI renders it.
pub fn format_span(v: &serde_json::Value) -> Option<OpLine> {
    let kind = v.get("kind")?.as_str()?;
    let name = v.get("name").and_then(|n| n.as_str()).unwrap_or("");
    let at = v.get("start").and_then(|s| s.as_u64()).unwrap_or(0);
    let ok = v.get("ok").and_then(|o| o.as_bool()).unwrap_or(true);
    let dur = v.get("duration_ms").and_then(|d| d.as_u64());
    let attrs = v.get("attrs").and_then(|a| a.as_object());
    let detail = attrs.map(|m| m.iter()
        .filter(|(_, v)| !v.is_null())
        .map(|(k, v)| match v {
            serde_json::Value::String(s) => format!("{k}={s}"),
            other => format!("{k}={other}"),
        })
        .collect::<Vec<_>>()
        .join(" ")).unwrap_or_default();
    Some(OpLine {
        at,
        kind: format!("{}{}", if ok { "" } else { "!" }, kind),
        detail: match dur {
            Some(ms) => format!("{name} {ms}ms {detail}"),
            None => format!("{name} {detail}"),
        }.trim_end().to_string(),
    })
}

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
        // trace spans: colour by kind, and anything failed is red
        k if k.starts_with('!') => theme::RED,
        "tool" => theme::GREEN,
        "llm" => theme::BLUE,
        "subagent" => theme::PURPLE,
        "session" => theme::YELLOW,
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
    pub source: Source,
    trace_path: Option<PathBuf>,
    journal_path: Option<PathBuf>,
}

impl LogsPane {
    pub fn new(path: &Path) -> Self {
        Self {
            path: Some(path.to_path_buf()),
            journal_path: Some(path.to_path_buf()),
            ..Default::default()
        }
    }

    /// Point the traces view at a specific file (the CLI picks today's).
    pub fn with_traces(mut self, path: &Path) -> Self {
        self.trace_path = Some(path.to_path_buf());
        self
    }

    /// Flip between the memory journal and the agent trace store.
    pub fn toggle_source(&mut self) {
        self.source = self.source.toggled();
        self.path = match self.source {
            Source::Journal => self.journal_path.clone(),
            Source::Traces => self.trace_path.clone(),
        };
        // a different file means different bytes: start its tail from scratch
        self.offset = 0;
        self.ops.clear();
        self.error = None;
        if self.path.is_none() {
            self.error = Some(format!("no {} file configured", self.source.label()));
        }
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
                let parsed = match self.source {
                    Source::Journal => format_op(&v),
                    Source::Traces => format_span(&v),
                };
                if let Some(op) = parsed { self.ops.push(op); }
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
            out.push(Line::from(Span::styled(
                format!("(no {} entries)", self.source.label()),
                Style::default().fg(theme::GREY),
            )));
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
        } else if key.code == KeyCode::Char('s') {
            self.toggle_source();
            true
        } else {
            false
        }
    }

    fn status(&self) -> String {
        let shown = self.visible().len();
        let src = self.source.label();
        if self.filter.is_empty() {
            format!("{} {src} entries", self.ops.len())
        } else {
            format!("{shown}/{} {src} entries · /{}", self.ops.len(), self.filter)
        }
    }

    fn help(&self) -> Vec<(&'static str, &'static str)> {
        vec![("/", "filter"), ("s", "journal / agent traces"), ("esc", "clear filter")]
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
        assert_eq!(pane.status(), "2 journal entries");
        assert!(pane.on_key(KeyEvent::new(KeyCode::Char('/'), KeyModifiers::NONE), 20));
        for c in "salience".chars() {
            pane.on_key(KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE), 20);
        }
        assert_eq!(pane.visible().len(), 1);
        assert_eq!(pane.status(), "1/2 journal entries · /salience");
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

    #[test]
    fn trace_spans_render_with_timing_and_outcome() {
        let ok = format_span(&serde_json::json!({
            "kind": "tool", "name": "bash_exec", "start": 10, "duration_ms": 42,
            "ok": true, "attrs": {"output_bytes": 500},
        })).unwrap();
        assert_eq!(ok.kind, "tool");
        assert!(ok.detail.contains("bash_exec 42ms"), "{}", ok.detail);
        assert!(ok.detail.contains("output_bytes=500"));
        assert_eq!(op_color(&ok.kind), theme::GREEN);

        let failed = format_span(&serde_json::json!({
            "kind": "tool", "name": "write_file", "start": 1, "ok": false, "attrs": {},
        })).unwrap();
        assert_eq!(op_color(&failed.kind), theme::RED, "a failed span must read as failed");

        // a line that is not a span is skipped, not rendered as garbage
        assert!(format_span(&serde_json::json!({"CreateNode": {"id": 1}})).is_none());
    }

    #[test]
    fn s_flips_between_the_journal_and_the_trace_store() {
        let dir = journal("sources").parent().unwrap().to_path_buf();
        let journal_path = dir.join("journal.jsonl");
        let traces = dir.join("2026-03-01.jsonl");
        append(&journal_path, &[r#"{"CreateNode":{"id":1,"kind":"Aspect","label":"helm","at":1}}"#]);
        append(&traces, &[r#"{"kind":"llm","name":"model round trip","start":2,"duration_ms":900,"ok":true,"attrs":{"model":"ox-alpha-free"}}"#]);

        let mut pane = LogsPane::new(&journal_path).with_traces(&traces);
        pane.tick();
        assert_eq!(pane.source, Source::Journal);
        assert!(pane.ops.iter().any(|o| o.kind == "CreateNode"));
        assert!(pane.status().contains("journal"));

        pane.on_key(KeyEvent::new(KeyCode::Char('s'), KeyModifiers::NONE), 20);
        pane.tick();
        assert_eq!(pane.source, Source::Traces);
        assert!(pane.ops.iter().any(|o| o.kind == "llm"), "{:?}", pane.ops);
        assert!(!pane.ops.iter().any(|o| o.kind == "CreateNode"),
            "switching source must not leave the other stream's entries behind");
        assert!(pane.status().contains("traces"));

        pane.on_key(KeyEvent::new(KeyCode::Char('s'), KeyModifiers::NONE), 20);
        pane.tick();
        assert_eq!(pane.source, Source::Journal);
        assert!(pane.ops.iter().any(|o| o.kind == "CreateNode"), "switching back re-reads");
    }

    #[test]
    fn switching_to_an_unconfigured_source_says_so() {
        let p = journal("notraces");
        append(&p, &[r#"{"CreateNode":{"id":1,"kind":"Aspect","label":"a","at":1}}"#]);
        let mut pane = LogsPane::new(&p);
        pane.toggle_source();
        pane.tick();
        assert!(text(&pane.lines(10)[0]).contains("no traces file"), "{:?}", pane.lines(10));
    }
}
