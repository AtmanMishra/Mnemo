//! `mnemo-cockpit`: one app, five panes, driven by pi's RPC mode and memsrv.
//!
//! Panes are modules implementing `PaneView`; this file owns only the event
//! loop and the wiring between panes and the two sidecars.
use crossterm::event::{self, Event, KeyCode};
use crossterm::execute;
use crossterm::terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use seatui::cockpit::{Action, Cockpit, Focus, Pane};
use seatui::cockpit_ui;
use seatui::memclient::{self, MemSession};
use seatui::pane::PaneView;
use seatui::pane_agents::AgentsPane;
use seatui::pane_chat::ChatPane;
use seatui::pane_logs::LogsPane;
use seatui::pane_memory::MemoryPane;
use seatui::pane_skills::SkillsPane;
use seatui::rpc::RpcSession;
use seatui::theme;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn main() -> io::Result<()> {
    let root = repo_root();
    let journal = memclient::default_journal();

    let mut cockpit = Cockpit::new();
    // both sidecars are optional: the cockpit is still useful without either
    let mut agent = match RpcSession::spawn(&root) {
        Ok(s) => Some(s),
        Err(e) => { cockpit.status = format!("agent unavailable: {e}"); None }
    };
    let mut mem = match MemSession::open(&journal) {
        Ok(m) => Some(m),
        Err(e) => { cockpit.status = format!("memory unavailable: {e}"); None }
    };
    if cockpit.status.is_empty() { cockpit.status = "ready".into(); }

    let home = std::env::var("HOME").map(PathBuf::from).unwrap_or_default();
    let mut panes = Panes {
        chat: ChatPane::new(),
        memory: MemoryPane::new(),
        agents: AgentsPane::new(),
        skills: SkillsPane::load(&root, &home, &root.join("harness-engine").join("bundles")),
        logs: {
            // 5.6: the same pane can show today's agent traces (`s` toggles)
            let today = std::process::Command::new("date")
                .arg("+%Y-%m-%d").output().ok()
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|s| s.trim().to_string())
                .unwrap_or_default();
            LogsPane::new(&journal).with_traces(&home.join(".mnemo").join("logs").join(format!("{today}.jsonl")))
        },
    };
    refresh_memory(&mut panes, mem.as_mut());

    enable_raw_mode()?;
    let mut out = io::stdout();
    execute!(out, EnterAlternateScreen)?;
    let mut term = Terminal::new(CrosstermBackend::new(out))?;

    let result = run(&mut term, &mut cockpit, &mut panes, agent.as_mut(), mem.as_mut());

    disable_raw_mode()?;
    execute!(term.backend_mut(), LeaveAlternateScreen)?;
    term.show_cursor()?;
    if let Some(a) = agent.as_mut() { a.stop(); }
    if let Some(m) = mem.as_mut() { m.stop(); }
    result
}

/// The five panes. Adding one is: a module, a field here, a match arm.
struct Panes {
    chat: ChatPane,
    memory: MemoryPane,
    agents: AgentsPane,
    skills: SkillsPane,
    logs: LogsPane,
}

impl Panes {
    fn view(&self, p: Pane) -> &dyn PaneView {
        match p {
            Pane::Chat => &self.chat,
            Pane::Memory => &self.memory,
            Pane::Agents => &self.agents,
            Pane::Skills => &self.skills,
            Pane::Logs => &self.logs,
        }
    }
    fn view_mut(&mut self, p: Pane) -> &mut dyn PaneView {
        match p {
            Pane::Chat => &mut self.chat,
            Pane::Memory => &mut self.memory,
            Pane::Agents => &mut self.agents,
            Pane::Skills => &mut self.skills,
            Pane::Logs => &mut self.logs,
        }
    }
}

/// Pull nodes + episode logs from memsrv into the panes that show them.
fn refresh_memory(panes: &mut Panes, mem: Option<&mut MemSession>) {
    let Some(mem) = mem else { return };
    let rows = match mem.dump() {
        Ok(r) => r,
        Err(e) => { panes.memory.error = Some(e); return; }
    };
    // episode transcripts come from each node's own state text
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

fn run<B: ratatui::backend::Backend>(
    term: &mut Terminal<B>,
    cockpit: &mut Cockpit,
    panes: &mut Panes,
    mut agent: Option<&mut RpcSession>,
    mut mem: Option<&mut MemSession>,
) -> io::Result<()> {
    let mut spin = 0usize;
    let mut body_height = 10usize;

    while !cockpit.quit {
        if let Some(a) = agent.as_deref_mut() {
            let events = a.poll();
            if !events.is_empty() {
                for ev in events { panes.chat.apply(ev); }
                cockpit.busy = panes.chat.busy;
                // the agent writes memory as it works: keep the panes honest
                refresh_memory(panes, mem.as_deref_mut());
            }
        }
        panes.view_mut(cockpit.pane).tick();

        let view = panes.view(cockpit.pane);
        let (body, help, pane_status) = (view.lines(body_height), view.help(), view.status());
        if !cockpit.busy { cockpit.status = pane_status; }

        term.draw(|f| {
            let (_, main, _, _) = cockpit_ui::layout(f.area());
            body_height = main.height.saturating_sub(2) as usize;
            cockpit_ui::draw_with_help(f, cockpit, body, &help);
        })?;

        if cockpit.busy {
            spin = (spin + 1) % theme::SPINNER.len();
            cockpit.pulse = !cockpit.pulse;
            cockpit.status = format!("{} working", theme::SPINNER[spin]);
        }

        if !event::poll(Duration::from_millis(theme::SPINNER_INTERVAL_MS))? { continue; }
        let Event::Key(key) = event::read()? else { continue };

        // pane-local keys win, but only when the body has focus — otherwise
        // every letter would be a shortcut instead of text
        if cockpit.focus == Focus::Main && panes.view_mut(cockpit.pane).on_key(key, body_height) {
            continue;
        }
        // Enter in the memory pane's search box runs the query
        if cockpit.pane == Pane::Memory && key.code == KeyCode::Enter {
            if run_memory_search(panes, mem.as_deref_mut()) { continue; }
        }

        match cockpit.on_key(key) {
            Action::Quit => break,
            Action::Submit(line) => {
                if let Some(rest) = line.strip_prefix('/') {
                    command(rest, cockpit, panes, agent.as_deref_mut(), mem.as_deref_mut());
                } else if let Some(a) = agent.as_deref_mut() {
                    panes.chat.push_user(&line);
                    cockpit.busy = true;
                    if let Err(e) = a.prompt(&line) { cockpit.status = format!("send failed: {e}"); }
                } else {
                    cockpit.status = "no agent process: check `mnemo auth status`".into();
                }
            }
            Action::Moved(d) => match cockpit.pane {
                Pane::Chat => {
                    let total = panes.chat.lines(0).len();
                    panes.chat.scroll_by(-d, total, body_height);
                }
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

/// Enter inside the memory pane's search box. Returns true if it was consumed.
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

fn command(
    cmd: &str,
    cockpit: &mut Cockpit,
    panes: &mut Panes,
    agent: Option<&mut RpcSession>,
    mem: Option<&mut MemSession>,
) {
    match cmd {
        "help" => cockpit.show_help = true,
        "quit" => cockpit.quit = true,
        "memory" => cockpit.pane = Pane::Memory,
        "agents" => cockpit.pane = Pane::Agents,
        "skills" => cockpit.pane = Pane::Skills,
        "logs" => cockpit.pane = Pane::Logs,
        "clear" => panes.chat = ChatPane::new(),
        "thinking" => panes.chat.show_thinking = !panes.chat.show_thinking,
        "abort" => match agent {
            Some(a) => { let _ = a.abort(); cockpit.status = "abort sent".into(); }
            None => cockpit.status = "no agent to abort".into(),
        },
        "consolidate" => match mem {
            Some(m) => match m.request("consolidate", serde_json::json!({})) {
                Ok(r) => {
                    let n = r.get("lessons").and_then(|l| l.as_array()).map(|a| a.len()).unwrap_or(0);
                    cockpit.status = format!("consolidated: {n} lesson(s)");
                    refresh_memory(panes, None);
                }
                Err(e) => cockpit.status = format!("consolidate failed: {e}"),
            },
            None => cockpit.status = "memory sidecar not running".into(),
        },
        other => cockpit.status = format!("unknown command /{other}"),
    }
}
