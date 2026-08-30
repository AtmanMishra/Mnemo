//! Slash-command palette: type `/` in the prompt and the matching commands
//! appear; tab completes, enter runs. Same idea as Claude Code's `/` menu.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cmd {
    pub name: &'static str,
    pub help: &'static str,
}

pub const COMMANDS: &[Cmd] = &[
    Cmd { name: "/help", help: "show keybindings and commands" },
    Cmd { name: "/clear", help: "clear the chat transcript" },
    Cmd { name: "/thinking", help: "expand or collapse thinking blocks" },
    Cmd { name: "/memory", help: "jump to the memory pane" },
    Cmd { name: "/agents", help: "jump to the agents pane" },
    Cmd { name: "/skills", help: "jump to the skills pane" },
    Cmd { name: "/logs", help: "jump to the logs pane" },
    Cmd { name: "/consolidate", help: "distil episodes into semantic lessons" },
    Cmd { name: "/abort", help: "stop the current agent run" },
    Cmd { name: "/quit", help: "leave the cockpit" },
];

/// Commands matching what has been typed so far. A bare "/" lists everything.
/// Matching is subsequence-based, so "/cons" and "/cnsl" both find consolidate.
pub fn matches(input: &str) -> Vec<Cmd> {
    if !input.starts_with('/') { return Vec::new(); }
    let needle = input[1..].to_ascii_lowercase();
    COMMANDS.iter().copied()
        .filter(|c| is_subsequence(&needle, &c.name[1..]))
        .collect()
}

fn is_subsequence(needle: &str, hay: &str) -> bool {
    let mut chars = hay.chars();
    needle.chars().all(|n| chars.any(|h| h.eq_ignore_ascii_case(&n)))
}

/// Longest command prefix shared by every match — what tab completes to.
pub fn complete(input: &str) -> Option<String> {
    let hits = matches(input);
    let first = hits.first()?.name;
    let common = hits.iter().skip(1).fold(first.len(), |n, c| {
        first.chars().zip(c.name.chars()).take(n).take_while(|(a, b)| a == b).count()
    });
    Some(first.chars().take(common.max(input.len())).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slash_lists_everything_and_plain_text_lists_nothing() {
        assert_eq!(matches("/").len(), COMMANDS.len());
        assert!(matches("fix the build").is_empty(), "prose is not a command");
        assert!(matches("").is_empty());
    }

    #[test]
    fn matching_is_forgiving_but_not_wrong() {
        assert_eq!(matches("/quit"), vec![Cmd { name: "/quit", help: "leave the cockpit" }]);
        // subsequence: dropped letters still find it
        assert!(matches("/cnsl").iter().any(|c| c.name == "/consolidate"));
        assert!(matches("/zzz").is_empty());
    }

    #[test]
    fn tab_completes_to_the_shared_prefix() {
        // only one command starts with "cons"
        assert_eq!(complete("/cons").as_deref(), Some("/consolidate"));
        // several share nothing beyond "/" -> input is left alone
        assert_eq!(complete("/nope"), None);
    }

    #[test]
    fn every_command_is_documented_and_unique() {
        let mut names: Vec<&str> = COMMANDS.iter().map(|c| c.name).collect();
        names.sort();
        let before = names.len();
        names.dedup();
        assert_eq!(names.len(), before, "duplicate command name");
        assert!(COMMANDS.iter().all(|c| c.name.starts_with('/') && !c.help.is_empty()));
    }
}
