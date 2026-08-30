//! 2.1 RPC backbone: drive the agent through pi's JSONL RPC mode instead of
//! scraping a REPL. We spawn `node agent/bin/mnemo.ts --mode rpc`, write
//! `RpcCommand` lines to stdin and read events from stdout.
//!
//! `parse_event` is pure so the whole protocol layer is testable from recorded
//! lines — no child process, no API key, no network.
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};

/// What the cockpit actually needs out of pi's event stream.
#[derive(Debug, Clone, PartialEq)]
pub enum AgentEvent {
    /// A run started.
    Started,
    /// Assistant text: a streaming delta, or the authoritative final message.
    Text { text: String, final_: bool },
    /// Reasoning/thinking text.
    Thinking(String),
    ToolStart { id: String, name: String, args: String },
    ToolEnd { id: String, name: String, ok: bool },
    /// End of a model round trip: what it cost.
    TurnEnd(TurnStats),
    /// Agent is idle again — safe to prompt.
    Settled,
    /// Protocol/command error, or a failed run.
    Error(String),
    Exit(Option<i32>),
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct TurnStats {
    pub provider: String,
    pub model: String,
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub cost: f64,
    pub stop_reason: String,
}

fn s(v: &Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

/// Concatenate the text parts of a pi message's content array.
fn message_text(msg: &Value) -> String {
    msg.get("content").and_then(|c| c.as_array()).map(|parts| {
        parts.iter()
            .filter(|p| p.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("")
    }).unwrap_or_default()
}

/// One JSONL line -> at most one cockpit event. Unknown event types are
/// ignored on purpose: pi adds events between versions and an unknown one is
/// not an error.
pub fn parse_event(v: &Value) -> Option<AgentEvent> {
    match v.get("type").and_then(|t| t.as_str())? {
        "agent_start" => Some(AgentEvent::Started),
        "agent_settled" => Some(AgentEvent::Settled),

        // command acknowledgement: only interesting when it failed
        "response" => match v.get("success").and_then(|b| b.as_bool()) {
            Some(false) => Some(AgentEvent::Error(match v.get("error") {
                Some(Value::String(e)) => e.clone(),
                Some(other) => other.to_string(),
                None => format!("{} failed", s(v, "command")),
            })),
            _ => None,
        },

        // streaming deltas. pi names these per content type; accept the ones
        // that carry text and ignore the rest.
        "message_update" => {
            let ev = v.get("assistantMessageEvent")?;
            let kind = ev.get("type").and_then(|t| t.as_str()).unwrap_or("");
            let delta = ev.get("delta").and_then(|d| d.as_str())
                .or_else(|| ev.get("text").and_then(|d| d.as_str()))
                .or_else(|| ev.get("thinking").and_then(|d| d.as_str()))
                .unwrap_or("");
            if delta.is_empty() { return None; }
            match kind {
                k if k.contains("thinking") || k.contains("reasoning") =>
                    Some(AgentEvent::Thinking(delta.to_string())),
                k if k.contains("text") => Some(AgentEvent::Text {
                    text: delta.to_string(), final_: false,
                }),
                _ => None,
            }
        }

        // authoritative assistant message
        "message_end" => {
            let msg = v.get("message")?;
            if s(msg, "role") != "assistant" { return None; }
            let text = message_text(msg);
            if text.is_empty() { return None; }
            Some(AgentEvent::Text { text, final_: true })
        }

        "turn_end" => {
            let msg = v.get("message")?;
            let usage = msg.get("usage");
            Some(AgentEvent::TurnEnd(TurnStats {
                provider: s(msg, "provider"),
                model: s(msg, "model"),
                tokens_in: usage.and_then(|u| u.get("input")).and_then(|x| x.as_u64()).unwrap_or(0),
                tokens_out: usage.and_then(|u| u.get("output")).and_then(|x| x.as_u64()).unwrap_or(0),
                cost: usage.and_then(|u| u.get("cost")).and_then(|c| c.get("total"))
                    .and_then(|x| x.as_f64()).unwrap_or(0.0),
                stop_reason: s(msg, "stopReason"),
            }))
        }

        "tool_execution_start" => Some(AgentEvent::ToolStart {
            id: s(v, "toolCallId"),
            name: s(v, "toolName"),
            args: v.get("args").map(summarize_args).unwrap_or_default(),
        }),
        "tool_execution_end" => Some(AgentEvent::ToolEnd {
            id: s(v, "toolCallId"),
            name: s(v, "toolName"),
            ok: !v.get("isError").and_then(|b| b.as_bool()).unwrap_or(false),
        }),
        _ => None,
    }
}

/// One-line rendering of tool arguments for a tool card.
fn summarize_args(args: &Value) -> String {
    match args {
        Value::Object(map) => map.iter()
            .map(|(k, v)| {
                let val = match v {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                let val: String = val.chars().take(60).collect();
                format!("{k}={}", val.replace('\n', " "))
            })
            .collect::<Vec<_>>()
            .join(" "),
        other => other.to_string(),
    }
}

/// A live agent process in RPC mode.
pub struct RpcSession {
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<AgentEvent>,
    next_id: u64,
}

impl RpcSession {
    /// Spawn `node <repo>/agent/bin/mnemo.ts --mode rpc`.
    pub fn spawn(repo_root: &Path) -> std::io::Result<Self> {
        let entry = repo_root.join("agent").join("bin").join("mnemo.ts");
        Self::spawn_command(
            Command::new("node")
                .arg(&entry)
                .args(["--mode", "rpc", "--no-builtin-tools"])
                .current_dir(repo_root),
        )
    }

    /// Spawn an arbitrary command speaking the same protocol (tests use a fake).
    pub fn spawn_command(cmd: &mut Command) -> std::io::Result<Self> {
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let (tx, rx): (Sender<AgentEvent>, Receiver<AgentEvent>) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() { continue; }
                match serde_json::from_str::<Value>(&line) {
                    Ok(v) => { if let Some(ev) = parse_event(&v) { if tx.send(ev).is_err() { break; } } }
                    // a non-JSON line is stray output, not a protocol failure
                    Err(_) => continue,
                }
            }
            let _ = tx.send(AgentEvent::Exit(None));
        });
        Ok(Self { child, stdin, rx, next_id: 1 })
    }

    fn send(&mut self, mut cmd: Value) -> std::io::Result<()> {
        let id = self.next_id;
        self.next_id += 1;
        cmd["id"] = Value::String(id.to_string());
        writeln!(self.stdin, "{cmd}")?;
        self.stdin.flush()
    }

    pub fn prompt(&mut self, message: &str) -> std::io::Result<()> {
        self.send(serde_json::json!({ "type": "prompt", "message": message }))
    }
    /// Interrupt a running turn with new instructions.
    pub fn steer(&mut self, message: &str) -> std::io::Result<()> {
        self.send(serde_json::json!({ "type": "steer", "message": message }))
    }
    pub fn abort(&mut self) -> std::io::Result<()> {
        self.send(serde_json::json!({ "type": "abort" }))
    }

    /// Every event that has arrived so far. Never blocks.
    pub fn poll(&mut self) -> Vec<AgentEvent> {
        self.rx.try_iter().collect()
    }

    pub fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for RpcSession {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ev(v: serde_json::Value) -> Option<AgentEvent> { parse_event(&v) }

    #[test]
    fn lifecycle_events_map_to_cockpit_states() {
        assert_eq!(ev(json!({"type": "agent_start"})), Some(AgentEvent::Started));
        assert_eq!(ev(json!({"type": "agent_settled"})), Some(AgentEvent::Settled));
        // unknown event types are ignored, not errors — pi adds events over time
        assert_eq!(ev(json!({"type": "queue_update", "queued": 2})), None);
        assert_eq!(ev(json!({"nope": 1})), None);
    }

    #[test]
    fn only_failed_command_responses_surface() {
        assert_eq!(ev(json!({"id": "1", "type": "response", "command": "prompt", "success": true})), None);
        assert_eq!(
            ev(json!({"id": "1", "type": "response", "command": "prompt", "success": false, "error": "busy"})),
            Some(AgentEvent::Error("busy".into())),
        );
        // failure without an error string still reports something usable
        assert!(matches!(
            ev(json!({"type": "response", "command": "abort", "success": false})),
            Some(AgentEvent::Error(e)) if e.contains("abort"),
        ));
    }

    #[test]
    fn streaming_deltas_split_text_from_thinking() {
        assert_eq!(
            ev(json!({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "hel"}})),
            Some(AgentEvent::Text { text: "hel".into(), final_: false }),
        );
        assert_eq!(
            ev(json!({"type": "message_update", "assistantMessageEvent": {"type": "thinking_delta", "thinking": "hmm"}})),
            Some(AgentEvent::Thinking("hmm".into())),
        );
        // empty deltas and non-text events produce nothing to render
        assert_eq!(ev(json!({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": ""}})), None);
        assert_eq!(ev(json!({"type": "message_update", "assistantMessageEvent": {"type": "toolcall_start", "id": "t1"}})), None);
    }

    #[test]
    fn message_end_yields_the_authoritative_assistant_text() {
        let e = ev(json!({"type": "message_end", "message": {"role": "assistant",
            "content": [{"type": "text", "text": "po"}, {"type": "thinking", "thinking": "x"},
                        {"type": "text", "text": "ng"}]}}));
        assert_eq!(e, Some(AgentEvent::Text { text: "pong".into(), final_: true }));
        // the user echo must not be rendered as an assistant reply
        assert_eq!(ev(json!({"type": "message_end", "message": {"role": "user",
            "content": [{"type": "text", "text": "hi"}]}})), None);
    }

    #[test]
    fn turn_end_carries_the_cost_of_the_round_trip() {
        // shape recorded from a live `mnemo --mode rpc` run
        let e = ev(json!({"type": "turn_end", "message": {"role": "assistant", "content": [],
            "provider": "opencode-go", "model": "ox-alpha-free",
            "usage": {"input": 12, "output": 3, "cost": {"total": 0.0}},
            "stopReason": "error"}}));
        let Some(AgentEvent::TurnEnd(st)) = e else { panic!("expected TurnEnd, got {e:?}") };
        assert_eq!((st.provider.as_str(), st.model.as_str()), ("opencode-go", "ox-alpha-free"));
        assert_eq!((st.tokens_in, st.tokens_out), (12, 3));
        assert_eq!(st.stop_reason, "error");
    }

    #[test]
    fn tool_events_carry_name_args_and_outcome() {
        assert_eq!(
            ev(json!({"type": "tool_execution_start", "toolCallId": "t1", "toolName": "bash_exec",
                      "args": {"cmd": "ls -la", "cwd": "/tmp"}})),
            Some(AgentEvent::ToolStart { id: "t1".into(), name: "bash_exec".into(),
                                         args: "cmd=ls -la cwd=/tmp".into() }),
        );
        assert_eq!(
            ev(json!({"type": "tool_execution_end", "toolCallId": "t1", "toolName": "bash_exec",
                      "result": "...", "isError": true})),
            Some(AgentEvent::ToolEnd { id: "t1".into(), name: "bash_exec".into(), ok: false }),
        );
        // missing isError means it worked
        assert!(matches!(
            ev(json!({"type": "tool_execution_end", "toolCallId": "t", "toolName": "x", "result": 1})),
            Some(AgentEvent::ToolEnd { ok: true, .. }),
        ));
    }

    #[test]
    fn long_and_multiline_tool_args_stay_one_line() {
        let out = summarize_args(&json!({"content": format!("a\nb{}", "c".repeat(200))}));
        assert!(!out.contains('\n'));
        assert!(out.chars().count() < 80, "args summary must stay short: {out}");
    }

    /// Drives a real child process over the real protocol — no LLM involved.
    #[test]
    fn session_reads_events_from_a_child_process() {
        let script = r#"
import sys, json
for line in sys.stdin:
    cmd = json.loads(line)
    assert cmd.get("id"), "every command must be correlated by id"
    print(json.dumps({"id": cmd["id"], "type": "response", "command": cmd["type"], "success": True}), flush=True)
    if cmd["type"] == "prompt":
        print(json.dumps({"type": "agent_start"}), flush=True)
        print("this is not json and must be ignored", flush=True)
        print(json.dumps({"type": "message_end", "message": {"role": "assistant",
              "content": [{"type": "text", "text": "echo: " + cmd["message"]}]}}), flush=True)
        print(json.dumps({"type": "agent_settled"}), flush=True)
"#;
        let mut cmd = Command::new("python3");
        cmd.arg("-c").arg(script);
        let mut sess = RpcSession::spawn_command(&mut cmd).expect("spawn fake agent");
        sess.prompt("hi").unwrap();

        let mut got = Vec::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            got.extend(sess.poll());
            if got.contains(&AgentEvent::Settled) { break; }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(got.first(), Some(&AgentEvent::Started), "got {got:?}");
        assert!(got.contains(&AgentEvent::Text { text: "echo: hi".into(), final_: true }), "got {got:?}");
        assert!(got.contains(&AgentEvent::Settled), "got {got:?}");
        sess.stop();
    }
}
