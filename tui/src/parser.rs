//! Parsers for sea-agent child-process control-channel lines (stderr).

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BannerInfo {
    pub provider: String,
    /// Full model string as printed by the CLI, e.g. "openrouter/openai/gpt-4o-mini".
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolEvent {
    pub name: String,
    pub ok: bool,
}

/// Parse "sea-agent: provider=<p> model=<m>" startup banner lines.
pub fn parse_banner(line: &str) -> Option<BannerInfo> {
    let rest = line.trim().strip_prefix("sea-agent:")?;
    let mut provider = None;
    let mut model = None;
    for tok in rest.split_whitespace() {
        if let Some(v) = tok.strip_prefix("provider=") {
            provider = Some(v.to_string());
        }
        if let Some(v) = tok.strip_prefix("model=") {
            model = Some(v.to_string());
        }
    }
    Some(BannerInfo {
        provider: provider?,
        model: model?,
    })
}

/// Parse "[tool] <name> -> ok|error" tool-event lines.
pub fn parse_tool_line(line: &str) -> Option<ToolEvent> {
    let rest = line.trim().strip_prefix("[tool]")?;
    let (name, status) = rest.rsplit_once("->")?;
    let ok = match status.trim() {
        "ok" => true,
        "error" => false,
        _ => return None,
    };
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    Some(ToolEvent {
        name: name.to_string(),
        ok,
    })
}

/// Split a possibly-partial stderr stream chunk into complete lines plus the
/// trailing partial remainder.
pub fn split_lines(buf: &mut String) -> Vec<String> {
    let mut out = Vec::new();
    while let Some(pos) = buf.find('\n') {
        let line: String = buf.drain(..=pos).collect();
        out.push(line.trim_end_matches(['\n', '\r']).to_string());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn banner_parses_provider_and_model() {
        let b = parse_banner("sea-agent: provider=openrouter model=openrouter/openai/gpt-4o-mini")
            .expect("should parse");
        assert_eq!(b.provider, "openrouter");
        assert_eq!(b.model, "openrouter/openai/gpt-4o-mini");
    }

    #[test]
    fn banner_rejects_non_banner_lines() {
        assert!(parse_banner("hello world").is_none());
        assert!(parse_banner("sea-agent REPL ready.").is_none());
        assert!(parse_banner("").is_none());
    }

    #[test]
    fn tool_line_ok_and_error() {
        let ok = parse_tool_line("[tool] read_file -> ok").unwrap();
        assert_eq!(ok, ToolEvent { name: "read_file".into(), ok: true });
        let err = parse_tool_line("[tool] run_tests -> error").unwrap();
        assert_eq!(err, ToolEvent { name: "run_tests".into(), ok: false });
    }

    #[test]
    fn tool_line_rejects_bad_status_and_empty_name() {
        assert!(parse_tool_line("[tool] thing -> crashed").is_none());
        assert!(parse_tool_line("[tool]  -> ok").is_none());
        assert!(parse_tool_line("not a tool line").is_none());
    }

    #[test]
    fn split_lines_handles_partial_chunks() {
        let mut buf = String::from("alpha\nbe");
        let done = split_lines(&mut buf);
        assert_eq!(done, vec!["alpha"]);
        buf.push_str("ta\n");
        let done = split_lines(&mut buf);
        assert_eq!(done, vec!["beta"]);
        assert!(buf.is_empty());
    }
}
