//! 8.4/8.5 Sessions pane: projects, the sessions inside them, and the
//! subagents each session spawned — one drill-down rather than three screens,
//! so it lives in the nav rail like every other pane.
//!
//! Levels: Projects -> Sessions (with subagents nested) -> one subagent's run.
//! The project you launched in is pinned to the top and marked, because
//! "wherever I open the agent, that folder is my project".
//!
//! Selection walks a FLAT row list rather than an index per level: a subagent
//! row is on screen, so it has to be reachable with j/k like anything else,
//! and one list means the highlight and the keystroke can never disagree.
use crate::cockpit::Pane;
use crate::pane::PaneView;
use crate::pane_logs::{format_span, op_color};
use crate::sessions::{Project, Session, Subagent};
use crate::theme;
use crossterm::event::{KeyCode, KeyEvent};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Level {
    #[default]
    Projects,
    Sessions,
    /// One subagent's run, read back from the trace store.
    Subagent,
}

/// One selectable row at the current level.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Row {
    /// Index into `ordered_projects()`.
    Project(usize),
    /// Index into `sessions`.
    Session(usize),
    /// Session index, then subagent index within it.
    Sub(usize, usize),
}

/// What the event loop should do after a keystroke here.
#[derive(Debug, Clone, PartialEq)]
pub enum Intent {
    None,
    /// Open this session's transcript in the Chat pane and resume it.
    OpenSession(Session),
    /// Start a fresh session in this project.
    NewSession(PathBuf),
    /// Show what this subagent did. The loop supplies its spans.
    OpenSubagent(Subagent),
}

#[derive(Debug, Clone, Default)]
pub struct SessionsPane {
    pub projects: Vec<Project>,
    /// Sessions of the project currently drilled into.
    pub sessions: Vec<Session>,
    pub level: Level,
    /// Index into `rows()`.
    pub selected: usize,
    /// Index into `projects` once drilled in.
    pub project: Option<usize>,
    /// Session ids whose subagents are expanded.
    pub expanded: Vec<String>,
    /// The subagent being viewed at `Level::Subagent`, with its trace spans.
    pub subagent: Option<Subagent>,
    pub spans: Vec<serde_json::Value>,
    /// The directory mnemo-agent was launched in.
    pub cwd: PathBuf,
    pub error: Option<String>,
}

impl SessionsPane {
    pub fn new(cwd: PathBuf) -> Self {
        Self { cwd, ..Default::default() }
    }

    /// Projects with the launch directory first, whether or not it has history.
    pub fn ordered_projects(&self) -> Vec<Project> {
        let mut out = self.projects.clone();
        match out.iter().position(|p| p.path == self.cwd) {
            Some(i) => {
                let here = out.remove(i);
                out.insert(0, here);
            }
            // launched somewhere with no sessions yet: it is still the project
            None if !self.cwd.as_os_str().is_empty() => out.insert(0, Project {
                path: self.cwd.clone(),
                dir: String::new(),
                sessions: 0,
                last_active: 0,
            }),
            None => {}
        }
        out
    }

    pub fn is_here(&self, p: &Project) -> bool {
        p.path == self.cwd
    }

    /// Every row the user can move through at the current level, in the order
    /// they are drawn. Rendering and selection both read this, so a nested
    /// subagent row cannot be visible-but-unreachable.
    pub fn rows(&self) -> Vec<Row> {
        match self.level {
            Level::Projects => (0..self.ordered_projects().len()).map(Row::Project).collect(),
            Level::Sessions => {
                let mut out = Vec::new();
                for (i, s) in self.sessions.iter().enumerate() {
                    out.push(Row::Session(i));
                    if self.expanded.contains(&s.id) {
                        out.extend((0..s.subagents.len()).map(|j| Row::Sub(i, j)));
                    }
                }
                out
            }
            // a detail view: nothing to select, esc goes back
            Level::Subagent => Vec::new(),
        }
    }

    pub fn row_count(&self) -> usize {
        self.rows().len()
    }

    pub fn selected_row(&self) -> Option<Row> {
        self.rows().get(self.selected).copied()
    }

    pub fn move_selection(&mut self, delta: isize) {
        let n = self.row_count();
        if n == 0 { self.selected = 0; return; }
        self.selected = (self.selected as isize + delta).clamp(0, n as isize - 1) as usize;
    }

    pub fn selected_project(&self) -> Option<Project> {
        match self.selected_row() {
            Some(Row::Project(i)) => self.ordered_projects().get(i).cloned(),
            _ => None,
        }
    }

    /// The session under the cursor — a subagent row counts as its parent, so
    /// `o` collapses the group you are standing inside.
    pub fn selected_session(&self) -> Option<&Session> {
        match self.selected_row() {
            Some(Row::Session(i)) | Some(Row::Sub(i, _)) => self.sessions.get(i),
            _ => None,
        }
    }

    pub fn selected_subagent(&self) -> Option<&Subagent> {
        match self.selected_row() {
            Some(Row::Sub(i, j)) => self.sessions.get(i)?.subagents.get(j),
            _ => None,
        }
    }

    /// The project we drilled into. Not `selected_project()`: once inside, the
    /// cursor is on sessions, and a new session belongs to the folder we are
    /// in, not to whatever row happens to be highlighted.
    pub fn current_project_path(&self) -> PathBuf {
        self.project
            .and_then(|i| self.projects.get(i))
            .map(|p| p.path.clone())
            .unwrap_or_else(|| self.cwd.clone())
    }

    /// Enter: drill into a project, open a session, or open a subagent.
    pub fn enter(&mut self) -> Intent {
        match self.level {
            Level::Projects => {
                let Some(p) = self.selected_project() else { return Intent::None };
                self.project = self.projects.iter().position(|x| x.path == p.path);
                self.level = Level::Sessions;
                self.selected = 0;
                self.sessions.clear(); // the loop refills from disk
                Intent::None
            }
            Level::Sessions => match self.selected_row() {
                Some(Row::Sub(i, j)) => match self.sessions.get(i)
                    .and_then(|s| s.subagents.get(j)).cloned() {
                    Some(sub) => Intent::OpenSubagent(sub),
                    None => Intent::None,
                },
                Some(Row::Session(i)) => match self.sessions.get(i) {
                    Some(s) => Intent::OpenSession(s.clone()),
                    None => Intent::None,
                },
                // a project with no sessions yet: enter starts one
                _ => Intent::NewSession(self.current_project_path()),
            },
            Level::Subagent => Intent::None,
        }
    }

    /// Show one subagent's run. Spans come from the loop, which owns the home
    /// directory the trace store lives under.
    pub fn show_subagent(&mut self, sub: Subagent, spans: Vec<serde_json::Value>) {
        self.subagent = Some(sub);
        self.spans = spans;
        self.level = Level::Subagent;
    }

    /// Escape / left: back out one level.
    pub fn back(&mut self) -> bool {
        match self.level {
            Level::Projects => false,
            // the cursor stayed on the subagent row we came from
            Level::Subagent => {
                self.level = Level::Sessions;
                self.subagent = None;
                self.spans.clear();
                true
            }
            Level::Sessions => {
                // `project` indexes self.projects, but the list on screen is
                // ordered_projects() with the launch directory pinned first —
                // look the path back up rather than reusing the index across
                // two orderings
                let path = self.project.and_then(|i| self.projects.get(i)).map(|p| p.path.clone());
                self.level = Level::Projects;
                self.selected = path
                    .and_then(|p| self.ordered_projects().iter().position(|x| x.path == p))
                    .unwrap_or(0);
                self.sessions.clear();
                true
            }
        }
    }

    pub fn toggle_expanded(&mut self) {
        let Some(id) = self.selected_session().map(|s| s.id.clone()) else { return };
        match self.expanded.iter().position(|x| *x == id) {
            Some(i) => {
                self.expanded.remove(i);
                // the rows below just vanished; do not leave the cursor past
                // the end of the list
                let n = self.row_count();
                self.selected = self.selected.min(n.saturating_sub(1));
            }
            None => self.expanded.push(id),
        }
    }

    /// The project directory whose sessions should be loaded, if any.
    pub fn wanted_project_dir(&self) -> Option<String> {
        if self.level != Level::Sessions { return None; }
        self.project.and_then(|i| self.projects.get(i)).map(|p| p.dir.clone())
    }

    /// The drilled-into project's name, for the Sessions header.
    fn project_title(&self) -> String {
        self.project.and_then(|i| self.projects.get(i))
            .map(|p| p.name())
            .unwrap_or_else(|| self.cwd.file_name()
                .map(|n| n.to_string_lossy().to_string()).unwrap_or_default())
    }
}

fn subagent_line(s: &Subagent, on: bool) -> Line<'static> {
    let color = if s.ok { theme::GREEN } else { theme::RED };
    let model = s.model.clone().unwrap_or_else(|| "same model".into());
    let label = if on {
        Style::default().fg(theme::YELLOW).add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(theme::WHITE)
    };
    Line::from(vec![
        Span::styled(format!("  {} └ ● ", if on { "▶" } else { " " }), Style::default().fg(color)),
        Span::styled(s.label.clone(), label),
        Span::styled(format!("  [{model}]"), Style::default().fg(theme::PURPLE)),
    ])
}

impl PaneView for SessionsPane {
    fn id(&self) -> Pane { Pane::Sessions }

    fn lines(&self, height: usize) -> Vec<Line<'static>> {
        if let Some(e) = &self.error {
            return vec![Line::from(Span::styled(format!("✖ {e}"), Style::default().fg(theme::RED)))];
        }
        let mut out: Vec<Line<'static>> = Vec::new();
        let mut row = 0usize;
        match self.level {
            Level::Projects => {
                let projects = self.ordered_projects();
                out.push(Line::from(Span::styled(
                    format!("PROJECTS ({})", projects.len()),
                    Style::default().fg(theme::YELLOW).add_modifier(Modifier::BOLD),
                )));
                if projects.is_empty() {
                    out.push(Line::from(Span::styled("(no projects yet)", Style::default().fg(theme::GREY))));
                }
                for p in projects.iter() {
                    let on = row == self.selected;
                    row += 1;
                    let style = if on {
                        Style::default().fg(theme::YELLOW).add_modifier(Modifier::BOLD)
                    } else {
                        Style::default().fg(theme::WHITE)
                    };
                    let mut spans = vec![
                        Span::styled(format!("{} ", if on { "▶" } else { " " }), style),
                        Span::styled(p.name(), style),
                    ];
                    if self.is_here(p) {
                        spans.push(Span::styled(" here", Style::default().fg(theme::ORANGE)));
                    }
                    spans.push(Span::styled(
                        format!("  {} session(s)", p.sessions),
                        Style::default().fg(theme::GREY),
                    ));
                    out.push(Line::from(spans));
                }
            }
            Level::Sessions => {
                out.push(Line::from(Span::styled(
                    format!("{} — SESSIONS ({})", self.project_title().to_uppercase(), self.sessions.len()),
                    Style::default().fg(theme::YELLOW).add_modifier(Modifier::BOLD),
                )));
                if self.sessions.is_empty() {
                    out.push(Line::from(Span::styled(
                        "(no sessions yet — enter starts one)", Style::default().fg(theme::GREY))));
                }
                for s in self.sessions.iter() {
                    let on = row == self.selected;
                    row += 1;
                    let style = if on {
                        Style::default().fg(theme::YELLOW).add_modifier(Modifier::BOLD)
                    } else {
                        Style::default().fg(theme::WHITE)
                    };
                    let model = s.model.clone().unwrap_or_else(|| "no model".into());
                    out.push(Line::from(vec![
                        Span::styled(format!("{} ", if on { "▶" } else { " " }), style),
                        Span::styled(s.title.clone(), style),
                        Span::styled(format!("  {} msgs", s.messages), Style::default().fg(theme::GREY)),
                        Span::styled(format!("  [{model}]"), Style::default().fg(theme::BLUE)),
                    ]));
                    if s.subagents.is_empty() { continue }
                    if self.expanded.contains(&s.id) {
                        for sub in s.subagents.iter() {
                            let on = row == self.selected;
                            row += 1;
                            out.push(subagent_line(sub, on));
                        }
                    } else {
                        out.push(Line::from(Span::styled(
                            format!("    └ {} subagent(s) — o to expand", s.subagents.len()),
                            Style::default().fg(theme::GREY),
                        )));
                    }
                }
            }
            Level::Subagent => {
                let Some(sub) = &self.subagent else { return out };
                let model = sub.model.clone().unwrap_or_else(|| "same model as parent".into());
                out.push(Line::from(vec![
                    Span::styled(format!("SUBAGENT — {}", sub.label.to_uppercase()),
                        Style::default().fg(theme::YELLOW).add_modifier(Modifier::BOLD)),
                    Span::styled(format!("  [{model}]"), Style::default().fg(theme::PURPLE)),
                    Span::styled(
                        if sub.ok { "  ok" } else { "  failed" },
                        Style::default().fg(if sub.ok { theme::GREEN } else { theme::RED }),
                    ),
                ]));
                if self.spans.is_empty() {
                    out.push(Line::from(Span::styled(
                        "(no trace for this run — the log may have been pruned)",
                        Style::default().fg(theme::GREY))));
                }
                for v in self.spans.iter() {
                    let Some(o) = format_span(v) else { continue };
                    out.push(Line::from(vec![
                        Span::styled(format!("{:<14} ", o.kind),
                            Style::default().fg(op_color(&o.kind)).add_modifier(Modifier::BOLD)),
                        Span::styled(o.detail, Style::default().fg(theme::WHITE)),
                    ]));
                }
            }
        }
        if height > 0 && out.len() > height {
            let start = out.len() - height;
            return out[start..].to_vec();
        }
        out
    }

    fn on_key(&mut self, key: KeyEvent, _h: usize) -> bool {
        match key.code {
            // Enter is handled by the event loop, which needs the Intent
            KeyCode::Esc | KeyCode::Left | KeyCode::Char('h') => self.back(),
            KeyCode::Char('o') if self.level == Level::Sessions => { self.toggle_expanded(); true }
            _ => false,
        }
    }

    fn status(&self) -> String {
        match self.level {
            Level::Projects => format!("{} project(s)", self.ordered_projects().len()),
            Level::Sessions => format!("{} session(s) · esc back", self.sessions.len()),
            Level::Subagent => format!("{} span(s) · esc back", self.spans.len()),
        }
    }

    fn help(&self) -> Vec<(&'static str, &'static str)> {
        vec![
            ("enter", "open project / resume session / open subagent"),
            ("esc", "back one level"),
            ("o", "expand subagents"),
            ("j/k", "move selection"),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::KeyModifiers;

    fn project(path: &str, sessions: usize, last: u64) -> Project {
        Project { path: PathBuf::from(path), dir: path.replace('/', "-"), sessions, last_active: last }
    }
    fn session(id: &str, title: &str, subs: Vec<Subagent>) -> Session {
        Session {
            id: id.into(), file: PathBuf::new(), cwd: PathBuf::new(), started: 0,
            provider: Some("anthropic".into()), model: Some("claude-opus-5".into()),
            messages: 3, title: title.into(), subagents: subs,
        }
    }
    fn subs() -> Vec<Subagent> {
        vec![
            Subagent { session: "c1".into(), label: "audit tests".into(), ok: true,
                       model: Some("kimi-k2.6".into()) },
            Subagent { session: "c2".into(), label: "write docs".into(), ok: false, model: None },
        ]
    }
    fn key(c: char) -> KeyEvent { KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE) }
    fn text(l: &Line) -> String { l.spans.iter().map(|s| s.content.to_string()).collect() }

    fn pane() -> SessionsPane {
        let mut p = SessionsPane::new(PathBuf::from("/work/here"));
        p.projects = vec![project("/work/other", 5, 200), project("/work/here", 2, 100)];
        p
    }

    #[test]
    fn the_launch_directory_is_pinned_first_and_marked() {
        let p = pane();
        let ordered = p.ordered_projects();
        assert_eq!(ordered[0].path, PathBuf::from("/work/here"),
            "wherever you opened the agent is your project, even if it is not the most recent");
        assert!(p.is_here(&ordered[0]));
        let rendered: Vec<String> = p.lines(0).iter().map(text).collect();
        assert!(rendered[1].contains("here"), "{rendered:?}");
    }

    #[test]
    fn a_launch_directory_with_no_history_is_still_a_project() {
        let mut p = SessionsPane::new(PathBuf::from("/brand/new"));
        p.projects = vec![project("/work/other", 5, 200)];
        let ordered = p.ordered_projects();
        assert_eq!(ordered.len(), 2);
        assert_eq!(ordered[0].path, PathBuf::from("/brand/new"));
        assert_eq!(ordered[0].sessions, 0);
    }

    #[test]
    fn enter_drills_into_a_project_and_esc_comes_back() {
        let mut p = pane();
        assert_eq!(p.level, Level::Projects);
        p.move_selection(1); // /work/other
        assert_eq!(p.enter(), Intent::None);
        assert_eq!(p.level, Level::Sessions);
        assert_eq!(p.wanted_project_dir().as_deref(), Some("-work-other"),
            "the loop is told which directory to load");

        assert!(p.back());
        assert_eq!(p.level, Level::Projects);
        assert_eq!(p.selected_project().map(|x| x.path), Some(PathBuf::from("/work/other")),
            "coming back keeps you on the project you were in");
        assert!(!p.back(), "esc at the top level is not ours to swallow");
    }

    #[test]
    fn enter_on_a_session_asks_the_loop_to_open_it() {
        let mut p = pane();
        p.enter();
        p.sessions = vec![session("s1", "fix the build", vec![]), session("s2", "write docs", vec![])];
        p.move_selection(1);
        assert_eq!(p.enter(), Intent::OpenSession(p.sessions[1].clone()));
    }

    #[test]
    fn a_project_with_no_sessions_starts_one_in_that_project() {
        let mut p = pane();
        p.enter(); // /work/here, the pinned launch directory
        p.sessions.clear();
        match p.enter() {
            Intent::NewSession(path) => assert_eq!(path, PathBuf::from("/work/here")),
            other => panic!("expected a new session, got {other:?}"),
        }
        // a different project starts its session in ITS folder, not the cwd
        p.back();
        p.move_selection(1);
        p.enter();
        p.sessions.clear();
        assert_eq!(p.enter(), Intent::NewSession(PathBuf::from("/work/other")));
    }

    #[test]
    fn subagents_collapse_until_asked_for() {
        let mut p = pane();
        p.enter();
        p.sessions = vec![session("s1", "fix the build", subs())];

        let collapsed: Vec<String> = p.lines(0).iter().map(text).collect();
        assert!(collapsed.iter().any(|l| l.contains("2 subagent(s)")), "{collapsed:?}");
        assert!(!collapsed.iter().any(|l| l.contains("audit tests")));

        assert!(p.on_key(key('o'), 20));
        let expanded: Vec<String> = p.lines(0).iter().map(text).collect();
        assert!(expanded.iter().any(|l| l.contains("audit tests")), "{expanded:?}");
        // 8.7: a child on a different model says so; one that inherited says that
        assert!(expanded.iter().any(|l| l.contains("[kimi-k2.6]")));
        assert!(expanded.iter().any(|l| l.contains("[same model]")));
        // and a failed child is visibly failed
        let failed = p.lines(0).into_iter().find(|l| text(l).contains("write docs")).unwrap();
        assert_eq!(failed.spans[0].style.fg, Some(theme::RED));
    }

    #[test]
    fn expanded_subagents_are_selectable_rows() {
        // they are drawn, so j/k must reach them — a visible row the cursor
        // skips is exactly the bug the flat row list replaced
        let mut p = pane();
        p.enter();
        p.sessions = vec![session("s1", "fix the build", subs()), session("s2", "other", vec![])];
        assert_eq!(p.row_count(), 2, "collapsed: two sessions");

        p.on_key(key('o'), 20);
        assert_eq!(p.row_count(), 4, "expanded: two sessions plus two children");
        p.move_selection(1);
        assert_eq!(p.selected_subagent().map(|s| s.label.clone()), Some("audit tests".into()));
        assert_eq!(p.selected_session().map(|s| s.id.clone()), Some("s1".into()),
            "standing on a child, `o` still targets its parent");
        p.move_selection(1);
        assert_eq!(p.selected_subagent().map(|s| s.label.clone()), Some("write docs".into()));
        p.move_selection(1);
        assert_eq!(p.selected_row(), Some(Row::Session(1)), "past the children is the next session");
    }

    #[test]
    fn collapsing_under_the_cursor_does_not_strand_it() {
        let mut p = pane();
        p.enter();
        p.sessions = vec![session("s1", "fix the build", subs())];
        p.on_key(key('o'), 20);
        p.move_selection(2); // the last child
        p.on_key(key('o'), 20); // collapse from underneath
        assert_eq!(p.selected, 0, "the cursor falls back onto the session");
        assert!(p.selected_subagent().is_none());
    }

    #[test]
    fn enter_on_a_subagent_opens_its_run_and_esc_returns() {
        let mut p = pane();
        p.enter();
        p.sessions = vec![session("s1", "fix the build", subs())];
        p.on_key(key('o'), 20);
        p.move_selection(1);
        let Intent::OpenSubagent(sub) = p.enter() else { panic!("expected a subagent") };
        assert_eq!(sub.session, "c1", "the loop is told which trace session to read");

        p.show_subagent(sub, vec![
            serde_json::json!({"kind":"tool","name":"bash_exec","start":100,"duration_ms":12,
                               "ok":true,"attrs":{"command":"make"}}),
            serde_json::json!({"kind":"llm","name":"model round trip","start":200,"ok":false,
                               "attrs":{"model":"kimi-k2.6"}}),
        ]);
        assert_eq!(p.level, Level::Subagent);
        let rendered: Vec<String> = p.lines(0).iter().map(text).collect();
        assert!(rendered[0].contains("AUDIT TESTS"), "{rendered:?}");
        assert!(rendered[0].contains("kimi-k2.6"), "the model it actually ran on");
        assert!(rendered.iter().any(|l| l.contains("bash_exec") && l.contains("command=make")),
            "the run's spans are what there is to see: {rendered:?}");
        assert!(rendered.iter().any(|l| l.contains("!llm")), "a failed span reads as failed");

        assert!(p.on_key(key('h'), 20));
        assert_eq!(p.level, Level::Sessions);
        assert!(p.spans.is_empty());
        assert_eq!(p.selected_subagent().map(|s| s.label.clone()), Some("audit tests".into()),
            "back leaves the cursor where it was");
    }

    #[test]
    fn a_subagent_with_no_surviving_trace_says_so() {
        let mut p = pane();
        p.enter();
        p.sessions = vec![session("s1", "t", subs())];
        p.show_subagent(subs()[1].clone(), vec![]);
        let rendered: Vec<String> = p.lines(0).iter().map(text).collect();
        assert!(rendered[0].contains("failed"), "{rendered:?}");
        assert!(rendered[0].contains("same model as parent"));
        assert!(rendered[1].contains("no trace"), "{rendered:?}");
    }

    #[test]
    fn selection_clamps_at_each_level() {
        let mut p = pane();
        p.move_selection(100);
        assert_eq!(p.selected, 1, "two projects");
        p.enter();
        p.sessions = vec![session("s1", "one", vec![])];
        p.move_selection(100);
        assert_eq!(p.selected, 0, "one session");
        p.move_selection(-100);
        assert_eq!(p.selected, 0);
    }

    #[test]
    fn the_sessions_view_names_the_project_and_the_model() {
        let mut p = pane();
        p.enter();
        p.sessions = vec![session("s1", "fix the build", vec![])];
        let rendered: Vec<String> = p.lines(0).iter().map(text).collect();
        assert!(rendered[0].contains("HERE — SESSIONS"), "{rendered:?}");
        assert!(rendered[1].contains("fix the build"));
        assert!(rendered[1].contains("[claude-opus-5]"), "a session says what it ran on");
    }
}
