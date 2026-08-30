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
    /// Alt+Enter: interrupt the running turn with this instead of waiting.
    Steer(String),
    /// Selection moved in the pane body; the pane decides what that means.
    Moved(isize),
    Quit,
}

#[derive(Debug, Clone)]
pub struct Cockpit {
    pub pane: Pane,
    pub focus: Focus,
    pub input: String,
    /// A message from the app that outranks the pane's own status line, and
    /// when it was set. Without this, every command's reply is overwritten by
    /// the pane status on the very next frame — the command appears to do
    /// nothing at all.
    pub notice: Option<(String, u64)>,
    /// Terminal mouse reporting. Off by default so the terminal's own
    /// drag-select keeps working; `/mouse` turns it on for wheel and clicks.
    pub mouse: bool,
    /// Messages typed while the agent was busy, in the order they were typed.
    /// They are sent one at a time as it settles, so a second Enter does not
    /// silently overwrite the first.
    pub queued: Vec<String>,
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
            queued: Vec::new(),
            notice: None,
            mouse: false,
            status: String::new(),
            quit: false,
            show_help: false,
            busy: false,
            pulse: false,
            model: None,
        }
    }
}

/// How long a command's reply stays on the status bar.
pub const NOTICE_MS: u64 = 5_000;

impl Cockpit {
    pub fn new() -> Self { Self::default() }

    /// Say something that must survive the next redraw.
    pub fn notify(&mut self, text: impl Into<String>, now: u64) {
        let text = text.into();
        self.status = text.clone();
        self.notice = Some((text, now));
    }

    /// What the status bar should show: a recent notice, else the pane's own.
    pub fn status_for(&mut self, pane_status: String, now: u64) -> String {
        match &self.notice {
            Some((text, at)) if now.saturating_sub(*at) < NOTICE_MS => text.clone(),
            Some(_) => { self.notice = None; pane_status }
            None => pane_status,
        }
    }

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
                // Enter sends (or queues, which the loop decides); alt+Enter
                // interrupts. The distinction lives here so both are one
                // keystroke — "wait for it to finish" and "stop, do this
                // instead" are the two things you want mid-run, and neither
                // should cost a command.
                KeyCode::Enter => {
                    let line = self.input.trim().to_string();
                    self.input.clear();
                    match (line.is_empty(), alt) {
                        (true, _) => Action::None,
                        (false, true) => Action::Steer(line),
                        (false, false) => Action::Submit(line),
                    }
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

#[cfg(test)]
mod queue_tests {
    use super::*;

    fn code(k: KeyCode) -> KeyEvent { KeyEvent::new(k, KeyModifiers::NONE) }

    #[test]
    fn enter_sends_and_alt_enter_steers() {
        // the two things you want mid-run are "wait your turn" and "stop, do
        // this instead"; neither should cost a slash command
        let mut c = Cockpit::new();
        c.input = "run the tests".into();
        assert_eq!(c.on_key(code(KeyCode::Enter)), Action::Submit("run the tests".into()));

        c.input = "actually check the lint first".into();
        assert_eq!(
            c.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::ALT)),
            Action::Steer("actually check the lint first".into()),
        );
        assert!(c.input.is_empty(), "either way the line is consumed");
    }

    #[test]
    fn an_empty_line_steers_nothing() {
        let mut c = Cockpit::new();
        assert_eq!(c.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::ALT)), Action::None);
        c.input = "   ".into();
        assert_eq!(c.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::ALT)), Action::None);
    }

    #[test]
    fn queued_messages_are_visible_rather_than_swallowed() {
        // a message that vanished into a buffer with no sign of it looks
        // exactly like one that was dropped
        let mut c = Cockpit::new();
        c.busy = true;
        c.queued = vec!["first".into(), "second".into()];
        let shown: Vec<String> = crate::cockpit_ui::prompt_lines(&c, " ").iter()
            .map(|l| l.spans.iter().map(|s| s.content.to_string()).collect::<String>())
            .collect();
        assert!(shown[1].contains("1. first"), "{shown:?}");
        assert!(shown[2].contains("2. second"));
    }

    #[test]
    fn a_long_queue_is_summarised_instead_of_eating_the_screen() {
        let mut c = Cockpit::new();
        c.queued = (0..9).map(|i| format!("msg {i}")).collect();
        let shown: Vec<String> = crate::cockpit_ui::prompt_lines(&c, " ").iter()
            .map(|l| l.spans.iter().map(|s| s.content.to_string()).collect::<String>())
            .collect();
        assert!(shown.last().unwrap().contains("+5 more queued"), "{shown:?}");
        assert!(shown.len() <= 6, "the transcript behind it still matters: {shown:?}");
    }

    #[test]
    fn the_status_bar_names_both_keys_only_while_it_matters() {
        let mut c = Cockpit::new();
        let text = |c: &Cockpit| crate::cockpit_ui::status_line(c).spans.iter()
            .map(|s| s.content.to_string()).collect::<String>();
        assert!(text(&c).contains("enter send"));
        c.busy = true;
        let busy = text(&c);
        assert!(busy.contains("enter queue") && busy.contains("alt+enter steer"), "{busy}");
    }
}

#[cfg(test)]
mod notice_tests {
    use super::*;

    #[test]
    fn a_commands_reply_survives_the_next_redraw() {
        // the bug: the pane status was reassigned every frame, so /mouse,
        // /model and "copied 400 chars" appeared to do nothing at all
        let mut c = Cockpit::new();
        c.notify("mouse on", 1_000);
        assert_eq!(c.status_for("6 entries".into(), 1_016), "mouse on", "one frame later");
        assert_eq!(c.status_for("6 entries".into(), 4_000), "mouse on", "and seconds later");
    }

    #[test]
    fn but_it_gives_the_pane_its_line_back() {
        // a notice that never expires is a status bar frozen on old news
        let mut c = Cockpit::new();
        c.notify("copied 412 chars", 1_000);
        assert_eq!(c.status_for("6 entries".into(), 1_000 + NOTICE_MS), "6 entries");
        assert!(c.notice.is_none(), "and it is cleared, not re-checked forever");
    }

    #[test]
    fn with_nothing_to_say_the_pane_speaks() {
        let mut c = Cockpit::new();
        assert_eq!(c.status_for("2 project(s)".into(), 500), "2 project(s)");
    }

    #[test]
    fn a_newer_notice_replaces_an_older_one() {
        let mut c = Cockpit::new();
        c.notify("queued (1)", 1_000);
        c.notify("queued (2)", 1_200);
        assert_eq!(c.status_for("x".into(), 1_300), "queued (2)");
    }
}
