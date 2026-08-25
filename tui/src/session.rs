//! Child-process plumbing behind the `SessionStream` trait.
//!
//! `RealSession` spawns `node <repo>/agent/bin/mnemo.ts` with full env
//! passthrough (incl. OPENROUTER_API_KEY, SEA_MODEL) and reads its
//! stdout/stderr on background threads into an mpsc channel.
//! `FakeSession` is a scripted implementation for --render-once and tests.

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// One chunk of child output. Chunks may be partial lines (assistant text
/// streams without newlines), so consumers must line-buffer themselves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OutputEvent {
    Stdout(String),
    Stderr(String),
    Exit(Option<i32>),
}

pub trait SessionStream {
    /// Send one user prompt line to the child.
    fn send_prompt(&mut self, s: &str);
    /// Drain all output events that have arrived so far.
    fn poll_output(&mut self) -> Vec<OutputEvent>;
}

// ---------------------------------------------------------------------------
// FakeSession
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct FakeSession {
    queue: VecDeque<OutputEvent>,
    pub sent: Vec<String>,
}

impl FakeSession {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn push(&mut self, ev: OutputEvent) {
        self.queue.push_back(ev);
    }
}

impl SessionStream for FakeSession {
    fn send_prompt(&mut self, s: &str) {
        self.sent.push(s.to_string());
    }
    fn poll_output(&mut self) -> Vec<OutputEvent> {
        self.queue.drain(..).collect()
    }
}

// ---------------------------------------------------------------------------
// RealSession
// ---------------------------------------------------------------------------

pub struct RealSession {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    rx: Receiver<OutputEvent>,
    exit_sent: bool,
}

/// Default location of the mnemo CLI entrypoint relative to this crate.
pub fn default_script_path() -> PathBuf {
    if let Ok(p) = std::env::var("SEA_SCRIPT") {
        return PathBuf::from(p);
    }
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../agent/bin/mnemo.ts")
}

fn spawn_reader(mut r: impl Read + Send + 'static, kind: fn(String) -> OutputEvent, tx: Sender<OutputEvent>) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match r.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                    if tx.send(kind(chunk)).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
}

impl RealSession {
    pub fn spawn(script: &Path) -> std::io::Result<Self> {
        let mut cmd = Command::new("node");
        cmd.arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Full environment passthrough; call out the two vars we depend on.
        cmd.envs(std::env::vars());
        if let Ok(k) = std::env::var("OPENROUTER_API_KEY") {
            cmd.env("OPENROUTER_API_KEY", k);
        }
        if let Ok(m) = std::env::var("SEA_MODEL") {
            cmd.env("SEA_MODEL", m);
        }

        let mut child = cmd.spawn()?;
        let stdin = Arc::new(Mutex::new(child.stdin.take().expect("stdin piped")));
        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take().expect("stderr piped");
        let (tx, rx) = mpsc::channel::<OutputEvent>();
        spawn_reader(stdout, OutputEvent::Stdout, tx.clone());
        spawn_reader(stderr, OutputEvent::Stderr, tx);
        Ok(Self { child, stdin, rx, exit_sent: false })
    }

    /// Kill the child process.
    pub fn shutdown(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for RealSession {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl SessionStream for RealSession {
    fn send_prompt(&mut self, s: &str) {
        if let Ok(mut w) = self.stdin.lock() {
            let _ = w.write_all(s.as_bytes());
            let _ = w.write_all(b"\n");
            let _ = w.flush();
        }
    }

    fn poll_output(&mut self) -> Vec<OutputEvent> {
        let mut out = Vec::new();
        while let Ok(ev) = self.rx.try_recv() {
            out.push(ev);
        }
        if !self.exit_sent && self.child.try_wait().ok().flatten().is_some() {
            // Child died: flush whatever the reader threads still hold.
            let deadline = Instant::now() + Duration::from_millis(250);
            while Instant::now() < deadline {
                match self.rx.recv_timeout(Duration::from_millis(25)) {
                    Ok(ev) => out.push(ev),
                    Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => break,
                }
            }
            while let Ok(ev) = self.rx.try_recv() {
                out.push(ev);
            }
            out.push(OutputEvent::Exit(self.child.wait().ok().and_then(|s| s.code())));
            self.exit_sent = true;
        }
        out
    }
}
