//! Slash-command registry, palette matching, parsing, and approval flags.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Command {
    pub name: &'static str,
    pub args: &'static str,
    pub desc: &'static str,
    /// Mutating commands require y/n approval unless --yolo.
    pub mutating: bool,
}

pub const COMMANDS: &[Command] = &[
    Command { name: "/help", args: "", desc: "show keybindings", mutating: false },
    Command { name: "/quit", args: "", desc: "exit seatui", mutating: false },
    Command { name: "/clear", args: "", desc: "wipe scrollback + transcript", mutating: true },
    Command { name: "/model", args: "[id]", desc: "restart child with MNEMO_MODEL override", mutating: true },
    Command { name: "/context", args: "", desc: "estimate context usage (chars/4)", mutating: false },
    Command { name: "/memory", args: "<query>", desc: "search memory layer via memsrv", mutating: false },
    Command { name: "/resume", args: "[n]", desc: "list/load saved sessions", mutating: false },
];

/// Commands matching a partial input like "/cl" (case-insensitive).
pub fn match_commands(input: &str) -> Vec<&'static Command> {
    let p = input.trim().to_lowercase();
    if !p.starts_with('/') || p.contains(' ') {
        return Vec::new();
    }
    COMMANDS
        .iter()
        .filter(|c| c.name.to_lowercase().starts_with(&p))
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    Help,
    Quit,
    Clear,
    Model(Option<String>),
    Context,
    Memory(String),
    Resume(Option<usize>),
    Unknown(String),
}

/// Parse a full command line into an action.
pub fn parse(input: &str) -> Action {
    let input = input.trim();
    let mut it = input.split_whitespace();
    let head = it.next().unwrap_or("").to_lowercase();
    let rest: Vec<&str> = it.collect();
    match head.as_str() {
        "/help" => Action::Help,
        "/quit" | "/exit" => Action::Quit,
        "/clear" => Action::Clear,
        "/model" => Action::Model(rest.first().map(|s| s.to_string())),
        "/context" => Action::Context,
        "/memory" => Action::Memory(rest.join(" ")),
        "/resume" => Action::Resume(rest.first().and_then(|s| s.parse().ok())),
        other => Action::Unknown(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefix_matching() {
        let m = match_commands("/cl");
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].name, "/clear");
        assert!(m[0].mutating);
    }

    #[test]
    fn empty_slash_lists_all_and_word_disables() {
        assert_eq!(match_commands("/").len(), COMMANDS.len());
        assert!(match_commands("/memory now").is_empty());
        assert!(match_commands("hello").is_empty());
    }

    #[test]
    fn case_insensitive_match() {
        assert_eq!(match_commands("/HELP")[0].name, "/help");
    }

    #[test]
    fn parse_actions() {
        assert_eq!(parse("/clear"), Action::Clear);
        assert_eq!(parse("/model openai/gpt-4o"), Action::Model(Some("openai/gpt-4o".into())));
        assert_eq!(parse("/model"), Action::Model(None));
        assert_eq!(parse("/memory rust ownership"), Action::Memory("rust ownership".into()));
        assert_eq!(parse("/resume"), Action::Resume(None));
        assert_eq!(parse("/resume 2"), Action::Resume(Some(2)));
        assert_eq!(parse("/nope"), Action::Unknown("/nope".into()));
        assert_eq!(parse("/EXIT"), Action::Quit);
    }
}
