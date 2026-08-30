//! 8.3/8.6 Onboarding and login, inside the runtime.
//!
//! The same flow serves both: on first run it takes over the screen because
//! nothing works without a provider, and `/login` opens it mid-session because
//! by then it is a choice, not a gate.
//!
//! Pure state plus a render function — no terminal, no network — so every step
//! and every wrong turn is a unit test. Writing the credential is `auth::save`.
use crate::auth::{self, AuthFile, PROVIDERS};
use crate::theme;
use crossterm::event::{KeyCode, KeyEvent};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// Pick which provider to log in to.
    Provider,
    /// Paste the key.
    Key,
    /// Name the default model for that provider.
    Model,
    /// Logged in; the caller closes the overlay.
    Done,
}

/// Why the overlay is open, which decides whether it can be dismissed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    /// First run: nothing works until this finishes.
    FirstRun,
    /// `/login` from inside a session: escapable.
    Login,
}

#[derive(Debug, Clone)]
pub struct Onboarding {
    pub step: Step,
    pub reason: Reason,
    pub provider_index: usize,
    pub key: String,
    pub model: String,
    pub error: Option<String>,
    /// Set once a credential is written.
    pub saved: Option<AuthFile>,
    home: PathBuf,
}

impl Onboarding {
    pub fn new(home: PathBuf, reason: Reason) -> Self {
        Self {
            step: Step::Provider,
            reason,
            provider_index: 0,
            key: String::new(),
            model: String::new(),
            error: None,
            saved: None,
            home,
        }
    }

    pub fn provider(&self) -> &'static str {
        PROVIDERS[self.provider_index.min(PROVIDERS.len() - 1)]
    }

    /// First run cannot be escaped; a mid-session login can.
    pub fn dismissable(&self) -> bool {
        self.reason == Reason::Login
    }

    /// Handle one key. Returns true when the overlay should close.
    pub fn on_key(&mut self, key: KeyEvent, now: u64) -> bool {
        self.error = None;
        match key.code {
            KeyCode::Esc if self.dismissable() => return true,
            KeyCode::Esc => {
                self.error = Some("a provider is required before the agent can run".into());
                return false;
            }
            _ => {}
        }

        match self.step {
            Step::Provider => match key.code {
                KeyCode::Up | KeyCode::Char('k') => {
                    self.provider_index = self.provider_index.saturating_sub(1);
                }
                KeyCode::Down | KeyCode::Char('j') => {
                    self.provider_index = (self.provider_index + 1).min(PROVIDERS.len() - 1);
                }
                KeyCode::Char(c) if c.is_ascii_digit() => {
                    if let Some(i) = c.to_digit(10).map(|d| d as usize) {
                        if i >= 1 && i <= PROVIDERS.len() { self.provider_index = i - 1; }
                    }
                }
                KeyCode::Enter => {
                    self.step = Step::Key;
                    self.key.clear();
                }
                _ => {}
            },

            Step::Key => match key.code {
                KeyCode::Backspace => { self.key.pop(); }
                KeyCode::Enter => {
                    match auth::set_key(&self.home, self.provider(), &self.key, None, now) {
                        Ok(auth) => {
                            self.saved = Some(auth);
                            self.step = Step::Model;
                            self.model.clear();
                        }
                        Err(e) => self.error = Some(e),
                    }
                }
                KeyCode::Char(c) => self.key.push(c),
                _ => {}
            },

            Step::Model => match key.code {
                KeyCode::Backspace => { self.model.pop(); }
                // a model can be chosen later from inside a session
                KeyCode::Enter if self.model.trim().is_empty() => {
                    self.step = Step::Done;
                    return true;
                }
                KeyCode::Enter => {
                    match auth::set_default_model(&self.home, self.provider(), self.model.trim()) {
                        Ok(auth) => {
                            self.saved = Some(auth);
                            self.step = Step::Done;
                            return true;
                        }
                        Err(e) => self.error = Some(e),
                    }
                }
                KeyCode::Char(c) => self.model.push(c),
                _ => {}
            },

            Step::Done => return true,
        }
        false
    }

    /// The line under the title telling the user what to do right now.
    pub fn prompt(&self) -> String {
        match self.step {
            Step::Provider => "choose a provider  ↑↓ or 1-5, enter to continue".into(),
            Step::Key => format!("paste your {} key, enter to save", self.provider()),
            Step::Model => "default model (enter to skip and pick one later)".into(),
            Step::Done => "logged in".into(),
        }
    }
}

/// A key is never echoed back: the terminal scrollback outlives the session.
pub fn masked(key: &str) -> String {
    let n = key.chars().count();
    if n == 0 { return String::new() }
    "•".repeat(n.min(40))
}

/// PIXEL onboarding: chunky title, one step at a time, colour as state.
pub fn lines(o: &Onboarding, existing: &AuthFile) -> Vec<Line<'static>> {
    let mut out: Vec<Line<'static>> = vec![
        Line::from(Span::styled(
            "▚ MNEMO ▞",
            Style::default().fg(theme::YELLOW).add_modifier(Modifier::BOLD),
        )),
        Line::from(Span::styled(
            "memory that works like a brain",
            Style::default().fg(theme::GREY),
        )),
        Line::from(""),
        Line::from(Span::styled(o.prompt(), Style::default().fg(theme::WHITE))),
        Line::from(""),
    ];

    match o.step {
        Step::Provider => {
            for (i, p) in PROVIDERS.iter().enumerate() {
                let on = i == o.provider_index;
                let live = existing.logged_in().contains(p);
                let style = if on {
                    Style::default().fg(theme::YELLOW).add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(theme::WHITE)
                };
                let mut spans = vec![
                    Span::styled(format!("{} {} {}", if on { "▶" } else { " " }, i + 1, p), style),
                ];
                if live {
                    // colour = state: green means this one already works
                    spans.push(Span::styled("  logged in", Style::default().fg(theme::GREEN)));
                }
                out.push(Line::from(spans));
            }
        }
        Step::Key => {
            out.push(Line::from(vec![
                Span::styled(format!("{}  ", o.provider()), Style::default().fg(theme::BLUE)),
                Span::styled(masked(&o.key), Style::default().fg(theme::WHITE)),
                Span::styled("▌", Style::default().fg(theme::YELLOW)),
            ]));
            out.push(Line::from(Span::styled(
                "stored in ~/.mnemo/auth.json, readable only by you",
                Style::default().fg(theme::GREY),
            )));
        }
        Step::Model => {
            out.push(Line::from(vec![
                Span::styled("model  ", Style::default().fg(theme::BLUE)),
                Span::styled(o.model.clone(), Style::default().fg(theme::WHITE)),
                Span::styled("▌", Style::default().fg(theme::YELLOW)),
            ]));
            out.push(Line::from(Span::styled(
                "e.g. claude-opus-5, kimi-k2.6 — or enter to decide later",
                Style::default().fg(theme::GREY),
            )));
        }
        Step::Done => {}
    }

    if let Some(e) = &o.error {
        out.push(Line::from(""));
        out.push(Line::from(Span::styled(
            format!("✖ {e}"),
            Style::default().fg(theme::RED).add_modifier(Modifier::BOLD),
        )));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::KeyModifiers;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mnemo-onboard-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn key(c: char) -> KeyEvent { KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE) }
    fn code(k: KeyCode) -> KeyEvent { KeyEvent::new(k, KeyModifiers::NONE) }
    fn type_str(o: &mut Onboarding, s: &str) {
        for c in s.chars() { o.on_key(key(c), 1); }
    }
    fn text(l: &Line) -> String { l.spans.iter().map(|s| s.content.to_string()).collect() }

    #[test]
    fn the_happy_path_writes_a_usable_credential() {
        let home = tmp("happy");
        let mut o = Onboarding::new(home.clone(), Reason::FirstRun);

        // pick opencode-go (5th)
        o.on_key(key('5'), 1);
        assert_eq!(o.provider(), "opencode-go");
        assert!(!o.on_key(code(KeyCode::Enter), 1));
        assert_eq!(o.step, Step::Key);

        type_str(&mut o, "sk-test-key-123456");
        assert!(!o.on_key(code(KeyCode::Enter), 7));
        assert_eq!(o.step, Step::Model);

        type_str(&mut o, "claude-opus-5");
        assert!(o.on_key(code(KeyCode::Enter), 7), "the overlay closes when done");
        assert_eq!(o.step, Step::Done);

        // and the agent can read it
        let saved = auth::load(&home);
        assert!(saved.is_configured());
        assert_eq!(saved.effective_provider(), Some("opencode-go"));
        assert_eq!(saved.default_model_for("opencode-go"), Some("claude-opus-5"));
    }

    #[test]
    fn a_bad_key_keeps_you_on_the_step_with_a_reason() {
        let home = tmp("badkey");
        let mut o = Onboarding::new(home.clone(), Reason::FirstRun);
        o.on_key(code(KeyCode::Enter), 1);
        type_str(&mut o, "abc");
        assert!(!o.on_key(code(KeyCode::Enter), 1));
        assert_eq!(o.step, Step::Key, "a refused key must not advance the flow");
        assert!(o.error.as_deref().unwrap().contains("too short"));
        assert!(!auth::load(&home).is_configured(), "nothing half-written");

        // the error is on screen, not just in the struct
        let rendered: Vec<String> = lines(&o, &AuthFile::default()).iter().map(text).collect();
        assert!(rendered.iter().any(|l| l.contains("too short")), "{rendered:?}");

        // correcting it works without restarting
        type_str(&mut o, "-now-long-enough");
        o.on_key(code(KeyCode::Enter), 1);
        assert_eq!(o.step, Step::Model);
    }

    #[test]
    fn the_model_step_can_be_skipped_and_chosen_later() {
        let home = tmp("skip");
        let mut o = Onboarding::new(home.clone(), Reason::FirstRun);
        o.on_key(code(KeyCode::Enter), 1);
        type_str(&mut o, "sk-test-key-123456");
        o.on_key(code(KeyCode::Enter), 1);
        assert!(o.on_key(code(KeyCode::Enter), 1), "empty model just closes");

        let saved = auth::load(&home);
        assert!(saved.is_configured(), "the key is still saved");
        assert_eq!(saved.default_model_for("anthropic"), None,
            "no model yet is a real state — the session reports it, it is not a crash");
    }

    #[test]
    fn first_run_cannot_be_escaped_but_login_can() {
        let home = tmp("escape");
        let mut first = Onboarding::new(home.clone(), Reason::FirstRun);
        assert!(!first.dismissable());
        assert!(!first.on_key(code(KeyCode::Esc), 1), "esc must not dismiss first run");
        assert!(first.error.as_deref().unwrap().contains("required"));

        let mut login = Onboarding::new(home, Reason::Login);
        assert!(login.dismissable());
        assert!(login.on_key(code(KeyCode::Esc), 1), "/login is a choice, so esc closes it");
    }

    #[test]
    fn the_key_is_never_echoed() {
        assert_eq!(masked("sk-secret-value"), "•".repeat(15));
        assert_eq!(masked(""), "");
        // a paste of something enormous does not blow up the line
        assert_eq!(masked(&"x".repeat(500)).chars().count(), 40);

        let home = tmp("mask");
        let mut o = Onboarding::new(home, Reason::FirstRun);
        o.on_key(code(KeyCode::Enter), 1);
        type_str(&mut o, "sk-secret-value-1234");
        let rendered = lines(&o, &AuthFile::default()).iter().map(text).collect::<Vec<_>>().join("\n");
        assert!(!rendered.contains("sk-secret-value"), "the key must never reach the screen");
        assert!(rendered.contains("•"));
    }

    #[test]
    fn provider_navigation_covers_arrows_letters_and_digits() {
        let home = tmp("nav");
        let mut o = Onboarding::new(home, Reason::FirstRun);
        assert_eq!(o.provider(), "anthropic");
        o.on_key(code(KeyCode::Down), 1);
        assert_eq!(o.provider(), "openai");
        o.on_key(key('j'), 1);
        assert_eq!(o.provider(), "openrouter");
        o.on_key(key('k'), 1);
        assert_eq!(o.provider(), "openai");
        o.on_key(code(KeyCode::Up), 1);
        assert_eq!(o.provider(), "anthropic");
        // clamps rather than wrapping, so holding a key cannot overshoot
        for _ in 0..20 { o.on_key(code(KeyCode::Up), 1); }
        assert_eq!(o.provider(), "anthropic");
        for _ in 0..20 { o.on_key(code(KeyCode::Down), 1); }
        assert_eq!(o.provider(), "opencode-go");
        // an out-of-range digit is ignored, not a panic
        o.on_key(key('9'), 1);
        assert_eq!(o.provider(), "opencode-go");
    }

    #[test]
    fn already_logged_in_providers_are_marked_on_the_picker() {
        let home = tmp("marked");
        auth::set_key(&home, "openrouter", "sk-or-abcdefghij", Some("kimi"), 1).unwrap();
        let o = Onboarding::new(home.clone(), Reason::Login);
        let rendered: Vec<String> = lines(&o, &auth::load(&home)).iter().map(text).collect();
        let row = rendered.iter().find(|l| l.contains("openrouter")).unwrap();
        assert!(row.contains("logged in"), "{row}");
        let anthropic = rendered.iter().find(|l| l.contains("anthropic")).unwrap();
        assert!(!anthropic.contains("logged in"));
    }

    #[test]
    fn logging_in_to_a_second_provider_keeps_the_first() {
        // 8.7 needs more than one provider live at once
        let home = tmp("second");
        auth::set_key(&home, "anthropic", "sk-ant-abcdefghij", Some("claude-opus-5"), 1).unwrap();
        let mut o = Onboarding::new(home.clone(), Reason::Login);
        o.on_key(key('5'), 2);
        o.on_key(code(KeyCode::Enter), 2);
        type_str(&mut o, "sk-oc-abcdefghij");
        o.on_key(code(KeyCode::Enter), 2);
        type_str(&mut o, "kimi-k2.6");
        o.on_key(code(KeyCode::Enter), 2);

        let saved = auth::load(&home);
        assert_eq!(saved.logged_in(), vec!["anthropic", "opencode-go"]);
        assert_eq!(saved.available_models().len(), 2, "both are now offerable to a subagent");
        assert_eq!(saved.effective_provider(), Some("anthropic"),
            "logging in to another provider must not silently switch the default");
    }
}
