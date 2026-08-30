//! 2.3 Chat pane: pi's RPC event stream rendered as a transcript —
//! streaming assistant text, thinking blocks, tool cards, diff blocks.
//! Pure state + pure rendering; the event loop only feeds it `AgentEvent`s.
use crate::cockpit::Pane;
use crate::md::{self, SegStyle};
use crate::pane::PaneView;
use crate::rpc::{AgentEvent, TurnStats};
use crate::sessions::Msg;
use crate::theme;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

#[derive(Debug, Clone, PartialEq)]
pub enum Entry {
    User(String),
    /// Assistant prose. `streaming` while deltas are still arriving.
    Assistant { text: String, streaming: bool },
    Thinking(String),
    /// One tool call. `ok` is None while it is still running; `output` is what
    /// it returned, kept so the card can be opened.
    Tool { id: String, name: String, args: String, ok: Option<bool>, output: String },
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
    /// All tool cards open, regardless of which one is focused.
    pub show_tools: bool,
    /// Indices of individually opened entries. A per-block set rather than one
    /// global flag: reading one tool's output should not bury the transcript
    /// under every other one.
    pub opened: Vec<usize>,
    /// Which foldable block the keys act on, as an index into `foldable()`.
    /// None until the first `[`/`]`, so the pane starts with no cursor to
    /// explain.
    pub focus: Option<usize>,
}

impl ChatPane {
    pub fn new() -> Self { Self::default() }

    /// Rebuild the transcript from a stored session (gap 1: resume).
    ///
    /// A resumed session must LOOK resumed — the same entries a live run would
    /// have produced, not an empty pane with a status line claiming otherwise.
    pub fn from_transcript(msgs: &[Msg]) -> Self {
        let mut pane = Self::new();
        for m in msgs {
            pane.entries.push(match m {
                Msg::User(t) => Entry::User(t.clone()),
                Msg::Assistant(t) => Entry::Assistant { text: t.clone(), streaming: false },
                Msg::Thinking(t) => Entry::Thinking(t.clone()),
                Msg::Tool { id, name, args, ok } => Entry::Tool {
                    id: id.clone(), name: name.clone(), args: args.clone(), ok: *ok,
                    // a stored session records the call, not what came back
                    output: String::new(),
                },
            });
        }
        pane
    }

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
                self.entries.push(Entry::Tool { id, name, args, ok: None, output: String::new() }),
            AgentEvent::ToolEnd { id, ok, name, output } => {
                match self.entries.iter_mut().rev().find(|e| matches!(e, Entry::Tool { id: i, .. } if *i == id)) {
                    Some(Entry::Tool { ok: slot, output: out, .. }) => { *slot = Some(ok); *out = output; }
                    // an end without a start still has to be visible
                    _ => self.entries.push(Entry::Tool {
                        id, name, args: String::new(), ok: Some(ok), output,
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
        let focused = self.focused_entry();
        for (i, e) in self.entries.iter().enumerate() {
            // a blank line before each of your messages: the turn boundary is
            // the thing the eye needs most and costs one row
            if matches!(e, Entry::User(_)) && !all.is_empty() { all.push(Line::from("")); }
            all.extend(render_entry(e, self.is_open(i), focused == Some(i)));
        }
        if height == 0 || all.len() <= height { return all; }
        let end = all.len().saturating_sub(self.scroll);
        let start = end.saturating_sub(height);
        all[start..end].to_vec()
    }

    /// Entries that can be opened: thinking blocks and tool cards.
    ///
    /// Returned as indices into `entries` so the cursor survives new messages
    /// arriving — a position counted from the end would move under you every
    /// time the agent said something.
    pub fn foldable(&self) -> Vec<usize> {
        self.entries.iter().enumerate()
            .filter(|(_, e)| matches!(e, Entry::Thinking(_) | Entry::Tool { .. }))
            .map(|(i, _)| i)
            .collect()
    }

    /// The entry index the fold keys act on.
    pub fn focused_entry(&self) -> Option<usize> {
        let f = self.foldable();
        f.get(self.focus?.min(f.len().saturating_sub(1))).copied()
    }

    /// Move the cursor to the next (or previous) foldable block.
    ///
    /// The first press lands on the LAST block rather than the first: the
    /// transcript is tail-anchored, so the block you want is the one you can
    /// see, not one thousands of lines up.
    pub fn move_focus(&mut self, delta: isize) {
        let n = self.foldable().len();
        if n == 0 { self.focus = None; return }
        self.focus = Some(match self.focus {
            None if delta < 0 => n - 1,
            None => n - 1,
            Some(i) => (i as isize + delta).clamp(0, n as isize - 1) as usize,
        });
    }

    /// Is this entry rendered open?
    pub fn is_open(&self, index: usize) -> bool {
        if self.opened.contains(&index) { return true }
        match self.entries.get(index) {
            Some(Entry::Thinking(_)) => self.show_thinking,
            Some(Entry::Tool { .. }) => self.show_tools,
            _ => false,
        }
    }

    /// Open or close the focused block.
    pub fn toggle_focused(&mut self) -> bool {
        let Some(index) = self.focused_entry() else { return false };
        // an entry covered by a show-all flag has to be removable from it,
        // so toggling it individually clears the flag for this one entry
        match self.opened.iter().position(|i| *i == index) {
            Some(at) => { self.opened.remove(at); }
            None => self.opened.push(index),
        }
        true
    }

    /// The text `y` puts on the clipboard: the focused block, or the whole
    /// transcript when nothing is focused.
    pub fn yank_text(&self) -> String {
        match self.focused_entry().and_then(|i| self.entries.get(i)) {
            Some(e) => entry_text(e),
            None => self.entries.iter().map(entry_text).collect::<Vec<_>>().join("\n"),
        }
    }

    /// Which entry produced each visible line, for a mouse click.
    ///
    /// Rendering is the only thing that knows a block became six lines, so the
    /// map is built the same way the lines are — deriving it separately is how
    /// a click lands one block off after a folding change.
    pub fn line_owners(&self, height: usize) -> Vec<Option<usize>> {
        let mut owners: Vec<Option<usize>> = Vec::new();
        let focused = self.focused_entry();
        for (i, e) in self.entries.iter().enumerate() {
            if matches!(e, Entry::User(_)) && !owners.is_empty() { owners.push(None); }
            let n = render_entry(e, self.is_open(i), focused == Some(i)).len();
            owners.extend(std::iter::repeat(Some(i)).take(n));
        }
        if height == 0 || owners.len() <= height { return owners }
        let end = owners.len().saturating_sub(self.scroll);
        let start = end.saturating_sub(height);
        owners[start..end].to_vec()
    }

    /// Put the fold cursor on the entry drawn at `row`, if it can be folded.
    pub fn focus_at_row(&mut self, row: usize, height: usize) -> bool {
        let Some(Some(entry)) = self.line_owners(height).get(row).copied() else { return false };
        let Some(at) = self.foldable().iter().position(|i| *i == entry) else { return false };
        self.focus = Some(at);
        true
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
            // [ and ] walk the foldable blocks; o opens the one under the caret
            KeyCode::Char('[') => { self.move_focus(-1); true }
            KeyCode::Char(']') => { self.move_focus(1); true }
            KeyCode::Char('o') => self.toggle_focused(),
            KeyCode::Esc => { self.focus = None; true }
            // and the two show-everything switches, for when you want the lot
            KeyCode::Char('t') => { self.show_thinking = !self.show_thinking; true }
            KeyCode::Char('T') => { self.show_tools = !self.show_tools; true }
            KeyCode::PageUp => { self.scroll_by(height as isize, total, height); true }
            KeyCode::PageDown => { self.scroll_by(-(height as isize), total, height); true }
            _ => false,
        }
    }

    fn status(&self) -> String {
        let tools = self.entries.iter().filter(|e| matches!(e, Entry::Tool { .. })).count();
        let here = match self.focus {
            Some(_) => format!(" · block {}/{}",
                self.focus.unwrap_or(0) + 1, self.foldable().len().max(1)),
            None => String::new(),
        };
        format!("{} entries · {tools} tool calls{here}", self.entries.len())
    }

    fn help(&self) -> Vec<(&'static str, &'static str)> {
        vec![
            ("[ / ]", "previous / next thinking or tool block"),
            ("o", "open or close the block under ▶"),
            ("t / T", "open or close ALL thinking / ALL tools"),
            ("y", "copy the focused block (or the transcript)"),
            ("esc", "drop the block cursor"),
            ("pgup/pgdn", "scroll transcript"),
        ]
    }
}

fn seg_style(s: SegStyle) -> Style {
    match s {
        SegStyle::Plain => Style::default().fg(theme::WHITE),
        SegStyle::Heading => Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD),
        SegStyle::Bold => Style::default().fg(theme::WHITE).add_modifier(Modifier::BOLD),
        SegStyle::Code => Style::default().fg(theme::GREEN),
        SegStyle::Url => Style::default().fg(theme::BLUE).add_modifier(Modifier::UNDERLINED),
    }
}

/// Tool cards get a status dot, and say whether there is anything to open.
fn tool_line(name: &str, args: &str, ok: Option<bool>, focused: bool, open: bool, output: &str)
    -> Line<'static>
{
    let (dot, color) = match ok {
        None => ("◐", theme::ORANGE),
        Some(true) => ("●", theme::GREEN),
        Some(false) => ("●", theme::RED),
    };
    let hint = match (output.is_empty(), open) {
        (true, _) => String::new(),
        (false, true) => "  ▾".into(),
        // say how much is behind the fold, so opening it is an informed choice
        (false, false) => format!("  ▸ {} lines", output.lines().count()),
    };
    Line::from(vec![
        caret(focused),
        Span::styled(format!("{dot} "), Style::default().fg(color)),
        Span::styled(name.to_string(), Style::default().fg(theme::BLUE).add_modifier(Modifier::BOLD)),
        Span::styled(format!(" {args}"), Style::default().fg(theme::GREY)),
        Span::styled(hint, Style::default().fg(theme::INDIGO)),
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

/// Every entry is drawn with a two-cell gutter, so who is speaking is a
/// column you can scan rather than a punctuation mark you have to read.
///
///   ▊  you        accent, solid — your own words
///   │  the agent  dim rail
///   ·  thinking   indigo
///   ●  a tool     green/red/orange by state
fn gutter(mark: &str, color: ratatui::style::Color) -> Span<'static> {
    Span::styled(format!("{mark:<2}"), Style::default().fg(color))
}

/// A caret marking the block the fold keys act on.
fn caret(focused: bool) -> Span<'static> {
    if focused {
        Span::styled("▶", Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD))
    } else {
        Span::raw(" ")
    }
}

/// Flatten one entry to plain text, for the clipboard.
pub fn entry_text(e: &Entry) -> String {
    match e {
        Entry::User(t) => t.clone(),
        Entry::Assistant { text, .. } => text.clone(),
        Entry::Thinking(t) => t.clone(),
        Entry::Tool { name, args, output, .. } =>
            if output.is_empty() { format!("{name} {args}") } else { format!("{name} {args}\n{output}") },
        Entry::Stats(s) => format!("{}/{} {}in {}out ${:.4}",
            s.provider, s.model, s.tokens_in, s.tokens_out, s.cost),
        Entry::Error(e) => e.clone(),
    }
}

fn render_entry(e: &Entry, open: bool, focused: bool) -> Vec<Line<'static>> {
    match e {
        Entry::User(t) => t.lines().enumerate().map(|(i, l)| Line::from(vec![
            // the bar runs the full height of a multi-line message, so a
            // pasted block still reads as one thing you said
            gutter("▊", theme::ACCENT),
            Span::styled(l.to_string(), Style::default()
                .fg(if i == 0 { theme::WHITE } else { theme::PEACH })
                .add_modifier(Modifier::BOLD)),
        ])).collect(),
        Entry::Assistant { text, streaming } => {
            let rail = || gutter("│", theme::DARKGREY);
            if is_diff(text) {
                return text.lines().map(|l| {
                    let d = diff_line(l);
                    Line::from(std::iter::once(rail()).chain(d.spans).collect::<Vec<_>>())
                }).collect();
            }
            let mut lines: Vec<Line<'static>> = md::render_markdown(text)
                .into_iter()
                .map(|segs| Line::from(
                    std::iter::once(rail())
                        .chain(segs.into_iter().map(|s| Span::styled(s.text, seg_style(s.style))))
                        .collect::<Vec<_>>(),
                ))
                .collect();
            if *streaming {
                lines.push(Line::from(vec![rail(),
                    Span::styled("▌", Style::default().fg(theme::ACCENT))]));
            }
            lines
        }
        Entry::Thinking(t) => {
            let style = Style::default().fg(theme::INDIGO);
            let head = |label: String| Line::from(vec![
                caret(focused), gutter("·", theme::INDIGO),
                Span::styled(label, style.add_modifier(Modifier::DIM)),
            ]);
            if open {
                std::iter::once(head("thinking".into()))
                    .chain(t.lines().map(|l| Line::from(vec![
                        Span::raw(" "), gutter("·", theme::DARKGREY),
                        Span::styled(l.to_string(), style),
                    ])))
                    .collect()
            } else {
                let words = t.split_whitespace().count();
                vec![head(format!("thinking ({words} words) — o to open"))]
            }
        }
        Entry::Tool { name, args, ok, output, .. } => {
            let mut out = vec![tool_line(name, args, *ok, focused, open, output)];
            if open && !output.is_empty() {
                let color = if *ok == Some(false) { theme::RED } else { theme::GREY };
                out.extend(output.lines().map(|l| Line::from(vec![
                    Span::raw(" "), gutter("│", theme::DARKGREY),
                    Span::styled(l.to_string(), Style::default().fg(color)),
                ])));
            }
            out
        }
        Entry::Stats(s) => vec![Line::from(vec![
            Span::raw(" "), gutter(" ", theme::GREY),
            Span::styled(
                format!("{}/{} · {}↑ {}↓ tok · ${:.4} · {}",
                    s.provider, s.model, s.tokens_in, s.tokens_out, s.cost, s.stop_reason),
                Style::default().fg(theme::GREY)),
        ])],
        Entry::Error(e) => vec![Line::from(vec![
            gutter("▊", theme::RED),
            Span::styled(format!("✖ {e}"),
                Style::default().fg(theme::RED).add_modifier(Modifier::BOLD)),
        ])],
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
        p.apply(AgentEvent::ToolEnd { id: "t1".into(), name: "bash_exec".into(), ok: false, output: String::new() });
        let line = &p.lines(0)[0];
        // span 0 is the focus caret, blank until [ or ] puts a cursor here
        assert_eq!(line.spans[0].content.as_ref(), " ");
        assert_eq!(line.spans[1].content.as_ref(), "● ");
        assert_eq!(line.spans[1].style.fg, Some(theme::RED));
        assert_eq!(p.entries.len(), 1, "the end updates the card, it does not add one");
    }

    #[test]
    fn an_orphan_tool_end_is_still_shown() {
        let mut p = ChatPane::new();
        p.apply(AgentEvent::ToolEnd { id: "x".into(), name: "ghost".into(), ok: true, output: String::new() });
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
        // span 0 is the agent's gutter rail; the marker colour is span 1
        let colors: Vec<_> = lines.iter().map(|l| l.spans[1].style.fg).collect();
        assert_eq!(colors[1], Some(theme::GREEN), "+++ header");
        assert_eq!(colors[2], Some(theme::BLUE), "@@ hunk");
        assert_eq!(colors[3], Some(theme::RED), "removal");
        assert_eq!(colors[4], Some(theme::GREEN), "addition");
        assert!(lines.iter().all(|l| l.spans[0].style.fg == Some(theme::DARKGREY)),
            "every agent line carries the rail");
    }

    #[test]
    fn markdown_is_rendered_for_completed_prose() {
        let mut p = ChatPane::new();
        p.apply(AgentEvent::Text { text: "# Title\nplain `code` here".into(), final_: true });
        let lines = p.lines(0);
        assert_eq!(lines[0].spans[1].style.fg, Some(theme::ACCENT), "heading, after the rail");
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
        // 20 messages plus the blank turn separator before all but the first
        assert_eq!(total, 39);
        let shown = p.lines(5);
        assert_eq!(text(&shown[4]), "▊ line 19", "tail is what you see by default");
        p.scroll_by(10, total, 5);
        assert_eq!(text(&p.lines(5)[4]), "▊ line 14");
        // cannot scroll past the top or below the tail
        p.scroll_by(1000, total, 5);
        assert_eq!(text(&p.lines(5)[0]), "▊ line 0");
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

#[cfg(test)]
mod fold_tests {
    use super::*;
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

    fn key(c: char) -> KeyEvent { KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE) }
    fn text(l: &Line) -> String { l.spans.iter().map(|s| s.content.to_string()).collect() }
    fn rendered(p: &ChatPane) -> Vec<String> { p.lines(0).iter().map(text).collect() }

    fn conversation() -> ChatPane {
        let mut p = ChatPane::new();
        p.push_user("list the files");
        p.apply(AgentEvent::Thinking("I should look at the directory first".into()));
        p.apply(AgentEvent::ToolStart {
            id: "t1".into(), name: "bash_exec".into(), args: "command=ls".into() });
        p.apply(AgentEvent::ToolEnd {
            id: "t1".into(), name: "bash_exec".into(), ok: true,
            output: "a.rs\nb.rs\nc.rs".into() });
        p.apply(AgentEvent::Text { text: "Three files.".into(), final_: true });
        p
    }

    #[test]
    fn a_tool_card_says_how_much_is_behind_the_fold() {
        // opening a block should be an informed choice, not a surprise
        let p = conversation();
        let out = rendered(&p);
        assert!(out.iter().any(|l| l.contains("▸ 3 lines")), "{out:?}");
        assert!(!out.iter().any(|l| l.contains("a.rs")), "closed by default");
    }

    #[test]
    fn brackets_walk_the_blocks_and_o_opens_the_one_under_the_caret() {
        let mut p = conversation();
        assert_eq!(p.foldable().len(), 2, "one thinking block, one tool call");
        assert!(p.focus.is_none(), "no cursor until you ask for one");

        // the first press lands on the LAST block: the transcript is
        // tail-anchored, so that is the one on screen
        p.on_key(key(']'), 20);
        assert!(matches!(p.entries[p.focused_entry().unwrap()], Entry::Tool { .. }));
        assert!(p.on_key(key('o'), 20));
        let out = rendered(&p);
        assert!(out.iter().any(|l| l.contains("a.rs")), "the output is now on screen: {out:?}");
        assert!(out.iter().any(|l| l.contains("▾")), "and the card says it is open");

        // back one, and the thinking block opens independently
        p.on_key(key('['), 20);
        assert!(matches!(p.entries[p.focused_entry().unwrap()], Entry::Thinking(_)));
        p.on_key(key('o'), 20);
        let out = rendered(&p);
        assert!(out.iter().any(|l| l.contains("I should look at the directory")), "{out:?}");
        assert!(out.iter().any(|l| l.contains("a.rs")), "the tool stayed open");
    }

    #[test]
    fn opening_one_block_does_not_open_the_others() {
        // the whole reason for a per-block key: reading one tool's output
        // must not bury the transcript under every other one
        let mut p = conversation();
        p.apply(AgentEvent::ToolStart {
            id: "t2".into(), name: "read_file".into(), args: "path=a.rs".into() });
        p.apply(AgentEvent::ToolEnd {
            id: "t2".into(), name: "read_file".into(), ok: true, output: "fn main() {}".into() });
        p.on_key(key(']'), 20);
        p.on_key(key('o'), 20);
        let out = rendered(&p);
        assert!(out.iter().any(|l| l.contains("fn main()")));
        assert!(!out.iter().any(|l| l.contains("a.rs\n")), "the other card stayed shut");
        assert!(!out.iter().any(|l| l.contains("b.rs")), "{out:?}");
    }

    #[test]
    fn t_and_shift_t_still_open_everything_at_once() {
        let mut p = conversation();
        p.on_key(key('t'), 20);
        assert!(rendered(&p).iter().any(|l| l.contains("I should look at")));
        p.on_key(key('T'), 20);
        assert!(rendered(&p).iter().any(|l| l.contains("b.rs")));
    }

    #[test]
    fn the_caret_survives_the_agent_saying_more() {
        // a cursor counted from the end would move under you every time a
        // message arrived
        let mut p = conversation();
        p.on_key(key('['), 20);
        p.on_key(key('['), 20);
        let before = p.focused_entry();
        assert!(matches!(p.entries[before.unwrap()], Entry::Thinking(_)));
        p.apply(AgentEvent::Text { text: "and more".into(), final_: true });
        p.apply(AgentEvent::ToolStart {
            id: "t9".into(), name: "glob_list".into(), args: "".into() });
        assert_eq!(p.focused_entry(), before, "still pointing at the same block");
    }

    #[test]
    fn esc_drops_the_cursor() {
        let mut p = conversation();
        p.on_key(key(']'), 20);
        assert!(p.focus.is_some());
        p.on_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE), 20);
        assert!(p.focus.is_none());
        assert!(!rendered(&p).iter().any(|l| l.starts_with("▶")), "no caret on screen");
    }

    #[test]
    fn a_tool_with_no_output_offers_nothing_to_open() {
        let mut p = ChatPane::new();
        p.apply(AgentEvent::ToolStart { id: "t".into(), name: "noop".into(), args: "".into() });
        p.apply(AgentEvent::ToolEnd {
            id: "t".into(), name: "noop".into(), ok: true, output: String::new() });
        let out = rendered(&p);
        assert!(!out.iter().any(|l| l.contains("▸")), "no fold marker: {out:?}");
        p.on_key(key(']'), 20);
        p.on_key(key('o'), 20);
        assert_eq!(rendered(&p).len(), 1, "opening an empty card adds no lines");
    }

    #[test]
    fn you_and_the_agent_are_told_apart_by_a_column_not_a_glyph() {
        let p = conversation();
        let lines = p.lines(0);
        let user = lines.iter().find(|l| text(l).contains("list the files")).unwrap();
        assert_eq!(user.spans[0].content.as_ref(), "▊ ");
        assert_eq!(user.spans[0].style.fg, Some(theme::ACCENT));

        let agent = lines.iter().find(|l| text(l).contains("Three files.")).unwrap();
        assert_eq!(agent.spans[0].content.as_ref(), "│ ");
        assert_eq!(agent.spans[0].style.fg, Some(theme::DARKGREY));
    }

    #[test]
    fn a_turn_boundary_gets_a_blank_line_but_the_transcript_does_not_start_with_one() {
        let mut p = ChatPane::new();
        p.push_user("first");
        assert_eq!(p.lines(0).len(), 1, "no leading blank");
        p.apply(AgentEvent::Text { text: "ok".into(), final_: true });
        p.push_user("second");
        let out = rendered(&p);
        assert_eq!(out[2], "", "the blank sits before your next message");
        assert!(out[3].contains("second"));
    }

    #[test]
    fn a_multi_line_message_keeps_its_bar_the_whole_way_down() {
        // a pasted block has to read as one thing you said
        let mut p = ChatPane::new();
        p.push_user("line one\nline two\nline three");
        let lines = p.lines(0);
        assert_eq!(lines.len(), 3);
        assert!(lines.iter().all(|l| l.spans[0].content.as_ref() == "▊ "), "{lines:?}");
    }

    #[test]
    fn yank_takes_the_focused_block_or_the_whole_transcript() {
        let mut p = conversation();
        assert!(p.yank_text().contains("list the files"), "nothing focused: everything");
        assert!(p.yank_text().contains("Three files."));

        p.on_key(key(']'), 20);
        let one = p.yank_text();
        assert!(one.contains("a.rs") && one.contains("bash_exec"), "{one}");
        assert!(!one.contains("Three files."), "just the block: {one}");
    }
}

#[cfg(test)]
mod mouse_tests {
    use super::*;

    fn pane() -> ChatPane {
        let mut p = ChatPane::new();
        p.push_user("go");
        p.apply(AgentEvent::Thinking("hmm".into()));
        p.apply(AgentEvent::Text { text: "one\ntwo".into(), final_: true });
        p.apply(AgentEvent::ToolStart { id: "t".into(), name: "ls".into(), args: "".into() });
        p.apply(AgentEvent::ToolEnd {
            id: "t".into(), name: "ls".into(), ok: true, output: "a\nb".into() });
        p
    }

    #[test]
    fn every_drawn_line_knows_which_block_it_came_from() {
        // rendering is the only thing that knows a block became six lines, so
        // deriving the map separately is how a click lands one block off
        let p = pane();
        let owners = p.line_owners(0);
        assert_eq!(owners.len(), p.lines(0).len(), "one owner per drawn line");
        assert_eq!(owners[0], Some(0), "your message");
        assert_eq!(owners[1], Some(1), "the thinking block");
        assert_eq!(owners[2], Some(2), "the agent's first line");
        assert_eq!(owners[3], Some(2), "and its second");
        assert_eq!(owners[4], Some(3), "the tool card");
    }

    #[test]
    fn the_map_follows_a_block_being_opened() {
        let mut p = pane();
        let before = p.line_owners(0).len();
        p.focus = Some(1); // the tool
        p.toggle_focused();
        let after = p.line_owners(0);
        assert_eq!(after.len(), before + 2, "two lines of output appeared");
        assert_eq!(after.len(), p.lines(0).len(), "and the map still matches");
        assert_eq!(*after.last().unwrap(), Some(3), "they belong to the tool");
    }

    #[test]
    fn clicking_a_foldable_row_focuses_it_and_clicking_prose_does_not() {
        let mut p = pane();
        assert!(p.focus_at_row(1, 0), "the thinking block is clickable");
        assert!(matches!(p.entries[p.focused_entry().unwrap()], Entry::Thinking(_)));
        assert!(!p.focus_at_row(2, 0), "prose is not a block you can open");
        assert!(!p.focus_at_row(999, 0), "a click past the end is not a panic");
    }

    #[test]
    fn the_map_respects_the_scroll_window_so_a_click_hits_what_you_see() {
        let mut p = ChatPane::new();
        for i in 0..10 {
            p.apply(AgentEvent::Thinking(format!("t{i}")));
            p.apply(AgentEvent::Text { text: format!("m{i}"), final_: true });
        }
        let height = 4;
        let owners = p.line_owners(height);
        assert_eq!(owners.len(), height);
        let visible = p.lines(height);
        assert_eq!(visible.len(), height);
        // the last visible line belongs to the last entry
        assert_eq!(*owners.last().unwrap(), Some(p.entries.len() - 1));

        p.scroll_by(2, p.lines(0).len(), height);
        let scrolled = p.line_owners(height);
        assert_ne!(scrolled, owners, "scrolling moves what a row points at");
        assert_eq!(scrolled.len(), p.lines(height).len());
    }
}
