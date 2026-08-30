//! 2.6 Skills pane: SKILL.md skills and harness bundles the agent can reach.
//! Discovery mirrors agent/src/skills/discovery.ts: walk up to the git root
//! looking for .pi/skills and .agents/skills, then the two home locations.
use crate::cockpit::Pane;
use crate::pane::PaneView;
use crate::theme;
use crossterm::event::{KeyCode, KeyEvent};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Origin {
    /// A SKILL.md directory.
    Skill,
    /// A harness bundle the agent built for itself at runtime.
    Harness,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SkillRow {
    pub name: String,
    pub description: String,
    pub scope: &'static str,
    pub origin: Origin,
    pub path: PathBuf,
}

/// Skill search roots, project-first, exactly like the TS discovery order.
pub fn skill_roots(start: &Path, home: &Path) -> Vec<(PathBuf, &'static str)> {
    let mut out = Vec::new();
    let mut cur = start.to_path_buf();
    loop {
        out.push((cur.join(".pi").join("skills"), "project"));
        out.push((cur.join(".agents").join("skills"), "project"));
        if cur.join(".git").exists() { break; }
        match cur.parent() {
            Some(p) if p != cur => cur = p.to_path_buf(),
            _ => break,
        }
    }
    out.push((home.join(".pi").join("agent").join("skills"), "global"));
    out.push((home.join(".agents").join("skills"), "global"));
    out
}

/// First non-empty `name:`/`description:` pair from SKILL.md frontmatter.
pub fn parse_frontmatter(md: &str) -> (Option<String>, Option<String>) {
    let mut name = None;
    let mut desc = None;
    for line in md.lines().skip_while(|l| l.trim().is_empty()).skip(1) {
        let line = line.trim();
        if line == "---" { break; }
        if let Some(v) = line.strip_prefix("name:") {
            name.get_or_insert(v.trim().trim_matches('"').to_string());
        }
        if let Some(v) = line.strip_prefix("description:") {
            desc.get_or_insert(v.trim().trim_matches('"').to_string());
        }
    }
    (name.filter(|s| !s.is_empty()), desc.filter(|s| !s.is_empty()))
}

/// Scan one directory of skill folders. Missing directories are not an error.
pub fn scan_skills(dir: &Path, scope: &'static str) -> Vec<SkillRow> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out = Vec::new();
    for e in entries.flatten() {
        let md = e.path().join("SKILL.md");
        let Ok(body) = std::fs::read_to_string(&md) else { continue };
        let (name, description) = parse_frontmatter(&body);
        out.push(SkillRow {
            name: name.unwrap_or_else(|| e.file_name().to_string_lossy().to_string()),
            description: description.unwrap_or_default(),
            scope,
            origin: Origin::Skill,
            path: md,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Harness bundles: a directory with a manifest.json naming the tools inside.
pub fn scan_harnesses(dir: &Path) -> Vec<SkillRow> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out = Vec::new();
    for e in entries.flatten() {
        let manifest = e.path().join("manifest.json");
        let Ok(body) = std::fs::read_to_string(&manifest) else { continue };
        let v: serde_json::Value = serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
        let name = v.get("name").and_then(|n| n.as_str())
            .unwrap_or(&e.file_name().to_string_lossy()).to_string();
        let tools = v.get("tools").and_then(|t| t.as_array()).map(|a| a.len()).unwrap_or(0);
        out.push(SkillRow {
            name,
            description: format!("{tools} tool(s)"),
            scope: "harness",
            origin: Origin::Harness,
            path: manifest,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

#[derive(Debug, Clone, Default)]
pub struct SkillsPane {
    pub rows: Vec<SkillRow>,
    pub selected: usize,
    pub filter: String,
    pub filtering: bool,
}

impl SkillsPane {
    pub fn new() -> Self { Self::default() }

    pub fn load(start: &Path, home: &Path, harness_dir: &Path) -> Self {
        let mut rows: Vec<SkillRow> = skill_roots(start, home).iter()
            .flat_map(|(dir, scope)| scan_skills(dir, scope))
            .collect();
        rows.extend(scan_harnesses(harness_dir));
        // first definition of a name wins, matching the agent's own precedence
        let mut seen = std::collections::HashSet::new();
        rows.retain(|r| seen.insert((r.name.clone(), r.origin)));
        Self { rows, ..Default::default() }
    }

    pub fn visible(&self) -> Vec<&SkillRow> {
        let f = self.filter.to_ascii_lowercase();
        self.rows.iter()
            .filter(|r| f.is_empty()
                || r.name.to_ascii_lowercase().contains(&f)
                || r.description.to_ascii_lowercase().contains(&f))
            .collect()
    }

    pub fn move_selection(&mut self, delta: isize) {
        let n = self.visible().len();
        if n == 0 { self.selected = 0; return; }
        self.selected = (self.selected as isize + delta).clamp(0, n as isize - 1) as usize;
    }
}

impl PaneView for SkillsPane {
    fn id(&self) -> Pane { Pane::Skills }

    fn lines(&self, height: usize) -> Vec<Line<'static>> {
        let rows = self.visible();
        let mut out: Vec<Line<'static>> = Vec::new();
        if self.filtering {
            out.push(Line::from(vec![
                Span::styled("filter ", Style::default().fg(theme::GREY)),
                Span::styled(self.filter.clone(), Style::default().fg(theme::YELLOW)),
                Span::styled("▌", Style::default().fg(theme::YELLOW)),
            ]));
        }
        if rows.is_empty() {
            out.push(Line::from(Span::styled("(no skills found)", Style::default().fg(theme::GREY))));
            return out;
        }
        for (i, r) in rows.iter().enumerate() {
            let on = i == self.selected;
            let style = if on {
                Style::default().fg(theme::YELLOW).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(theme::WHITE)
            };
            let (tag, color) = match r.origin {
                Origin::Skill => ("SKILL", theme::BLUE),
                Origin::Harness => ("HARNESS", theme::GREEN),
            };
            out.push(Line::from(vec![
                Span::styled(format!("{} ", if on { "▶" } else { " " }), style),
                Span::styled(format!("{tag:<8}"), Style::default().fg(color)),
                Span::styled(r.name.clone(), style),
                Span::styled(format!("  {}", r.description), Style::default().fg(theme::GREY)),
            ]));
        }
        if height > 0 && out.len() > height {
            let start = out.len() - height;
            return out[start..].to_vec();
        }
        out
    }

    fn on_key(&mut self, key: KeyEvent, _h: usize) -> bool {
        if self.filtering {
            match key.code {
                KeyCode::Esc => { self.filtering = false; self.filter.clear(); self.selected = 0; true }
                KeyCode::Backspace => { self.filter.pop(); self.selected = 0; true }
                KeyCode::Char(c) => { self.filter.push(c); self.selected = 0; true }
                _ => false,
            }
        } else if key.code == KeyCode::Char('/') {
            self.filtering = true;
            self.filter.clear();
            true
        } else {
            false
        }
    }

    fn status(&self) -> String {
        let harnesses = self.rows.iter().filter(|r| r.origin == Origin::Harness).count();
        format!("{} skills · {harnesses} harnesses", self.rows.len() - harnesses)
    }

    fn help(&self) -> Vec<(&'static str, &'static str)> {
        vec![("/", "filter by name"), ("j/k", "move selection")]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::KeyModifiers;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cockpit-skills-{name}"));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn write_skill(root: &Path, dir: &str, name: &str, desc: &str) {
        let d = root.join(dir);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {desc}\n---\n\nbody\n")).unwrap();
    }
    fn text(l: &Line) -> String { l.spans.iter().map(|s| s.content.to_string()).collect() }

    #[test]
    fn roots_walk_up_to_the_git_root_then_stop() {
        let root = tmp("roots");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        let deep = root.join("a").join("b");
        std::fs::create_dir_all(&deep).unwrap();
        let home = tmp("home");
        let roots = skill_roots(&deep, &home);
        assert!(roots.iter().any(|(p, _)| p.starts_with(&deep)));
        assert!(roots.iter().any(|(p, _)| p.starts_with(&root)), "must reach the git root");
        assert!(roots.iter().any(|(p, s)| p.starts_with(&home) && *s == "global"));
        // and it does not climb past the git root into the whole filesystem
        assert!(!roots.iter().any(|(p, _)| p == &PathBuf::from("/").join(".pi").join("skills")));
    }

    #[test]
    fn frontmatter_is_read_and_bad_files_fall_back_to_the_folder_name() {
        let (n, d) = parse_frontmatter("---\nname: tui-design\ndescription: make it pretty\n---\nbody");
        assert_eq!((n.as_deref(), d.as_deref()), (Some("tui-design"), Some("make it pretty")));
        assert_eq!(parse_frontmatter("no frontmatter at all"), (None, None));

        let root = tmp("fm");
        let d = root.join("nameless");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("SKILL.md"), "just a body").unwrap();
        let rows = scan_skills(&root, "project");
        assert_eq!(rows[0].name, "nameless", "a skill without frontmatter is still usable");
    }

    #[test]
    fn directories_without_skill_md_are_not_skills() {
        let root = tmp("nonskill");
        std::fs::create_dir_all(root.join("notaskill")).unwrap();
        write_skill(&root, "real", "real", "yes");
        let rows = scan_skills(&root, "project");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, "real");
        // a missing directory is empty, not a crash
        assert!(scan_skills(&root.join("nope"), "project").is_empty());
    }

    #[test]
    fn harness_bundles_are_listed_with_their_tool_count() {
        let root = tmp("harness");
        let b = root.join("csvkit");
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(b.join("manifest.json"),
            r#"{"name":"csvkit","tools":[{"name":"csv_head"},{"name":"csv_stats"}]}"#).unwrap();
        let rows = scan_harnesses(&root);
        assert_eq!(rows[0].name, "csvkit");
        assert_eq!(rows[0].description, "2 tool(s)");
        assert_eq!(rows[0].origin, Origin::Harness);
    }

    #[test]
    fn filtering_matches_name_or_description_and_resets_selection() {
        let mut p = SkillsPane::new();
        p.rows = vec![
            SkillRow { name: "tui-design".into(), description: "terminal ui".into(),
                       scope: "project", origin: Origin::Skill, path: PathBuf::new() },
            SkillRow { name: "graft".into(), description: "codebase graph".into(),
                       scope: "project", origin: Origin::Skill, path: PathBuf::new() },
        ];
        p.move_selection(1);
        assert_eq!(p.selected, 1);
        assert!(p.on_key(KeyEvent::new(KeyCode::Char('/'), KeyModifiers::NONE), 20));
        for c in "graph".chars() { p.on_key(KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE), 20); }
        assert_eq!(p.visible().len(), 1, "matches the description too");
        assert_eq!(p.selected, 0, "selection must not point past the filtered list");
        p.on_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE), 20);
        assert_eq!(p.visible().len(), 2);
    }

    #[test]
    fn skills_and_harnesses_are_visually_distinct() {
        let mut p = SkillsPane::new();
        p.rows = vec![
            SkillRow { name: "s".into(), description: String::new(), scope: "project",
                       origin: Origin::Skill, path: PathBuf::new() },
            SkillRow { name: "h".into(), description: String::new(), scope: "harness",
                       origin: Origin::Harness, path: PathBuf::new() },
        ];
        let lines = p.lines(0);
        assert!(text(&lines[0]).contains("SKILL"));
        assert_eq!(lines[0].spans[1].style.fg, Some(theme::BLUE));
        assert!(text(&lines[1]).contains("HARNESS"));
        assert_eq!(lines[1].spans[1].style.fg, Some(theme::GREEN));
        assert_eq!(p.status(), "1 skills · 1 harnesses");
    }
}
