//! Compose functions: draw the PIXEL layout into a ratatui frame.

use crate::app::{AgentState, App, Speaker};
use crate::theme;
use ratatui::layout::{Alignment, Constraint, Layout, Position, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, Clear, Paragraph};
use ratatui::Frame;

/// Greedy word-wrap. Long words are hard-broken at the width boundary.
pub fn wrap(text: &str, width: usize) -> Vec<String> {
    let w = width.max(1);
    let mut out: Vec<String> = Vec::new();
    for para in text.split('\n') {
        if para.is_empty() {
            out.push(String::new());
            continue;
        }
        let mut line = String::new();
        for word in para.split(' ') {
            let mut rest: std::borrow::Cow<str> = std::borrow::Cow::Borrowed(word);
            loop {
                let cur = line.chars().count();
                let rl = rest.chars().count();
                if cur == 0 && rl <= w {
                    line.push_str(&rest);
                    break;
                }
                if cur > 0 && cur + 1 + rl <= w {
                    line.push(' ');
                    line.push_str(&rest);
                    break;
                }
                if cur > 0 {
                    out.push(std::mem::take(&mut line));
                }
                // line is empty here
                if rl > w {
                    let chars: Vec<char> = rest.chars().collect();
                    out.push(chars[..w].iter().collect());
                    rest = std::borrow::Cow::Owned(chars[w..].iter().collect());
                } else {
                    line.push_str(&rest);
                    break;
                }
            }
        }
        out.push(line);
    }
    out
}

pub fn speaker_prefix(speaker: Speaker) -> Span<'static> {
    match speaker {
        Speaker::User => Span::styled("▶ you", Style::default().fg(theme::ORANGE).add_modifier(Modifier::BOLD)),
        Speaker::Agent => Span::styled("◆ sea", Style::default().fg(theme::GREEN).add_modifier(Modifier::BOLD)),
        Speaker::System => Span::styled("·· sys", Style::default().fg(theme::GREY)),
    }
}

fn chat_lines(area_width: u16, app: &App) -> Vec<Line<'static>> {
    let w = area_width.max(4) as usize;
    const INDENT: usize = 7; // "▶ you " width
    let body_w = w.saturating_sub(INDENT);
    let mut lines: Vec<Line> = Vec::new();
    for e in &app.chat {
        let wrapped = {
            let text = e.text.trim_end_matches('\n').to_string();
            if text.is_empty() {
                vec![String::new()]
            } else {
                wrap(&text, body_w)
            }
        };
        let mut first = vec![
            speaker_prefix(e.speaker),
            Span::raw(" "),
            Span::raw(wrapped[0].clone()),
        ];
        lines.push(Line::from(std::mem::take(&mut first)));
        for cont in &wrapped[1..] {
            lines.push(Line::from(vec![
                Span::raw(" ".repeat(INDENT)),
                Span::raw(cont.clone()),
            ]));
        }
        lines.push(Line::from(""));
    }
    lines
}

pub fn draw_chat(f: &mut Frame, area: Rect, app: &App) {
    let block = Block::default()
        .title(Span::styled(theme::title("chat"), theme::title_style()))
        .borders(Borders::ALL)
        .border_type(BorderType::Double)
        .border_style(Style::default().fg(theme::DARKBLUE));
    let inner = block.inner(area);
    f.render_widget(block, area);

    let lines = chat_lines(inner.width, app);
    let visible = inner.height as usize;
    let total = lines.len();
    let skip = if app.autoscroll {
        total.saturating_sub(visible)
    } else {
        total
            .saturating_sub(visible)
            .saturating_sub(app.scroll_up as usize)
    };
    let para = Paragraph::new(lines).scroll((skip.min(u16::MAX as usize) as u16, 0));
    f.render_widget(para, inner);
}

pub fn draw_activity(f: &mut Frame, area: Rect, app: &App) {
    let block = Block::default()
        .title(Span::styled(theme::title("activity"), theme::title_style()))
        .borders(Borders::ALL)
        .border_type(BorderType::Double)
        .border_style(Style::default().fg(theme::DARKBLUE));
    let inner = block.inner(area);
    f.render_widget(block, area);

    let lines: Vec<Line> = app
        .activity
        .iter()
        .take(crate::app::ACTIVITY_CAP)
        .map(|t| {
            let (tag, color) = if t.ok {
                ("ok  ", theme::GREEN)
            } else {
                ("err ", theme::RED)
            };
            Line::from(vec![
                Span::styled(format!("[{}]", tag), Style::default().fg(color)),
                Span::styled(format!(" {}", t.name), Style::default().fg(theme::WHITE)),
            ])
        })
        .collect();
    f.render_widget(Paragraph::new(lines), inner);
}

const MEMORY_HELP: &[&str] = &[
    "The memory layer is attached to",
    "the agent session.",
    "",
    "memory_search(q, k)",
    "  recall facts + past episodes",
    "write_fact(text)",
    "  persist durable knowledge",
    "steer(hint)",
    "  nudge the running agent",
    "",
    "(live memory pane coming soon)",
];

pub fn draw_memory(f: &mut Frame, area: Rect) {
    let block = Block::default()
        .title(Span::styled(theme::title("memory"), theme::title_style()))
        .borders(Borders::ALL)
        .border_type(BorderType::Double)
        .border_style(Style::default().fg(theme::DARKBLUE));
    let inner = block.inner(area);
    f.render_widget(block, area);

    let mut lines: Vec<Line> = MEMORY_HELP
        .iter()
        .map(|s| Line::from(Span::styled(*s, Style::default().fg(theme::WHITE))))
        .collect();
    lines.push(Line::from(""));
    lines.push(Line::from(vec![
        Span::styled("ctx ", Style::default().fg(theme::BLUE)),
        Span::styled(
            theme::dither_meter(0.42, (inner.width as usize).saturating_sub(6).max(4)),
            Style::default().fg(theme::BLUE),
        ),
    ]));
    f.render_widget(Paragraph::new(lines), inner);
}

pub fn draw_input(f: &mut Frame, area: Rect, app: &App) {
    let block = Block::default()
        .title(Span::styled(theme::title("input"), theme::title_style()))
        .borders(Borders::ALL)
        .border_type(BorderType::Double)
        .border_style(Style::default().fg(theme::DARKBLUE));
    let inner = block.inner(area);
    f.render_widget(block, area);
    f.render_widget(
        Paragraph::new(app.input.clone()).style(Style::default().fg(theme::WHITE)),
        inner,
    );
    let col = (inner.x as usize + app.cursor.min(inner.width as usize)) as u16;
    f.set_cursor_position(Position::new(col.min(inner.x + inner.width.saturating_sub(1)), inner.y));
}

pub fn draw_status(f: &mut Frame, area: Rect, app: &App, now: std::time::Instant) {
    let cols = Layout::horizontal([
        Constraint::Percentage(40),
        Constraint::Percentage(20),
        Constraint::Percentage(40),
    ])
    .split(area);

    let left_model = app.model.clone().unwrap_or_else(|| "starting...".into());
    let mut left_spans = vec![Span::styled(
        format!(" SEA {}", left_model),
        Style::default().fg(theme::YELLOW).add_modifier(Modifier::BOLD),
    )];
    if let Some(p) = &app.provider {
        left_spans.push(Span::styled(format!(" ({})", p), Style::default().fg(theme::GREY)));
    }
    if app.exited {
        left_spans = vec![Span::styled(
            " SEA (agent exited)",
            Style::default().fg(theme::RED).add_modifier(Modifier::BOLD),
        )];
    }
    f.render_widget(Paragraph::new(Line::from(left_spans)), cols[0]);

    let mid: Line = match app.state {
        AgentState::Thinking => Line::from(Span::styled(
            format!("THINKING {}", app.spinner_frame(now)),
            Style::default().fg(theme::YELLOW),
        )),
        AgentState::Idle => Line::from(Span::styled("IDLE", Style::default().fg(theme::GREEN))),
        AgentState::Starting => {
            Line::from(Span::styled("STARTING", Style::default().fg(theme::GREY)))
        }
    };
    f.render_widget(Paragraph::new(mid).alignment(Alignment::Center), cols[1]);

    f.render_widget(
        Paragraph::new(Line::from(Span::styled(
            "[?] help | [/] commands | Ctrl+C quit ",
            Style::default().fg(theme::GREY),
        )))
        .alignment(Alignment::Right),
        cols[2],
    );
}

fn overlay_area(area: Rect, w: u16, h: u16) -> Rect {
    let w = w.min(area.width.saturating_sub(2)).max(10);
    let h = h.min(area.height.saturating_sub(2)).max(3);
    Rect {
        x: area.x + (area.width - w) / 2,
        y: area.y + (area.height - h) / 2,
        width: w,
        height: h,
    }
}

fn help_text() -> Vec<Line<'static>> {
    let key = Style::default().fg(theme::ORANGE);
    let desc = Style::default().fg(theme::WHITE);
    let rows: &[(&str, &str)] = &[
        ("type", "edit prompt"),
        ("Enter", "send prompt / run command"),
        ("Up/Down", "input history (or chat scroll when empty)"),
        ("PageUp/PageDown", "scroll chat"),
        ("Left/Right", "move input cursor"),
        ("?", "toggle this help"),
        ("/", "command hints (/restart /clear /quit)"),
        ("Ctrl+C", "quit (kills agent child)"),
    ];
    rows.iter()
        .map(|(k, d)| {
            Line::from(vec![
                Span::styled(format!("{:<18}", k), key),
                Span::styled(*d, desc),
            ])
        })
        .collect()
}

fn commands_text() -> Vec<Line<'static>> {
    let cmd = Style::default().fg(theme::GREEN);
    let desc = Style::default().fg(theme::WHITE);
    [
        ("/restart", "respawn the sea-agent child process"),
        ("/clear", "wipe the chat transcript"),
        ("/quit", "exit seatui"),
    ]
    .iter()
    .map(|(c, d)| {
        Line::from(vec![
            Span::styled(format!("{:<12}", c), cmd),
            Span::styled(*d, desc),
        ])
    })
    .collect()
}

fn draw_centered_overlay(f: &mut Frame, title: &'static str, lines: Vec<Line<'static>>) {
    let size = f.area();
    let h = lines.len() as u16 + 2;
    let w = lines
        .iter()
        .map(|l| l.width() as u16)
        .max()
        .unwrap_or(20)
        + 4;
    let area = overlay_area(size, w, h);
    f.render_widget(Clear, area);
    let block = Block::default()
        .title(Span::styled(theme::title(title), theme::title_style()))
        .borders(Borders::ALL)
        .border_type(BorderType::Double)
        .border_style(Style::default().fg(theme::YELLOW))
        .style(Style::default().bg(theme::BLACK));
    let inner = block.inner(area);
    f.render_widget(block, area);
    f.render_widget(Paragraph::new(lines), inner);
}

/// Full frame composition.
pub fn compose(f: &mut Frame, app: &App, now: std::time::Instant) {
    let root = Layout::vertical([
        Constraint::Min(3),
        Constraint::Length(3),
        Constraint::Length(1),
    ])
    .split(f.area());
    let cols = Layout::horizontal([Constraint::Percentage(68), Constraint::Percentage(32)])
        .split(root[0]);
    let right =
        Layout::vertical([Constraint::Percentage(45), Constraint::Min(0)]).split(cols[1]);
    draw_chat(f, cols[0], app);
    draw_activity(f, right[0], app);
    draw_memory(f, right[1]);
    draw_input(f, root[1], app);
    draw_status(f, root[2], app, now);
    if app.show_help {
        draw_centered_overlay(f, "? help", help_text());
    }
    if app.show_cmds {
        draw_centered_overlay(f, "/ commands", commands_text());
    }
}
