//! Inline-REPL drawing: bottom viewport (input + status + overlays) and
//! tool-call card lines for the native scrollback.

use crate::app::{AgentState, App};
use crate::parser::ToolEvent;
use crate::theme;
use ratatui::layout::{Alignment, Constraint, Layout, Position, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, Paragraph};
use ratatui::Frame;

pub const BASE_HEIGHT: u16 = 4; // input block (3) + status (1)

/// Total inline viewport height given current overlay state.
pub fn inline_height(app: &App) -> u16 {
    let mut h = BASE_HEIGHT;
    if app.show_help {
        h += help_lines().len() as u16 + 2; // + borders
    }
    if app.confirm.is_some() {
        h += 1;
    } else if !app.palette_matches().is_empty() {
        let n = app.palette_matches().len() as u16;
        h += n.min(6);
    }
    h.min(20)
}

pub const CONTEXT_CAPACITY_TOKENS: u64 = 128_000;

fn context_fraction(app: &App) -> f32 {
    (app.context_tokens() as f32 / CONTEXT_CAPACITY_TOKENS as f32).clamp(0.0, 1.0)
}

fn context_color(app: &App) -> ratatui::style::Color {
    match context_fraction(app) {
        f if f < 0.5 => theme::YELLOW,
        f if f < 0.8 => theme::ORANGE,
        _ => theme::RED,
    }
}

fn clock_utc() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (h, rem) = ((secs / 3600) % 24, secs % 3600);
    let (m, s) = (rem / 60, rem % 60);
    format!("{:02}:{:02}:{:02}", h, m, s)
}

/// Draw one inline frame inside the viewport area.
pub fn compose_inline(f: &mut Frame, app: &App, now: std::time::Instant) {
    let area = f.area();
    let status_h = 1u16;
    let confirm_h = u16::from(app.confirm.is_some());
    let palette_rows = if app.confirm.is_none() {
        app.palette_matches().len().min(6) as u16
    } else {
        0
    };
    let help_h = if app.show_help { help_lines().len() as u16 + 2 } else { 0 };
    let input_h = area.height.saturating_sub(status_h + confirm_h + palette_rows + help_h);

    // Stack from the bottom: status, input, then overlays above.
    let rows = Layout::vertical([
        Constraint::Min(help_h),
        Constraint::Length(help_h),
        Constraint::Length(palette_rows),
        Constraint::Length(confirm_h),
        Constraint::Length(input_h),
        Constraint::Length(status_h),
    ])
    .split(area);

    if help_h > 0 {
        draw_help(f, rows[1]);
    }
    if palette_rows > 0 && app.confirm.is_none() {
        draw_palette(f, rows[2], app);
    }
    if confirm_h > 0 {
        draw_confirm(f, rows[3], app);
    }
    draw_input(f, rows[4], app);
    draw_status(f, rows[5], app, now);
}

fn draw_help(f: &mut Frame, area: Rect) {
    let block = Block::default()
        .title(Span::styled(theme::title("? help"), theme::title_style()))
        .borders(Borders::ALL)
        .border_type(BorderType::Double)
        .border_style(Style::default().fg(theme::YELLOW))
        .style(Style::default().bg(theme::BLACK));
    let inner = block.inner(area);
    f.render_widget(block, area);
    f.render_widget(Paragraph::new(help_lines()), inner);
}

fn help_lines() -> Vec<Line<'static>> {
    let key = Style::default().fg(theme::ORANGE);
    let desc = Style::default().fg(theme::WHITE);
    [
        ("type", "edit prompt"),
        ("Enter", "send / run command"),
        ("Up/Down", "history"),
        ("Tab", "complete slash command"),
        ("?", "toggle help"),
        ("Ctrl+C", "quit"),
    ]
    .iter()
    .map(|(k, d)| {
        Line::from(vec![
            Span::styled(format!("{:<10}", k), key),
            Span::styled(*d, desc),
        ])
    })
    .collect()
}

fn draw_palette(f: &mut Frame, area: Rect, app: &App) {
    let matches = app.palette_matches();
    let lines: Vec<Line> = matches
        .iter()
        .take(area.height as usize)
        .map(|c| {
            Line::from(vec![
                Span::styled(format!("{:<10}", c.name), Style::default().fg(theme::GREEN)),
                Span::styled(format!(" {:<9}", c.args), Style::default().fg(theme::BLUE)),
                Span::styled(c.desc, Style::default().fg(theme::GREY)),
            ])
        })
        .collect();
    f.render_widget(Paragraph::new(lines), area);
}

fn draw_confirm(f: &mut Frame, area: Rect, app: &App) {
    if let Some(p) = &app.confirm {
        f.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(" approve ", Style::default().fg(theme::BLACK).bg(theme::YELLOW)),
                Span::styled(
                    format!(" {} [y/n] (--yolo disables)", p.label),
                    Style::default().fg(theme::YELLOW),
                ),
            ])),
            area,
        );
    }
}

fn draw_input(f: &mut Frame, area: Rect, app: &App) {
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

fn draw_status(f: &mut Frame, area: Rect, app: &App, now: std::time::Instant) {
    let cols = Layout::horizontal([
        Constraint::Percentage(30),
        Constraint::Percentage(40),
        Constraint::Percentage(30),
    ])
    .split(area);

    let model = app.model.clone().unwrap_or_else(|| "starting...".into());
    f.render_widget(
        Paragraph::new(Line::from(Span::styled(
            format!(" {}", model),
            Style::default().fg(theme::BLUE),
        ))),
        cols[0],
    );

    let frac = context_fraction(app);
    let width = (cols[1].width as usize).saturating_sub(10).max(4);
    let bar = theme::dither_meter(frac, width);
    let state_txt = match app.state {
        AgentState::Thinking => {
            format!("{} ", app.spinner_frame(now))
        }
        _ => String::new(),
    };
    f.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(state_txt, Style::default().fg(theme::YELLOW)),
            Span::styled(bar, Style::default().fg(context_color(app))),
            Span::styled(
                format!(" {:>2.0}%", frac * 100.0),
                Style::default().fg(context_color(app)),
            ),
        ]))
        .alignment(Alignment::Center),
        cols[1],
    );

    let session = app
        .session_file
        .as_ref()
        .and_then(|p| p.file_stem())
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "(new)".into());
    f.render_widget(
        Paragraph::new(Line::from(Span::styled(
            format!("{} {} ", session, clock_utc()),
            Style::default().fg(theme::GREY),
        )))
        .alignment(Alignment::Right),
        cols[2],
    );
}

// ---------------------------------------------------------------------------
// Tool call cards (printed into native scrollback)
// ---------------------------------------------------------------------------

const DIFF_TOOLS: &[&str] = &["apply_edit", "write_file"];

/// One-line tool-end card: green dot + name (+ grey detail) on success,
/// red dot + name + "error" on failure. For apply_edit/write_file with
/// details, renders a +/- diff summary.
pub fn tool_card(ev: &ToolEvent, details: Option<&str>) -> Vec<Span<'static>> {
    let mut spans = Vec::new();
    if ev.ok {
        spans.push(Span::styled("● ", Style::default().fg(theme::GREEN)));
        spans.push(Span::styled(
            ev.name.clone(),
            Style::default().fg(theme::WHITE).add_modifier(Modifier::BOLD),
        ));
        if DIFF_TOOLS.contains(&ev.name.as_str()) {
            if let Some(d) = details {
                spans.push(Span::styled(format!(" {}", d), Style::default().fg(theme::GREY)));
            } else {
                spans.push(Span::styled(" edit applied", Style::default().fg(theme::GREY)));
            }
        } else if let Some(d) = details {
            spans.push(Span::styled(format!(" {}", d), Style::default().fg(theme::GREY)));
        }
    } else {
        spans.push(Span::styled("● ", Style::default().fg(theme::RED)));
        spans.push(Span::styled(ev.name.clone(), Style::default().fg(theme::RED)));
        spans.push(Span::styled(" error", Style::default().fg(theme::RED)));
    }
    spans
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands;
    use crate::parser::ToolEvent;

    #[test]
    fn ok_card_has_green_dot_and_name() {
        let spans = tool_card(
            &ToolEvent { name: "Bash".into(), ok: true },
            Some("ls -la"),
        );
        assert_eq!(spans[0].content.as_ref(), "● ");
        assert_eq!(spans[0].style.fg, Some(theme::GREEN));
        assert_eq!(spans[1].content.as_ref(), "Bash");
        assert_eq!(spans[2].content.as_ref(), " ls -la");
    }

    #[test]
    fn error_card_marks_failure() {
        let spans = tool_card(&ToolEvent { name: "run_tests".into(), ok: false }, None);
        assert_eq!(spans[0].style.fg, Some(theme::RED));
        assert_eq!(spans[2].content.as_ref(), " error");
    }

    #[test]
    fn diff_tool_gets_edit_summary() {
        let spans = tool_card(&ToolEvent { name: "write_file".into(), ok: true }, None);
        assert!(spans.iter().any(|s| s.content.contains("edit applied")));
        let spans = tool_card(&ToolEvent { name: "apply_edit".into(), ok: true }, Some("+3 -1 src/main.rs"));
        assert!(spans.iter().any(|s| s.content.contains("+3 -1 src/main.rs")));
    }

    #[test]
    fn inline_height_varies_with_overlays() {
        let mut app = App::new();
        assert_eq!(inline_height(&app), BASE_HEIGHT);
        app.input = "/".into();
        assert!(inline_height(&app) > BASE_HEIGHT);
        app.input.clear();
        app.show_help = true;
        assert!(inline_height(&app) >= BASE_HEIGHT + 4);
        app.show_help = false;
        app.confirm = Some(crate::app::PendingConfirm {
            label: "clear".into(),
            action: commands::Action::Clear,
        });
        assert_eq!(inline_height(&app), BASE_HEIGHT + 1);
    }

    #[test]
    fn command_list_has_expected_entries() {
        for name in ["/help", "/quit", "/clear", "/model", "/context", "/memory", "/resume"] {
            assert!(commands::COMMANDS.iter().any(|c| c.name == name), "missing {}", name);
        }
    }
}
