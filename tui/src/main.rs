//! seatui: PIXEL-design terminal UI for the sea-agent.

mod app;
mod parser;
mod session;
mod theme;
mod ui;

use app::{App, AgentState};
use session::{FakeSession, OutputEvent, RealSession, SessionStream};
use std::io;
use std::process::ExitCode;
use std::time::Duration;

enum Session {
    Real(Box<RealSession>),
    #[allow(dead_code)]
    Fake(Box<FakeSession>),
}

impl Session {
    fn inner(&mut self) -> &mut dyn SessionStream {
        match self {
            Session::Real(r) => r.as_mut(),
            Session::Fake(f) => f.as_mut(),
        }
    }
    fn restart(&mut self, script: &std::path::Path) -> io::Result<()> {
        *self = Session::Real(Box::new(RealSession::spawn(script)?));
        Ok(())
    }
}

fn demo_app() -> App {
    let mut a = App::new();
    a.on_send("fix the failing unit test in src/parser.rs");
    a.on_output(&OutputEvent::Stderr(
        "sea-agent: provider=openrouter model=openrouter/openai/gpt-4o-mini\n".into(),
    ));
    a.on_output(&OutputEvent::Stderr("[tool] read_file -> ok\n".into()));
    a.on_output(&OutputEvent::Stderr("[tool] grep -> ok\n".into()));
    a.on_output(&OutputEvent::Stderr("[tool] run_tests -> error\n".into()));
    a.on_output(&OutputEvent::Stdout(
        "> I'll look at the failing test first.\n".into(),
    ));
    a.on_output(&OutputEvent::Stdout(
        "The `split_lines` helper dropped its final partial line; I'll fix that now.".into(),
    ));
    a.push_system("demo frame -- no child process was spawned");
    a.state = AgentState::Idle;
    a
}

/// --self-test: run internal unit checks, print PASS/FAIL lines.
fn self_test() -> ExitCode {
    let mut checks: Vec<(String, bool)> = Vec::new();
    checks.extend(theme::checks());

    // parser checks (banner + tool line structs)
    let b = parser::parse_banner("sea-agent: provider=anthropic model=anthropic/claude-3-haiku");
    checks.push((
        "parser:banner-struct".into(),
        b == Some(parser::BannerInfo {
            provider: "anthropic".into(),
            model: "anthropic/claude-3-haiku".into(),
        }),
    ));
    let t = parser::parse_tool_line("[tool] memory_search -> ok");
    checks.push((
        "parser:tool-ok-struct".into(),
        t == Some(parser::ToolEvent { name: "memory_search".into(), ok: true }),
    ));
    let t2 = parser::parse_tool_line("[tool] bash -> error");
    checks.push((
        "parser:tool-error-struct".into(),
        t2 == Some(parser::ToolEvent { name: "bash".into(), ok: false }),
    ));
    checks.push(("parser:reject-garbage".into(), parser::parse_banner("nope").is_none()
        && parser::parse_tool_line("[tool] x -> meh").is_none()));

    // transcript formatting / compose checks against an offscreen buffer
    let mut a = demo_app();
    a.show_help = false;
    checks.extend(ui_compose_checks(&a));

    // FakeSession plumbing check
    let mut fs = FakeSession::new();
    fs.push(OutputEvent::Stdout("hi\n".into()));
    fs.send_prompt("test");
    checks.push((
        "session:fake-roundtrip".into(),
        fs.poll_output() == vec![OutputEvent::Stdout("hi\n".into())] && fs.sent == vec!["test"],
    ));

    let mut failed = 0;
    for (name, ok) in &checks {
        if *ok {
            println!("PASS {}", name);
        } else {
            println!("FAIL {}", name);
            failed += 1;
        }
    }
    if failed == 0 {
        println!("ALL PASS ({} checks)", checks.len());
        ExitCode::SUCCESS
    } else {
        println!("{} FAILURES", failed);
        ExitCode::FAILURE
    }
}

fn ui_compose_checks(a: &App) -> Vec<(String, bool)> {
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;
    let mut term = Terminal::new(TestBackend::new(100, 30)).expect("test backend");
    let snapshot_now = std::time::Instant::now();
    term.draw(|f| ui::compose(f, a, snapshot_now)).expect("draw");
    let buf = term.backend().buffer();
    let content: String = (0..buf.area.height)
        .flat_map(|y| (0..buf.area.width).map(move |x| (x, y)))
        .map(|(x, y)| buf[(x, y)].symbol().to_string())
        .collect();

    vec![
        ("ui:chat-title".into(), content.contains("▚ CHAT ▞")),
        ("ui:user-prefix".into(), content.contains("▶ you")),
        ("ui:agent-prefix".into(), content.contains("◆ sea")),
        (
            "ui:agent-text".into(),
            content.contains("failing test first"),
        ),
        ("ui:activity-title".into(), content.contains("▚ ACTIVITY ▞")),
        ("ui:memory-title".into(), content.contains("▚ MEMORY ▞")),
        ("ui:input-title".into(), content.contains("▚ INPUT ▞")),
        ("ui:status-model".into(), content.contains("SEA openrouter/openai/gpt-4o-mini")),
        ("ui:status-idle".into(), content.contains("IDLE")),
        ("ui:status-hint".into(), content.contains("[?] help | [/] commands | Ctrl+C quit")),
        (
            "ui:activity-tool-ok".into(),
            content.contains("[ok  ] read_file"),
        ),
        (
            "ui:activity-tool-err".into(),
            content.contains("[err ] run_tests"),
        ),
    ]
}

/// --render-once: draw ONE frame against a fake session and print it.
fn render_once() -> ExitCode {
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;
    let a = demo_app();
    let mut term = Terminal::new(TestBackend::new(100, 30)).expect("test backend");
    let snapshot_now = std::time::Instant::now();
    term.draw(|f| ui::compose(f, &a, snapshot_now)).expect("draw");
    let buf = term.backend().buffer();
    for y in 0..buf.area.height {
        let row: String = (0..buf.area.width)
            .map(|x| buf[(x, y)].symbol().to_string())
            .collect();
        println!("{}", row.trim_end());
    }
    ExitCode::SUCCESS
}

fn handle_key(app: &mut App, key: crossterm::event::KeyEvent) -> KeyAction {
    use crossterm::event::{KeyCode, KeyEventKind, KeyModifiers};
    if key.kind != KeyEventKind::Press {
        return KeyAction::None;
    }
    if key.modifiers.contains(KeyModifiers::CONTROL)
        && matches!(key.code, KeyCode::Char('c'))
    {
        return KeyAction::Quit;
    }
    match key.code {
        KeyCode::Esc => {
            app.show_help = false;
            app.show_cmds = false;
            KeyAction::None
        }
        KeyCode::Char('?') => {
            app.show_help = !app.show_help;
            KeyAction::None
        }
        KeyCode::Char('/') => {
            app.show_cmds = true;
            KeyAction::None
        }
        _ if app.show_help || app.show_cmds => KeyAction::CloseOverlay,
        KeyCode::Enter => match app.take_input() {
            Some(text) => {
                if text.starts_with('/') {
                    match text.as_str() {
                        "/restart" => KeyAction::Restart,
                        "/clear" => {
                            app.clear_chat();
                            app.push_system("transcript cleared");
                            KeyAction::None
                        }
                        "/quit" => KeyAction::Quit,
                        other => {
                            app.push_system(&format!(
                                "unknown command `{}` (/restart /clear /quit)",
                                other
                            ));
                            KeyAction::None
                        }
                    }
                } else {
                    KeyAction::Send(text)
                }
            }
            None => KeyAction::None,
        },
        KeyCode::Up => {
            if !app.input.is_empty() || app.hist_pos < app.history.len() {
                if !app.history_prev() {
                    app.scroll_chat_up(1);
                }
            } else {
                app.scroll_chat_up(1);
            }
            KeyAction::None
        }
        KeyCode::Down => {
            if !app.input.is_empty() || app.hist_pos < app.history.len() {
                if !app.history_next() {
                    // already at newest draft: scroll chat instead is not
                    // possible with text present; ignore.
                }
            } else {
                // total/visible unknown here; pass generous bounds so any
                // scroll-down re-enables autoscroll at the bottom.
                app.scroll_chat_down(1, usize::MAX, 0);
            }
            KeyAction::None
        }
        KeyCode::PageUp => {
            app.scroll_chat_up(10);
            KeyAction::None
        }
        KeyCode::PageDown => {
            app.scroll_chat_down(10, usize::MAX, 0);
            KeyAction::None
        }
        KeyCode::Left => {
            app.cursor_left();
            KeyAction::None
        }
        KeyCode::Right => {
            app.cursor_right();
            KeyAction::None
        }
        KeyCode::Backspace => {
            app.backspace();
            KeyAction::None
        }
        KeyCode::Delete => {
            app.delete();
            KeyAction::None
        }
        KeyCode::Char(c) => {
            app.insert_char(c);
            KeyAction::None
        }
        _ => KeyAction::None,
    }
}

enum KeyAction {
    None,
    Quit,
    Restart,
    Send(String),
    CloseOverlay,
}

/// Live interactive loop driving the real child process.
fn run_live() -> io::Result<ExitCode> {
    use crossterm::event::{self, Event};
    use crossterm::execute;
    use crossterm::terminal::{
        disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
    };
    use ratatui::backend::CrosstermBackend;
    use ratatui::Terminal;

    let script = session::default_script_path();
    if !script.exists() {
        eprintln!("sea-agent script not found: {}", script.display());
        return Ok(ExitCode::FAILURE);
    }

    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let result = (|| -> io::Result<()> {
        let mut sess = Session::Real(Box::new(RealSession::spawn(&script)?));
        let mut app = App::new();
        loop {
            for ev in sess.inner().poll_output() {
                app.on_output(&ev);
            }
            let now = std::time::Instant::now();
            app.on_tick(now);
            terminal.draw(|f| ui::compose(f, &app, now))?;

            if event::poll(Duration::from_millis(40))? {
                if let Event::Key(k) = event::read()? {
                    match handle_key(&mut app, k) {
                        KeyAction::Quit => break,
                        KeyAction::Send(text) => {
                            sess.inner().send_prompt(&text);
                            app.on_send(&text);
                        }
                        KeyAction::Restart => match sess.restart(&script) {
                            Ok(()) => {
                                app.on_restart();
                                app.push_system("restarted agent child process");
                            }
                            Err(e) => app.push_system(&format!("restart failed: {}", e)),
                        },
                        KeyAction::CloseOverlay | KeyAction::None => {}
                    }
                }
            }
        }
        Ok(())
    })();

    disable_raw_mode()?;
    execute!(io::stdout(), LeaveAlternateScreen)?;
    result.map(|_| ExitCode::SUCCESS)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(|s| s.as_str()) {
        Some("--render-once") => render_once(),
        Some("--self-test") => self_test(),
        Some(other) => {
            eprintln!("usage: seatui [--render-once | --self-test]\nunknown flag: {}", other);
            ExitCode::FAILURE
        }
        None => match run_live() {
            Ok(code) => code,
            Err(e) => {
                eprintln!("seatui: {}", e);
                ExitCode::FAILURE
            }
        },
    }
}
