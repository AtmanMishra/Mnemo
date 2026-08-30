//! 2.2 Cockpit shell state: which pane is showing, what has focus, what the
//! user is typing. Pure — no terminal, no child processes — so the whole
//! navigation model is unit-testable.
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pane {
    Chat,
    Sessions,
    Memory,
    Agents,
    Skills,
    Logs,
}

impl Pane {
    pub const ALL: [Pane; 6] =
        [Pane::Chat, Pane::Sessions, Pane::Memory, Pane::Agents, Pane::Skills, Pane::Logs];

    pub fn label(self) -> &'static str {
        match self {
            Pane::Chat => "Chat",
            Pane::Sessions => "Sessions",
            Pane::Memory => "Memory",
            Pane::Agents => "Agents",
            Pane::Skills => "Skills",
            Pane::Logs => "Logs",
        }
    }
    pub fn index(self) -> usize {
        Pane::ALL.iter().position(|p| *p == self).unwrap_or(0)
    }
    fn step(self, delta: isize) -> Pane {
        let n = Pane::ALL.len() as isize;
        Pane::ALL[(((self.index() as isize + delta) % n + n) % n) as usize]
    }
    pub fn next(self) -> Pane { self.step(1) }
    pub fn prev(self) -> Pane { self.step(-1) }
    /// '1'..'5' -> pane, for direct jumps.
    pub fn from_digit(c: char) -> Option<Pane> {
        c.to_digit(10)
            .filter(|d| *d >= 1)
            .and_then(|d| Pane::ALL.get(d as usize - 1).copied())
    }
}

/// Which region takes keystrokes. The focus ring is drawn around it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Focus {
    /// The pane body: list navigation, single-key shortcuts.
    Main,
    /// The prompt line: every printable key is text.
    Input,
}

/// What the event loop should do after a keystroke.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    None,
    /// Submit the input line (already cleared from state).
    Submit(String),
    /// Selection moved in the pane body; the pane decides what that means.
    Moved(isize),
    Quit,
}

#[derive(Debug, Clone)]
pub struct Cockpit {
    pub pane: Pane,
    pub focus: Focus,
    pub input: String,
    pub status: String,
    pub quit: bool,
    /// `?` help card is open.
    pub show_help: bool,
    /// Agent is mid-run (drives the spinner and the cursor pulse).
    pub busy: bool,
    /// Alternating flag for the cursor pulse.
    pub pulse: bool,
    /// provider/model this session will run on; None means nothing is set yet
    /// and prompting will fail with a readable error rather than a crash (8.6).
    pub model: Option<(String, String)>,
}

impl Default for Cockpit {
    fn default() -> Self {
        Self {
            pane: Pane::Chat,
            focus: Focus::Input,
            input: String::new(),
            status: String::new(),
            quit: false,
            show_help: false,
            busy: false,
            pulse: false,
            model: None,
        }
    }
}

impl Cockpit {
    pub fn new() -> Self { Self::default() }

    /// Handle one keystroke. Pane switching works from any focus so the rail is
    /// always reachable, even mid-sentence.
    pub fn on_key(&mut self, key: KeyEvent) -> Action {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let alt = key.modifiers.contains(KeyModifiers::ALT);

        match key.code {
            KeyCode::Char('c') | KeyCode::Char('d') if ctrl => {
                self.quit = true;
                return Action::Quit;
            }
            // tab completes a command before it moves panes
            KeyCode::Tab if self.input.starts_with('/') => {
                if let Some(done) = crate::palette::complete(&self.input) { self.input = done; }
                return Action::None;
            }
            KeyCode::Tab => { self.pane = self.pane.next(); return Action::None; }
            KeyCode::BackTab => { self.pane = self.pane.prev(); return Action::None; }
            // alt+digit works while typing; a bare digit only when not typing
            KeyCode::Char(c) if alt && c.is_ascii_digit() => {
                if let Some(p) = Pane::from_digit(c) { self.pane = p; }
                return Action::None;
            }
            _ => {}
        }

        match self.focus {
            Focus::Input => match key.code {
                KeyCode::Enter => {
                    let line = self.input.trim().to_string();
                    self.input.clear();
                    if line.is_empty() { Action::None } else { Action::Submit(line) }
                }
                KeyCode::Backspace => { self.input.pop(); Action::None }
                KeyCode::Esc if self.show_help => { self.show_help = false; Action::None }
            KeyCode::Esc => { self.focus = Focus::Main; Action::None }
                KeyCode::Char(c) if !ctrl => { self.input.push(c); Action::None }
                _ => Action::None,
            },
            Focus::Main => match key.code {
                KeyCode::Char('?') => { self.show_help = !self.show_help; Action::None }
                KeyCode::Esc if self.show_help => { self.show_help = false; Action::None }
                KeyCode::Char('q') => { self.quit = true; Action::Quit }
                KeyCode::Char('i') | KeyCode::Enter => { self.focus = Focus::Input; Action::None }
                KeyCode::Char(c) if c.is_ascii_digit() => {
                    if let Some(p) = Pane::from_digit(c) { self.pane = p; }
                    Action::None
                }
                KeyCode::Down | KeyCode::Char('j') => Action::Moved(1),
                KeyCode::Up | KeyCode::Char('k') => Action::Moved(-1),
                _ => Action::None,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(c: char) -> KeyEvent { KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE) }
    fn code(k: KeyCode) -> KeyEvent { KeyEvent::new(k, KeyModifiers::NONE) }
    fn with(k: KeyCode, m: KeyModifiers) -> KeyEvent { KeyEvent::new(k, m) }

    #[test]
    fn rail_has_the_planned_panes_in_order() {
        let labels: Vec<&str> = Pane::ALL.iter().map(|p| p.label()).collect();
        assert_eq!(labels, ["Chat", "Sessions", "Memory", "Agents", "Skills", "Logs"]);
        assert_eq!(Pane::from_digit('1'), Some(Pane::Chat));
        assert_eq!(Pane::from_digit('2'), Some(Pane::Sessions));
        assert_eq!(Pane::from_digit('6'), Some(Pane::Logs));
        assert_eq!(Pane::from_digit('0'), None);
        assert_eq!(Pane::from_digit('7'), None);
    }

    #[test]
    fn tab_cycles_panes_and_wraps_both_ways() {
        let mut c = Cockpit::new();
        for want in [Pane::Sessions, Pane::Memory, Pane::Agents, Pane::Skills, Pane::Logs, Pane::Chat] {
            c.on_key(code(KeyCode::Tab));
            assert_eq!(c.pane, want);
        }
        c.on_key(code(KeyCode::BackTab));
        assert_eq!(c.pane, Pane::Logs, "shift-tab wraps backwards");
    }

    #[test]
    fn pane_switching_works_while_typing() {
        let mut c = Cockpit::new();
        for ch in "hello".chars() { c.on_key(key(ch)); }
        c.on_key(with(KeyCode::Char('4'), KeyModifiers::ALT));
        assert_eq!(c.pane, Pane::Agents);
        assert_eq!(c.input, "hello", "switching panes must not eat the draft");
        // a bare digit while typing is text, not navigation
        c.on_key(key('2'));
        assert_eq!(c.input, "hello2");
        assert_eq!(c.pane, Pane::Agents);
    }

    #[test]
    fn bare_digits_navigate_once_the_body_has_focus() {
        let mut c = Cockpit::new();
        c.on_key(code(KeyCode::Esc));
        assert_eq!(c.focus, Focus::Main);
        c.on_key(key('5'));
        assert_eq!(c.pane, Pane::Skills);
        assert!(c.input.is_empty());
    }

    #[test]
    fn input_submits_trimmed_and_clears() {
        let mut c = Cockpit::new();
        for ch in "  fix the build  ".chars() { c.on_key(key(ch)); }
        assert_eq!(c.on_key(code(KeyCode::Enter)), Action::Submit("fix the build".into()));
        assert_eq!(c.input, "");
        // enter on an empty line does nothing at all
        assert_eq!(c.on_key(code(KeyCode::Enter)), Action::None);
    }

    #[test]
    fn backspace_and_focus_round_trip() {
        let mut c = Cockpit::new();
        for ch in "abc".chars() { c.on_key(key(ch)); }
        c.on_key(code(KeyCode::Backspace));
        assert_eq!(c.input, "ab");
        c.on_key(code(KeyCode::Esc));
        assert_eq!(c.focus, Focus::Main);
        c.on_key(key('i'));
        assert_eq!(c.focus, Focus::Input);
        assert_eq!(c.input, "ab", "the draft survives a focus round trip");
    }

    #[test]
    fn body_focus_moves_selection_and_quits() {
        let mut c = Cockpit::new();
        c.on_key(code(KeyCode::Esc));
        assert_eq!(c.on_key(key('j')), Action::Moved(1));
        assert_eq!(c.on_key(code(KeyCode::Up)), Action::Moved(-1));
        assert_eq!(c.on_key(key('q')), Action::Quit);
        assert!(c.quit);
    }

    #[test]
    fn ctrl_c_quits_from_anywhere_without_typing_a_c() {
        let mut c = Cockpit::new();
        assert_eq!(c.on_key(with(KeyCode::Char('c'), KeyModifiers::CONTROL)), Action::Quit);
        assert_eq!(c.input, "");
    }

    #[test]
    fn tab_completes_a_command_before_it_switches_panes() {
        let mut c = Cockpit::new();
        for ch in "/cons".chars() { c.on_key(key(ch)); }
        c.on_key(code(KeyCode::Tab));
        assert_eq!(c.input, "/consolidate");
        assert_eq!(c.pane, Pane::Chat, "tab must not also move the pane");
        // with no command open, tab is navigation again
        c.input.clear();
        c.on_key(code(KeyCode::Tab));
        assert_eq!(c.pane, Pane::Sessions);
    }

    #[test]
    fn help_card_toggles_from_the_body_and_escapes() {
        let mut c = Cockpit::new();
        c.on_key(code(KeyCode::Esc));
        c.on_key(key('?'));
        assert!(c.show_help);
        c.on_key(key('?'));
        assert!(!c.show_help);
        c.on_key(key('?'));
        c.on_key(code(KeyCode::Esc));
        assert!(!c.show_help, "esc closes the card");
    }
}
