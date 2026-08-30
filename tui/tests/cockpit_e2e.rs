//! End-to-end cockpit check: a real memsrv over a real journal, real skill
//! files on disk, driven through the real key handler, rendered to a real
//! ratatui backend. Everything except the terminal itself and the LLM.
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::backend::TestBackend;
use ratatui::Terminal;
use seatui::cockpit::{Action, Cockpit, Focus, Pane};
use seatui::cockpit_ui;
use seatui::memclient::{memsrv_bin, MemSession};
use seatui::pane::PaneView;
use seatui::pane_agents::AgentsPane;
use seatui::pane_chat::ChatPane;
use seatui::pane_logs::LogsPane;
use seatui::pane_memory::MemoryPane;
use seatui::pane_skills::SkillsPane;
use seatui::rpc::AgentEvent;
use std::path::PathBuf;

fn key(c: char) -> KeyEvent { KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE) }
fn code(k: KeyCode) -> KeyEvent { KeyEvent::new(k, KeyModifiers::NONE) }

fn workdir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("cockpit-e2e-{name}"));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// Render one frame and return the screen as a string.
fn screen(c: &Cockpit, pane: &dyn PaneView, w: u16, h: u16) -> String {
    let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
    term.draw(|f| {
        let (_, main, _, _) = cockpit_ui::layout(f.area());
        let body = pane.lines(main.height.saturating_sub(2) as usize);
        cockpit_ui::draw_with_help(f, c, body, &pane.help());
    })
    .unwrap();
    format!("{:?}", term.backend().buffer())
}

#[test]
fn cockpit_drives_real_memory_through_every_pane() {
    if !memsrv_bin().exists() {
        eprintln!("skipping: memsrv not built (cargo build in memory-layer/)");
        return;
    }
    let dir = workdir("full");
    let journal = dir.join("journal.jsonl");

    // --- seed a real memory graph through the real sidecar -----------------
    let mut mem = MemSession::open(&journal).unwrap();
    mem.request("create_node", serde_json::json!({"kind": "aspect", "label": "helm rollback needs --wait"})).unwrap();
    let ep = mem.request("episode", serde_json::json!({"label": "deploy checkout"})).unwrap();
    let ep = ep.get("episode").unwrap().as_u64().unwrap();
    let sub = mem.request("episode", serde_json::json!({"label": format!("subagent of #{ep}: audit tests")})).unwrap();
    let sub = sub.get("episode").unwrap().as_u64().unwrap();
    let steer = mem.request("steer", serde_json::json!({
        "episode": ep, "failure": "helm rollback timed out on checkout",
    })).unwrap();
    let pain = steer.get("pain_node").unwrap().as_u64().unwrap();

    // --- memory pane: grouped by brain area, salience included -------------
    let rows = mem.dump().unwrap();
    let mut memory = MemoryPane::new();
    memory.rows = rows.clone();
    let areas: Vec<&str> = memory.grouped().iter().map(|(a, _)| *a).collect();
    assert!(areas.contains(&"Episodic") && areas.contains(&"Semantic") && areas.contains(&"Salience"),
        "3.6: nodes must group by brain area, got {areas:?}");
    assert!(memory.rows.iter().any(|r| r.id == pain && r.area == "Salience"),
        "the steer() pain marker must show up in Salience");

    let mut cockpit = Cockpit::new();
    cockpit.pane = Pane::Memory;
    let out = screen(&cockpit, &memory, 90, 24);
    assert!(out.contains("SALIENCE"), "area headers render: {out}");
    assert!(out.contains("helm rollback needs"), "labels render, not just ids");

    // --- memory pane search, filtered to one area, through memsrv ----------
    cockpit.focus = Focus::Main;
    assert!(memory.on_key(key('/'), 20));
    for c in "helm rollback".chars() { memory.on_key(key(c), 20); }
    memory.rows = mem.search(&memory.query, 10, &["salience".into()]).unwrap();
    assert!(!memory.rows.is_empty(), "area-filtered search found nothing");
    assert!(memory.rows.iter().all(|r| r.area == "Salience"),
        "3.2: the areas filter must hold: {:?}", memory.rows);
    memory.rows = rows.clone();

    // --- agents pane: the delegation tree, from the same journal -----------
    let logs: Vec<(u64, Vec<String>)> = rows.iter()
        .filter(|r| r.kind == "TaskEpisode")
        .map(|r| (r.id, mem.state(r.id).unwrap().lines().map(|l| l.trim().to_string()).collect()))
        .collect();
    let agents = AgentsPane::load(&rows, &|id| {
        logs.iter().find(|(i, _)| *i == id).map(|(_, l)| l.clone()).unwrap_or_default()
    });
    let tree: Vec<(usize, u64)> = agents.tree().iter().map(|(d, e)| (*d, e.id)).collect();
    assert_eq!(tree, [(0, ep), (1, sub)], "2.5: subagent must nest under its parent");
    assert!(agents.status().contains("failed"), "the steered episode is a failure: {}", agents.status());

    cockpit.pane = Pane::Agents;
    let out = screen(&cockpit, &agents, 90, 24);
    assert!(out.contains("deploy checkout") && out.contains("audit tests"), "{out}");

    // --- logs pane: tails the journal memsrv actually wrote ----------------
    let mut logs_pane = LogsPane::new(&journal);
    logs_pane.tick();
    assert!(logs_pane.ops.len() >= 6, "2.7: journal ops must stream in, got {}", logs_pane.ops.len());
    assert!(logs_pane.ops.iter().any(|o| o.kind == "SetArea"), "area ops are journaled");
    logs_pane.filtering = true;
    logs_pane.filter = "setarea".into();
    assert!(logs_pane.visible().len() < logs_pane.ops.len(), "the filter narrows the stream");

    cockpit.pane = Pane::Logs;
    assert!(screen(&cockpit, &logs_pane, 90, 24).contains("SetArea"));

    // --- new ops appear without restarting the pane ------------------------
    let before = logs_pane.ops.len();
    mem.request("create_node", serde_json::json!({"kind": "harness", "label": "lint-harness"})).unwrap();
    logs_pane.tick();
    assert!(logs_pane.ops.len() > before, "2.7: the tail must pick up live writes");

    mem.stop();
}

#[test]
fn cockpit_navigates_and_renders_every_pane_without_an_agent() {
    let dir = workdir("nav");
    // a real skill on disk for the skills pane to find
    let skills = dir.join(".agents").join("skills").join("tui-design");
    std::fs::create_dir_all(&skills).unwrap();
    std::fs::write(skills.join("SKILL.md"),
        "---\nname: tui-design\ndescription: terminal interface guidance\n---\nbody").unwrap();
    std::fs::create_dir_all(dir.join(".git")).unwrap();

    let mut cockpit = Cockpit::new();
    let chat = ChatPane::new();
    let memory = MemoryPane::new();
    let agents = AgentsPane::new();
    let skills_pane = SkillsPane::load(&dir, &dir, &dir.join("bundles"));
    let logs = LogsPane::new(&dir.join("missing.jsonl"));

    assert!(skills_pane.rows.iter().any(|r| r.name == "tui-design"),
        "2.6: skills must be discovered from disk, got {:?}", skills_pane.rows);

    // tab all the way round, rendering each pane
    for expected in [Pane::Memory, Pane::Agents, Pane::Skills, Pane::Logs, Pane::Chat] {
        cockpit.on_key(code(KeyCode::Tab));
        assert_eq!(cockpit.pane, expected);
        let view: &dyn PaneView = match cockpit.pane {
            Pane::Chat => &chat,
            Pane::Memory => &memory,
            Pane::Agents => &agents,
            Pane::Skills => &skills_pane,
            Pane::Logs => &logs,
        };
        let out = screen(&cockpit, view, 90, 20);
        assert!(out.contains("MNEMO"), "the rail is always visible");
        assert!(out.contains(&expected.label().to_uppercase()), "{expected:?} title missing");
    }

    // every pane renders something rather than an empty box
    assert!(screen(&cockpit, &memory, 80, 18).contains("memory is empty"));
    assert!(screen(&cockpit, &agents, 80, 18).contains("no episodes"));
    assert!(screen(&cockpit, &logs, 80, 18).contains("no journal"), "a missing journal is reported");
}

#[test]
fn a_prompt_round_trip_renders_as_a_transcript() {
    let mut cockpit = Cockpit::new();
    let mut chat = ChatPane::new();

    // type a prompt and submit it
    for c in "fix the build".chars() { cockpit.on_key(key(c)); }
    let Action::Submit(line) = cockpit.on_key(code(KeyCode::Enter)) else {
        panic!("enter must submit the prompt");
    };
    chat.push_user(&line);
    cockpit.busy = chat.busy;
    assert!(cockpit.busy, "the shell shows work in progress");

    // replay the exact event sequence pi emits for a tool-using turn
    for ev in [
        AgentEvent::Started,
        AgentEvent::Thinking("checking the failing test".into()),
        AgentEvent::ToolStart { id: "t1".into(), name: "bash_exec".into(), args: "cmd=cargo test".into() },
        AgentEvent::ToolEnd { id: "t1".into(), name: "bash_exec".into(), ok: true },
        AgentEvent::Text { text: "the build is ".into(), final_: false },
        AgentEvent::Text { text: "the build is green".into(), final_: true },
        AgentEvent::Settled,
    ] {
        chat.apply(ev);
    }
    cockpit.busy = chat.busy;
    assert!(!cockpit.busy, "settling must stop the spinner");

    let out = screen(&cockpit, &chat, 80, 20);
    assert!(out.contains("fix the build"), "the user turn is in the transcript");
    assert!(out.contains("bash_exec"), "tool card rendered");
    assert!(out.contains("the build is green"), "assistant reply rendered");
    assert!(out.contains("thinking"), "thinking block is summarised");
    assert!(!out.contains("checking the failing test"), "and collapsed by default");

    // the ? card and the / palette both reach the screen
    cockpit.focus = Focus::Main;
    cockpit.on_key(key('?'));
    assert!(screen(&cockpit, &chat, 80, 20).contains("tab"), "help card lists global keys");
    cockpit.on_key(code(KeyCode::Esc));
    cockpit.focus = Focus::Input;
    for c in "/con".chars() { cockpit.on_key(key(c)); }
    assert!(screen(&cockpit, &chat, 80, 20).contains("/consolidate"), "palette filters as you type");
}
