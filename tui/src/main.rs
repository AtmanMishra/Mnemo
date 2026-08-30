//! seatui: INLINE REPL terminal UI for the sea-agent.
//!
//! Paradigm (Claude Code / Codex CLI style):
//! - conversation transcript lives in NATIVE terminal scrollback (inserted
//!   via ratatui's inline-viewport `insert_before`); users scroll/copy/search
//!   with their terminal.
//! - only a small bottom region is ratatui-managed: input editor + status
//!   line + transient overlays (command palette, help, approval prompt).
//!
//! Flags:
//!   --render-once   print one sample frame to stdout and exit
//!   --self-test     internal unit checks, exit != 0 on failure
//!   --yolo          skip y/n approval for mutating slash commands
//!   --verbose       echo raw child stderr lines into scrollback

mod app;
mod commands;
mod md;
mod memclient;
mod parser;
mod rpc;
mod session;
mod session_store;
mod theme;
mod ui;

use app::{App, AgentState, PendingConfirm};
use commands::Action;
use ratatui::backend::CrosstermBackend;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Paragraph, Widget};
use ratatui::{Terminal, Viewport};
use session::{FakeSession, OutputEvent, RealSession, SessionStream};
use std::io::{self, Write};
use std::process::ExitCode;
use std::time::Duration;

type Term = Terminal<CrosstermBackend<io::Stdout>>;

// ---------------------------------------------------------------------------
// Scrollback printing
// ---------------------------------------------------------------------------

/// Split overly wide lines at `width` columns, preserving span styles where
/// possible, so a no-wrap Paragraph renders them 1:1 into an insert_before
/// buffer.
fn flatten_lines(lines: Vec<Line<'static>>, width: usize) -> Vec<Line<'static>> {
    let width = width.max(1);
    let mut out: Vec<Line<'static>> = Vec::new();
    for line in lines {
        if line.width() <= width {
            out.push(line);
            continue;
        }
        let mut row: Vec<Span<'static>> = Vec::new();
        let mut col = 0usize;
        for span in line.spans {
            let mut text: String = span.content.to_string();
            while !text.is_empty() {
                let take = (width - col).min(text.chars().count());
                if take == 0 {
                    out.push(Line::from(std::mem::take(&mut row)));
                    col = 0;
                    continue;
                }
                let chunk: String = text.chars().take(take).collect();
                row.push(Span::styled(chunk, span.style));
                col += take;
                text = text.chars().skip(take).collect();
                if col >= width {
                    out.push(Line::from(std::mem::take(&mut row)));
                    col = 0;
                }
            }
        }
        if !row.is_empty() {
            out.push(Line::from(row));
        }
    }
    out
}

/// Insert styled lines into native scrollback above the inline viewport.
fn print_scrollback(term: &mut Term, lines: Vec<Line<'static>>) -> io::Result<()> {
    if lines.is_empty() {
        return Ok(());
    }
    let width = term.size()?.width as usize;
    let flat = flatten_lines(lines, width);
    let height = flat.len().max(1) as u16;
    term.insert_before(height, |buf| {
        Paragraph::new(flat).render(buf.area, buf);
    })
}

fn header_lines() -> Vec<Line<'static>> {
    vec![
        Line::from(vec![
            Span::styled("MNEMO", Style::default().fg(theme::YELLOW).add_modifier(Modifier::BOLD)),
            Span::styled(" // ", Style::default().fg(theme::GREY)),
            Span::styled(
                "agentic coding assistant",
                Style::default().fg(theme::WHITE).add_modifier(Modifier::BOLD),
            ),
        ]),
        Line::from(Span::styled(
            "type a prompt · /help for commands · Ctrl+C quit",
            Style::default().fg(theme::GREY),
        )),
    ]
}

fn user_msg_lines(text: &str) -> Vec<Line<'static>> {
    let mut out = vec![Line::from(vec![
        Span::styled("▶ you ", Style::default().fg(theme::ORANGE).add_modifier(Modifier::BOLD)),
        Span::styled(text.to_string(), Style::default().fg(theme::WHITE)),
    ])];
    out.push(Line::from(""));
    out
}

fn system_note(text: &str) -> Vec<Line<'static>> {
    vec![Line::from(Span::styled(
        format!("·· {}", text),
        Style::default().fg(theme::GREY),
    ))]
}

fn markdown_lines(src: &str) -> Vec<Line<'static>> {
    md::render_markdown(src)
        .into_iter()
        .map(|segs| {
            Line::from(
                segs.into_iter()
                    .map(|s| {
                        let style = match s.style {
                            md::SegStyle::Plain => Style::default().fg(theme::WHITE),
                            md::SegStyle::Heading => Style::default()
                                .fg(theme::WHITE)
                                .add_modifier(Modifier::BOLD | Modifier::UNDERLINED),
                            md::SegStyle::Bold => {
                                Style::default().fg(theme::WHITE).add_modifier(Modifier::BOLD)
                            }
                            md::SegStyle::Code => Style::default().fg(theme::GREY),
                            md::SegStyle::Url => {
                                Style::default().fg(theme::BLUE).add_modifier(Modifier::UNDERLINED)
                            }
                        };
                        Span::styled(s.text, style)
                    })
                    .collect::<Vec<_>>(),
            )
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Live REPL
// ---------------------------------------------------------------------------

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

fn make_term(stdout: io::Stdout, height: u16) -> io::Result<Term> {
    Terminal::with_options(
        CrosstermBackend::new(stdout),
        ratatui::TerminalOptions { viewport: Viewport::Inline(height) },
    )
}

/// The inline-viewport field is private in ratatui 0.29, so overlay-driven
/// height changes recreate the Terminal (Stdout is a cheap cloneable handle).
fn sync_viewport(term: &mut Term, current_h: &mut u16, app: &App) -> io::Result<()> {
    let want = ui::inline_height(app);
    if *current_h != want {
        *term = make_term(io::stdout(), want)?;
        *current_h = want;
    }
    Ok(())
}

/// Auto-save the transcript (first save creates the timestamped file,
/// later saves rewrite the same file).
fn autosave(app: &mut App) {
    if app.transcript.is_empty() {
        return;
    }
    match app.session_file.clone() {
        Some(p) => {
            let _ = session_store::save_to(&p, &app.transcript);
        }
        None => {
            if let Ok(p) = session_store::save_session(&app.transcript) {
                app.session_file = Some(p);
            }
        }
    }
}

fn run_live(yolo: bool, verbose: bool) -> io::Result<ExitCode> {
    use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
    use crossterm::terminal::{disable_raw_mode, enable_raw_mode};

    let script = session::default_script_path();
    if !script.exists() {
        eprintln!("mnemo script not found: {}", script.display());
        return Ok(ExitCode::FAILURE);
    }

    enable_raw_mode()?;
    let mut term: Term = Terminal::with_options(
        CrosstermBackend::new(io::stdout()),
        ratatui::TerminalOptions { viewport: Viewport::Inline(ui::BASE_HEIGHT) },
    )?;

    let result = (|| -> io::Result<ExitCode> {
        let mut sess = Session::Real(Box::new(RealSession::spawn(&script)?));
        let mut app = App::new();
        print_scrollback(&mut term, header_lines())?;
        print_scrollback(
            &mut term,
            system_note(&format!(
                "child: node {} (--yolo {})",
                script.display(),
                if yolo { "on" } else { "off" }
            )),
        )?;
        let mut model_printed = false;
        let mut prev_state = app.state;
        let mut vp_h = ui::BASE_HEIGHT;
        let mut quit = false;

        while !quit {
            // --- drain child output ---------------------------------------
            for ev in sess.inner().poll_output() {
                match &ev {
                    OutputEvent::Stdout(_) | OutputEvent::Stderr(_) => {
                        for t in app.on_output(&ev) {
                            print_scrollback(&mut term, vec![Line::from(ui::tool_card(&t, None))])?;
                        }
                        if let OutputEvent::Stderr(chunk) = &ev {
                            if verbose && !chunk.trim().is_empty() {
                                print_scrollback(&mut term, system_note(chunk.trim()))?;
                            }
                        }
                        if !model_printed && app.model_announced {
                            model_printed = true;
                            print_scrollback(
                                &mut term,
                                vec![Line::from(Span::styled(
                                    format!(
                                        "model: {} ({})",
                                        app.model.clone().unwrap_or_default(),
                                        app.provider.clone().unwrap_or_default()
                                    ),
                                    Style::default().fg(theme::BLUE),
                                ))],
                            )?;
                        }
                    }
                    OutputEvent::Exit(code) => {
                        app.on_output(&ev);
                        print_scrollback(
                            &mut term,
                            vec![Line::from(Span::styled(
                                format!("(agent exited, code={})", code.map(|c| c.to_string()).unwrap_or_else(|| "?".into())),
                                Style::default().fg(theme::RED),
                            ))],
                        )?;
                    }
                }
            }

            // --- flush streaming assistant lines --------------------------
            let done_lines = app.drain_stream_lines();
            if !done_lines.is_empty() {
                let lines: Vec<Line> = done_lines
                    .into_iter()
                    .map(|l| Line::from(Span::styled(l, Style::default().fg(theme::WHITE))))
                    .collect();
                print_scrollback(&mut term, lines)?;
            }

            app.on_tick(std::time::Instant::now());
            if prev_state != AgentState::Idle && app.state == AgentState::Idle {
                // message completed: flush partial tail line
                if let Some(tail) = app.flush_stream_tail() {
                    print_scrollback(
                        &mut term,
                        vec![Line::from(Span::styled(tail, Style::default().fg(theme::WHITE)))],
                    )?;
                }
                print_scrollback(&mut term, vec![Line::from("")])?;
                autosave(&mut app);
            }
            prev_state = app.state;

            // --- draw inline viewport -------------------------------------
            let now = std::time::Instant::now();
            sync_viewport(&mut term, &mut vp_h, &app)?;
            term.draw(|f| ui::compose_inline(f, &app, now))?;

            // --- input ------------------------------------------------------
            if event::poll(Duration::from_millis(40))? {
                if let Event::Key(k) = event::read()? {
                    if k.kind != KeyEventKind::Press {
                        continue;
                    }
                    if k.modifiers.contains(KeyModifiers::CONTROL)
                        && matches!(k.code, KeyCode::Char('c'))
                    {
                        quit = true;
                        continue;
                    }
                    // approval gate first
                    if k.code == KeyCode::Esc {
                        app.confirm = None;
                        app.show_help = false;
                        continue;
                    }
                    if let Some(pending) = app.confirm.take_if(|_| true) {
                        match k.code {
                            KeyCode::Char('y') | KeyCode::Char('Y') => {
                                execute_action(&mut sess, &mut app, &mut term, pending.action, &script)?;
                            }
                            _ => {
                                print_scrollback(&mut term, system_note("cancelled"))?;
                            }
                        }
                        continue;
                    }
                    match k.code {
                        KeyCode::Tab => {
                            app.tab_complete();
                        }
                        KeyCode::Char('?') if app.input.is_empty() => {
                            app.show_help = !app.show_help;
                        }
                        KeyCode::Enter => {
                            if let Some(text) = app.take_input() {
                                if text.starts_with('/') {
                                    let action = commands::parse(&text);
                                    let mutating = match &action {
                                        Action::Clear | Action::Model(_) => true,
                                        _ => false,
                                    };
                                    if mutating && !yolo {
                                        app.confirm = Some(PendingConfirm {
                                            label: text.clone(),
                                            action,
                                        });
                                    } else {
                                        let will_quit = matches!(action, Action::Quit);
                                        execute_action(&mut sess, &mut app, &mut term, action, &script)?;
                                        quit = will_quit;
                                    }
                                } else {
                                    print_scrollback(&mut term, user_msg_lines(&text))?;
                                    sess.inner().send_prompt(&text);
                                    app.on_send(&text);
                                }
                            }
                        }
                        KeyCode::Up => {
                            app.history_prev();
                        }
                        KeyCode::Down => {
                            app.history_next();
                        }
                        KeyCode::Left => app.cursor_left(),
                        KeyCode::Right => app.cursor_right(),
                        KeyCode::Backspace => app.backspace(),
                        KeyCode::Delete => app.delete(),
                        KeyCode::Char(c) => app.insert_char(c),
                        _ => {}
                    }
                }
            }
        }

        autosave(&mut app);
        Ok(ExitCode::SUCCESS)
    })();

    disable_raw_mode()?;
    println!();
    result
}

fn execute_action(
    sess: &mut Session,
    app: &mut App,
    term: &mut Term,
    action: Action,
    script: &std::path::Path,
) -> io::Result<()> {
    match action {
        Action::Help => {
            let mut lines = vec![
                Line::from(Span::styled(
                    "keys",
                    Style::default().fg(theme::YELLOW).add_modifier(Modifier::BOLD),
                )),
                Line::from(Span::styled(
                    "  Enter send · Up/Down history · Tab complete · ? help overlay · Ctrl+C quit",
                    Style::default().fg(theme::WHITE),
                )),
                Line::from(Span::styled(
                    "commands",
                    Style::default().fg(theme::YELLOW).add_modifier(Modifier::BOLD),
                )),
            ];
            for c in commands::COMMANDS {
                lines.push(Line::from(vec![
                    Span::styled(format!("  {:<10}", c.name), Style::default().fg(theme::GREEN)),
                    Span::styled(format!("{:<8} ", c.args), Style::default().fg(theme::BLUE)),
                    Span::styled(c.desc, Style::default().fg(theme::GREY)),
                ]));
            }
            print_scrollback(term, lines)?;
        }
        Action::Quit => {}
        Action::Clear => {
            app.clear_transcript();
            app.session_file = None;
            crossterm::execute!(io::stdout(), crossterm::terminal::Clear(crossterm::terminal::ClearType::All))?;
            print_scrollback(term, header_lines())?;
        }
        Action::Model(Some(id)) => {
            std::env::set_var("MNEMO_MODEL", &id);
            match sess.restart(script) {
                Ok(()) => {
                    app.restart_reset();
                    print_scrollback(
                        term,
                        system_note(&format!("restarted with MNEMO_MODEL={}", id)),
                    )?;
                }
                Err(e) => print_scrollback(term, system_note(&format!("restart failed: {}", e)))?,
            }
        }
        Action::Model(None) => {
            print_scrollback(
                term,
                system_note(&format!(
                    "current model: {}",
                    app.model.clone().unwrap_or_else(|| "(starting...)".into())
                )),
            )?;
        }
        Action::Context => {
            let est = app.context_tokens();
            let frac = (est as f32 / ui::CONTEXT_CAPACITY_TOKENS as f32).clamp(0.0, 1.0);
            let bar = theme::dither_meter(frac, 24);
            print_scrollback(
                term,
                vec![Line::from(Span::styled(
                    format!(
                        "context ~{} tokens (~{:.0}% of {}k budget) [{}]",
                        est,
                        frac * 100.0,
                        ui::CONTEXT_CAPACITY_TOKENS / 1000,
                        bar
                    ),
                    Style::default().fg(theme::BLUE),
                ))],
            )?;
        }
        Action::Memory(q) => {
            if q.is_empty() {
                print_scrollback(term, system_note("usage: /memory <query>"))?;
            } else {
                print_scrollback(term, system_note(&format!("searching memory: {}", q)))?;
                let journal = memclient::default_journal();
                match memclient::query(&journal, &q, 5, Duration::from_secs(5)) {
                    Ok(hits) if hits.is_empty() => {
                        print_scrollback(term, system_note("no memory hits"))?
                    }
                    Ok(hits) => {
                        let lines: Vec<Line> = hits
                            .iter()
                            .map(|h| {
                                Line::from(Span::styled(
                                    format!(
                                        "  ● node #{} score {:.2}{}",
                                        h.node,
                                        h.score,
                                        if h.via_graph { " (via graph)" } else { "" }
                                    ),
                                    Style::default().fg(theme::GREEN),
                                ))
                            })
                            .collect();
                        print_scrollback(term, lines)?;
                    }
                    Err(e) => print_scrollback(term, system_note(&format!("memory: {}", e)))?,
                }
            }
        }
        Action::Resume(None) => {
            let metas = session_store::list_sessions();
            if metas.is_empty() {
                print_scrollback(term, system_note("no saved sessions"))?;
            } else {
                let mut lines = system_note("/resume <n> to load:");
                for (i, m) in metas.iter().enumerate() {
                    lines.push(Line::from(Span::styled(
                        format!("  {}. {}", i + 1, m.name),
                        Style::default().fg(theme::WHITE),
                    )));
                }
                print_scrollback(term, lines)?;
            }
        }
        Action::Resume(Some(n)) => {
            let metas = session_store::list_sessions();
            match metas.get(n.saturating_sub(1)) {
                Some(meta) => match session_store::load_session(&meta.path) {
                    Ok(t) => {
                        let mut lines = vec![Line::from(Span::styled(
                            format!("── resumed {} ──", meta.name),
                            Style::default().fg(theme::YELLOW).add_modifier(Modifier::BOLD),
                        ))];
                        for (speaker, content) in &t {
                            match speaker {
                                app::Speaker::User => lines.extend(user_msg_lines(content)),
                                app::Speaker::Agent => {
                                    lines.extend(markdown_lines(content));
                                    lines.push(Line::from(""));
                                }
                                app::Speaker::System => lines.extend(system_note(content)),
                            }
                        }
                        app.transcript = t;
                        app.session_file = Some(meta.path.clone());
                        print_scrollback(term, lines)?;
                    }
                    Err(e) => print_scrollback(term, system_note(&format!("load failed: {}", e)))?,
                },
                None => print_scrollback(term, system_note("no such session index"))?,
            }
        }
        Action::Unknown(other) => {
            print_scrollback(
                term,
                system_note(&format!("unknown command `{}` (/help)", other)),
            )?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// --render-once
// ---------------------------------------------------------------------------

fn fg_ansi(c: Color) -> String {
    match c {
        Color::Rgb(r, g, b) => format!("\x1b[38;2;{};{};{}m", r, g, b),
        _ => String::new(),
    }
}

fn span_to_ansi(span: &Span) -> String {
    let mut out = fg_ansi(span.style.fg.unwrap_or(theme::WHITE));
    let m = span.style.add_modifier;
    if m.contains(Modifier::BOLD) {
        out.push_str("\x1b[1m");
    }
    if m.contains(Modifier::UNDERLINED) {
        out.push_str("\x1b[4m");
    }
    out.push_str(span.content.as_ref());
    out.push_str("\x1b[0m");
    out
}

fn print_ansi_lines(lines: &[Line]) {
    let stdout = io::stdout();
    let mut w = stdout.lock();
    for line in lines {
        for span in &line.spans {
            let _ = write!(w, "{}", span_to_ansi(span));
        }
        let _ = writeln!(w);
    }
}

fn render_once() -> ExitCode {
    // Sample scrollback (no terminal state touched; ANSI-styled plain output).
    print_ansi_lines(&header_lines());
    print_ansi_lines(&user_msg_lines("explain the memory layer and fix the failing test"));
    print_ansi_lines(&[Line::from(Span::styled(
        "● read_file src/memory-design-spec.md",
        Style::default().fg(theme::GREEN),
    ))]);
    print_ansi_lines(&[Line::from(Span::styled(
        "● apply_edit +12 -3 src/parser.rs",
        Style::default().fg(theme::GREEN),
    ))]);
    print_ansi_lines(&[Line::from(Span::styled(
        "● run_tests error",
        Style::default().fg(theme::RED),
    ))]);
    let sample_md = "## Memory layer\n\nFacts live in a **graph**; recall uses `memory_search`.\n\n- nodes: entity/harness/outcome\n- see https://example.com/spec\n\n```bash\ncargo test -p memory-layer\n```";
    print_ansi_lines(&markdown_lines(sample_md));
    print_ansi_lines(&system_note("(sample frame -- no child process was spawned)"));
    // Empty input row + status row.
    println!(
        "{}",
        span_to_ansi(&Span::styled("╔═ INPUT ═══════════════════════════════════════════════════════╗", Style::default().fg(theme::DARKBLUE)))
    );
    println!("{}", span_to_ansi(&Span::styled("║ ", Style::default().fg(theme::DARKBLUE))));
    println!(
        "{}",
        span_to_ansi(&Span::styled("╚══════════════════════════════════════════════════════════════╝", Style::default().fg(theme::DARKBLUE)))
    );
    println!(
        "{} {}{} {}",
        span_to_ansi(&Span::styled(" starting...", Style::default().fg(theme::BLUE))),
        span_to_ansi(&Span::styled(theme::dither_meter(0.12, 20), Style::default().fg(theme::YELLOW))),
        span_to_ansi(&Span::styled(" 12%", Style::default().fg(theme::YELLOW))),
        span_to_ansi(&Span::styled("(new) 12:00:00 ", Style::default().fg(theme::GREY))),
    );
    ExitCode::SUCCESS
}

// ---------------------------------------------------------------------------
// --self-test
// ---------------------------------------------------------------------------

fn self_test() -> ExitCode {
    use ratatui::backend::TestBackend;
    let mut checks: Vec<(String, bool)> = Vec::new();
    checks.extend(theme::checks());

    // parsers
    checks.push((
        "parser:banner".into(),
        parser::parse_banner("sea-agent: provider=openrouter model=openrouter/x/y")
            == Some(parser::BannerInfo {
                provider: "openrouter".into(),
                model: "openrouter/x/y".into(),
            }),
    ));
    checks.push((
        "parser:tool".into(),
        parser::parse_tool_line("[tool] bash -> ok")
            == Some(parser::ToolEvent { name: "bash".into(), ok: true }),
    ));

    // markdown-lite
    let segs = md::parse_inline("**bold** and `code` plus https://ratatui.rs end");
    checks.push((
        "md:inline".into(),
        segs.iter().map(|s| s.style).collect::<Vec<_>>()
            == [md::SegStyle::Plain, md::SegStyle::Bold, md::SegStyle::Plain, md::SegStyle::Code, md::SegStyle::Plain, md::SegStyle::Url, md::SegStyle::Plain],
    ));
    let lines = md::render_markdown("## T\n```rs\nx()\n```");
    checks.push((
        "md:fence".into(),
        lines.len() == 4 && lines[2][0].style == md::SegStyle::Code,
    ));

    // palette matching + parse
    checks.push((
        "commands:match".into(),
        commands::match_commands("/cl").len() == 1
            && commands::match_commands("/").len() == commands::COMMANDS.len(),
    ));
    checks.push((
        "commands:parse".into(),
        commands::parse("/memory rust ai") == Action::Memory("rust ai".into()),
    ));

    // session store roundtrip
    {
        let dir = std::env::temp_dir().join(format!("seatui-selftest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::env::set_var("SEA_SESSIONS_DIR", &dir);
        let t = vec![
            (app::Speaker::User, "q".into()),
            (app::Speaker::Agent, "a\nb".into()),
        ];
        let p = session_store::save_session(&t);
        let roundtrip = p.as_ref().ok().and_then(|p| session_store::load_session(p).ok());
        checks.push((
            "store:roundtrip".into(),
            roundtrip.as_deref() == Some(t.as_slice()),
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("SEA_SESSIONS_DIR");
    }

    // fake session plumbing
    let mut fs = FakeSession::new();
    fs.push(OutputEvent::Stdout("hi\n".into()));
    fs.send_prompt("test");
    checks.push((
        "session:fake-roundtrip".into(),
        fs.poll_output() == vec![OutputEvent::Stdout("hi\n".into())] && fs.sent == vec!["test"],
    ));

    // inline frame composes against a test backend
    {
        let mut a = App::new();
        a.input = "/cl".into();
        let mut term = Terminal::with_options(
            TestBackend::new(80, ui::inline_height(&a)),
            ratatui::TerminalOptions { viewport: Viewport::Fixed(ratatui::layout::Rect::new(0, 0, 80, ui::inline_height(&a))) },
        )
        .unwrap();
        let now = std::time::Instant::now();
        term.draw(|f| ui::compose_inline(f, &a, now)).unwrap();
        let buf = term.backend().buffer();
        let content: String = (0..buf.area.height)
            .flat_map(|y| (0..buf.area.width).map(move |x| (x, y)))
            .map(|(x, y)| buf[(x, y)].symbol().to_string())
            .collect();
        checks.push((
            "ui:inline-frame".into(),
            content.contains("▚ INPUT ▞") && content.contains("/clear"),
        ));
    }

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

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flags: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    if flags.contains(&"--render-once") {
        return render_once();
    }
    if flags.contains(&"--self-test") {
        return self_test();
    }
    let yolo = flags.contains(&"--yolo");
    let verbose = flags.contains(&"--verbose");
    match run_live(yolo, verbose) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("seatui: {}", e);
            ExitCode::FAILURE
        }
    }
}
