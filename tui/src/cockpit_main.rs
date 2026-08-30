//! `mnemo-cockpit`: one app, five panes, driven by pi's RPC mode.
//! Chat is wired in 2.3; the other panes land in 2.4-2.7.
use crossterm::event::{self, Event};
use crossterm::execute;
use crossterm::terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen};
use ratatui::backend::CrosstermBackend;
use ratatui::text::Line;
use ratatui::Terminal;
use seatui::cockpit::{Action, Cockpit};
use seatui::cockpit_ui;
use std::io;
use std::time::Duration;

fn main() -> io::Result<()> {
    let mut cockpit = Cockpit::new();
    cockpit.status = "ready".into();

    enable_raw_mode()?;
    let mut out = io::stdout();
    execute!(out, EnterAlternateScreen)?;
    let mut term = Terminal::new(CrosstermBackend::new(out))?;

    let result = run(&mut term, &mut cockpit);

    disable_raw_mode()?;
    execute!(term.backend_mut(), LeaveAlternateScreen)?;
    term.show_cursor()?;
    result
}

fn run<B: ratatui::backend::Backend>(
    term: &mut Terminal<B>,
    cockpit: &mut Cockpit,
) -> io::Result<()> {
    while !cockpit.quit {
        term.draw(|f| cockpit_ui::draw(f, cockpit, body(cockpit)))?;
        if !event::poll(Duration::from_millis(120))? { continue; }
        if let Event::Key(key) = event::read()? {
            match cockpit.on_key(key) {
                Action::Quit => break,
                Action::Submit(line) => cockpit.status = format!("sent: {line}"),
                _ => {}
            }
        }
    }
    Ok(())
}

fn body(c: &Cockpit) -> Vec<Line<'static>> {
    vec![Line::from(format!("{} pane — not wired yet", c.pane.label()))]
}
