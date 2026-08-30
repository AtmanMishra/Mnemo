//! 8.3/8.6 Onboarding and login, inside the runtime.
//!
//! The same flow serves both: on first run it takes over the screen because
//! nothing works without a provider, and `/login` opens it mid-session because
//! by then it is a choice, not a gate.
//!
//! Pure state plus a render function — no terminal, no network — so every step
//! and every wrong turn is a unit test. Writing the credential is `auth::save`.
use crate::auth::{self, AuthFile, PROVIDERS};
use crate::brand;
use crate::models::{filter_models, Model};
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
    /// `/model` from inside a session: skips straight to picking a model,
    /// across every provider already logged in.
    ModelOnly,
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
    /// The catalog for the model step. Empty until `load_models` runs, which
    /// the event loop does because it needs to spawn a process to find out.
    pub models: Vec<Model>,
    /// Why the catalog is missing, when it is. Distinct from "no models".
    pub models_error: Option<String>,
    /// Cursor into `visible_models()`.
    pub model_index: usize,
    /// Frames elapsed since the overlay opened. Drives Nyx pacing along the
    /// bottom — the whole point is that she is there for the WHOLE of setup,
    /// not just the first screen.
    pub tick: usize,
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
            models: Vec::new(),
            models_error: None,
            model_index: 0,
            tick: 0,
            home,
        }
    }

    /// `/model`: no provider to set up, just a model to choose.
    pub fn for_model(home: PathBuf) -> Self {
        let mut o = Self::new(home, Reason::ModelOnly);
        o.step = Step::Model;
        o
    }

    /// Hand the overlay the catalog. Filtered to the provider being set up,
    /// because during a login the only models you can pick are that
    /// provider's — offering another one would write a model the stored key
    /// cannot serve.
    pub fn load_models(&mut self, found: Result<Vec<Model>, String>) {
        match found {
            Ok(all) => {
                self.models = match self.reason {
                    // /model: every provider you are actually logged in to. A
                    // model whose provider has no stored key cannot be saved,
                    // so offering it would only produce a confusing refusal.
                    Reason::ModelOnly => {
                        let auth = auth::load(&self.home);
                        let live = auth.logged_in();
                        all.into_iter().filter(|(p, _)| live.contains(&p.as_str())).collect()
                    }
                    _ => all.into_iter().filter(|(p, _)| p == self.provider()).collect(),
                };
                self.models_error = None;
            }
            // never fatal: the field still accepts a typed name
            Err(e) => { self.models.clear(); self.models_error = Some(e); }
        }
        self.model_index = 0;
    }

    /// The rows on screen: the catalog narrowed by whatever has been typed.
    pub fn visible_models(&self) -> Vec<Model> {
        filter_models(&self.models, &self.model)
    }

    /// The row under the cursor, if the catalog has one.
    pub fn highlighted(&self) -> Option<Model> {
        let rows = self.visible_models();
        rows.get(self.model_index.min(rows.len().saturating_sub(1))).cloned()
    }

    pub fn provider(&self) -> &'static str {
        PROVIDERS[self.provider_index.min(PROVIDERS.len() - 1)]
    }

    /// First run cannot be escaped; anything mid-session can.
    pub fn dismissable(&self) -> bool {
        self.reason != Reason::FirstRun
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
                KeyCode::Up => self.model_index = self.model_index.saturating_sub(1),
                KeyCode::Down => {
                    let n = self.visible_models().len();
                    if n > 0 { self.model_index = (self.model_index + 1).min(n - 1); }
                }
                // typing narrows the list, so the cursor must not stay
                // pointing past the end of what is now on screen
                KeyCode::Backspace => { self.model.pop(); self.model_index = 0; }
                KeyCode::Char(c) => { self.model.push(c); self.model_index = 0; }
                KeyCode::Enter => {
                    // the highlighted row wins over the raw text: the text is
                    // the filter, and "opus" is not a model name
                    let chosen = self.highlighted()
                        .or_else(|| {
                            let typed = self.model.trim();
                            if typed.is_empty() { None }
                            else { Some((self.fallback_provider(), typed.to_string())) }
                        });
                    let Some((provider, model)) = chosen else {
                        // nothing picked and nothing typed: decide later
                        self.step = Step::Done;
                        return true;
                    };
                    match self.choose(&provider, &model) {
                        Ok(auth) => {
                            self.saved = Some(auth);
                            self.step = Step::Done;
                            return true;
                        }
                        Err(e) => self.error = Some(e),
                    }
                }
                _ => {}
            },

            Step::Done => return true,
        }
        false
    }

    /// Which provider a typed-in model name belongs to when the catalog could
    /// not be read. During a login it is the one being set up; from `/model`
    /// there is no such provider, so it is whichever one sessions already use.
    fn fallback_provider(&self) -> String {
        if self.reason != Reason::ModelOnly { return self.provider().to_string() }
        let auth = auth::load(&self.home);
        auth.effective_provider().map(str::to_string)
            .unwrap_or_else(|| self.provider().to_string())
    }

    /// Write the chosen model, and — only from `/model` — make its provider
    /// the one new sessions use. During a login the provider is already
    /// decided, and repointing it there would silently switch accounts.
    fn choose(&self, provider: &str, model: &str) -> Result<AuthFile, String> {
        let auth = auth::set_default_model(&self.home, provider, model)?;
        if self.reason == Reason::ModelOnly {
            return auth::set_default_provider(&self.home, provider);
        }
        Ok(auth)
    }

    /// The line under the title telling the user what to do right now.
    pub fn prompt(&self) -> String {
        match self.step {
            Step::Provider => "choose a provider  ↑↓ or 1-5, enter to continue".into(),
            Step::Key => format!("paste your {} key, enter to save", self.provider()),
            Step::Model => match (self.models.is_empty(), &self.models_error) {
                (true, Some(_)) => "type a model name — the catalog could not be read".into(),
                (true, None) => "default model (enter to skip and pick one later)".into(),
                _ => "↑↓ to choose, type to filter, enter to select".into(),
            },
            Step::Done => "logged in".into(),
        }
    }
}

/// How many catalog rows fit under the field without pushing the chrome off.
const MODEL_ROWS: usize = 8;

/// A key is never echoed back: the terminal scrollback outlives the session.
pub fn masked(key: &str) -> String {
    let n = key.chars().count();
    if n == 0 { return String::new() }
    "•".repeat(n.min(40))
}

/// PIXEL onboarding: chunky title, one step at a time, colour as state.
pub fn lines(o: &Onboarding, existing: &AuthFile) -> Vec<Line<'static>> {
    lines_in(o, existing, 100)
}

/// The overlay, sized for a terminal `cols` wide.
///
/// First run gets the full brand — wordmark and Nyx — because it is the one
/// moment the product introduces itself. `/login` and `/model` get the
/// wordmark alone: you already know what this is, and a cat every time you
/// switch model is a cat you stop seeing.
pub fn lines_in(o: &Onboarding, existing: &AuthFile, cols: usize) -> Vec<Line<'static>> {
    let mut out: Vec<Line<'static>> = Vec::new();
    if o.reason == Reason::FirstRun {
        out.extend(brand::splash(cols));
    } else if let Some(w) = brand::wordmark_for(cols) {
        out.extend(brand::paint_at(w, brand::SCALE_WORDMARK));
    } else {
        out.push(Line::from(Span::styled(
            "▚ MNEMO ▞",
            Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD),
        )));
    }
    out.push(Line::from(""));
    out.push(Line::from(Span::styled(o.prompt(), Style::default().fg(theme::WHITE))));
    out.push(Line::from(""));

    match o.step {
        Step::Provider => {
            for (i, p) in PROVIDERS.iter().enumerate() {
                let on = i == o.provider_index;
                let live = existing.logged_in().contains(p);
                let style = if on {
                    Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD)
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
                Span::styled("▌", Style::default().fg(theme::ACCENT)),
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
                Span::styled("▌", Style::default().fg(theme::ACCENT)),
            ]));
            let rows = o.visible_models();
            if let Some(e) = &o.models_error {
                // the catalog failing is not the same as having no models, and
                // the field still works, so say both
                out.push(Line::from(Span::styled(
                    format!("could not read the model list ({e})"),
                    Style::default().fg(theme::ORANGE),
                )));
                out.push(Line::from(Span::styled(
                    "type a model name instead, or enter to decide later",
                    Style::default().fg(theme::GREY),
                )));
            } else if o.models.is_empty() {
                out.push(Line::from(Span::styled(
                    "loading models…",
                    Style::default().fg(theme::GREY),
                )));
            } else if rows.is_empty() {
                out.push(Line::from(Span::styled(
                    format!("no model matches \"{}\"", o.model.trim()),
                    Style::default().fg(theme::GREY),
                )));
            } else {
                let cursor = o.model_index.min(rows.len() - 1);
                // a long catalog scrolls around the cursor rather than showing
                // the first eight forever
                let start = cursor.saturating_sub(MODEL_ROWS - 1);
                for (i, (provider, model)) in rows.iter().enumerate()
                    .skip(start).take(MODEL_ROWS)
                {
                    let on = i == cursor;
                    let style = if on {
                        Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD)
                    } else {
                        Style::default().fg(theme::WHITE)
                    };
                    out.push(Line::from(vec![
                        Span::styled(format!("{} ", if on { "▶" } else { " " }), style),
                        Span::styled(model.clone(), style),
                        Span::styled(format!("  {provider}"), Style::default().fg(theme::GREY)),
                    ]));
                }
                if rows.len() > MODEL_ROWS {
                    out.push(Line::from(Span::styled(
                        format!("{} of {} — type to narrow", MODEL_ROWS.min(rows.len()), rows.len()),
                        Style::default().fg(theme::GREY),
                    )));
                }
            }
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
    // Nyx paces along the bottom for every step of setup. Onboarding is the
    // one moment a new user is waiting on something they cannot hurry; a
    // still screen during it reads as a hang.
    out.push(Line::from(""));
    out.extend(brand::pace_lines(o.tick, cols.saturating_sub(2)));
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

#[cfg(test)]
mod model_picker_tests {
    use super::*;
    use crossterm::event::KeyModifiers;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mnemo-picker-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn key(c: KeyCode) -> KeyEvent { KeyEvent::new(c, KeyModifiers::NONE) }
    fn ch(c: char) -> KeyEvent { key(KeyCode::Char(c)) }
    fn catalog() -> Vec<Model> {
        vec![
            ("opencode".into(), "claude-opus-5".into()),
            ("opencode".into(), "gpt-5.5".into()),
            ("opencode-go".into(), "kimi-k2.6".into()),
        ]
    }
    fn text(l: &Line) -> String { l.spans.iter().map(|s| s.content.to_string()).collect() }

    #[test]
    fn slash_model_lists_every_logged_in_provider_and_picks_one() {
        // the bug: /model asked for a name you had to already know
        let home = tmp("slash-model");
        auth::set_key(&home, "opencode", "sk-op-abcdefghij", None, 1).unwrap();
        auth::set_key(&home, "opencode-go", "sk-oc-abcdefghij", None, 1).unwrap();
        let mut o = Onboarding::for_model(home.clone());
        assert_eq!(o.step, Step::Model, "no provider to set up, just a model");
        o.load_models(Ok(catalog()));
        assert_eq!(o.visible_models().len(), 3, "every provider's models, not one each");

        let rendered: Vec<String> = lines(&o, &auth::load(&home)).iter().map(text).collect();
        assert!(rendered.iter().any(|l| l.contains("claude-opus-5")), "{rendered:?}");
        assert!(rendered.iter().any(|l| l.contains("kimi-k2.6")));

        o.on_key(key(KeyCode::Down), 1);
        assert_eq!(o.highlighted().unwrap().1, "gpt-5.5");
        assert!(o.on_key(key(KeyCode::Enter), 1));

        let saved = auth::load(&home);
        assert_eq!(saved.default_model_for("opencode").as_deref(), Some("gpt-5.5"));
        assert_eq!(saved.effective_provider(), Some("opencode"),
            "/model also decides which provider new sessions use");
    }

    #[test]
    fn typing_filters_the_list_rather_than_naming_the_model() {
        let home = tmp("filter");
        auth::set_key(&home, "opencode", "sk-op-abcdefghij", None, 1).unwrap();
        let mut o = Onboarding::for_model(home.clone());
        o.load_models(Ok(catalog()));
        for c in "opus".chars() { o.on_key(ch(c), 1); }
        assert_eq!(o.visible_models().len(), 1);
        assert!(o.on_key(key(KeyCode::Enter), 1));
        // "opus" is not a model name; the highlighted row is what gets saved
        assert_eq!(auth::load(&home).default_model_for("opencode").as_deref(), Some("claude-opus-5"));
    }

    #[test]
    fn narrowing_the_list_moves_the_cursor_back_into_it() {
        let home = tmp("cursor");
        for p in ["opencode", "opencode-go"] {
            auth::set_key(&home, p, "sk-xx-abcdefghij", None, 1).unwrap();
        }
        let mut o = Onboarding::for_model(home);
        o.load_models(Ok(catalog()));
        o.on_key(key(KeyCode::Down), 1);
        o.on_key(key(KeyCode::Down), 1);
        assert_eq!(o.highlighted().unwrap().1, "kimi-k2.6");
        for c in "gpt".chars() { o.on_key(ch(c), 1); }
        assert_eq!(o.highlighted().unwrap().1, "gpt-5.5", "not left pointing past the end");
    }

    #[test]
    fn logging_in_only_offers_the_provider_you_just_gave_a_key_for() {
        // a model from another provider would be saved against a key that
        // cannot serve it
        let home = tmp("login-scope");
        let mut o = Onboarding::new(home.clone(), Reason::Login);
        o.provider_index = PROVIDERS.iter().position(|p| *p == "opencode-go").unwrap();
        o.step = Step::Model;
        o.load_models(Ok(catalog()));
        assert_eq!(o.visible_models(), vec![("opencode-go".to_string(), "kimi-k2.6".to_string())]);
    }

    #[test]
    fn a_login_does_not_silently_switch_which_provider_is_default() {
        let home = tmp("no-switch");
        auth::set_key(&home, "anthropic", "sk-ant-abcdefghij", Some("claude-opus-5"), 1).unwrap();
        auth::set_default_provider(&home, "anthropic").unwrap();

        let mut o = Onboarding::new(home.clone(), Reason::Login);
        auth::set_key(&home, "opencode-go", "sk-oc-abcdefghij", None, 2).unwrap();
        o.provider_index = PROVIDERS.iter().position(|p| *p == "opencode-go").unwrap();
        o.step = Step::Model;
        o.load_models(Ok(catalog()));
        assert!(o.on_key(key(KeyCode::Enter), 1));
        let saved = auth::load(&home);
        assert_eq!(saved.default_model_for("opencode-go").as_deref(), Some("kimi-k2.6"));
        assert_eq!(saved.effective_provider(), Some("anthropic"),
            "logging in to a second provider must not repoint the first");
    }

    #[test]
    fn an_unreadable_catalog_still_lets_you_type_a_name() {
        // offline, or node missing: the step must not become a dead end
        let home = tmp("catalog-error");
        auth::set_key(&home, "opencode-go", "sk-oc-abcdefghij", None, 1).unwrap();
        let mut o = Onboarding::for_model(home.clone());
        o.load_models(Err("could not run the agent".into()));
        assert!(o.visible_models().is_empty());
        let rendered: Vec<String> = lines(&o, &auth::load(&home)).iter().map(text).collect();
        assert!(rendered.iter().any(|l| l.contains("could not read the model list")), "{rendered:?}");
        assert!(rendered.iter().any(|l| l.contains("type a model name instead")));

        for c in "kimi-k2.6".chars() { o.on_key(ch(c), 1); }
        assert!(o.on_key(key(KeyCode::Enter), 1));
        assert_eq!(auth::load(&home).default_model_for("opencode-go").as_deref(), Some("kimi-k2.6"),
            "the typed name lands on the provider sessions actually use");
    }

    #[test]
    fn enter_with_nothing_chosen_still_means_decide_later() {
        let home = tmp("skip");
        let mut o = Onboarding::for_model(home.clone());
        o.load_models(Ok(Vec::new()));
        assert!(o.on_key(key(KeyCode::Enter), 1));
        assert_eq!(o.step, Step::Done);
        assert!(auth::load(&home).available_models().is_empty());
    }

    #[test]
    fn escape_closes_a_model_pick_but_never_a_first_run() {
        let home = tmp("escape");
        let mut o = Onboarding::for_model(home.clone());
        assert!(o.dismissable());
        assert!(o.on_key(key(KeyCode::Esc), 1));

        let mut first = Onboarding::new(home, Reason::FirstRun);
        assert!(!first.dismissable());
        assert!(!first.on_key(key(KeyCode::Esc), 1));
    }
}

#[cfg(test)]
mod pacing_tests {
    use super::*;

    fn text(l: &Line) -> String { l.spans.iter().map(|s| s.content.to_string()).collect() }

    fn tmp2(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mnemo-pace-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn nyx_is_on_screen_for_every_step_of_setup() {
        // "she is there through the WHOLE onboarding process" — not just the
        // first screen
        let home = tmp2("every-step");
        let auth = auth::load(&home);
        for step in [Step::Provider, Step::Key, Step::Model] {
            let mut o = Onboarding::new(home.clone(), Reason::FirstRun);
            o.step = step;
            let rendered: Vec<String> = lines_in(&o, &auth, 120).iter().map(text).collect();
            let joined = rendered.join("\n");
            assert!(joined.contains("▓▓") && joined.contains("▄▄"),
                "no cat on {step:?}: {joined}");
        }
    }

    #[test]
    fn she_moves_between_frames() {
        let home = tmp2("moves");
        let auth = auth::load(&home);
        let frame = |t: usize| {
            let mut o = Onboarding::new(home.clone(), Reason::Login);
            o.tick = t;
            lines_in(&o, &auth, 120).iter().map(text).collect::<Vec<_>>().join("\n")
        };
        assert_ne!(frame(0), frame(4), "the animation is not animating");
        // and the mascot is drawn at two cells per pixel, like everywhere else
        let mut o = Onboarding::new(home, Reason::Login);
        o.tick = 6;
        let cat = lines_in(&o, &auth, 120);
        let coat = cat.iter().flat_map(|l| l.spans.iter())
            .find(|s| s.style.fg == Some(brand::COAT) && s.content.contains('█'))
            .expect("a coat span");
        assert!(coat.content.contains("██"), "drawn at the wrong scale: {:?}", coat.content);
    }

    #[test]
    fn a_narrow_terminal_still_gets_a_whole_cat() {
        let home = tmp2("narrow");
        let auth = auth::load(&home);
        let mut o = Onboarding::new(home, Reason::Login);
        o.tick = 3;
        // Prose is clipped by the renderer and reads fine clipped. ART does
        // not: a cat cut in half by the right edge is a bug, so only the
        // drawn rows are held to the width.
        for cols in [30usize, 44, 80, 200] {
            let widest = lines_in(&o, &auth, cols).iter()
                .filter(|l| text(l).contains('█'))
                .map(|l| text(l).chars().count())
                .max().unwrap_or(0);
            assert!(widest <= cols, "cols={cols} drew art {widest} wide");
        }
        // she fits from 44 columns up, and is dropped below that rather than
        // being cut off by the right edge
        let has_cat = |cols: usize| lines_in(&o, &auth, cols).iter()
            .any(|l| text(l).contains("▓▓"));
        assert!(!has_cat(30));
        assert!(has_cat(80));
    }
}
