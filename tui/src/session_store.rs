//! Session persistence: ~/.sea/sessions/<timestamp>.jsonl, role/content JSONL.

use crate::app::Speaker;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn sessions_dir() -> PathBuf {
    if let Ok(d) = std::env::var("SEA_SESSIONS_DIR") {
        return PathBuf::from(d);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    Path::new(&home).join(".sea").join("sessions")
}

fn role_of(s: Speaker) -> &'static str {
    match s {
        Speaker::User => "user",
        Speaker::Agent => "assistant",
        Speaker::System => "system",
    }
}

fn speaker_of(role: &str) -> Option<Speaker> {
    match role {
        "user" => Some(Speaker::User),
        "assistant" => Some(Speaker::Agent),
        "system" => Some(Speaker::System),
        _ => None,
    }
}

/// Append-save the transcript to a new timestamped file; returns its path.
pub fn save_session(transcript: &[(Speaker, String)]) -> io::Result<PathBuf> {
    let dir = sessions_dir();
    fs::create_dir_all(&dir)?;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("{}.jsonl", ts));
    save_to(&path, transcript)?;
    Ok(path)
}

pub fn save_to(path: &Path, transcript: &[(Speaker, String)]) -> io::Result<()> {
    let mut f = io::BufWriter::new(fs::File::create(path)?);
    for (speaker, content) in transcript {
        serde_json::to_writer(
            &mut f,
            &serde_json::json!({ "role": role_of(*speaker), "content": content }),
        )?;
        f.write_all(b"\n")?;
    }
    f.flush()?;
    Ok(())
}

pub fn load_session(path: &Path) -> io::Result<Vec<(Speaker, String)>> {
    let txt = fs::read_to_string(path)?;
    let mut out = Vec::new();
    for line in txt.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let v: serde_json::Value = serde_json::from_str(line)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        let role = v.get("role").and_then(|r| r.as_str()).unwrap_or("");
        let content = v.get("content").and_then(|c| c.as_str()).unwrap_or("");
        if let Some(sp) = speaker_of(role) {
            out.push((sp, content.to_string()));
        }
    }
    Ok(out)
}

pub struct SessionMeta {
    pub path: PathBuf,
    pub name: String,
}

/// List saved sessions, newest first.
pub fn list_sessions() -> Vec<SessionMeta> {
    list_sessions_in(&sessions_dir())
}

pub fn list_sessions_in(dir: &Path) -> Vec<SessionMeta> {
    let mut metas: Vec<SessionMeta> = Vec::new();
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().map_or(true, |x| x != "jsonl") {
                continue;
            }
            metas.push(SessionMeta {
                name: p.file_stem().unwrap_or_default().to_string_lossy().to_string(),
                path: p,
            });
        }
    }
    metas.sort_by(|a, b| b.name.cmp(&a.name));
    metas
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "seatui-test-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn save_load_roundtrip() {
        let dir = tmp_dir("roundtrip");
        // SAFETY(test): single-threaded test binary section for this env var
        std::env::set_var("SEA_SESSIONS_DIR", &dir);
        let t = vec![
            (Speaker::User, "hello **world**".to_string()),
            (Speaker::Agent, "hi `there`\nline two".to_string()),
            (Speaker::System, "note".to_string()),
        ];
        let path = save_session(&t).unwrap();
        assert_eq!(path.parent().unwrap(), dir);
        assert_eq!(path.extension().unwrap(), "jsonl");
        let loaded = load_session(&path).unwrap();
        assert_eq!(loaded, t);
        let _ = fs::remove_dir_all(&dir);
        std::env::remove_var("SEA_SESSIONS_DIR");
    }

    #[test]
    fn list_sessions_newest_first() {
        let dir = tmp_dir("listing");
        save_to(&dir.join("100.jsonl"), &[]).unwrap();
        save_to(&dir.join("200.jsonl"), &[]).unwrap();
        save_to(&dir.join("ignore.txt"), &[]).unwrap();
        let metas = list_sessions_in(&dir);
        assert_eq!(metas.len(), 2);
        assert_eq!(metas[0].name, "200");
        assert_eq!(metas[1].name, "100");
        let _ = fs::remove_dir_all(&dir);
    }
}
