//! 2.5 Agents pane: the delegation tree, reconstructed from journal episodes.
//! A subagent writes into the SAME shared journal as its parent, so the episode
//! nodes plus their logs are the whole tree.
use crate::cockpit::Pane;
use crate::memclient::NodeRow;
use crate::pane::PaneView;
use crate::theme;
use crossterm::event::{KeyCode, KeyEvent};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunState {
    Running,
    Ok,
    Failed,
}

impl RunState {
    fn glyph(self) -> (&'static str, ratatui::style::Color) {
        match self {
            RunState::Running => ("◐", theme::ORANGE),
            RunState::Ok => ("●", theme::GREEN),
            RunState::Failed => ("●", theme::RED),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Episode {
    pub id: u64,
    pub label: String,
    pub state: RunState,
    /// Parent episode, when this run was spawned by another agent.
    pub parent: Option<u64>,
    pub transcript: Vec<String>,
}

/// Classify an episode from its log lines: an "outcome" entry decides it.
pub fn state_from_log(log: &[String]) -> RunState {
    for line in log.iter().rev() {
        let l = line.to_ascii_lowercase();
        if !l.contains("outcome") { continue; }
        let failed = ["fail", "error", "broke", "404", "timed out", "panic"]
            .iter().any(|w| l.contains(w));
        return if failed { RunState::Failed } else { RunState::Ok };
    }
    RunState::Running
}

/// A subagent episode names its parent in its label, e.g.
/// "subagent of #12: audit the tests".
pub fn parent_from_label(label: &str) -> Option<u64> {
    let rest = label.split_once('#')?.1;
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() { return None; }
    label.to_ascii_lowercase().contains("subagent").then(|| digits.parse().ok())?
}

#[derive(Debug, Clone, Default)]
pub struct AgentsPane {
    pub episodes: Vec<Episode>,
    pub selected: usize,
    pub show_transcript: bool,
    pub error: Option<String>,
}

impl AgentsPane {
    pub fn new() -> Self { Self::default() }

    /// Build the pane from memsrv rows plus each episode's log lines.
    pub fn load(rows: &[NodeRow], logs: &dyn Fn(u64) -> Vec<String>) -> Self {
        let mut episodes: Vec<Episode> = rows.iter()
            .filter(|r| r.kind == "TaskEpisode")
            .map(|r| {
                let transcript = logs(r.id);
                Episode {
                    id: r.id,
                    label: r.label.clone(),
                    state: state_from_log(&transcript),
                    parent: parent_from_label(&r.label),
                    transcript,
                }
            })
            .collect();
        episodes.sort_by_key(|e| e.id);
        Self { episodes, ..Default::default() }
    }

    /// Episodes in tree order: each root followed by its children.
    ///
    /// **Only roots that actually delegated.** Every pi session writes an
    /// episode, so listing all roots filled this pane with thirty rows of
    /// "pi session 2026-08-25T…" and nothing else — a list that answered no
    /// question anyone had. A root with no children is a session, and the
    /// Sessions pane is where sessions live.
    pub fn tree(&self) -> Vec<(usize, &Episode)> {
        let mut out = Vec::new();
        for root in self.episodes.iter().filter(|e| e.parent.is_none()) {
            let children: Vec<&Episode> = self.episodes.iter()
                .filter(|e| e.parent == Some(root.id)).collect();
            if children.is_empty() { continue }
            out.push((0usize, root));
            for child in children {
                out.push((1usize, child));
            }
        }
        // orphans (parent id we never saw) must still be reachable
        for e in &self.episodes {
            if e.parent.is_some() && !out.iter().any(|(_, x)| x.id == e.id) {
                out.push((1, e));
            }
        }
        out
    }

    pub fn selected_episode(&self) -> Option<&Episode> {
        self.tree().get(self.selected).map(|(_, e)| *e)
    }

    pub fn move_selection(&mut self, delta: isize) {
        let n = self.tree().len();
        if n == 0 { self.selected = 0; return; }
        self.selected = (self.selected as isize + delta).clamp(0, n as isize - 1) as usize;
    }
}

impl PaneView for AgentsPane {
    fn id(&self) -> Pane { Pane::Agents }

    fn lines(&self, height: usize) -> Vec<Line<'static>> {
        if let Some(e) = &self.error {
            return vec![Line::from(Span::styled(format!("✖ {e}"), Style::default().fg(theme::RED)))];
        }
        let tree = self.tree();
        if tree.is_empty() { return Vec::new(); }
        let mut out: Vec<Line<'static>> = Vec::new();
        for (i, (depth, e)) in tree.iter().enumerate() {
            let (dot, color) = e.state.glyph();
            let on = i == self.selected;
            let style = if on {
                Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(theme::WHITE)
            };
            let indent = if *depth == 0 { String::new() } else { "  └ ".to_string() };
            out.push(Line::from(vec![
                Span::styled(format!("{} ", if on { "▶" } else { " " }), style),
                Span::styled(format!("{dot} "), Style::default().fg(color)),
                Span::styled(format!("{indent}#{} {}", e.id, e.label), style),
            ]));
        }
        if self.show_transcript {
            if let Some(e) = self.selected_episode() {
                out.push(Line::from(""));
                out.push(Line::from(Span::styled(
                    format!("── transcript of #{} ──", e.id),
                    Style::default().fg(theme::BLUE),
                )));
                out.extend(e.transcript.iter().map(|l| Line::from(
                    Span::styled(format!("  {l}"), Style::default().fg(theme::GREY)),
                )));
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
            KeyCode::Enter | KeyCode::Char('o') => { self.show_transcript = !self.show_transcript; true }
            _ => false,
        }
    }

    fn badge(&self) -> Option<usize> { Some(self.tree().len()) }

    fn purpose(&self) -> &'static str {
        "Sub-agents this project has spawned, and how they nest. The agent creates these itself."
    }

    fn empty_hint(&self) -> Vec<&'static str> {
        vec![
            "No sub-agents yet.",
            "The agent spawns one when a task is self-contained and worth",
            "doing separately — ask it to: use a subagent to ...",
            "Each runs on its own model and writes into the same memory.",
        ]
    }

    fn status(&self) -> String {
        // count what is ON SCREEN. Counting every episode said "45 episodes"
        // over a pane showing none of them, which is worse than saying nothing
        let shown: Vec<&Episode> = self.tree().into_iter().map(|(_, e)| e).collect();
        if shown.is_empty() { return "no sub-agents".into() }
        let running = shown.iter().filter(|e| e.state == RunState::Running).count();
        let failed = shown.iter().filter(|e| e.state == RunState::Failed).count();
        let parents = self.tree().iter().filter(|(d, _)| *d == 0).count();
        format!("{} run(s) under {parents} session(s) · {running} running · {failed} failed",
                shown.len() - parents)
    }

    fn help(&self) -> Vec<(&'static str, &'static str)> {
        vec![("enter/o", "toggle transcript"), ("j/k", "move selection")]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::KeyModifiers;

    fn ep(id: u64, label: &str) -> NodeRow {
        NodeRow { id, kind: "TaskEpisode".into(), area: "Episodic".into(),
                  label: label.into(), facts: 0 }
    }
    fn text(l: &Line) -> String { l.spans.iter().map(|s| s.content.to_string()).collect() }

    #[test]
    fn outcome_logs_decide_run_state() {
        assert_eq!(state_from_log(&[]), RunState::Running);
        assert_eq!(state_from_log(&["created: node".into()]), RunState::Running);
        assert_eq!(state_from_log(&["outcome: all tests pass".into()]), RunState::Ok);
        assert_eq!(state_from_log(&["outcome: 404 on rewritten path".into()]), RunState::Failed);
        // the LAST outcome wins: a run that recovered is not still failed
        assert_eq!(
            state_from_log(&["outcome: error".into(), "outcome: fixed and green".into()]),
            RunState::Ok,
        );
    }

    #[test]
    fn subagent_parents_come_from_the_label() {
        assert_eq!(parent_from_label("subagent of #12: audit tests"), Some(12));
        assert_eq!(parent_from_label("deploy #12 to prod"), None, "a plain id is not a parent");
        assert_eq!(parent_from_label("subagent with no number"), None);
    }

    #[test]
    fn tree_nests_children_under_their_parent() {
        let rows = vec![ep(1, "root task"), ep(2, "subagent of #1: sub work"), ep(3, "other root")];
        let p = AgentsPane::load(&rows, &|_| vec![]);
        let tree: Vec<(usize, u64)> = p.tree().iter().map(|(d, e)| (*d, e.id)).collect();
        // #3 delegated to nobody, so it is a session, not an agent
        assert_eq!(tree, [(0, 1), (1, 2)]);
    }

    #[test]
    fn a_session_that_delegated_to_nobody_is_not_an_agent() {
        // every pi session writes an episode. Listing them all filled this
        // pane with thirty rows of "pi session 2026-08-25T…" and answered no
        // question anyone had; sessions belong in the Sessions pane.
        let rows = vec![ep(1, "pi session 2026-08-25T03:23:42Z"),
                        ep(2, "pi session 2026-08-25T10:58:20Z")];
        let p = AgentsPane::load(&rows, &|_| vec![]);
        assert!(p.tree().is_empty(), "{:?}", p.tree().len());
        assert_eq!(p.badge(), Some(0), "and the rail says so, rather than lying");
        assert!(p.empty_hint().iter().any(|l| l.contains("subagent")),
            "the empty state has to say how to make one");
    }

    #[test]
    fn an_orphaned_subagent_is_still_listed() {
        let rows = vec![ep(9, "subagent of #404: parent never journaled")];
        let p = AgentsPane::load(&rows, &|_| vec![]);
        assert_eq!(p.tree().len(), 1, "an unknown parent must not hide the run");
    }

    #[test]
    fn only_episodes_appear_here() {
        let rows = vec![
            ep(1, "root"),
            NodeRow { id: 2, kind: "Aspect".into(), area: "Semantic".into(),
                      label: "helm".into(), facts: 1 },
        ];
        let p = AgentsPane::load(&rows, &|_| vec![]);
        assert_eq!(p.episodes.len(), 1);
    }

    #[test]
    fn status_counts_running_and_failed() {
        let rows = vec![ep(1, "a"), ep(2, "subagent of #1: b"), ep(3, "subagent of #1: c")];
        let p = AgentsPane::load(&rows, &|id| match id {
            2 => vec!["outcome: failed hard".into()],
            3 => vec!["outcome: done".into()],
            _ => vec![],
        });
        assert_eq!(p.status(), "2 run(s) under 1 session(s) · 1 running · 1 failed");
    }

    #[test]
    fn transcript_drills_into_the_selected_run_only() {
        let rows = vec![ep(1, "root"), ep(2, "subagent of #1: second")];
        let mut p = AgentsPane::load(&rows, &|id| vec![format!("log of {id}")]);
        assert!(p.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE), 30));
        let shown: Vec<String> = p.lines(0).iter().map(text).collect();
        assert!(shown.iter().any(|l| l.contains("log of 1")));
        assert!(!shown.iter().any(|l| l.contains("log of 2")), "{shown:?}");
        p.move_selection(1);
        let shown: Vec<String> = p.lines(0).iter().map(text).collect();
        assert!(shown.iter().any(|l| l.contains("log of 2")));
    }

    #[test]
    fn state_glyphs_are_coloured_by_outcome() {
        let rows = vec![ep(1, "a"), ep(2, "subagent of #1: b")];
        let p = AgentsPane::load(&rows, &|_| vec!["outcome: error".into()]);
        assert_eq!(p.lines(0)[0].spans[1].style.fg, Some(theme::RED));
    }
}
