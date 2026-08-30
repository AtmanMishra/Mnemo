//! 2.2 Cockpit chrome: nav rail + main pane + input/status bar.
//! Pane bodies are filled in by 2.3-2.7; this module owns the frame around them.
use crate::cockpit::{Cockpit, Focus, Pane};
use crate::theme;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, Paragraph};
use ratatui::Frame;

/// Nav rail width: "▶ 1 Memory" plus borders.
pub const RAIL_WIDTH: u16 = 14;
const INPUT_HEIGHT: u16 = 3;
const STATUS_HEIGHT: u16 = 1;

/// Split the screen into (rail, body, input, status).
pub fn layout(area: Rect) -> (Rect, Rect, Rect, Rect) {
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Length(RAIL_WIDTH), Constraint::Min(10)])
        .split(area);
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(3),
            Constraint::Length(INPUT_HEIGHT),
            Constraint::Length(STATUS_HEIGHT),
        ])
        .split(cols[1]);
    (cols[0], rows[0], rows[1], rows[2])
}

/// A focus ring: the focused region gets a thick yellow border, the rest grey.
pub fn ring(focused: bool) -> Block<'static> {
    let (color, kind) = if focused {
        (theme::YELLOW, BorderType::Thick)
    } else {
        (theme::GREY, BorderType::Plain)
    };
    Block::default()
        .borders(Borders::ALL)
        .border_type(kind)
        .border_style(Style::default().fg(color))
}

/// One rail row per pane: "▶ 1 Chat" for the active one, "  2 Memory" otherwise.
pub fn rail_lines(active: Pane) -> Vec<Line<'static>> {
    Pane::ALL
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let on = *p == active;
            let marker = if on { "▶" } else { " " };
            let style = if on {
                Style::default().fg(theme::YELLOW).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(theme::GREY)
            };
            Line::from(Span::styled(format!("{marker} {} {}", i + 1, p.label()), style))
        })
        .collect()
}

/// Status bar: pane, focus and whatever the app last reported.
pub fn status_line(c: &Cockpit) -> Line<'static> {
    let hint = match c.focus {
        Focus::Input => "enter send · esc body",
        Focus::Main => "i input · j/k move · q quit",
    };
    Line::from(vec![
        Span::styled(format!(" {} ", c.pane.label().to_uppercase()),
            Style::default().fg(theme::BLACK).bg(theme::YELLOW).add_modifier(Modifier::BOLD)),
        Span::styled(format!(" {} ", c.status), Style::default().fg(theme::WHITE)),
        Span::styled(format!("· tab pane · {hint}"), Style::default().fg(theme::GREY)),
    ])
}

/// Draw the shell. `body` is the pane's own rendered content.
pub fn draw(f: &mut Frame, c: &Cockpit, body: Vec<Line<'static>>) {
    let (rail, main, input, status) = layout(f.area());

    f.render_widget(
        Paragraph::new(rail_lines(c.pane))
            .block(ring(false).title(Span::styled("MNEMO", theme::title_style()))),
        rail,
    );
    f.render_widget(
        Paragraph::new(body).block(
            ring(c.focus == Focus::Main)
                .title(Span::styled(theme::title(c.pane.label()), theme::title_style())),
        ),
        main,
    );
    f.render_widget(
        Paragraph::new(Line::from(format!("› {}", c.input)))
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
        assert_eq!(lines.len(), 5);
        let marked: Vec<String> = lines.iter()
            .map(|l| l.spans[0].content.to_string())
            .filter(|s| s.starts_with('▶'))
            .collect();
        assert_eq!(marked, vec!["▶ 3 Agents"]);
        assert_eq!(lines[0].spans[0].style.fg, Some(theme::GREY));
        assert_eq!(lines[2].spans[0].style.fg, Some(theme::YELLOW));
    }

    #[test]
    fn focus_ring_follows_focus() {
        // the focused region is visibly different from the idle one
        assert_ne!(format!("{:?}", ring(true)), format!("{:?}", ring(false)));
        // and it renders with the focus colour
        let mut term = ratatui::Terminal::new(TestBackend::new(10, 3)).unwrap();
        term.draw(|f| f.render_widget(ring(true), f.area())).unwrap();
        let cell = term.backend().buffer()[(0, 0)].clone();
        assert_eq!(cell.fg, theme::YELLOW);
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
}
