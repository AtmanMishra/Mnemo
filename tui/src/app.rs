//! Application state for the inline REPL: input editor, history, transcript
//! store, streaming buffers, overlays, approval gate.

use crate::commands;
use crate::parser::{parse_banner, parse_tool_line, split_lines, ToolEvent};
use crate::session::OutputEvent;
use std::path::PathBuf;
use std::time::{Duration, Instant};

pub const THINKING_QUIET_MS: u64 = 1500;

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

/// A mutating command awaiting y/n approval.
#[derive(Debug, Clone)]
pub struct PendingConfirm {
    pub label: String,
    pub action: commands::Action,
}

pub struct App {
    pub input: String,
    /// Cursor position as a char index into `input`.
    pub cursor: usize,
    pub history: Vec<String>,
    /// Position while browsing history; == history.len() means not browsing.
    pub hist_pos: usize,
    draft: String,

    pub provider: Option<String>,
    pub model: Option<String>,
    pub state: AgentState,
    pub exited: bool,

    pub show_help: bool,
    pub confirm: Option<PendingConfirm>,

    /// Full logical transcript (for /context estimate + session save/load).
    pub transcript: Vec<(Speaker, String)>,
    pub session_file: Option<PathBuf>,
    /// Unflushed tail of the streaming assistant message.
    pub stream_buf: String,
    pub model_announced: bool,

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
            input: String::new(),
            cursor: 0,
            history: Vec::new(),
            hist_pos: 0,
            draft: String::new(),
            provider: None,
            model: None,
            state: AgentState::Starting,
            exited: false,
            show_help: false,
            confirm: None,
            transcript: Vec::new(),
            session_file: None,
            stream_buf: String::new(),
            model_announced: false,
            last_output: None,
            expecting_reply: false,
            stderr_buf: String::new(),
            start: Instant::now(),
        }
    }

    // -- transcript ---------------------------------------------------------

    pub fn record(&mut self, speaker: Speaker, text: &str) {
        self.transcript.push((speaker, text.to_string()));
    }

    pub fn clear_transcript(&mut self) {
        self.transcript.clear();
        self.stream_buf.clear();
    }

    pub fn context_tokens(&self) -> u64 {
        let chars: usize = self.transcript.iter().map(|(_, c)| c.len()).sum();
        (chars as u64).div_ceil(4)
    }

    // -- send / receive -----------------------------------------------------

    pub fn on_send(&mut self, prompt: &str) {
        self.record(Speaker::User, prompt);
        self.expecting_reply = true;
        self.state = AgentState::Thinking;
        self.last_output = Some(Instant::now());
    }

    pub fn on_output(&mut self, ev: &OutputEvent) -> Vec<ToolEvent> {
        let mut tool_events = Vec::new();
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
                        return tool_events; // wait for the rest of the prompt
                    } else if let Some(rest) = data.strip_prefix('>') {
                        data = rest.strip_prefix(' ').unwrap_or(rest);
                    }
                    self.expecting_reply = false;
                    self.transcript.push((Speaker::Agent, String::new()));
                }
                match self.transcript.last_mut() {
                    Some((Speaker::Agent, text)) => text.push_str(data),
                    _ => self.transcript.push((Speaker::Agent, data.to_string())),
                }
                self.stream_buf.push_str(data);
            }
            OutputEvent::Stderr(chunk) => {
                self.last_output = Some(Instant::now());
                self.stderr_buf.push_str(chunk);
                for line in split_lines(&mut self.stderr_buf) {
                    if line.is_empty() {
                        continue;
                    }
                    if let Some(b) = parse_banner(&line) {
                        if !self.model_announced {
                            self.provider = Some(b.provider);
                            self.model = Some(b.model);
                            self.model_announced = true;
                            if !self.exited && self.state == AgentState::Starting {
                                self.state = AgentState::Idle;
                            }
                        }
                    } else if let Some(t) = parse_tool_line(&line) {
                        tool_events.push(t);
                    }
                }
            }
            OutputEvent::Exit(_) => {
                self.exited = true;
                self.state = AgentState::Idle;
                self.expecting_reply = false;
            }
        }
        tool_events
    }

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
            / crate::theme::SPINNER_INTERVAL_MS as u128) as usize
            % crate::theme::SPINNER.len();
        crate::theme::SPINNER[idx]
    }

    pub fn restart_reset(&mut self) {
        self.exited = false;
        self.provider = None;
        self.model = None;
        self.model_announced = false;
        self.state = AgentState::Starting;
        self.expecting_reply = false;
        self.stream_buf.clear();
        self.last_output = None;
    }

    /// Flush any complete lines from the streaming assistant buffer.
    /// Returns the completed raw lines; keeps the partial tail buffered.
    pub fn drain_stream_lines(&mut self) -> Vec<String> {
        let mut out = Vec::new();
        while let Some(pos) = self.stream_buf.find('\n') {
            let line: String = self.stream_buf.drain(..=pos).collect();
            out.push(line.trim_end_matches(['\n', '\r']).to_string());
        }
        out
    }

    /// Final flush when the message completes (no trailing newline case).
    pub fn flush_stream_tail(&mut self) -> Option<String> {
        if self.stream_buf.is_empty() || self.expecting_reply {
            return None;
        }
        Some(std::mem::take(&mut self.stream_buf))
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

    pub fn take_input(&mut self) -> Option<String> {
        let text = self.input.trim().to_string();
        self.input.clear();
        self.cursor = 0;
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

    // -- palette ------------------------------------------------------------

    pub fn palette_matches(&self) -> Vec<&'static crate::commands::Command> {
        commands::match_commands(&self.input)
    }

    /// TAB: complete to the first palette match (+ trailing space).
    pub fn tab_complete(&mut self) -> bool {
        let matches = self.palette_matches();
        if let Some(first) = matches.first() {
            let completed = format!("{} ", first.name);
            self.input = completed;
            self.cursor = self.input.chars().count();
            true
        } else {
            false
        }
    }
}
