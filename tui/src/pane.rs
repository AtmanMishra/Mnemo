//! The pane contract. Every cockpit pane is a module implementing `PaneView`,
//! so adding one is: write the file, implement the trait, register it.
use crate::cockpit::Pane;
use crossterm::event::KeyEvent;
use ratatui::text::Line;

/// What a pane must do to live in the rail.
pub trait PaneView {
    fn id(&self) -> Pane;

    /// Body content, already trimmed to `height` lines.
    fn lines(&self, height: usize) -> Vec<Line<'static>>;

    /// Pane-local keys, tried BEFORE the shared navigation model.
    /// Return true to consume the key.
    fn on_key(&mut self, _key: KeyEvent, _height: usize) -> bool { false }

    /// Right-hand status text (counts, filters, mode).
    fn status(&self) -> String { String::new() }

    /// One line per pane-local binding, for the `?` overlay.
    fn help(&self) -> Vec<(&'static str, &'static str)> { Vec::new() }

    /// Called once per frame before render, for panes with live data.
    fn tick(&mut self) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::{KeyCode, KeyModifiers};

    struct Stub(Pane, u32);
    impl PaneView for Stub {
        fn id(&self) -> Pane { self.0 }
        fn lines(&self, _h: usize) -> Vec<Line<'static>> { vec![Line::from(self.1.to_string())] }
        fn on_key(&mut self, key: KeyEvent, _h: usize) -> bool {
            if key.code == KeyCode::Char('x') { self.1 += 1; true } else { false }
        }
    }

    #[test]
    fn a_pane_reports_its_own_identity() {
        let s = Stub(Pane::Logs, 0);
        assert_eq!(s.id(), Pane::Logs);
        assert!(s.status().is_empty(), "status is optional");
        assert!(s.help().is_empty(), "pane-local help is optional");
    }

    #[test]
    fn unhandled_keys_fall_through_to_navigation() {
        let mut s = Stub(Pane::Chat, 0);
        assert!(!s.on_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE), 10),
            "tab must reach the shell so pane switching always works");
        assert!(s.on_key(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE), 10));
        assert_eq!(s.lines(1)[0].spans[0].content, "1");
    }
}
