//! 2.4 + 3.6 Memory pane: nodes grouped by brain area, live search, node state.
//! Data comes from memsrv; the pane state itself is pure so it is testable
//! without a sidecar.
use crate::cockpit::Pane;
use crate::memclient::NodeRow;
use crate::pane::PaneView;
use crate::theme;
use crossterm::event::{KeyCode, KeyEvent};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

/// Rail order for the six areas, so the pane always groups the same way.
pub const AREA_ORDER: [&str; 6] = [
    "Episodic", "Semantic", "Procedural", "Spatial", "Salience", "Executive",
];

/// Colour = state (PIXEL rule 1): pain is red, plans are blue, and so on.
pub fn area_color(area: &str) -> ratatui::style::Color {
    match area {
        "Salience" => theme::RED,
        "Executive" => theme::BLUE,
        "Episodic" => theme::ORANGE,
        "Procedural" => theme::GREEN,
        "Spatial" => theme::PURPLE,
        _ => theme::WHITE,
    }
}

#[derive(Debug, Clone, Default)]
pub struct MemoryPane {
    pub rows: Vec<NodeRow>,
    /// Search text; empty means "show everything from dump".
    pub query: String,
    pub searching: bool,
    /// Area filter; empty means all areas.
    pub area_filter: Option<String>,
    pub selected: usize,
    /// Detail text for the selected node, fetched on demand.
    pub detail: Option<String>,
    pub error: Option<String>,
}

impl MemoryPane {
    pub fn new() -> Self { Self::default() }

    /// Rows after the area filter, grouped by area in rail order.
    pub fn grouped(&self) -> Vec<(&'static str, Vec<&NodeRow>)> {
        AREA_ORDER.iter()
            .filter(|a| self.area_filter.as_deref().map_or(true, |f| f == **a))
            .map(|area| {
                let mut rows: Vec<&NodeRow> = self.rows.iter().filter(|r| r.area == *area).collect();
                rows.sort_by_key(|r| r.id);
                (*area, rows)
            })
            .filter(|(_, rows)| !rows.is_empty())
            .collect()
    }

    /// Flattened selectable rows, in the order they are displayed.
    pub fn visible(&self) -> Vec<&NodeRow> {
        self.grouped().into_iter().flat_map(|(_, r)| r).collect()
    }

    pub fn selected_node(&self) -> Option<u64> {
        self.visible().get(self.selected).map(|r| r.id)
    }

    pub fn move_selection(&mut self, delta: isize) {
        let n = self.visible().len();
        if n == 0 { self.selected = 0; return; }
        let next = self.selected as isize + delta;
        self.selected = next.clamp(0, n as isize - 1) as usize;
        self.detail = None; // stale detail must never be shown against a new row
    }

    /// Cycle the area filter: all -> Episodic -> ... -> Executive -> all.
    pub fn cycle_area(&mut self) {
        let next = match &self.area_filter {
            None => Some(AREA_ORDER[0].to_string()),
            Some(cur) => AREA_ORDER.iter().position(|a| a == cur)
                .and_then(|i| AREA_ORDER.get(i + 1))
                .map(|a| a.to_string()),
        };
        self.area_filter = next;
        self.selected = 0;
        self.detail = None;
    }

    /// Areas to pass to memsrv's `areas` search filter.
    pub fn search_areas(&self) -> Vec<String> {
        self.area_filter.iter().map(|a| a.to_ascii_lowercase()).collect()
    }
}

impl PaneView for MemoryPane {
    fn id(&self) -> Pane { Pane::Memory }

    fn lines(&self, height: usize) -> Vec<Line<'static>> {
        if let Some(e) = &self.error {
            return vec![Line::from(Span::styled(format!("✖ {e}"), Style::default().fg(theme::RED)))];
        }
        let mut out: Vec<Line<'static>> = Vec::new();
        if self.searching {
            out.push(Line::from(vec![
                Span::styled("search ", Style::default().fg(theme::GREY)),
                Span::styled(self.query.clone(), Style::default().fg(theme::ACCENT)),
                Span::styled("▌", Style::default().fg(theme::ACCENT)),
            ]));
        }
        let mut idx = 0usize;
        for (area, rows) in self.grouped() {
            out.push(Line::from(Span::styled(
                format!("{} ({})", area.to_uppercase(), rows.len()),
                Style::default().fg(area_color(area)).add_modifier(Modifier::BOLD),
            )));
            for r in rows {
                let on = idx == self.selected;
                let marker = if on { "▶" } else { " " };
                let style = if on {
                    Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(theme::WHITE)
                };
                out.push(Line::from(vec![
                    Span::styled(format!("{marker} #{:<4}", r.id), style),
                    Span::styled(r.label.clone(), style),
                    Span::styled(format!("  {} facts", r.facts), Style::default().fg(theme::GREY)),
                ]));
                idx += 1;
            }
        }
        if out.is_empty() {
            out.push(Line::from(Span::styled("(memory is empty)", Style::default().fg(theme::GREY))));
        }
        if let Some(d) = &self.detail {
            out.push(Line::from(""));
            out.extend(d.lines().map(|l| Line::from(
                Span::styled(l.to_string(), Style::default().fg(theme::GREY)),
            )));
        }
        if height > 0 && out.len() > height {
            let start = out.len() - height;
            return out[start..].to_vec();
        }
        out
    }

    fn on_key(&mut self, key: KeyEvent, _height: usize) -> bool {
        if self.searching {
            match key.code {
                KeyCode::Esc => { self.searching = false; self.query.clear(); true }
                KeyCode::Backspace => { self.query.pop(); true }
                KeyCode::Char(c) => { self.query.push(c); true }
                _ => false, // Enter runs the query in the event loop
            }
        } else {
            match key.code {
                KeyCode::Char('/') => { self.searching = true; self.query.clear(); true }
                KeyCode::Char('a') => { self.cycle_area(); true }
                _ => false,
            }
        }
    }

    fn status(&self) -> String {
        let area = self.area_filter.as_deref().unwrap_or("all areas");
        format!("{} nodes · {}", self.visible().len(), area)
    }

    fn help(&self) -> Vec<(&'static str, &'static str)> {
        vec![
            ("/", "search memory"),
            ("a", "cycle brain area filter"),
            ("enter", "load node state"),
            ("j/k", "move selection"),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::KeyModifiers;

    fn row(id: u64, area: &str, label: &str) -> NodeRow {
        NodeRow { id, kind: "Aspect".into(), area: area.into(), label: label.into(), facts: 1 }
    }
    fn pane() -> MemoryPane {
        let mut p = MemoryPane::new();
        p.rows = vec![
            row(3, "Semantic", "helm rollback"),
            row(1, "Salience", "pain: 404 on rewrite"),
            row(2, "Episodic", "deploy checkout"),
            row(4, "Semantic", "ingress annotations"),
        ];
        p
    }
    fn key(c: char) -> KeyEvent { KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE) }
    fn text(l: &Line) -> String { l.spans.iter().map(|s| s.content.to_string()).collect() }

    #[test]
    fn nodes_group_by_area_in_rail_order() {
        let p = pane();
        let groups: Vec<&str> = p.grouped().iter().map(|(a, _)| *a).collect();
        assert_eq!(groups, ["Episodic", "Semantic", "Salience"], "empty areas are not shown");
        // within a group, rows are ordered by id, not by arrival
        let semantic: Vec<u64> = p.grouped()[1].1.iter().map(|r| r.id).collect();
        assert_eq!(semantic, [3, 4]);
    }

    #[test]
    fn area_filter_cycles_through_every_area_and_back_to_all() {
        let mut p = pane();
        assert_eq!(p.status(), "4 nodes · all areas");
        p.cycle_area();
        assert_eq!(p.area_filter.as_deref(), Some("Episodic"));
        assert_eq!(p.visible().len(), 1);
        for _ in 0..AREA_ORDER.len() { p.cycle_area(); }
        assert_eq!(p.area_filter, None, "cycling past the last area returns to all");
        assert_eq!(p.visible().len(), 4);
    }

    #[test]
    fn selection_follows_display_order_and_clamps() {
        let mut p = pane();
        assert_eq!(p.selected_node(), Some(2), "first row of the first group");
        p.move_selection(1);
        assert_eq!(p.selected_node(), Some(3));
        p.move_selection(100);
        assert_eq!(p.selected_node(), Some(1), "last visible row");
        p.move_selection(-100);
        assert_eq!(p.selected, 0);
    }

    #[test]
    fn moving_the_selection_drops_stale_detail() {
        let mut p = pane();
        p.detail = Some("state of #2".into());
        p.move_selection(1);
        assert!(p.detail.is_none(), "detail must never be shown against another node");
    }

    #[test]
    fn search_mode_captures_typing_and_escapes_cleanly() {
        let mut p = pane();
        assert!(p.on_key(key('/'), 20));
        assert!(p.searching);
        for c in "helm".chars() { assert!(p.on_key(key(c), 20)); }
        assert_eq!(p.query, "helm");
        assert!(p.on_key(KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE), 20));
        assert_eq!(p.query, "hel");
        // 'a' is the area shortcut, but inside search it is just a letter
        assert!(p.on_key(key('a'), 20));
        assert_eq!(p.query, "hela");
        assert_eq!(p.area_filter, None);
        assert!(p.on_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE), 20));
        assert!(!p.searching && p.query.is_empty());
    }

    #[test]
    fn search_areas_are_lowercased_for_memsrv() {
        let mut p = pane();
        assert!(p.search_areas().is_empty(), "no filter means search everywhere");
        p.cycle_area();
        assert_eq!(p.search_areas(), vec!["episodic".to_string()]);
    }

    #[test]
    fn rendering_shows_headers_content_and_the_cursor() {
        let p = pane();
        let out: Vec<String> = p.lines(0).iter().map(text).collect();
        assert!(out[0].starts_with("EPISODIC (1)"));
        assert!(out[1].starts_with("▶ #2"), "selected row is marked: {:?}", out[1]);
        assert!(out.iter().any(|l| l.contains("pain: 404 on rewrite")), "{out:?}");
        // area headers are coloured by state
        assert_eq!(p.lines(0)[0].spans[0].style.fg, Some(theme::ORANGE));
    }

    #[test]
    fn empty_and_error_states_say_so() {
        let p = MemoryPane::new();
        assert!(text(&p.lines(0)[0]).contains("memory is empty"));
        let mut p = MemoryPane::new();
        p.error = Some("memsrv closed the connection".into());
        assert!(text(&p.lines(0)[0]).contains("memsrv closed"));
    }
}
