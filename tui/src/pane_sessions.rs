//! 8.4/8.5 Sessions pane: projects, the sessions inside them, and the
//! subagents each session spawned — one drill-down rather than three screens,
//! so it lives in the nav rail like every other pane.
//!
//! Levels: Projects -> Sessions -> (a session, expanded to show its subagents).
//! The project you launched in is pinned to the top and marked, because
//! "wherever I open the agent, that folder is my project".
use crate::cockpit::Pane;
use crate::pane::PaneView;
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
}

/// What the event loop should do after a keystroke here.
#[derive(Debug, Clone, PartialEq)]
pub enum Intent {
    None,
    /// Open this session's transcript in the Chat pane.
    OpenSession(Session),
    /// Start a fresh session in this project.
    NewSession(PathBuf),
}

#[derive(Debug, Clone, Default)]
pub struct SessionsPane {
    pub projects: Vec<Project>,
    /// Sessions of the project currently drilled into.
    pub sessions: Vec<Session>,
    pub level: Level,
    pub selected: usize,
    /// Index into `projects` once drilled in.
    pub project: Option<usize>,
    /// Session ids whose subagents are expanded.
    pub expanded: Vec<String>,
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

    /// Rows the user can move through at the current level.
    pub fn row_count(&self) -> usize {
        match self.level {
            Level::Projects => self.ordered_projects().len(),
            Level::Sessions => self.sessions.len(),
        }
    }

    pub fn move_selection(&mut self, delta: isize) {
        let n = self.row_count();
        if n == 0 { self.selected = 0; return; }
        self.selected = (self.selected as isize + delta).clamp(0, n as isize - 1) as usize;
    }

    pub fn selected_project(&self) -> Option<Project> {
        self.ordered_projects().get(self.selected).cloned()
    }

    pub fn selected_session(&self) -> Option<&Session> {
        self.sessions.get(self.selected)
    }

    /// Enter: drill into a project, or open the selected session.
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
            Level::Sessions => match self.selected_session() {
                Some(s) => Intent::OpenSession(s.clone()),
                // a project with no sessions yet: enter starts one
                None => Intent::NewSession(
                    self.selected_project().map(|p| p.path).unwrap_or_else(|| self.cwd.clone()),
                ),
            },
        }
    }

    /// Escape / left: back out to the project list.
    pub fn back(&mut self) -> bool {
        if self.level == Level::Projects { return false; }
        // `project` indexes self.projects, but the list on screen is
        // ordered_projects() with the launch directory pinned first — look the
        // path back up rather than reusing the index across two orderings
        let path = self.project.and_then(|i| self.projects.get(i)).map(|p| p.path.clone());
        self.level = Level::Projects;
        self.selected = path
            .and_then(|p| self.ordered_projects().iter().position(|x| x.path == p))
            .unwrap_or(0);
        self.sessions.clear();
        true
    }

    pub fn toggle_expanded(&mut self) {
        let Some(id) = self.selected_session().map(|s| s.id.clone()) else { return };
        match self.expanded.iter().position(|x| *x == id) {
            Some(i) => { self.expanded.remove(i); }
            None => self.expanded.push(id),
        }
    }

    /// The project directory whose sessions should be loaded, if any.
    pub fn wanted_project_dir(&self) -> Option<String> {
        if self.level != Level::Sessions { return None; }
        self.project.and_then(|i| self.projects.get(i)).map(|p| p.dir.clone())
    }
}

fn subagent_line(s: &Subagent) -> Line<'static> {
    let (dot, color) = if s.ok { ("●", theme::GREEN) } else { ("●", theme::RED) };
    let model = s.model.clone().unwrap_or_else(|| "same model".into());
    Line::from(vec![
        Span::styled(format!("    └ {dot} "), Style::default().fg(color)),
        Span::styled(s.label.clone(), Style::default().fg(theme::WHITE)),
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
                for (i, p) in projects.iter().enumerate() {
                    let on = i == self.selected;
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
                let name = self.projects.get(self.project.unwrap_or(0))
                    .map(|p| p.name())
                    .unwrap_or_else(|| self.cwd.file_name()
                        .map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
                out.push(Line::from(Span::styled(
                    format!("{} — SESSIONS ({})", name.to_uppercase(), self.sessions.len()),
                    Style::default().fg(theme::YELLOW).add_modifier(Modifier::BOLD),
                )));
                if self.sessions.is_empty() {
                    out.push(Line::from(Span::styled(
                        "(no sessions yet — enter starts one)", Style::default().fg(theme::GREY))));
                }
                for (i, s) in self.sessions.iter().enumerate() {
                    let on = i == self.selected;
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
                    if !s.subagents.is_empty() {
                        if self.expanded.contains(&s.id) {
                            out.extend(s.subagents.iter().map(subagent_line));
                        } else {
                            out.push(Line::from(Span::styled(
                                format!("    └ {} subagent(s) — o to expand", s.subagents.len()),
                                Style::default().fg(theme::GREY),
                            )));
                        }
                    }
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
        }
    }

    fn help(&self) -> Vec<(&'static str, &'static str)> {
        vec![
            ("enter", "open project / resume session"),
            ("esc", "back to projects"),
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
    fn a_project_with_no_sessions_starts_one_on_enter() {
        let mut p = pane();
        p.enter();
        p.sessions.clear();
        match p.enter() {
            Intent::NewSession(path) => assert_eq!(path, PathBuf::from("/work/here")),
            other => panic!("expected a new session, got {other:?}"),
        }
    }

    #[test]
    fn subagents_collapse_until_asked_for() {
        let mut p = pane();
        p.enter();
        p.sessions = vec![session("s1", "fix the build", vec![
            Subagent { session: "c1".into(), label: "audit tests".into(), ok: true,
                       model: Some("kimi-k2.6".into()) },
            Subagent { session: "c2".into(), label: "write docs".into(), ok: false, model: None },
        ])];

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
