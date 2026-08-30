//! Copying out of the TUI.
//!
//! The app runs in the alternate screen. As long as it does NOT capture the
//! mouse, the terminal's own drag-select and copy keep working, which is the
//! best selection UI available — it knows about the font, the scrollback and
//! the platform's clipboard. So mouse capture stays off by default and this
//! module covers what dragging cannot: copying one logical block (a whole
//! tool output, a whole thinking block) without picking it out by hand.
use std::io::Write;
use std::process::{Command, Stdio};

/// Clipboard commands to try, in order. The first one that exists wins.
///
/// macOS first because that is where this is developed, then Wayland, then
/// two X11 options — `xclip` and `xsel` are rarely both installed.
const CANDIDATES: [(&str, &[&str]); 4] = [
    ("pbcopy", &[]),
    ("wl-copy", &[]),
    ("xclip", &["-selection", "clipboard"]),
    ("xsel", &["--clipboard", "--input"]),
];

/// Put `text` on the system clipboard.
///
/// Returns the tool that took it, or why nothing did. A failure has to be
/// reportable: silently not copying looks identical to copying, and you only
/// find out when you paste.
pub fn copy(text: &str) -> Result<&'static str, String> {
    if text.is_empty() { return Err("nothing to copy".into()) }
    let mut tried = Vec::new();
    for (bin, args) in CANDIDATES {
        match feed(bin, args, text) {
            Ok(()) => return Ok(bin),
            Err(e) => tried.push(format!("{bin} ({e})")),
        }
    }
    Err(format!("no clipboard tool found — tried {}", tried.join(", ")))
}

fn feed(bin: &str, args: &[&str], text: &str) -> Result<(), String> {
    let mut child = Command::new(bin)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    child.stdin.take()
        .ok_or_else(|| "no stdin".to_string())?
        .write_all(text.as_bytes())
        .map_err(|e| e.to_string())?;
    match child.wait() {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("exit {status}")),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_text_is_refused_rather_than_clearing_the_clipboard() {
        // yanking an empty block must not wipe what you copied a minute ago
        assert!(copy("").is_err());
    }

    #[test]
    fn a_missing_tool_reports_what_it_tried() {
        // the message has to name the fix; "copy failed" does not
        match feed("definitely-not-a-clipboard-tool", &[], "x") {
            Err(e) => assert!(!e.is_empty()),
            Ok(()) => panic!("that binary should not exist"),
        }
    }

    #[test]
    fn copying_reports_which_tool_took_it_or_why_none_did() {
        // on a machine with a clipboard this really copies; on a headless CI
        // box it must fail with a usable reason rather than pretending
        match copy("mnemo clipboard self-check") {
            Ok(bin) => assert!(CANDIDATES.iter().any(|(c, _)| *c == bin), "{bin}"),
            Err(e) => assert!(e.contains("tried"), "{e}"),
        }
    }
}
