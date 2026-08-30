//! 2.3 Chat pane: pi's RPC event stream rendered as a transcript —
//! streaming assistant text, thinking blocks, tool cards, diff blocks.
//! Pure state + pure rendering; the event loop only feeds it `AgentEvent`s.
use crate::cockpit::Pane;
use crate::md::{self, SegStyle};
use crate::pane::PaneView;
use crate::rpc::{AgentEvent, TurnStats};
use crate::theme;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

#[derive(Debug, Clone, PartialEq)]
pub enum Entry {
    User(String),
    /// Assistant prose. `streaming` while deltas are still arriving.
    Assistant { text: String, streaming: bool },
    Thinking(String),
    /// One tool call. `ok` is None while it is still running.
    Tool { id: String, name: String, args: String, ok: Option<bool> },
    Stats(TurnStats),
    Error(String),
}

#[derive(Debug, Clone, Default)]
pub struct ChatPane {
    pub entries: Vec<Entry>,
    /// Agent is mid-run: the status bar shows a spinner.
    pub busy: bool,
    /// Scrollback offset in lines from the bottom; 0 follows the tail.
    pub scroll: usize,
    /// Thinking blocks are collapsed to one line unless expanded.
    pub show_thinking: bool,
}

impl ChatPane {
    pub fn new() -> Self { Self::default() }

    pub fn push_user(&mut self, text: &str) {
        self.entries.push(Entry::User(text.to_string()));
        self.busy = true;
        self.scroll = 0;
    }

    /// Fold one agent event into the transcript.
    pub fn apply(&mut self, ev: AgentEvent) {
        match ev {
            AgentEvent::Started => self.busy = true,
            AgentEvent::Settled | AgentEvent::Exit(_) => self.busy = false,

            // deltas append to the open assistant entry; message_end replaces
            // it, because pi's final message is the authoritative text
            AgentEvent::Text { text, final_: false } => match self.entries.last_mut() {
                Some(Entry::Assistant { text: t, streaming: true }) => t.push_str(&text),
                _ => self.entries.push(Entry::Assistant { text, streaming: true }),
            },
            AgentEvent::Text { text, final_: true } => match self.entries.last_mut() {
                Some(Entry::Assistant { text: t, streaming }) if *streaming => {
                    *t = text;
                    *streaming = false;
                }
                _ => self.entries.push(Entry::Assistant { text, streaming: false }),
            },

            AgentEvent::Thinking(t) => match self.entries.last_mut() {
                Some(Entry::Thinking(prev)) => prev.push_str(&t),
                _ => self.entries.push(Entry::Thinking(t)),
            },

            AgentEvent::ToolStart { id, name, args } =>
                self.entries.push(Entry::Tool { id, name, args, ok: None }),
            AgentEvent::ToolEnd { id, ok, .. } => {
                match self.entries.iter_mut().rev().find(|e| matches!(e, Entry::Tool { id: i, .. } if *i == id)) {
                    Some(Entry::Tool { ok: slot, .. }) => *slot = Some(ok),
                    // an end without a start still has to be visible
                    _ => self.entries.push(Entry::Tool {
                        id, name: String::new(), args: String::new(), ok: Some(ok),
                    }),
                }
            }
            AgentEvent::TurnEnd(stats) => self.entries.push(Entry::Stats(stats)),
            AgentEvent::Error(e) => { self.entries.push(Entry::Error(e)); self.busy = false; }
        }
    }

    /// Render the transcript, tail-anchored, into at most `height` lines.
    pub fn lines(&self, height: usize) -> Vec<Line<'static>> {
        let mut all: Vec<Line<'static>> = Vec::new();
        for e in &self.entries {
            all.extend(render_entry(e, self.show_thinking));
        }
        if height == 0 || all.len() <= height { return all; }
        let end = all.len().saturating_sub(self.scroll);
        let start = end.saturating_sub(height);
        all[start..end].to_vec()
    }

    /// Scroll back (positive) or forward (negative) through history.
    pub fn scroll_by(&mut self, delta: isize, total_lines: usize, height: usize) {
        let max = total_lines.saturating_sub(height);
        let next = self.scroll as isize + delta;
        self.scroll = next.clamp(0, max as isize) as usize;
    }
}

impl PaneView for ChatPane {
    fn id(&self) -> Pane { Pane::Chat }

    fn lines(&self, height: usize) -> Vec<Line<'static>> { ChatPane::lines(self, height) }

    fn on_key(&mut self, key: crossterm::event::KeyEvent, height: usize) -> bool {
        use crossterm::event::KeyCode;
        let total = ChatPane::lines(self, 0).len();
        match key.code {
            KeyCode::Char('t') => { self.show_thinking = !self.show_thinking; true }
            KeyCode::PageUp => { self.scroll_by(height as isize, total, height); true }
            KeyCode::PageDown => { self.scroll_by(-(height as isize), total, height); true }
            _ => false,
        }
    }

    fn status(&self) -> String {
        let tools = self.entries.iter().filter(|e| matches!(e, Entry::Tool { .. })).count();
        format!("{} entries · {tools} tool calls", self.entries.len())
    }

    fn help(&self) -> Vec<(&'static str, &'static str)> {
        vec![
            ("t", "expand/collapse thinking"),
            ("pgup/pgdn", "scroll transcript"),
            ("j/k", "scroll one line"),
        ]
    }
}

fn seg_style(s: SegStyle) -> Style {
    match s {
        SegStyle::Plain => Style::default().fg(theme::WHITE),
        SegStyle::Heading => Style::default().fg(theme::YELLOW).add_modifier(Modifier::BOLD),
        SegStyle::Bold => Style::default().fg(theme::WHITE).add_modifier(Modifier::BOLD),
        SegStyle::Code => Style::default().fg(theme::GREEN),
        SegStyle::Url => Style::default().fg(theme::BLUE).add_modifier(Modifier::UNDERLINED),
    }
}

/// Tool cards get a status dot; diff-shaped output is coloured per line.
fn tool_line(name: &str, args: &str, ok: Option<bool>) -> Line<'static> {
    let (dot, color) = match ok {
        None => ("◐", theme::ORANGE),
        Some(true) => ("●", theme::GREEN),
        Some(false) => ("●", theme::RED),
    };
    Line::from(vec![
        Span::styled(format!("{dot} "), Style::default().fg(color)),
        Span::styled(name.to_string(), Style::default().fg(theme::BLUE).add_modifier(Modifier::BOLD)),
        Span::styled(format!(" {args}"), Style::default().fg(theme::GREY)),
    ])
}

/// A diff hunk line coloured by its marker, so patches read at a glance.
pub fn diff_line(raw: &str) -> Line<'static> {
    let color = match raw.chars().next() {
        Some('+') => theme::GREEN,
        Some('-') => theme::RED,
        Some('@') => theme::BLUE,
        _ => theme::GREY,
    };
    Line::from(Span::styled(raw.to_string(), Style::default().fg(color)))
}

fn is_diff(text: &str) -> bool {
    text.lines().filter(|l| l.starts_with("+++") || l.starts_with("@@")).count() > 0
}

fn render_entry(e: &Entry, show_thinking: bool) -> Vec<Line<'static>> {
    match e {
        Entry::User(t) => vec![Line::from(vec![
            Span::styled("› ", Style::default().fg(theme::YELLOW).add_modifier(Modifier::BOLD)),
            Span::styled(t.clone(), Style::default().fg(theme::WHITE).add_modifier(Modifier::BOLD)),
        ])],
        Entry::Assistant { text, streaming } => {
            if is_diff(text) {
                return text.lines().map(diff_line).collect();
            }
            let mut lines: Vec<Line<'static>> = md::render_markdown(text)
                .into_iter()
                .map(|segs| Line::from(
                    segs.into_iter()
                        .map(|s| Span::styled(s.text, seg_style(s.style)))
                        .collect::<Vec<_>>(),
                ))
                .collect();
            if *streaming {
                lines.push(Line::from(Span::styled("▌", Style::default().fg(theme::YELLOW))));
            }
            lines
        }
        Entry::Thinking(t) => {
            let style = Style::default().fg(theme::PURPLE).add_modifier(Modifier::DIM);
            if show_thinking {
                std::iter::once(Line::from(Span::styled("· thinking", style)))
                    .chain(t.lines().map(|l| Line::from(Span::styled(format!("  {l}"), style))))
                    .collect()
            } else {
                let words = t.split_whitespace().count();
                vec![Line::from(Span::styled(format!("· thinking ({words} words)"), style))]
            }
        }
        Entry::Tool { name, args, ok, .. } => vec![tool_line(name, args, *ok)],
        Entry::Stats(s) => vec![Line::from(Span::styled(
            format!("  {}/{} · {}↑ {}↓ tok · ${:.4} · {}",
                s.provider, s.model, s.tokens_in, s.tokens_out, s.cost, s.stop_reason),
            Style::default().fg(theme::GREY),
        ))],
        Entry::Error(e) => vec![Line::from(Span::styled(
            format!("✖ {e}"), Style::default().fg(theme::RED).add_modifier(Modifier::BOLD),
        ))],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(l: &Line) -> String { l.spans.iter().map(|s| s.content.to_string()).collect() }
    fn all_text(p: &ChatPane) -> String {
        p.lines(0).iter().map(|l| text(l)).collect::<Vec<_>>().join("\n")
    }

    #[test]
    fn deltas_accumulate_then_the_final_message_wins() {
        let mut p = ChatPane::new();
        p.push_user("say pong");
        for d in ["po", "n"] {
            p.apply(AgentEvent::Text { text: d.into(), final_: false });
        }
        assert!(all_text(&p).contains("pon"), "{}", all_text(&p));
        // pi's message_end is authoritative — it replaces, not appends
        p.apply(AgentEvent::Text { text: "pong".into(), final_: true });
        let out = all_text(&p);
        assert!(out.contains("pong"));
        assert!(!out.contains("ponpong"), "final message must replace the stream: {out}");
        assert_eq!(p.entries.iter().filter(|e| matches!(e, Entry::Assistant { .. })).count(), 1);
    }

    #[test]
    fn streaming_shows_a_cursor_until_the_message_closes() {
        let mut p = ChatPane::new();
        p.apply(AgentEvent::Text { text: "hi".into(), final_: false });
        assert!(all_text(&p).contains('▌'));
        p.apply(AgentEvent::Text { text: "hi".into(), final_: true });
        assert!(!all_text(&p).contains('▌'));
    }

    #[test]
    fn busy_tracks_the_run_lifecycle() {
        let mut p = ChatPane::new();
        assert!(!p.busy);
        p.push_user("go");
        assert!(p.busy);
        p.apply(AgentEvent::Settled);
        assert!(!p.busy);
        p.apply(AgentEvent::Started);
        assert!(p.busy);
        p.apply(AgentEvent::Error("boom".into()));
        assert!(!p.busy, "an error must not leave the UI spinning forever");
    }

    #[test]
    fn tool_card_flips_from_running_to_outcome() {
        let mut p = ChatPane::new();
        p.apply(AgentEvent::ToolStart { id: "t1".into(), name: "bash_exec".into(), args: "cmd=ls".into() });
        assert!(all_text(&p).contains("◐ bash_exec cmd=ls"), "{}", all_text(&p));
        p.apply(AgentEvent::ToolEnd { id: "t1".into(), name: "bash_exec".into(), ok: false });
        let line = &p.lines(0)[0];
        assert_eq!(line.spans[0].content.as_ref(), "● ");
        assert_eq!(line.spans[0].style.fg, Some(theme::RED));
        assert_eq!(p.entries.len(), 1, "the end updates the card, it does not add one");
    }

    #[test]
    fn an_orphan_tool_end_is_still_shown() {
        let mut p = ChatPane::new();
        p.apply(AgentEvent::ToolEnd { id: "x".into(), name: "ghost".into(), ok: true });
        assert_eq!(p.entries.len(), 1);
    }

    #[test]
    fn thinking_collapses_by_default_and_expands_on_request() {
        let mut p = ChatPane::new();
        p.apply(AgentEvent::Thinking("weighing two options".into()));
        p.apply(AgentEvent::Thinking(" carefully".into()));
        assert_eq!(p.entries.len(), 1, "consecutive thinking deltas are one block");
        assert!(all_text(&p).contains("thinking (4 words)"), "{}", all_text(&p));
        p.show_thinking = true;
        assert!(all_text(&p).contains("weighing two options carefully"));
    }

    #[test]
    fn diff_output_is_coloured_per_marker() {
        let mut p = ChatPane::new();
        p.apply(AgentEvent::Text {
            text: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new".into(),
            final_: true,
        });
        let lines = p.lines(0);
        let colors: Vec<_> = lines.iter().map(|l| l.spans[0].style.fg).collect();
        assert_eq!(colors[1], Some(theme::GREEN), "+++ header");
        assert_eq!(colors[2], Some(theme::BLUE), "@@ hunk");
        assert_eq!(colors[3], Some(theme::RED), "removal");
        assert_eq!(colors[4], Some(theme::GREEN), "addition");
    }

    #[test]
    fn markdown_is_rendered_for_completed_prose() {
        let mut p = ChatPane::new();
        p.apply(AgentEvent::Text { text: "# Title\nplain `code` here".into(), final_: true });
        let lines = p.lines(0);
        assert_eq!(lines[0].spans[0].style.fg, Some(theme::YELLOW));
        assert!(lines[1].spans.iter().any(|s| s.style.fg == Some(theme::GREEN)), "inline code");
    }

    #[test]
    fn stats_line_reports_the_round_trip_cost() {
        let mut p = ChatPane::new();
        p.apply(AgentEvent::TurnEnd(TurnStats {
            provider: "opencode-go".into(), model: "ox-alpha-free".into(),
            tokens_in: 120, tokens_out: 45, cost: 0.0, stop_reason: "stop".into(),
        }));
        let t = all_text(&p);
        assert!(t.contains("opencode-go/ox-alpha-free") && t.contains("120↑ 45↓"), "{t}");
    }

    #[test]
    fn transcript_is_tail_anchored_and_scrolls_back() {
        let mut p = ChatPane::new();
        for i in 0..20 { p.push_user(&format!("line {i}")); }
        let total = p.lines(0).len();
        assert_eq!(total, 20);
        let shown = p.lines(5);
        assert_eq!(text(&shown[4]), "› line 19", "tail is what you see by default");
        p.scroll_by(5, total, 5);
        assert_eq!(text(&p.lines(5)[4]), "› line 14");
        // cannot scroll past the top or below the tail
        p.scroll_by(1000, total, 5);
        assert_eq!(text(&p.lines(5)[0]), "› line 0");
        p.scroll_by(-1000, total, 5);
        assert_eq!(p.scroll, 0);
    }

    #[test]
    fn a_new_prompt_jumps_back_to_the_tail() {
        let mut p = ChatPane::new();
        for i in 0..10 { p.push_user(&format!("l{i}")); }
        p.scroll_by(5, 10, 3);
        assert!(p.scroll > 0);
        p.push_user("newest");
        assert_eq!(p.scroll, 0);
    }
}
