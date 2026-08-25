//! Application state: transcript, activity strip, input editor, status model.

use crate::parser::{parse_banner, parse_tool_line, split_lines, ToolEvent};
use crate::session::OutputEvent;
use std::collections::VecDeque;
use std::time::Duration;
use std::time::Instant;

pub const THINKING_QUIET_MS: u64 = 1500;
pub const SPINNER_INTERVAL_MS: u64 = 80;
pub const ACTIVITY_CAP: usize = 12;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Speaker {
    User,
    Agent,
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentState {
    Starting,
    Idle,
    Thinking,
}

#[derive(Debug, Clone)]
pub struct Entry {
    pub speaker: Speaker,
    pub text: String,
}

pub struct App {
    pub chat: Vec<Entry>,
    pub activity: VecDeque<ToolEvent>,
    pub input: String,
    /// Cursor position as a char index into `input`.
    pub cursor: usize,
    pub history: Vec<String>,
    /// Position while browsing history; == history.len() means not browsing.
    pub hist_pos: usize,
    draft: String,
    /// Lines the chat view is scrolled up from the bottom (when !autoscroll).
    pub scroll_up: u16,
    pub autoscroll: bool,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub state: AgentState,
    pub exited: bool,
    pub show_help: bool,
    pub show_cmds: bool,
    last_output: Option<Instant>,
    expecting_reply: bool,
    stderr_buf: String,
    start: Instant,
}

impl Default for App {
    fn default() -> Self {
        Self::new()
    }
}

impl App {
    pub fn new() -> Self {
        App {
            chat: Vec::new(),
            activity: VecDeque::new(),
            input: String::new(),
            cursor: 0,
            history: Vec::new(),
            hist_pos: 0,
            draft: String::new(),
            scroll_up: 0,
            autoscroll: true,
            provider: None,
            model: None,
            state: AgentState::Starting,
            exited: false,
            show_help: false,
            show_cmds: false,
            last_output: None,
            expecting_reply: false,
            stderr_buf: String::new(),
            start: Instant::now(),
        }
    }

    // -- transcript ---------------------------------------------------------

    /// Record a user prompt being sent and enter THINKING.
    pub fn on_send(&mut self, prompt: &str) {
        self.chat.push(Entry { speaker: Speaker::User, text: prompt.to_string() });
        self.autoscroll = true;
        self.scroll_up = 0;
        self.expecting_reply = true;
        self.state = AgentState::Thinking;
        self.last_output = Some(Instant::now());
    }

    pub fn push_system(&mut self, text: &str) {
        self.chat.push(Entry { speaker: Speaker::System, text: text.to_string() });
    }

    // -- child output -------------------------------------------------------

    pub fn on_output(&mut self, ev: &OutputEvent) {
        match ev {
            OutputEvent::Stdout(data) => {
                self.last_output = Some(Instant::now());
                let mut data = data.as_str();
                if self.expecting_reply {
                    // The REPL writes a "> " question prompt to stdout before
                    // each answer; strip it from the first chunk.
                    if let Some(rest) = data.strip_prefix("> ") {
                        data = rest;
                    } else if data == ">" {
                        return; // prompt split across chunks: wait for more
                    } else if let Some(rest) = data.strip_prefix('>') {
                        data = rest.strip_prefix(' ').unwrap_or(rest);
                    }
                    self.expecting_reply = false;
                    self.chat.push(Entry { speaker: Speaker::Agent, text: data.to_string() });
                    return;
                }
                match self.chat.last_mut() {
                    Some(e) if e.speaker == Speaker::Agent => e.text.push_str(data),
                    _ => self.chat.push(Entry { speaker: Speaker::Agent, text: data.to_string() }),
                }
            }
            OutputEvent::Stderr(chunk) => {
                self.last_output = Some(Instant::now());
                self.stderr_buf.push_str(chunk);
                for line in split_lines(&mut self.stderr_buf) {
                    if line.is_empty() {
                        continue;
                    }
                    if let Some(b) = parse_banner(&line) {
                        self.provider = Some(b.provider);
                        self.model = Some(b.model);
                        if self.state == AgentState::Starting && !self.exited {
                            self.state = AgentState::Idle;
                        }
                    } else if let Some(t) = parse_tool_line(&line) {
                        self.activity.push_front(t);
                        while self.activity.len() > ACTIVITY_CAP {
                            self.activity.pop_back();
                        }
                    }
                }
            }
            OutputEvent::Exit(_) => {
                self.exited = true;
                self.state = AgentState::Idle;
                self.expecting_reply = false;
            }
        }
    }

    /// Periodic tick: spinner advance + THINKING->IDLE quiet-time heuristic.
    pub fn on_tick(&mut self, now: Instant) {
        if let Some(t) = self.last_output {
            if self.state == AgentState::Thinking
                && now.duration_since(t) >= Duration::from_millis(THINKING_QUIET_MS)
            {
                self.state = AgentState::Idle;
            }
        }
    }

    pub fn spinner_frame(&self, now: Instant) -> &'static str {
        let idx = (now.duration_since(self.start).as_millis()
            / SPINNER_INTERVAL_MS as u128) as usize
            % crate::theme::SPINNER.len();
        crate::theme::SPINNER[idx]
    }

    // -- restart ------------------------------------------------------------

    pub fn on_restart(&mut self) {
        self.exited = false;
        self.provider = None;
        self.model = None;
        self.state = AgentState::Starting;
        self.expecting_reply = false;
        self.last_output = None;
    }

    pub fn clear_chat(&mut self) {
        self.chat.clear();
        self.scroll_up = 0;
        self.autoscroll = true;
    }

    // -- input editing ------------------------------------------------------

    fn byte_pos(&self) -> usize {
        self.input
            .char_indices()
            .nth(self.cursor)
            .map(|(i, _)| i)
            .unwrap_or(self.input.len())
    }

    pub fn insert_char(&mut self, c: char) {
        let b = self.byte_pos();
        self.input.insert(b, c);
        self.cursor += 1;
        self.hist_pos = self.history.len();
    }

    pub fn backspace(&mut self) {
        if self.cursor > 0 {
            let b = self.byte_pos();
            let prev = self.input[..b]
                .char_indices()
                .next_back()
                .map(|(i, _)| i)
                .unwrap_or(0);
            self.input.replace_range(prev..b, "");
            self.cursor -= 1;
        }
    }

    pub fn delete(&mut self) {
        let b = self.byte_pos();
        if b < self.input.len() {
            let next = self.input[b..]
                .char_indices()
                .nth(1)
                .map(|(i, _)| b + i)
                .unwrap_or(self.input.len());
            self.input.replace_range(b..next, "");
        }
    }

    pub fn cursor_left(&mut self) {
        self.cursor = self.cursor.saturating_sub(1);
    }

    pub fn cursor_right(&mut self) {
        let max = self.input.chars().count();
        self.cursor = (self.cursor + 1).min(max);
    }

    /// Take the current input for submission (clears the editor).
    pub fn take_input(&mut self) -> Option<String> {
        let text = self.input.trim().to_string();
        self.input.clear();
        self.cursor = 0;
        self.hist_pos = self.history.len();
        if text.is_empty() {
            None
        } else {
            self.history.push(text.clone());
            self.hist_pos = self.history.len();
            Some(text)
        }
    }

    pub fn history_prev(&mut self) -> bool {
        if self.history.is_empty() || self.hist_pos == 0 {
            return false;
        }
        if self.hist_pos == self.history.len() {
            self.draft = self.input.clone();
        }
        self.hist_pos -= 1;
        self.input = self.history[self.hist_pos].clone();
        self.cursor = self.input.chars().count();
        true
    }

    pub fn history_next(&mut self) -> bool {
        if self.hist_pos >= self.history.len() {
            return false;
        }
        self.hist_pos += 1;
        self.input = if self.hist_pos == self.history.len() {
            self.draft.clone()
        } else {
            self.history[self.hist_pos].clone()
        };
        self.cursor = self.input.chars().count();
        true
    }

    // -- scrolling ----------------------------------------------------------

    pub fn scroll_chat_up(&mut self, lines: u16) {
        self.autoscroll = false;
        self.scroll_up = self.scroll_up.saturating_add(lines);
    }

    /// Scroll down; re-enables auto-scroll when reaching the bottom.
    pub fn scroll_chat_down(&mut self, lines: u16, total_lines: usize, visible: usize) {
        if self.scroll_up <= lines {
            self.scroll_up = 0;
            self.autoscroll = true;
        } else {
            self.scroll_up -= lines;
        }
        let max_scroll = total_lines.saturating_sub(visible);
        if self.scroll_up as usize >= max_scroll {
            self.scroll_up = max_scroll.min(u16::MAX as usize) as u16;
            self.autoscroll = true;
        }
    }
}
