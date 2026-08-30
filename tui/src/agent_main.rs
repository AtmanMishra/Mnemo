//! `mnemo-agent`: the whole product in one terminal app.
//!
//! Launch it anywhere and that directory is your project. First run walks the
//! pixel onboarding; after that you land in Chat, with Sessions one key away
//! (projects, their sessions, and the subagents each spawned). Logging in,
//! switching model and spawning a differently-modelled subagent all happen
//! here — nothing sends you back to a shell.
use crossterm::event::{self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEvent,
                       KeyModifiers, MouseButton, MouseEventKind};
use crossterm::execute;
use crossterm::terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use seatui::auth::{self, AuthFile};
use seatui::brand;
use seatui::clipboard;
use seatui::cockpit::{Action, Cockpit, Focus, Pane};
use seatui::cockpit_ui;
use seatui::memclient::{self, MemSession};
use seatui::models;
use seatui::onboarding::{self, Onboarding, Reason};
use seatui::pane::PaneView;
use seatui::pane_agents::AgentsPane;
use seatui::pane_chat::ChatPane;
use seatui::pane_logs::LogsPane;
use seatui::pane_memory::MemoryPane;
use seatui::pane_sessions::{Intent, SessionsPane};
use seatui::pane_skills::SkillsPane;
use seatui::rpc::RpcSession;
use seatui::sessions::{attach_subagents, list_projects, list_sessions, spans_for, subagents_from_traces, transcript};
use seatui::theme;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn home() -> PathBuf {
    std::env::var("HOME").map(PathBuf::from).unwrap_or_default()
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// `--projects` prints what the Sessions pane would show and exits. Kept
/// because a TUI is the one thing you cannot inspect from a script.
fn print_projects(home: &Path, cwd: &Path) {
    let mut pane = SessionsPane::new(cwd.to_path_buf());
    pane.projects = list_projects(home);
    for p in pane.ordered_projects() {
        let here = if pane.is_here(&p) { " (here)" } else { "" };
        println!("{:<40} {:>3} session(s){here}", p.path.display(), p.sessions);
        for s in list_sessions(home, &p.dir).iter().take(3) {
            println!("    {} · {} msgs · {}", s.title, s.messages,
                s.model.clone().unwrap_or_else(|| "no model".into()));
        }
    }
}

struct Panes {
    chat: ChatPane,
    sessions: SessionsPane,
    memory: MemoryPane,
    agents: AgentsPane,
    skills: SkillsPane,
    logs: LogsPane,
}

impl Panes {
    fn view(&self, p: Pane) -> &dyn PaneView {
        match p {
            Pane::Chat => &self.chat,
            Pane::Sessions => &self.sessions,
            Pane::Memory => &self.memory,
            Pane::Agents => &self.agents,
            Pane::Skills => &self.skills,
            Pane::Logs => &self.logs,
        }
    }
    fn view_mut(&mut self, p: Pane) -> &mut dyn PaneView {
        match p {
            Pane::Chat => &mut self.chat,
            Pane::Sessions => &mut self.sessions,
            Pane::Memory => &mut self.memory,
            Pane::Agents => &mut self.agents,
            Pane::Skills => &mut self.skills,
            Pane::Logs => &mut self.logs,
        }
    }
}

fn main() -> io::Result<()> {
    let home = home();
    let cwd = std::env::current_dir().unwrap_or_default();

    if std::env::args().any(|a| a == "--projects") {
        print_projects(&home, &cwd);
        return Ok(());
    }
    // a TUI is the one thing a script cannot inspect, so the readers it
    // depends on are runnable on their own against real files
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--brand") {
        let cols = crossterm::terminal::size().map(|(w, _)| w as usize).unwrap_or(100);
        for line in brand::sheet(cols) {
            println!("{}", line.spans.iter().map(|s| s.content.to_string()).collect::<String>());
        }
        return Ok(());
    }
    if let Some(i) = args.iter().position(|a| a == "--transcript") {
        let Some(file) = args.get(i + 1) else {
            eprintln!("mnemo-agent --transcript <session.jsonl>");
            return Ok(());
        };
        for m in transcript(Path::new(file)) {
            println!("{m:?}");
        }
        return Ok(());
    }

    let root = repo_root();
    let journal = memclient::default_journal();
    let mut cockpit = Cockpit::new();

    // 8.3: nothing works without a provider, so first run starts here
    let mut stored = auth::load(&home);
    let mut overlay = if stored.is_configured() {
        None
    } else {
        Some(Onboarding::new(home.clone(), Reason::FirstRun))
    };
    apply_model(&mut cockpit, &stored);

    let mut panes = Panes {
        chat: {
            let mut c = ChatPane::new();
            c.project = cwd.display().to_string();
            c
        },
        sessions: {
            let mut p = SessionsPane::new(cwd.clone());
            p.projects = list_projects(&home);
            p
        },
        memory: MemoryPane::new(),
        agents: AgentsPane::new(),
        skills: SkillsPane::load(&root, &home, &root.join("harness-engine").join("bundles")),
        logs: LogsPane::new(&journal).with_traces(&home.join(".mnemo").join("logs")
            .join(format!("{}.jsonl", today()))),
    };

    // the agent only starts once there is something to talk to
    let mut agent = if stored.is_configured() { spawn_agent(&root, &cwd, None, &mut cockpit) } else { None };
    let mut mem = MemSession::open(&journal).ok();
    refresh_memory(&mut panes, mem.as_mut());

    enable_raw_mode()?;
    let mut out = io::stdout();
    execute!(out, EnterAlternateScreen)?;
    let mut term = Terminal::new(CrosstermBackend::new(out))?;

    let result = run(&mut term, &mut cockpit, &mut panes, &mut overlay, &mut stored,
                     &mut agent, mem.as_mut(), &home, &root, &cwd);

    disable_raw_mode()?;
    let _ = set_mouse(false); // a terminal left in mouse mode is unusable
    execute!(term.backend_mut(), LeaveAlternateScreen)?;
    term.show_cursor()?;
    if let Some(a) = agent.as_mut() { a.stop(); }
    if let Some(m) = mem.as_mut() { m.stop(); }
    result
}

fn today() -> String {
    std::process::Command::new("date").arg("+%Y-%m-%d").output().ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// Start (or restart) the agent in `cwd`, resuming `session` if given.
///
/// The launch directory is the project, so the agent runs THERE — running it
/// in the mnemo repo would file every session under the wrong project and give
/// the model the wrong tree to read.
fn spawn_agent(root: &Path, cwd: &Path, session: Option<&Path>, cockpit: &mut Cockpit)
    -> Option<RpcSession>
{
    match RpcSession::spawn_in(root, cwd, session) {
        Ok(s) => Some(s),
        Err(e) => { cockpit.notify(format!("agent unavailable: {e}"), now_ms()); None }
    }
}

/// Swap the running agent for one in another project, replacing the chat
/// transcript with whatever that session already contains.
fn switch_to(
    root: &Path, cwd: &Path, session: Option<&Path>,
    cockpit: &mut Cockpit, panes: &mut Panes, agent: &mut Option<RpcSession>,
) {
    if let Some(a) = agent.as_mut() { a.stop(); }
    *agent = spawn_agent(root, cwd, session, cockpit);
    let (project, width) = (cwd.display().to_string(), panes.chat.width);
    panes.chat = match session {
        Some(f) => ChatPane::from_transcript(&transcript(f)),
        None => ChatPane::new(),
    };
    panes.chat.project = project;
    panes.chat.width = width;
    cockpit.pane = Pane::Chat;
    cockpit.busy = false;
}

/// Reflect the stored credential in the status bar (8.6).
fn apply_model(cockpit: &mut Cockpit, auth: &AuthFile) {
    cockpit.model = auth.effective_provider().and_then(|p| {
        auth.default_model_for(p).map(|m| (p.to_string(), m.to_string()))
    });
}

fn refresh_memory(panes: &mut Panes, mem: Option<&mut MemSession>) {
    let Some(mem) = mem else { return };
    let rows = match mem.dump() {
        Ok(r) => r,
        Err(e) => { panes.memory.error = Some(e); return; }
    };
    let logs: Vec<(u64, Vec<String>)> = rows.iter()
        .filter(|r| r.kind == "TaskEpisode")
        .map(|r| (r.id, mem.state(r.id).unwrap_or_default()
            .lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect()))
        .collect();
    panes.memory.rows = rows.clone();
    panes.memory.error = None;
    let sel = panes.agents.selected;
    panes.agents = AgentsPane::load(&rows, &|id| {
        logs.iter().find(|(i, _)| *i == id).map(|(_, l)| l.clone()).unwrap_or_default()
    });
    panes.agents.selected = sel.min(panes.agents.tree().len().saturating_sub(1));
}

/// Load the sessions of whichever project the pane drilled into (8.5).
fn refresh_sessions(panes: &mut Panes, home: &Path) {
    let Some(dir) = panes.sessions.wanted_project_dir() else { return };
    if !panes.sessions.sessions.is_empty() { return; }
    let mut sessions = if dir.is_empty() { Vec::new() } else { list_sessions(home, &dir) };
    attach_subagents(&mut sessions, &subagents_from_traces(home));
    panes.sessions.sessions = sessions;
}

#[allow(clippy::too_many_arguments)]
fn run<B: ratatui::backend::Backend>(
    term: &mut Terminal<B>,
    cockpit: &mut Cockpit,
    panes: &mut Panes,
    overlay: &mut Option<Onboarding>,
    stored: &mut AuthFile,
    agent: &mut Option<RpcSession>,
    mut mem: Option<&mut MemSession>,
    home: &Path,
    root: &Path,
    cwd: &Path,
) -> io::Result<()> {
    let mut spin = 0usize;
    let mut body_height = 10usize;
    let mut body_width = 100usize;

    while !cockpit.quit {
        // --- onboarding takes the whole screen while it is open -------------
        if let Some(ob) = overlay.as_mut() {
            let cols = term.size().map(|s| s.width as usize).unwrap_or(100);
            ob.tick = ob.tick.wrapping_add(1);
            let body = onboarding::lines_in(ob, stored, cols);
            term.draw(|f| cockpit_ui::draw_onboarding(f, body))?;
            // the same cadence as the rest of the app, so Nyx walks at one speed
            if !event::poll(Duration::from_millis(theme::SPINNER_INTERVAL_MS))? { continue; }
            let Event::Key(key) = event::read()? else { continue };
            if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) {
                return Ok(());
            }
            // the catalog costs a process spawn, so fetch it once, the first
            // time the model step is on screen
            if ob.step == onboarding::Step::Model
                && ob.models.is_empty() && ob.models_error.is_none()
            {
                ob.load_models(models::fetch_models(root));
            }
            if ob.on_key(key, now_ms()) {
                *stored = auth::load(home);
                apply_model(cockpit, stored);
                // the agent could not start without a provider; start it now
                if agent.is_none() && stored.is_configured() {
                    *agent = spawn_agent(root, cwd, None, cockpit);
                }
                *overlay = None;
            }
            continue;
        }

        if let Some(a) = agent.as_mut() {
            let events = a.poll();
            if !events.is_empty() {
                for ev in events { panes.chat.apply(ev); }
                cockpit.busy = panes.chat.busy;
                refresh_memory(panes, mem.as_deref_mut());
            }
        }
        // one queued message per settle, so each gets a whole turn
        if !cockpit.busy && !cockpit.queued.is_empty() && agent.is_some() {
            let next = cockpit.queued.remove(0);
            send_prompt(&next, cockpit, panes, agent.as_mut());
        }
        panes.chat.width = body_width;
        panes.view_mut(cockpit.pane).tick();
        refresh_sessions(panes, home);

        let view = panes.view(cockpit.pane);
        let (body, help, pane_status) = (view.lines(body_height), view.help(), view.status());
        if !cockpit.busy { cockpit.status = cockpit.status_for(pane_status, now_ms()); }

        term.draw(|f| {
            let (_, main, _, _) = cockpit_ui::layout_with(f.area(), cockpit.queued.len());
            body_height = main.height.saturating_sub(2) as usize;
            body_width = main.width.saturating_sub(2) as usize;
            cockpit_ui::draw_with_help(f, cockpit, body, &help);
        })?;

        if cockpit.busy {
            // a dither band rather than a spinner: thinking is not one cell of
            // work, and a travelling wave reads as progress where a twitching
            // character reads as a stuck process
            spin = (spin + 1) % theme::DITHER_PERIOD;
            cockpit.pulse = !cockpit.pulse;
            let waiting = match cockpit.queued.len() {
                0 => String::new(),
                n => format!(" · {n} queued"),
            };
            cockpit.status = format!("{} thinking{waiting}", theme::dither_wave(spin, 12));
        }

        if !event::poll(Duration::from_millis(theme::SPINNER_INTERVAL_MS))? { continue; }
        let key = match event::read()? {
            Event::Key(k) => k,
            // Mouse events only arrive while capture is on, which is off by
            // default — see `set_mouse`.
            Event::Mouse(m) => { on_mouse(m, cockpit, panes, body_height); continue }
            _ => continue,
        };

        // Enter inside Sessions opens a project or a session
        if cockpit.pane == Pane::Sessions && cockpit.focus == Focus::Main
            && key.code == KeyCode::Enter
        {
            match panes.sessions.enter() {
                Intent::OpenSession(s) => {
                    // the session's OWN cwd, not ours: resuming from the
                    // wrong directory makes pi fork it into another project
                    let dir = if s.cwd.as_os_str().is_empty() { cwd.to_path_buf() } else { s.cwd.clone() };
                    switch_to(root, &dir, Some(&s.file), cockpit, panes, agent);
                    if let (Some(p), Some(m)) = (s.provider.clone(), s.model.clone()) {
                        cockpit.model = Some((p, m));
                    }
                    cockpit.notify(format!("resumed: {}", s.title), now_ms());
                }
                Intent::NewSession(path) => {
                    switch_to(root, &path, None, cockpit, panes, agent);
                    cockpit.notify(format!("new session in {}", path.display()), now_ms());
                }
                Intent::OpenSubagent(sub) => {
                    let spans = spans_for(home, &sub.session);
                    panes.sessions.show_subagent(sub, spans);
                }
                Intent::None => {}
            }
            continue;
        }
        // y copies out of the app. The terminal's own drag-select still
        // works (we never capture the mouse), but dragging cannot pick out one
        // logical block across a scroll boundary — this can.
        if cockpit.focus == Focus::Main && key.code == KeyCode::Char('y') {
            let text = match cockpit.pane {
                Pane::Chat => panes.chat.yank_text(),
                _ => panes.view(cockpit.pane).lines(0).iter()
                    .map(|l| l.spans.iter().map(|s| s.content.to_string()).collect::<String>())
                    .collect::<Vec<_>>().join("\n"),
            };
            cockpit.notify(match clipboard::copy(&text) {
                Ok(bin) => format!("copied {} chars ({bin})", text.len()),
                Err(e) => format!("copy failed: {e}"),
            }, now_ms());
            continue;
        }
        if cockpit.focus == Focus::Main && panes.view_mut(cockpit.pane).on_key(key, body_height) {
            continue;
        }
        if cockpit.pane == Pane::Memory && key.code == KeyCode::Enter
            && run_memory_search(panes, mem.as_deref_mut())
        {
            continue;
        }

        match cockpit.on_key(key) {
            Action::Quit => break,
            Action::Submit(line) => {
                if let Some(rest) = line.strip_prefix('/') {
                    command(rest, cockpit, panes, overlay, stored, agent.as_mut(),
                            mem.as_deref_mut(), home, root);
                } else if cockpit.model.is_none() {
                    // 8.6: an unset model is a readable error, not a crash
                    cockpit.notify("no model set — run /login, or /model to pick one", now_ms());
                } else if cockpit.busy {
                    // typing while it works is normal; the message waits its
                    // turn rather than being dropped or jammed into this one
                    cockpit.queued.push(line);
                    cockpit.notify(format!("queued ({}) — alt+enter to steer instead",
                                             cockpit.queued.len()), now_ms());
                } else {
                    send_prompt(&line, cockpit, panes, agent.as_mut());
                }
            }
            Action::Steer(line) => {
                // steering is only meaningful mid-run; otherwise it is a prompt
                match (cockpit.busy, agent.as_mut()) {
                    (true, Some(a)) => {
                        panes.chat.push_user(&format!("↯ {line}"));
                        match a.steer(&line) {
                            Ok(()) => cockpit.notify("steering", now_ms()),
                            Err(e) => cockpit.notify(format!("steer failed: {e}"), now_ms()),
                        }
                    }
                    (false, _) if cockpit.model.is_some() =>
                        send_prompt(&line, cockpit, panes, agent.as_mut()),
                    _ => cockpit.notify("nothing running to steer", now_ms()),
                }
            }
            Action::Moved(d) => match cockpit.pane {
                Pane::Chat => {
                    let total = panes.chat.lines(0).len();
                    panes.chat.scroll_by(-d, total, body_height);
                }
                Pane::Sessions => panes.sessions.move_selection(d),
                Pane::Memory => panes.memory.move_selection(d),
                Pane::Agents => panes.agents.move_selection(d),
                Pane::Skills => panes.skills.move_selection(d),
                Pane::Logs => {}
            },
            Action::None => {}
        }
    }
    Ok(())
}

/// Turn terminal mouse reporting on or off.
///
/// It is OFF by default, and that is a deliberate choice rather than an
/// omission: while the app does not capture the mouse, the TERMINAL's own
/// drag-select and copy keep working, and the terminal's selection is better
/// than anything a TUI can reimplement — it knows the font, the scrollback and
/// the platform clipboard. Turning capture on buys the scroll wheel and
/// click-to-open, and costs native selection (most terminals still give it
/// back if you hold shift, or option on macOS).
fn set_mouse(on: bool) -> io::Result<()> {
    let mut out = io::stdout();
    if on { execute!(out, EnableMouseCapture) } else { execute!(out, DisableMouseCapture) }
}

/// Wheel scrolls the focused pane; a click on the rail switches pane, and a
/// click on a foldable block in Chat opens it.
fn on_mouse(m: crossterm::event::MouseEvent, cockpit: &mut Cockpit, panes: &mut Panes, height: usize) {
    match m.kind {
        MouseEventKind::ScrollUp => scroll(cockpit, panes, 1, height),
        MouseEventKind::ScrollDown => scroll(cockpit, panes, -1, height),
        MouseEventKind::Down(MouseButton::Left) => {
            // the rail is the left column; everything else is the body
            if (m.column as usize) < cockpit_ui::RAIL_WIDTH as usize {
                // rail row 1 is the first pane: row 0 is the border
                if let Some(p) = Pane::ALL.get((m.row as usize).saturating_sub(1)) {
                    cockpit.pane = *p;
                    cockpit.focus = Focus::Main;
                }
                return;
            }
            if cockpit.pane == Pane::Chat {
                let row = (m.row as usize).saturating_sub(1); // body border
                if panes.chat.focus_at_row(row, height) {
                    cockpit.focus = Focus::Main;
                    panes.chat.toggle_focused();
                }
            }
        }
        _ => {}
    }
}

fn scroll(cockpit: &mut Cockpit, panes: &mut Panes, delta: isize, height: usize) {
    match cockpit.pane {
        Pane::Chat => {
            let total = panes.chat.lines(0).len();
            panes.chat.scroll_by(delta, total, height);
        }
        Pane::Sessions => panes.sessions.move_selection(-delta),
        Pane::Memory => panes.memory.move_selection(-delta),
        Pane::Agents => panes.agents.move_selection(-delta),
        Pane::Skills => panes.skills.move_selection(-delta),
        Pane::Logs => {}
    }
}

/// Send one prompt and mark the UI busy. The single place a turn starts, so
/// the queue and a fresh message cannot drift apart.
fn send_prompt(line: &str, cockpit: &mut Cockpit, panes: &mut Panes, agent: Option<&mut RpcSession>) {
    let Some(a) = agent else {
        cockpit.notify("agent process is not running", now_ms());
        return;
    };
    panes.chat.push_user(line);
    cockpit.busy = true;
    if let Err(e) = a.prompt(line) { cockpit.notify(format!("send failed: {e}"), now_ms()); }
}

fn run_memory_search(panes: &mut Panes, mem: Option<&mut MemSession>) -> bool {
    let m = &mut panes.memory;
    if !m.searching || m.query.is_empty() { return false; }
    let (q, areas) = (m.query.clone(), m.search_areas());
    match mem {
        Some(mem) => match mem.search(&q, 20, &areas) {
            Ok(rows) => { m.rows = rows; m.selected = 0; m.error = None; }
            Err(e) => m.error = Some(e),
        },
        None => m.error = Some("memory sidecar not running".into()),
    }
    m.searching = false;
    true
}

#[allow(clippy::too_many_arguments)]
fn command(
    cmd: &str,
    cockpit: &mut Cockpit,
    panes: &mut Panes,
    overlay: &mut Option<Onboarding>,
    stored: &mut AuthFile,
    agent: Option<&mut RpcSession>,
    mem: Option<&mut MemSession>,
    home: &Path,
    root: &Path,
) {
    let (name, arg) = match cmd.split_once(' ') {
        Some((n, a)) => (n, a.trim()),
        None => (cmd, ""),
    };
    match name {
        "help" => cockpit.show_help = true,
        "quit" => cockpit.quit = true,
        // 8.6: authenticate without leaving the session
        "login" => *overlay = Some(Onboarding::new(home.to_path_buf(), Reason::Login)),
        "model" => {
            *stored = auth::load(home);
            if stored.logged_in().is_empty() {
                cockpit.notify("no provider logged in — /login first", now_ms());
            } else if arg.is_empty() {
                // no argument: show what the logged-in providers actually
                // offer. Asking someone to type a model name they have never
                // seen is not a choice, it is a quiz.
                let mut ob = Onboarding::for_model(home.to_path_buf());
                ob.load_models(models::fetch_models(root));
                *overlay = Some(ob);
            } else {
                match models::fetch_models(root) {
                    Ok(catalog) => match catalog.iter().find(|(p, m)| m == arg || format!("{p}/{m}") == arg) {
                        Some((p, m)) => match auth::set_default_model(home, p, m)
                            .and_then(|_| auth::set_default_provider(home, p))
                        {
                            Ok(auth) => {
                                *stored = auth;
                                apply_model(cockpit, stored);
                                cockpit.notify(format!("model: {p}/{m}"), now_ms());
                            }
                            Err(e) => cockpit.notify(format!("could not save: {e}"), now_ms()),
                        },
                        None => cockpit.notify(
                            format!("'{arg}' is not offered by any logged-in provider — /model to browse"),
                            now_ms()),
                    },
                    Err(e) => cockpit.notify(format!("could not read the model list: {e}"), now_ms()),
                }
            }
        }
        "mouse" => {
            cockpit.mouse = !cockpit.mouse;
            match set_mouse(cockpit.mouse) {
                Ok(()) => {
                    let msg = if cockpit.mouse {
                        "mouse on — wheel scrolls, click opens a block; hold shift to select text"
                    } else {
                        "mouse off — drag to select and copy as usual"
                    };
                    cockpit.notify(msg, now_ms());
                }
                Err(e) => {
                    cockpit.mouse = !cockpit.mouse;
                    cockpit.notify(format!("mouse: {e}"), now_ms());
                }
            }
        }
        "sessions" => cockpit.pane = Pane::Sessions,
        "memory" => cockpit.pane = Pane::Memory,
        "agents" => cockpit.pane = Pane::Agents,
        "skills" => cockpit.pane = Pane::Skills,
        "logs" => cockpit.pane = Pane::Logs,
        "clear" => panes.chat = ChatPane::new(),
        "thinking" => panes.chat.show_thinking = !panes.chat.show_thinking,
        "abort" => match agent {
            Some(a) => { let _ = a.abort(); cockpit.notify("abort sent", now_ms()); }
            None => cockpit.notify("no agent to abort", now_ms()),
        },
        "consolidate" => match mem {
            Some(m) => match m.request("consolidate", serde_json::json!({})) {
                Ok(r) => {
                    let n = r.get("lessons").and_then(|l| l.as_array()).map(|a| a.len()).unwrap_or(0);
                    cockpit.notify(format!("consolidated: {n} lesson(s)"), now_ms());
                }
                Err(e) => cockpit.notify(format!("consolidate failed: {e}"), now_ms()),
            },
            None => cockpit.notify("memory sidecar not running", now_ms()),
        },
        other => cockpit.notify(format!("unknown command /{other}"), now_ms()),
    }
}

/// Unused outside tests, but keeps the key type imported for clarity.
#[allow(dead_code)]
fn _key(c: char) -> KeyEvent {
    KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE)
}
