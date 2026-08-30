//! 8.4/8.5 Projects and sessions.
//!
//! pi already stores sessions per project at
//! `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`, and each
//! file's first line is a header carrying the real cwd. So "projects" is not a
//! new concept to invent — it is that directory, read back.
//!
//! Subagent runs are correlated separately: the trace store records spans with
//! kind "subagent" carrying the parent session, and journal episodes label
//! themselves "subagent of #N". Both are read here so a session can show what
//! it delegated.
use std::path::{Path, PathBuf};

/// One directory under pi's session root: a folder someone has worked in.
#[derive(Debug, Clone, PartialEq)]
pub struct Project {
    /// Real filesystem path, from a session header when we could read one.
    pub path: PathBuf,
    /// pi's on-disk directory name (the encoded cwd).
    pub dir: String,
    pub sessions: usize,
    /// Most recent session start, epoch ms; 0 when unknown.
    pub last_active: u64,
}

impl Project {
    /// The name worth showing in a list: the folder, not the whole path.
    pub fn name(&self) -> String {
        self.path.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| self.dir.clone())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Session {
    pub id: String,
    pub file: PathBuf,
    pub cwd: PathBuf,
    /// Epoch ms from the session header.
    pub started: u64,
    /// Last model the session ran on, if it recorded one.
    pub provider: Option<String>,
    pub model: Option<String>,
    pub messages: usize,
    /// First user message, trimmed — what the session was actually about.
    pub title: String,
    /// Subagent runs correlated to this session (8.5).
    pub subagents: Vec<Subagent>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Subagent {
    pub session: String,
    pub label: String,
    pub ok: bool,
    pub model: Option<String>,
}

pub fn pi_session_root(home: &Path) -> PathBuf {
    home.join(".pi").join("agent").join("sessions")
}

/// pi encodes a cwd by replacing every path separator with a dash and
/// wrapping the result. Decoding is lossy, which is why the session header's
/// own `cwd` is preferred wherever one can be read.
pub fn decode_dir(dir: &str) -> PathBuf {
    PathBuf::from(dir.trim_matches('-').replace('-', "/"))
}

fn read_header(file: &Path) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(file).ok()?;
    let first = text.lines().next()?;
    serde_json::from_str(first).ok()
}

/// Every project pi has sessions for, most recently active first.
pub fn list_projects(home: &Path) -> Vec<Project> {
    let root = pi_session_root(home);
    let Ok(entries) = std::fs::read_dir(&root) else { return Vec::new() };
    let mut out: Vec<Project> = Vec::new();
    for e in entries.flatten() {
        if !e.path().is_dir() { continue; }
        let dir = e.file_name().to_string_lossy().to_string();
        let files = session_files(&e.path());
        if files.is_empty() { continue; }
        // the header knows the real path; fall back to decoding the folder name
        let path = files.iter()
            .find_map(|f| read_header(f)?.get("cwd")?.as_str().map(PathBuf::from))
            .unwrap_or_else(|| decode_dir(&dir));
        let last_active = files.iter()
            .filter_map(|f| header_time(f))
            .max()
            .unwrap_or(0);
        out.push(Project { path, dir, sessions: files.len(), last_active });
    }
    out.sort_by(|a, b| b.last_active.cmp(&a.last_active).then(a.dir.cmp(&b.dir)));
    out
}

fn session_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut files: Vec<PathBuf> = entries.flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "jsonl").unwrap_or(false))
        .collect();
    files.sort();
    files
}

fn header_time(file: &Path) -> Option<u64> {
    let v = read_header(file)?;
    parse_time(v.get("timestamp")?.as_str()?)
}

/// pi writes ISO-8601; we only need something sortable and printable.
pub fn parse_time(iso: &str) -> Option<u64> {
    // YYYY-MM-DDTHH:MM:SS(.mmm)Z -> epoch ms, without pulling in a date crate
    let (date, rest) = iso.split_once('T')?;
    let mut d = date.split('-');
    let (y, m, day) = (d.next()?.parse::<i64>().ok()?, d.next()?.parse::<i64>().ok()?, d.next()?.parse::<i64>().ok()?);
    let time = rest.trim_end_matches('Z');
    let mut t = time.split(':');
    let (hh, mm) = (t.next()?.parse::<i64>().ok()?, t.next()?.parse::<i64>().ok()?);
    let secs_part = t.next().unwrap_or("0");
    let (ss, ms) = match secs_part.split_once('.') {
        Some((s, frac)) => (s.parse::<i64>().ok()?, frac.trim_end_matches('Z').parse::<i64>().unwrap_or(0)),
        None => (secs_part.parse::<i64>().ok()?, 0),
    };
    // days since epoch via the civil-from-days algorithm
    let y_adj = if m <= 2 { y - 1 } else { y };
    let era = if y_adj >= 0 { y_adj } else { y_adj - 399 } / 400;
    let yoe = y_adj - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86_400 + hh * 3600 + mm * 60 + ss) * 1000 + ms).max(0) as u64)
}

/// Sessions for one project directory, newest first.
pub fn list_sessions(home: &Path, dir: &str) -> Vec<Session> {
    let mut out: Vec<Session> = session_files(&pi_session_root(home).join(dir))
        .iter()
        .filter_map(|f| read_session(f))
        .collect();
    out.sort_by(|a, b| b.started.cmp(&a.started));
    out
}

/// Read one session file: header, model, message count and a title.
pub fn read_session(file: &Path) -> Option<Session> {
    let text = std::fs::read_to_string(file).ok()?;
    let mut id = String::new();
    let mut cwd = PathBuf::new();
    let mut started = 0u64;
    let (mut provider, mut model) = (None, None);
    let mut messages = 0usize;
    let mut title = String::new();

    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        match v.get("type").and_then(|t| t.as_str()) {
            Some("session") => {
                id = v.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string();
                cwd = v.get("cwd").and_then(|c| c.as_str()).map(PathBuf::from).unwrap_or_default();
                started = v.get("timestamp").and_then(|t| t.as_str()).and_then(parse_time).unwrap_or(0);
            }
            // the LAST model_change is the model the session ended on
            Some("model_change") => {
                provider = v.get("provider").and_then(|p| p.as_str()).map(str::to_string);
                model = v.get("modelId").and_then(|m| m.as_str()).map(str::to_string);
            }
            Some("message") => {
                messages += 1;
                if title.is_empty() {
                    if let Some(text) = first_user_text(&v) { title = text; }
                }
            }
            _ => {}
        }
    }
    if id.is_empty() { return None; }
    Some(Session {
        id, file: file.to_path_buf(), cwd, started, provider, model, messages,
        title: if title.is_empty() { "(no prompt yet)".into() } else { title },
        subagents: Vec::new(),
    })
}

/// One message of a stored session, in the order it was written.
///
/// This mirrors what `AgentEvent` carries for a *live* run, so a resumed
/// transcript and a running one render through the same chat entries.
#[derive(Debug, Clone, PartialEq)]
pub enum Msg {
    User(String),
    Assistant(String),
    Thinking(String),
    /// `ok` is None only when the session file ends before the result arrived.
    Tool { id: String, name: String, args: String, ok: Option<bool> },
}

/// Replay a stored session file into messages.
///
/// pi writes the tool call and its result as two separate lines, so a result
/// is matched back onto its call by `toolCallId` rather than appended — a
/// resumed transcript has to read like the live one, not like a log.
pub fn transcript(file: &Path) -> Vec<Msg> {
    let Ok(text) = std::fs::read_to_string(file) else { return Vec::new() };
    let mut out: Vec<Msg> = Vec::new();
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if v.get("type").and_then(|t| t.as_str()) != Some("message") { continue }
        let Some(msg) = v.get("message") else { continue };
        match msg.get("role").and_then(|r| r.as_str()) {
            Some("user") => {
                let t = content_text(msg);
                if !t.is_empty() { out.push(Msg::User(t)); }
            }
            Some("assistant") => {
                let Some(parts) = msg.get("content").and_then(|c| c.as_array()) else { continue };
                for p in parts {
                    match p.get("type").and_then(|t| t.as_str()) {
                        Some("text") => if let Some(t) = str_at(p, "text") { out.push(Msg::Assistant(t)) },
                        Some("thinking") => if let Some(t) = str_at(p, "thinking") { out.push(Msg::Thinking(t)) },
                        Some("toolCall") => out.push(Msg::Tool {
                            id: p.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string(),
                            name: p.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string(),
                            args: p.get("arguments").map(crate::rpc::summarize_args).unwrap_or_default(),
                            ok: None,
                        }),
                        _ => {}
                    }
                }
            }
            Some("toolResult") => {
                let id = msg.get("toolCallId").and_then(|i| i.as_str()).unwrap_or("");
                let ok = !msg.get("isError").and_then(|b| b.as_bool()).unwrap_or(false);
                match out.iter_mut().rev().find(|m| matches!(m, Msg::Tool { id: i, .. } if i == id)) {
                    Some(Msg::Tool { ok: slot, .. }) => *slot = Some(ok),
                    // a result with no matching call still has to be visible
                    _ => out.push(Msg::Tool {
                        id: id.to_string(),
                        name: msg.get("toolName").and_then(|n| n.as_str()).unwrap_or("").to_string(),
                        args: String::new(),
                        ok: Some(ok),
                    }),
                }
            }
            _ => {}
        }
    }
    out
}

fn str_at(v: &serde_json::Value, key: &str) -> Option<String> {
    let s = v.get(key)?.as_str()?;
    if s.is_empty() { None } else { Some(s.to_string()) }
}

/// pi writes user content as an array of parts, but older lines used a bare
/// string; both have to read back.
fn content_text(msg: &serde_json::Value) -> String {
    match msg.get("content") {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(parts)) => parts.iter()
            .filter(|c| c.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|c| c.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

/// Every span the trace store holds for one run, oldest first.
///
/// A subagent is a separate process with its own trace session, so this is the
/// only record of what it actually did — there is no pi session we can
/// correlate it back to.
pub fn spans_for(home: &Path, session: &str) -> Vec<serde_json::Value> {
    let dir = home.join(".mnemo").join("logs");
    let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut files: Vec<PathBuf> = entries.flatten().map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "jsonl").unwrap_or(false))
        .collect();
    files.sort();
    let mut out = Vec::new();
    for f in files {
        let Ok(text) = std::fs::read_to_string(&f) else { continue };
        for line in text.lines() {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
            if v.get("session").and_then(|s| s.as_str()) == Some(session) { out.push(v); }
        }
    }
    out.sort_by_key(|v| v.get("start").and_then(|s| s.as_u64()).unwrap_or(0));
    out
}

fn first_user_text(v: &serde_json::Value) -> Option<String> {
    let msg = v.get("message")?;
    if msg.get("role")?.as_str()? != "user" { return None; }
    let text: String = msg.get("content")?.as_array()?.iter()
        .filter(|c| c.get("type").and_then(|t| t.as_str()) == Some("text"))
        .filter_map(|c| c.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join(" ");
    let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.is_empty() { return None; }
    Some(one_line.chars().take(70).collect())
}

/// Subagent runs from the trace store, grouped by the session that spawned them.
/// Traces are the only place the parent link is recorded, so a missing or
/// pruned log simply means no subagents are shown — never an error.
pub fn subagents_from_traces(home: &Path) -> Vec<(String, Subagent)> {
    let dir = home.join(".mnemo").join("logs");
    let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut files: Vec<PathBuf> = entries.flatten().map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "jsonl").unwrap_or(false))
        .collect();
    files.sort();

    let mut out = Vec::new();
    for f in files {
        let Ok(text) = std::fs::read_to_string(&f) else { continue };
        for line in text.lines() {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
            if v.get("kind").and_then(|k| k.as_str()) != Some("subagent") { continue; }
            let attrs = v.get("attrs");
            let parent = attrs.and_then(|a| a.get("parent_session")).and_then(|p| p.as_str());
            let Some(parent) = parent else { continue };
            out.push((parent.to_string(), Subagent {
                session: v.get("session").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                label: v.get("name").and_then(|n| n.as_str()).unwrap_or("subagent").to_string(),
                ok: v.get("ok").and_then(|o| o.as_bool()).unwrap_or(true),
                model: attrs.and_then(|a| a.get("model")).and_then(|m| m.as_str()).map(str::to_string),
            }));
        }
    }
    out
}

/// Attach trace-recorded subagents to the sessions that spawned them.
pub fn attach_subagents(sessions: &mut [Session], links: &[(String, Subagent)]) {
    for s in sessions.iter_mut() {
        s.subagents = links.iter()
            .filter(|(parent, _)| *parent == s.id)
            .map(|(_, sub)| sub.clone())
            .collect();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mnemo-sessions-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write_session(home: &Path, dir: &str, name: &str, lines: &[String]) -> PathBuf {
        let d = pi_session_root(home).join(dir);
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join(format!("{name}.jsonl"));
        std::fs::write(&f, lines.join("\n") + "\n").unwrap();
        f
    }

    fn header(id: &str, cwd: &str, ts: &str) -> String {
        serde_json::json!({"type":"session","version":3,"id":id,"timestamp":ts,"cwd":cwd}).to_string()
    }
    fn user_msg(text: &str) -> String {
        serde_json::json!({"type":"message","message":{"role":"user","content":[{"type":"text","text":text}]}}).to_string()
    }

    #[test]
    fn iso_timestamps_parse_to_something_sortable() {
        let a = parse_time("2026-08-25T13:06:47.745Z").unwrap();
        let b = parse_time("2026-08-25T13:08:47.914Z").unwrap();
        assert!(b > a);
        // a known epoch, so the civil-days maths is actually checked
        assert_eq!(parse_time("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(parse_time("2000-01-01T00:00:00Z"), Some(946_684_800_000));
        assert_eq!(parse_time("not a date"), None);
    }

    #[test]
    fn projects_come_from_pi_session_directories_newest_first() {
        let home = tmp("projects");
        write_session(&home, "--Users-me-old--", "a",
            &[header("s1", "/Users/me/old", "2026-01-01T00:00:00.000Z")]);
        write_session(&home, "--Users-me-new--", "b",
            &[header("s2", "/Users/me/new", "2026-08-01T00:00:00.000Z")]);
        write_session(&home, "--Users-me-new--", "c",
            &[header("s3", "/Users/me/new", "2026-08-02T00:00:00.000Z")]);

        let projects = list_projects(&home);
        assert_eq!(projects.len(), 2);
        assert_eq!(projects[0].path, PathBuf::from("/Users/me/new"), "most recent first");
        assert_eq!(projects[0].sessions, 2);
        assert_eq!(projects[0].name(), "new", "the list shows the folder, not the full path");
        assert_eq!(projects[1].name(), "old");
    }

    #[test]
    fn the_real_cwd_comes_from_the_header_not_the_folder_name() {
        // decoding the folder name is lossy: a project with a dash in its path
        // would decode wrong, so the header wins whenever there is one
        let home = tmp("cwd");
        write_session(&home, "--Users-me-my-app--", "a",
            &[header("s1", "/Users/me/my-app", "2026-01-01T00:00:00.000Z")]);
        let projects = list_projects(&home);
        assert_eq!(projects[0].path, PathBuf::from("/Users/me/my-app"));
        assert_ne!(decode_dir("--Users-me-my-app--"), PathBuf::from("/Users/me/my-app"),
            "this is exactly the case the header rescues");
    }

    #[test]
    fn an_empty_or_missing_session_root_is_no_projects() {
        let home = tmp("none");
        assert!(list_projects(&home).is_empty());
        std::fs::create_dir_all(pi_session_root(&home).join("--empty--")).unwrap();
        assert!(list_projects(&home).is_empty(), "a directory with no sessions is not a project");
    }

    #[test]
    fn a_session_reports_its_model_title_and_message_count() {
        let home = tmp("session");
        let f = write_session(&home, "--p--", "s", &[
            header("abc", "/p", "2026-08-25T13:06:47.745Z"),
            serde_json::json!({"type":"model_change","provider":"opencode-go","modelId":"ox-alpha-free"}).to_string(),
            user_msg("  fix   the build  "),
            serde_json::json!({"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}).to_string(),
            serde_json::json!({"type":"model_change","provider":"anthropic","modelId":"claude-opus-5"}).to_string(),
        ]);
        let s = read_session(&f).unwrap();
        assert_eq!(s.id, "abc");
        assert_eq!(s.cwd, PathBuf::from("/p"));
        assert_eq!(s.messages, 2);
        assert_eq!(s.title, "fix the build", "whitespace is collapsed for the list");
        assert_eq!(s.model.as_deref(), Some("claude-opus-5"),
            "the LAST model change is the model the session ended on");
        assert_eq!(s.provider.as_deref(), Some("anthropic"));
    }

    #[test]
    fn a_session_with_no_prompt_yet_still_lists() {
        let home = tmp("empty-session");
        let f = write_session(&home, "--p--", "s", &[header("abc", "/p", "2026-08-25T13:06:47.745Z")]);
        let s = read_session(&f).unwrap();
        assert_eq!(s.title, "(no prompt yet)");
        assert_eq!(s.messages, 0);
        // a file with no header is not a session at all
        let bad = write_session(&home, "--p--", "junk", &["not json".into()]);
        assert!(read_session(&bad).is_none());
    }

    #[test]
    fn sessions_list_newest_first_within_a_project() {
        let home = tmp("order");
        write_session(&home, "--p--", "a", &[header("old", "/p", "2026-01-01T00:00:00.000Z"), user_msg("first")]);
        write_session(&home, "--p--", "b", &[header("new", "/p", "2026-08-01T00:00:00.000Z"), user_msg("second")]);
        let sessions = list_sessions(&home, "--p--");
        assert_eq!(sessions.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["new", "old"]);
    }

    #[test]
    fn subagents_attach_to_the_session_that_spawned_them() {
        let home = tmp("subagents");
        let logs = home.join(".mnemo").join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(logs.join("2026-08-30.jsonl"), [
            serde_json::json!({"kind":"subagent","name":"subagent run","session":"child-1","ok":true,
                "attrs":{"parent_session":"parent-1","model":"claude-opus-5"}}).to_string(),
            serde_json::json!({"kind":"subagent","name":"subagent run","session":"child-2","ok":false,
                "attrs":{"parent_session":"parent-1"}}).to_string(),
            serde_json::json!({"kind":"subagent","name":"subagent run","session":"child-3","ok":true,
                "attrs":{"parent_session":"other"}}).to_string(),
            // a plain tool span is not a subagent
            serde_json::json!({"kind":"tool","name":"bash_exec","session":"parent-1","attrs":{}}).to_string(),
        ].join("\n")).unwrap();

        let links = subagents_from_traces(&home);
        assert_eq!(links.len(), 3);

        let mut sessions = vec![Session {
            id: "parent-1".into(), file: PathBuf::new(), cwd: PathBuf::new(), started: 0,
            provider: None, model: None, messages: 0, title: "t".into(), subagents: vec![],
        }];
        attach_subagents(&mut sessions, &links);
        assert_eq!(sessions[0].subagents.len(), 2, "only this session's children");
        assert_eq!(sessions[0].subagents[0].model.as_deref(), Some("claude-opus-5"),
            "a child running on a different model shows which one");
        assert!(!sessions[0].subagents[1].ok, "a failed child reads as failed");
    }

    fn assistant(parts: serde_json::Value) -> String {
        serde_json::json!({"type":"message","message":{"role":"assistant","content":parts}}).to_string()
    }
    fn tool_result(id: &str, is_error: bool) -> String {
        serde_json::json!({"type":"message","message":{"role":"toolResult","toolCallId":id,
            "toolName":"bash_exec","isError":is_error,
            "content":[{"type":"text","text":"out"}]}}).to_string()
    }

    #[test]
    fn a_stored_session_replays_into_messages_in_order() {
        let home = tmp("transcript");
        let f = write_session(&home, "--p--", "s", &[
            header("abc", "/p", "2026-08-25T13:06:47.745Z"),
            user_msg("fix the build"),
            assistant(serde_json::json!([
                {"type":"thinking","thinking":"let me look"},
                {"type":"text","text":"Running the build."},
                {"type":"toolCall","id":"call_1","name":"bash_exec","arguments":{"command":"make"}},
            ])),
            tool_result("call_1", false),
            assistant(serde_json::json!([{"type":"text","text":"Fixed."}])),
        ]);
        let t = transcript(&f);
        assert_eq!(t, vec![
            Msg::User("fix the build".into()),
            Msg::Thinking("let me look".into()),
            Msg::Assistant("Running the build.".into()),
            Msg::Tool { id: "call_1".into(), name: "bash_exec".into(),
                        args: "command=make".into(), ok: Some(true) },
            Msg::Assistant("Fixed.".into()),
        ]);
    }

    #[test]
    fn a_tool_result_lands_on_its_own_call_not_the_last_one() {
        // two calls in flight: matching by position would mark the wrong one
        let home = tmp("tool-match");
        let f = write_session(&home, "--p--", "s", &[
            header("abc", "/p", "2026-08-25T13:06:47.745Z"),
            assistant(serde_json::json!([
                {"type":"toolCall","id":"a","name":"read_file","arguments":{"path":"x"}},
                {"type":"toolCall","id":"b","name":"bash_exec","arguments":{"command":"y"}},
            ])),
            tool_result("b", true),
        ]);
        let t = transcript(&f);
        assert_eq!(t[0], Msg::Tool { id: "a".into(), name: "read_file".into(),
                                     args: "path=x".into(), ok: None },
            "the call with no result yet stays unresolved");
        assert!(matches!(&t[1], Msg::Tool { id, ok: Some(false), .. } if id == "b"),
            "the failure lands on b, got {:?}", t[1]);
    }

    #[test]
    fn an_unreadable_or_empty_session_replays_as_nothing() {
        let home = tmp("no-transcript");
        assert!(transcript(&home.join("nope.jsonl")).is_empty());
        let f = write_session(&home, "--p--", "s",
            &[header("abc", "/p", "2026-08-25T13:06:47.745Z")]);
        assert!(transcript(&f).is_empty());
    }

    #[test]
    fn spans_of_one_run_come_back_oldest_first() {
        let home = tmp("spans");
        let logs = home.join(".mnemo").join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(logs.join("2026-08-30.jsonl"), [
            serde_json::json!({"kind":"llm","name":"model round trip","session":"child-1","start":200}).to_string(),
            serde_json::json!({"kind":"session","name":"session","session":"child-1","start":100}).to_string(),
            serde_json::json!({"kind":"tool","name":"bash_exec","session":"other","start":150}).to_string(),
        ].join("\n")).unwrap();

        let spans = spans_for(&home, "child-1");
        assert_eq!(spans.len(), 2, "only this run's spans");
        assert_eq!(spans[0].get("start").unwrap().as_u64(), Some(100), "oldest first");
        assert!(spans_for(&home, "nobody").is_empty());
    }

    #[test]
    fn a_missing_trace_store_just_means_no_subagents() {
        let home = tmp("no-traces");
        assert!(subagents_from_traces(&home).is_empty());
    }
}
