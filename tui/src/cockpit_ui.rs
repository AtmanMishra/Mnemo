//! 2.2 Cockpit chrome: nav rail + main pane + input/status bar.
//! Pane bodies are filled in by 2.3-2.7; this module owns the frame around them.
use crate::cockpit::{Cockpit, Focus, Pane};
use crate::palette;
use crate::theme;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, Paragraph, Wrap};
use ratatui::Frame;

/// Nav rail width: "▶ 1 Memory" plus borders.
pub const RAIL_WIDTH: u16 = 14;
const INPUT_HEIGHT: u16 = 3;
/// A queue longer than this is summarised rather than listed: the transcript
/// it is waiting behind matters more than the tail of the queue.
const MAX_QUEUE_ROWS: usize = 4;
const STATUS_HEIGHT: u16 = 1;

/// Split the screen into (rail, body, input, status).
///
/// `queued` grows the input box so waiting messages are on screen rather than
/// clipped by a fixed-height box — capped, because a long queue must not eat
/// the transcript it is queued behind.
pub fn layout_with(area: Rect, queued: usize) -> (Rect, Rect, Rect, Rect) {
    let extra = queued.min(MAX_QUEUE_ROWS) as u16;
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Length(RAIL_WIDTH), Constraint::Min(10)])
        .split(area);
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(3),
            Constraint::Length(INPUT_HEIGHT + extra),
            Constraint::Length(STATUS_HEIGHT),
        ])
        .split(cols[1]);
    (cols[0], rows[0], rows[1], rows[2])
}

/// The common case: nothing queued.
pub fn layout(area: Rect) -> (Rect, Rect, Rect, Rect) {
    layout_with(area, 0)
}

/// Pane chrome. PIXEL rule 2: double-line borders for chrome, never nested.
/// Focus is carried by colour (rule 1: colour = state), not by a second frame.
pub fn ring(focused: bool) -> Block<'static> {
    let color = if focused { theme::ACCENT } else { theme::GREY };
    Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Double)
        .border_style(Style::default().fg(color))
}

/// One rail row per pane: "▶ 1 Chat" for the active one, "  2 Memory" otherwise.
pub fn rail_lines(active: Pane) -> Vec<Line<'static>> {
    rail_lines_with(active, &[None; 6])
}

/// The rail, with a count beside each pane.
///
/// A rail of six nouns is a menu of six guesses. A count answers the first
/// question you actually have — is there anything in there? — without making
/// you visit every tab to find out.
pub fn rail_lines_with(active: Pane, badges: &[Option<usize>]) -> Vec<Line<'static>> {
    Pane::ALL
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let on = *p == active;
            let marker = if on { "▶" } else { " " };
            let style = if on {
                Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(theme::WHITE)
            };
            let mut spans = vec![
                Span::styled(format!("{marker} {} {}", i + 1, p.label()), style),
            ];
            if let Some(Some(n)) = badges.get(i) {
                // a zero is worth showing: "nothing here yet" is information
                spans.push(Span::styled(
                    format!("  {n}"),
                    Style::default().fg(if *n == 0 { theme::DARKGREY } else { theme::INDIGO }),
                ));
            }
            Line::from(spans)
        })
        .collect()
}

/// Overlay rows shown under the prompt: the `/` command palette, or the `?`
/// help card. Returns an empty vec when neither is open.
pub fn overlay_lines(c: &Cockpit, pane_help: &[(&'static str, &'static str)]) -> Vec<Line<'static>> {
    if c.show_help {
        let mut out = vec![Line::from(Span::styled(
            theme::title("keys"), theme::title_style()))];
        let global = [
            ("tab / shift-tab", "next / previous pane"),
            ("alt+1..6", "jump to a pane"),
            ("esc", "leave the prompt, focus the body"),
            ("i / enter", "focus the prompt"),
            ("enter", "send — or queue it, if the agent is working"),
            ("alt+enter", "interrupt the running turn with this instead"),
            ("/", "command palette"),
            ("?", "this card"),
            ("ctrl+c", "quit"),
        ];
        for (k, d) in global.iter().chain(pane_help.iter()) {
            out.push(Line::from(vec![
                Span::styled(format!("  {k:<16}"), Style::default().fg(theme::ACCENT)),
                Span::styled((*d).to_string(), Style::default().fg(theme::WHITE)),
            ]));
        }
        return out;
    }
    palette::matches(&c.input).into_iter().map(|cmd| Line::from(vec![
        Span::styled(format!("  {:<14}", cmd.name),
            Style::default().fg(theme::GREEN).add_modifier(Modifier::BOLD)),
        Span::styled(cmd.help.to_string(), Style::default().fg(theme::GREY)),
    ])).collect()
}

/// The prompt, plus anything waiting behind it.
///
/// A queued message has to be visible: typing while the agent works is normal,
/// and a message that vanished into a buffer with no sign of it is
/// indistinguishable from one that was dropped.
pub fn prompt_lines(c: &Cockpit, cursor: &str) -> Vec<Line<'static>> {
    let mut out = vec![Line::from(vec![
        Span::styled("› ", Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD)),
        Span::styled(c.input.clone(), Style::default().fg(theme::WHITE)),
        Span::styled(cursor.to_string(), Style::default().fg(theme::ACCENT)),
    ])];
    for (i, q) in c.queued.iter().take(MAX_QUEUE_ROWS).enumerate() {
        out.push(Line::from(vec![
            Span::styled(format!("{}. ", i + 1), Style::default().fg(theme::INDIGO)),
            Span::styled(q.clone(), Style::default().fg(theme::INDIGO)),
        ]));
    }
    if c.queued.len() > MAX_QUEUE_ROWS {
        out.push(Line::from(Span::styled(
            format!("   +{} more queued", c.queued.len() - MAX_QUEUE_ROWS),
            Style::default().fg(theme::GREY),
        )));
    }
    out
}

/// Status bar: pane, focus and whatever the app last reported.
pub fn status_line(c: &Cockpit) -> Line<'static> {
    let hint = match (c.focus, c.busy) {
        // the two things worth knowing mid-run are exactly the two keys
        (Focus::Input, true) => "enter queue · alt+enter steer · esc body",
        (Focus::Input, false) => "enter send · esc body",
        (Focus::Main, _) => "i input · [ ] blocks · o open · y copy · q quit",
    };
    // colour = state: a session with no model set says so in red, because
    // prompting will fail until it is chosen (8.6)
    let (model_text, model_style) = match &c.model {
        Some((provider, model)) => (
            format!(" {provider}/{model} "),
            Style::default().fg(theme::BLUE),
        ),
        None => (
            " no model — /login or /model ".to_string(),
            Style::default().fg(theme::RED).add_modifier(Modifier::BOLD),
        ),
    };
    Line::from(vec![
        Span::styled(format!(" {} ", c.pane.label().to_uppercase()),
            Style::default().fg(theme::BLACK).bg(theme::ACCENT).add_modifier(Modifier::BOLD)),
        Span::styled(model_text, model_style),
        Span::styled(format!("{} ", c.status), Style::default().fg(theme::WHITE)),
        Span::styled(format!("· tab pane · {hint}"), Style::default().fg(theme::GREY)),
    ])
}

/// Draw the shell. `body` is the pane's own rendered content.
pub fn draw(f: &mut Frame, c: &Cockpit, body: Vec<Line<'static>>) {
    draw_with_help(f, c, body, &[])
}

/// Full-screen onboarding: nothing else is drawn while it is open, because
/// nothing else works yet (8.3).
pub fn draw_onboarding(f: &mut Frame, body: Vec<Line<'static>>) {
    let area = f.area();
    f.render_widget(
        Paragraph::new(body).block(
            ring(true).title(Span::styled(theme::title("welcome"), theme::title_style())),
        ),
        area,
    );
}

/// Draw the shell. `body` is the pane's own rendered content; `pane_help` its
/// key bindings for the `?` card.
pub fn draw_with_help(
    f: &mut Frame,
    c: &Cockpit,
    body: Vec<Line<'static>>,
    pane_help: &[(&'static str, &'static str)],
) {
    draw_full(f, c, body, pane_help, &[None; 6])
}

/// Render the shell. `badges` are the per-pane counts for the rail.
pub fn draw_full(
    f: &mut Frame,
    c: &Cockpit,
    body: Vec<Line<'static>>,
    pane_help: &[(&'static str, &'static str)],
    badges: &[Option<usize>; 6],
) {
    let (rail, main, input, status) = layout_with(f.area(), c.queued.len());
    let overlay = overlay_lines(c, pane_help);

    f.render_widget(
        Paragraph::new(rail_lines_with(c.pane, badges))
            .block(ring(false).title(Span::styled("MNEMO", theme::title_style()))),
        rail,
    );
    // the overlay eats into the body rather than covering it, so nothing the
    // pane is showing is ever hidden behind a popup
    let (main, over) = if overlay.is_empty() {
        (main, None)
    } else {
        let h = (overlay.len() as u16 + 2).min(main.height.saturating_sub(3));
        (
            Rect { height: main.height - h, ..main },
            Some(Rect { y: main.y + main.height - h, height: h, ..main }),
        )
    };
    f.render_widget(
        // Chat wraps its own lines so its tail-anchoring stays honest; this
        // is the safety net for every other pane
        Paragraph::new(body).wrap(Wrap { trim: false }).block(
            ring(c.focus == Focus::Main)
                .title(Span::styled(theme::title(c.pane.label()), theme::title_style())),
        ),
        main,
    );
    if let Some(rect) = over {
        f.render_widget(
            Paragraph::new(overlay).block(ring(false).title(Span::styled(
                if c.show_help { theme::title("help") } else { theme::title("commands") },
                theme::title_style(),
            ))),
            rect,
        );
    }
    // PIXEL rule 7: the prompt cursor pulses while the agent is streaming
    let cursor = if c.busy && c.pulse { "▌" } else { " " };
    f.render_widget(
        // a long prompt wraps rather than running off the right edge
        Paragraph::new(prompt_lines(c, cursor))
            .wrap(Wrap { trim: false })
            .block(ring(c.focus == Focus::Input)),
        input,
    );
    f.render_widget(Paragraph::new(status_line(c)), status);
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    #[test]
    fn layout_reserves_rail_input_and_status() {
        let (rail, main, input, status) = layout(Rect::new(0, 0, 100, 30));
        assert_eq!(rail.width, RAIL_WIDTH);
        assert_eq!(main.x, RAIL_WIDTH, "body starts right of the rail");
        assert_eq!(input.height, INPUT_HEIGHT);
        assert_eq!(status.height, STATUS_HEIGHT);
        assert_eq!(main.height + input.height + status.height, 30);
        // rail is tall enough for all five panes plus borders
        assert!(rail.height >= Pane::ALL.len() as u16 + 2);
    }

    #[test]
    fn rail_marks_only_the_active_pane() {
        let lines = rail_lines(Pane::Agents);
        assert_eq!(lines.len(), Pane::ALL.len());
        let marked: Vec<String> = lines.iter()
            .map(|l| l.spans[0].content.to_string())
            .filter(|s| s.starts_with('▶'))
            .collect();
        assert_eq!(marked, vec!["▶ 4 Agents"]);
        assert_eq!(lines[0].spans[0].style.fg, Some(theme::WHITE),
            "inactive rows stay readable; the accent alone marks the active one");
        assert_eq!(lines[Pane::Agents.index()].spans[0].style.fg, Some(theme::ACCENT));
    }

    #[test]
    fn focus_ring_follows_focus() {
        // the focused region is visibly different from the idle one
        assert_ne!(format!("{:?}", ring(true)), format!("{:?}", ring(false)));
        // and it renders with the focus colour
        let mut term = ratatui::Terminal::new(TestBackend::new(10, 3)).unwrap();
        term.draw(|f| f.render_widget(ring(true), f.area())).unwrap();
        let cell = term.backend().buffer()[(0, 0)].clone();
        assert_eq!(cell.fg, theme::ACCENT);
    }

    #[test]
    fn the_status_bar_says_when_no_model_is_set() {
        let mut c = Cockpit::new();
        assert_eq!(c.model, None);
        let text: String = status_line(&c).spans.iter().map(|s| s.content.to_string()).collect();
        assert!(text.contains("no model"), "an unset model must be visible, not a surprise: {text}");
        assert!(text.contains("/login"), "and it must say how to fix it");
        assert_eq!(status_line(&c).spans[1].style.fg, Some(theme::RED));

        c.model = Some(("anthropic".into(), "claude-opus-5".into()));
        let text: String = status_line(&c).spans.iter().map(|s| s.content.to_string()).collect();
        assert!(text.contains("anthropic/claude-opus-5"));
        assert!(!text.contains("no model"));
    }

    #[test]
    fn status_bar_shows_pane_and_focus_specific_hints() {
        let mut c = Cockpit::new();
        c.status = "ready".into();
        let text: String = status_line(&c).spans.iter().map(|s| s.content.to_string()).collect();
        assert!(text.contains("CHAT") && text.contains("ready") && text.contains("enter send"));
        c.focus = Focus::Main;
        c.pane = Pane::Logs;
        let text: String = status_line(&c).spans.iter().map(|s| s.content.to_string()).collect();
        assert!(text.contains("LOGS") && text.contains("q quit"));
    }

    #[test]
    fn shell_renders_rail_body_and_prompt_together() {
        let mut term = Terminal::new(TestBackend::new(60, 14)).unwrap();
        let mut c = Cockpit::new();
        c.pane = Pane::Memory;
        c.input = "helm rollback".into();
        c.status = "3 nodes".into();
        term.draw(|f| draw(f, &c, vec![Line::from("body goes here")])).unwrap();
        let dump = format!("{:?}", term.backend().buffer());
        for want in ["MNEMO", "Chat", "Memory", "body goes here", "helm rollback", "3 nodes"] {
            assert!(dump.contains(want), "screen missing {want:?}");
        }
    }

    #[test]
    fn typing_a_slash_opens_the_command_palette() {
        let mut c = Cockpit::new();
        c.input = "/cons".into();
        let lines = overlay_lines(&c, &[]);
        assert_eq!(lines.len(), 1);
        let t: String = lines[0].spans.iter().map(|s| s.content.to_string()).collect();
        assert!(t.contains("/consolidate"), "{t}");
        // prose is not a command, so no palette
        c.input = "fix the build".into();
        assert!(overlay_lines(&c, &[]).is_empty());
    }

    #[test]
    fn help_card_lists_global_and_pane_keys_together() {
        let mut c = Cockpit::new();
        c.show_help = true;
        let text: Vec<String> = overlay_lines(&c, &[("t", "toggle thinking")])
            .iter().map(|l| l.spans.iter().map(|s| s.content.to_string()).collect())
            .collect();
        assert!(text.iter().any(|l| l.contains("tab") && l.contains("pane")));
        assert!(text.iter().any(|l| l.contains("toggle thinking")), "pane keys too: {text:?}");
    }

    #[test]
    fn the_overlay_shrinks_the_body_instead_of_covering_it() {
        let mut term = Terminal::new(TestBackend::new(70, 18)).unwrap();
        let mut c = Cockpit::new();
        c.input = "/".into();
        let body: Vec<Line> = (0..3).map(|i| Line::from(format!("body row {i}"))).collect();
        term.draw(|f| draw_with_help(f, &c, body, &[])).unwrap();
        let dump = format!("{:?}", term.backend().buffer());
        assert!(dump.contains("body row 0"), "body must stay visible under the palette");
        assert!(dump.contains("/help"), "palette rendered");
        // more commands than rows: the list clips, the body does not
        assert!(!dump.contains("/quit"), "an overlong palette is clipped, not overlapping");
    }

    #[test]
    fn the_prompt_cursor_pulses_only_while_busy() {
        let mut term = Terminal::new(TestBackend::new(50, 12)).unwrap();
        let mut c = Cockpit::new();
        c.busy = true;
        c.pulse = true;
        term.draw(|f| draw(f, &c, vec![])).unwrap();
        assert!(format!("{:?}", term.backend().buffer()).contains('▌'));
        c.busy = false;
        term.draw(|f| draw(f, &c, vec![])).unwrap();
        assert!(!format!("{:?}", term.backend().buffer()).contains('▌'));
    }
}
