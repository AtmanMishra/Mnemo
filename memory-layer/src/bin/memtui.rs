//! memtui: ratatui terminal UI over the memory layer journal.
//! Run: cargo run --bin memtui [-- path/to/journal.jsonl] [--render-once]
//! --render-once draws a single frame to stdout (no alt screen, no raw mode)
//! and exits 0, for non-interactive smoke tests.
use memory_layer::model::{Millis, NodeId, NodeKind, Op};
use memory_layer::persist::Journal;
use memory_layer::remote::OpenRouterEmbedder;
use memory_layer::search::{build_vectors, search, SearchOpts, SearchResult};
use memory_layer::store::StoreData;
use memory_layer::vec::{Embedder, HashingEmbedder};
use std::io::Write;
use ratatui::{
    prelude::*,
    widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph, Wrap},
};

// ---------- dotenv (same tiny loader as memcli) ----------
fn load_dotenv() {
    for candidate in [".env", "../.env"] {
        if let Ok(txt) = std::fs::read_to_string(candidate) {
            for line in txt.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') { continue; }
                if let Some((k, v)) = line.split_once('=') {
                    std::env::set_var(k.trim(), v.trim());
                }
            }
            return;
        }
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Focus { List, Detail, Search }

struct App {
    store: StoreData,
    ops: Vec<Op>,
    ops_replayed: usize,
    load_error: Option<String>,
    jpath: String,
    clock: Millis,
    embedder_mode: String,
    embedder: std::sync::Arc<dyn Embedder>,
    node_ids: Vec<NodeId>,
    sel: ListState,
    focus: Focus,
    search_input: String,
    search_typing: bool,
    results: Vec<SearchResult>,
    result_sel: usize,
    status: String,
    show_ops: bool,
    show_help: bool,
}

fn kind_glyph(k: NodeKind) -> &'static str {
    match k {
        NodeKind::Aspect => "\u{25c6}",      // diamond
        NodeKind::TaskEpisode => "\u{25b6}", // triangle
        NodeKind::Entity => "\u{25cf}",      // circle
        NodeKind::Harness => "\u{2699}",     // gear
        NodeKind::Outcome => "\u{2713}",     // check
    }
}

impl App {
    fn load(jpath: &str) -> App {
        let embedder: std::sync::Arc<dyn Embedder> =
            match std::env::var("OPENROUTER_API_KEY") {
                Ok(k) if !k.is_empty() => match
                    OpenRouterEmbedder::from_env(std::path::Path::new("data"))
                {
                    Some(e) => std::sync::Arc::new(e),
                    None => std::sync::Arc::new(HashingEmbedder),
                },
                _ => std::sync::Arc::new(HashingEmbedder),
            };
        let embedder_mode = if std::env::var("OPENROUTER_API_KEY")
            .map(|k| !k.is_empty()).unwrap_or(false)
        {
            "openrouter".to_string()
        } else {
            "hashing".to_string()
        };
        let (ops, mut load_error) = match Journal::read_all(jpath) {
            Ok(ops) => (ops, None),
            Err(e) => (Vec::new(), Some(format!("journal unreadable: {e}"))),
        };
        let mut s = StoreData::new();
        let mut max_seen: Millis = 0;
        let mut applied = 0usize;
        for op in &ops {
            match s.apply(op) {
                Ok(()) => applied += 1,
                Err(e) => {
                    let msg = format!("journal error: {e}");
                    eprintln!("{msg}");
                    load_error.get_or_insert(msg);
                }
            }
            let at = op_at(op);
            max_seen = max_seen.max(at);
        }
        let clock = 1_700_000_000_000u64.max(max_seen + 1);
        let mut node_ids: Vec<NodeId> =
            s.nodes.values().filter(|n| !n.deleted).map(|n| n.id).collect();
        node_ids.sort_unstable();
        let mut sel = ListState::default();
        if !node_ids.is_empty() { sel.select(Some(0)); }
        App {
            store: s, ops, ops_replayed: applied, load_error, jpath: jpath.into(),
            clock, embedder_mode,
            embedder,
            node_ids, sel,
            focus: Focus::List,
            search_input: String::new(), search_typing: false,
            results: Vec::new(), result_sel: 0,
            status: "ready. / search | ? help | s ops | y copy | r reload | q quit".into(),
            show_ops: false,
            show_help: false,
        }
    }

    fn reload(&mut self) {
        let fresh = App::load(&self.jpath);
        *self = fresh;
        self.status = format!("reloaded {} ops from {}", self.ops.len(), self.jpath);
    }

    fn selected_node(&self) -> Option<NodeId> {
        self.sel.selected().and_then(|i| self.node_ids.get(i).copied())
    }

    fn move_sel(&mut self, delta: i32) {
        if self.node_ids.is_empty() { return; }
        let cur = self.sel.selected().unwrap_or(0) as i32;
        let n = self.node_ids.len() as i32;
        let next = (cur + delta).rem_euclid(n) as usize;
        self.sel.select(Some(next));
    }

    fn run_search(&mut self) {
        let q = self.search_input.trim().to_string();
        if q.is_empty() {
            self.status = "empty query".into();
            return;
        }
        let vectors = build_vectors(&self.store, self.embedder.as_ref());
        self.results = search(
            &self.store, &vectors, self.embedder.as_ref(), &q, 8, self.clock, &SearchOpts::default(),
        );
        self.result_sel = 0;
        self.status = format!(
            "searched '{}' -> {} hits ({})",
            q, self.results.len(), self.embedder_mode
        );
    }

    /// Enter on a highlighted result jumps the main list to that node.
    fn jump_to_result(&mut self) {
        if let Some(r) = self.results.get(self.result_sel) {
            if let Some(i) = self.node_ids.iter().position(|&id| id == r.node) {
                self.sel.select(Some(i));
                self.focus = Focus::Detail;
                self.status = format!("jumped to #{}", r.node);
            }
        }
    }

    fn ops_lines(&self) -> Vec<String> {
        let take = self.ops.iter().rev().take(20).collect::<Vec<_>>();
        take.iter().rev().map(|op| fmt_op(op)).collect()
    }
}

fn op_at(op: &Op) -> Millis {
    match op {
        Op::CreateNode { at, .. } | Op::AddFact { at, .. }
        | Op::SupersedeFact { at, .. } | Op::SetArea { at, .. } | Op::DeleteNode { at, .. }
        | Op::Link { at, .. } | Op::Unlink { at, .. }
        | Op::Reweight { at, .. } | Op::RecordOutcome { at, .. }
        | Op::PushContext { at, .. } | Op::CommitLog { at, .. } => *at,
    }
}

/// Human-readable one-line rendering of a journaled op.
fn fmt_op(op: &Op) -> String {
    match op {
        Op::CreateNode { id, kind, label, at } =>
            format!("[{at}] create #{id} {:?} \"{label}\"", kind),
        Op::AddFact { node, fact_id, key, value, at } =>
            format!("[{at}] fact #{fid} on #{node}: {key}={value}", fid = fact_id),
        Op::SupersedeFact { node, old_fact, new_fact_id, new_value, at, .. } =>
            format!("[{at}] supersede #{old_fact} -> #{new_fact_id} on #{node}: {new_value}"),
        Op::SetArea { node, area, at } =>
            format!("[{at}] area #{node} = {:?}", area),
        Op::DeleteNode { node, hard, at } =>
            format!("[{at}] delete #{node} hard={hard}"),
        Op::Link { id, src, dst, kind, at } =>
            format!("[{at}] link edge #{id} #{src} -{:?}-> #{dst}", kind),
        Op::Unlink { edge, at } => format!("[{at}] unlink edge #{edge}"),
        Op::Reweight { edge, delta, at } =>
            format!("[{at}] reweight edge #{edge} by {delta:+.2}"),
        Op::RecordOutcome { edge, success, at } =>
            format!("[{at}] outcome edge #{edge}: {}", if *success { "success" } else { "failure" }),
        Op::PushContext { to, chunk, at } =>
            format!("[{at}] push ctx to #{to} from #{}: {}", chunk.from, chunk.note),
        Op::CommitLog { node, kind, detail, at } =>
            format!("[{at}] log #{node} {kind}: {detail}"),
    }
}


/// One navigation step: result selection in Search (when results exist), else node list.
fn step(app: &mut App, delta: i32) {
    if app.focus == Focus::Search && !app.results.is_empty() {
        let n = app.results.len() as i32;
        app.result_sel = ((app.result_sel as i32 + delta).rem_euclid(n)) as usize;
    } else {
        app.move_sel(delta);
    }
}

/// g/G: jump to top/bottom of the active list.
fn jump_end(app: &mut App, bottom: bool) {
    if app.focus == Focus::Search && !app.results.is_empty() {
        app.result_sel = if bottom { app.results.len() - 1 } else { 0 };
    } else if !app.node_ids.is_empty() {
        let i = if bottom { app.node_ids.len() - 1 } else { 0 };
        app.sel.select(Some(i));
    }
}

/// n/N: next/prev search result when present.
fn cycle_result(app: &mut App, forward: bool) {
    if app.results.is_empty() { return; }
    let n = app.results.len();
    app.result_sel = if forward {
        (app.result_sel + 1) % n
    } else {
        (app.result_sel + n - 1) % n
    };
}

/// Copy to system clipboard via pbcopy/xclip/wl-copy if any exists.
fn copy_to_clipboard(text: &str) -> bool {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let cmds: [&[&str]; 3] = [
        &["pbcopy"],
        &["xclip", "-selection", "clipboard"],
        &["wl-copy"],
    ];
    for c in cmds {
        let mut child = match Command::new(c[0]).args(&c[1..])
            .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn()
        {
            Ok(ch) => ch,
            Err(_) => continue,
        };
        if let Some(mut stdin) = child.stdin.take() {
            if stdin.write_all(text.as_bytes()).is_err() {
                continue;
            }
        }
        if child.wait().map(|st| st.success()).unwrap_or(false) {
            return true;
        }
    }
    false
}

const HELP_TEXT: &str = "\
navigation:
  Up/Down / j k     move selection (node list; results when search pane focused)
  g / G             jump to top / bottom of active list
  Tab               cycle panes: list -> detail -> search
search:
  /                 type query (Esc cancels)
  Enter             run search (or jump to highlighted result)
  n / N             next / previous search result
other:
  y                 copy selected node state to clipboard
  s                 show last 20 journal ops
  r                 reload journal from disk
  ?                 toggle this help
  q                 quit";

// ---------- UI ----------

fn detail_text(app: &App, id: NodeId) -> String {
    let mut out = app.store.state_of(id).unwrap_or_else(|e| e);
    // incoming SuppliesContext edges with weights, strongest first
    let feeders = app.store.feeders_of(id, app.clock);
    out.push_str(&format!("incoming SuppliesContext ({}):\n", feeders.len()));
    for e in feeders {
        let lbl = app.store.nodes.get(&e.src)
            .map(|n| n.label.as_str()).unwrap_or("?");
        out.push_str(&format!("  <- #{} \"{}\" w={:.2}\n", e.src, lbl, e.weight));
    }
    out
}

fn ui(f: &mut Frame, app: &App) {
    let root = Layout::vertical([
        Constraint::Min(3),     // main area
        Constraint::Length(1),  // status bar
    ]).split(f.size());

    let main = Layout::horizontal([
        Constraint::Percentage(40), // list
        Constraint::Percentage(60), // right column
    ]).split(root[0]);

    let right = Layout::vertical([
        Constraint::Percentage(55), // detail
        Constraint::Percentage(45), // search
    ]).split(main[1]);

    // --- left pane: node list ---
    let items: Vec<ListItem> = app.node_ids.iter().map(|&id| {
        let n = &app.store.nodes[&id];
        ListItem::new(Line::from(format!(
            "#{} {} {} ({} facts)",
            id, kind_glyph(n.kind), n.label, n.active_facts().count()
        )))
    }).collect();
    let list_title = format!(" nodes ({}) ", app.node_ids.len());
    let list = List::new(items)
        .block(Block::default().borders(Borders::ALL).title(list_title))
        .highlight_style(Style::default().bg(Color::Blue).fg(Color::White))
        .highlight_symbol("> ");
    f.render_stateful_widget(list, main[0], &mut {
        // render_stateful_widget needs &mut; clone sel so App stays &App in ui()
        let mut s = app.sel.clone();
        s.select(Some(s.selected().map(|i| i.min(app.node_ids.len().saturating_sub(1))).unwrap_or(0)));
        if app.node_ids.is_empty() { s.select(None); }
        s
    });

    // --- right-top: detail ---
    let detail_body = match app.selected_node() {
        Some(id) => detail_text(app, id),
        None => "(no nodes)".to_string(),
    };
    let detail_title = match app.selected_node() {
        Some(id) => format!(" detail #{} ", id),
        None => " detail ".to_string(),
    };
    let detail = Paragraph::new(detail_body)
        .block(Block::default().borders(Borders::ALL).title(detail_title))
        .wrap(Wrap { trim: false });
    f.render_widget(detail, right[0]);

    // --- right-bottom: search pane ---
    let mut lines: Vec<Line> = Vec::new();
    let prompt = if app.search_typing { "> " } else { "/ " };
    let cursor = if app.search_typing { "_" } else { "" };
    lines.push(Line::from(format!("query: {}{}{}", prompt, app.search_input, cursor)));
    if app.results.is_empty() {
        lines.push(Line::from("(no results yet — type after '/', Enter searches)"));
    } else {
        for (i, r) in app.results.iter().enumerate() {
            let lbl = app.store.nodes.get(&r.node)
                .map(|n| n.label.as_str()).unwrap_or("(deleted)");
            let marker = if i == app.result_sel { ">" } else { " " };
            let via = if r.via_graph { " (via graph)" } else { "" };
            lines.push(Line::from(format!(
                "{} #{} {:<26} score={:.3}{}",
                marker, r.node, lbl, r.score, via
            )));
        }
    }
    let search_title = format!(" search [{}] ", app.embedder_mode);
    let sp = Paragraph::new(lines)
        .block(Block::default().borders(Borders::ALL).title(search_title));
    f.render_widget(sp, right[1]);

    // --- status bar ---
    let (nodes_live, edges_alive) = (
        app.store.nodes.values().filter(|n| !n.deleted).count(),
        app.store.edges.values()
            .filter(|e| e.alive_at(app.clock)).count(),
    );
    let warn = app.load_error.as_deref().unwrap_or("");
    let status = format!(
        " embedder={} ops replayed={} nodes={} edges(alive)={}{}",
        app.embedder_mode, app.ops_replayed, nodes_live, edges_alive,
        if warn.is_empty() { String::new() } else { format!(" WARN: {warn}") },
    );
    let bar = Paragraph::new(status)
        .style(Style::default().bg(Color::DarkGray).fg(Color::White));
    f.render_widget(bar, root[1]);

    // --- overlays: recent ops / help cheat-sheet ---
    if app.show_ops {
        let area = centered_rect(70, 60, f.size());
        f.render_widget(Clear, area);
        let body = app.ops_lines().join("\n");
        let popup = Paragraph::new(if body.is_empty() { "(no ops)" } else { &body })
            .block(Block::default()
                .borders(Borders::ALL)
                .title(format!(" last {} journal ops (Esc closes) ", app.ops_lines().len())))
            .wrap(Wrap { trim: false });
        f.render_widget(popup, area);
    }
    if app.show_help {
        let area = centered_rect(60, 70, f.size());
        f.render_widget(Clear, area);
        let popup = Paragraph::new(HELP_TEXT)
            .block(Block::default()
                .borders(Borders::ALL)
                .title(" keybindings (? closes) "))
            .wrap(Wrap { trim: false });
        f.render_widget(popup, area);
    }
}

fn centered_rect(pct_x: u16, pct_y: u16, r: Rect) -> Rect {
    let pop = Layout::vertical([
        Constraint::Percentage((100 - pct_y) / 2),
        Constraint::Percentage(pct_y),
        Constraint::Percentage((100 - pct_y) / 2),
    ]).split(r);
    Layout::horizontal([
        Constraint::Percentage((100 - pct_x) / 2),
        Constraint::Percentage(pct_x),
        Constraint::Percentage((100 - pct_x) / 2),
    ]).split(pop[1])[1]
}

// ---------- entry points ----------

fn draw_once(app: &App) -> std::io::Result<()> {
    // stdout backend WITHOUT alternate screen or raw mode: one frame, then exit.
    let backend = CrosstermBackend::new(std::io::stdout());
    let mut term = Terminal::new(backend)?;
    term.draw(|f| ui(f, app))?;
    writeln!(std::io::stdout())?;
    Ok(())
}

fn run_tui(app: &mut App) -> std::io::Result<()> {
    let mut stdout = std::io::stdout();
    crossterm::terminal::enable_raw_mode()?;
    crossterm::execute!(stdout, crossterm::terminal::EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut term = Terminal::new(backend)?;
    let res = tui_loop(&mut term, app);
    crossterm::terminal::disable_raw_mode()?;
    crossterm::execute!(term.backend_mut(), crossterm::terminal::LeaveAlternateScreen)?;
    term.show_cursor()?;
    res
}

fn tui_loop<B: Backend>(
    term: &mut Terminal<B>, app: &mut App,
) -> std::io::Result<()> {
    loop {
        term.draw(|f| ui(f, app))?;
        if let crossterm::event::Event::Key(key) = crossterm::event::read()? {
            if key.kind != crossterm::event::KeyEventKind::Press { continue; }
            use crossterm::event::KeyCode as K;

            if app.show_ops || app.show_help {
                // any key closes the open overlay
                let which = if app.show_ops { "ops" } else { "help" };
                app.show_ops = false;
                app.show_help = false;
                app.status = format!("{which} closed");
                continue;
            }

            if app.search_typing {
                match key.code {
                    K::Char(c) => app.search_input.push(c),
                    K::Backspace => { app.search_input.pop(); }
                    K::Esc => { app.search_typing = false; app.status = "search cancelled".into(); }
                    K::Enter => {
                        app.search_typing = false;
                        app.run_search();
                        app.focus = Focus::Search;
                    }
                    _ => {}
                }
                continue;
            }

            match key.code {
                K::Char('q') => return Ok(()),
                K::Tab => {
                    app.focus = match app.focus {
                        Focus::List => Focus::Detail,
                        Focus::Detail => Focus::Search,
                        Focus::Search => Focus::List,
                    };
                    app.status = format!("focus: {:?}", app.focus);
                }
                K::Up | K::Char('k') => step(app, -1),
                K::Down | K::Char('j') => step(app, 1),
                K::Char('g') => jump_end(app, false),
                K::Char('G') => jump_end(app, true),
                K::Char('?') => {
                    app.show_help = true;
                }
                K::Char('y') => match app.selected_node() {
                    Some(id) => match app.store.state_of(id) {
                        Ok(txt) => {
                            let ok = copy_to_clipboard(&txt);
                            app.status = if ok {
                                format!("copied #{id}")
                            } else {
                                format!("copied #{} (no clipboard tool found)", id)
                            };
                        }
                        Err(e) => app.status = format!("copy failed: {e}"),
                    },
                    None => app.status = "nothing to copy".into(),
                },
                K::Char('n') => {
                    cycle_result(app, true);
                    if app.results.is_empty() { app.status = "no results".into(); }
                }
                K::Char('N') => {
                    cycle_result(app, false);
                    if app.results.is_empty() { app.status = "no results".into(); }
                }
                K::Char('/') => {
                    app.search_typing = true;
                    app.search_input.clear();
                    app.status = "typing query... Enter=search Esc=cancel".into();
                }
                K::Enter => {
                    if app.focus == Focus::Search && !app.results.is_empty() {
                        app.jump_to_result();
                    } else {
                        app.run_search();
                    }
                }
                K::Char('s') => {
                    app.show_ops = true;
                }
                K::Char('r') => app.reload(),
                _ => {}
            }
        }
    }
}

fn main() {
    // 2.9: superseded by the cockpit's Memory pane (nodes grouped by brain
    // area, search, node state) and Logs pane (live journal tail).
    eprintln!("memtui is deprecated — use `cargo run --bin mnemo-cockpit` (Memory/Logs panes).");
    load_dotenv();
    let args: Vec<String> = std::env::args().collect();
    let render_once = args.iter().any(|a| a == "--render-once");
    // render one frame with the help overlay open (non-interactive proof of the overlay)
    let show_help_once = args.iter().any(|a| a == "--show-help-once");
    let jpath = args.iter()
        .filter(|a| !a.starts_with('-'))
        .nth(1)
        .cloned()
        .unwrap_or_else(|| "data/memcli-journal.jsonl".to_string());

    let app = App::load(&jpath);

    let mut app = app;
    app.show_help = show_help_once;

    if render_once || show_help_once {
        match draw_once(&app) {
            Ok(()) => {}
            Err(e) => {
                eprintln!("render failed: {e}");
                std::process::exit(1);
            }
        }
        return; // exit 0
    }

    if let Err(e) = run_tui(&mut app) {
        eprintln!("tui error: {e}");
        std::process::exit(1);
    }
}
