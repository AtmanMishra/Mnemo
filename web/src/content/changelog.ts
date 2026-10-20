// The changelog's one source. The page (/changelog), the Atom feed (/changelog.xml), the
// home page's version line and the download page all read this file, so a release is
// recorded once. The newest entry is first. Add an entry when you run
// `bun app/scripts/release.ts prepare`, beside docs/releases/vX.Y.Z.md.

export type Kind = "added" | "changed" | "fixed" | "security" | "removed";

export interface Change {
  kind: Kind;
  /** Short, in the user's terms. */
  text: string;
  /** What it means for the person using it, when the line alone does not say. */
  detail?: string;
  /** The part of Mnemo it touches, for filtering. */
  area: Area;
}

export type Area = "install" | "memory" | "interface" | "safety" | "agents" | "tools" | "site";

export interface Release {
  version: string;
  date: string;
  /** One sentence: what this release is about. */
  headline: string;
  changes: Change[];
  /** Problems known when the release was cut. */
  known?: string[];
}

export const KIND_LABEL: Record<Kind, string> = {
  added: "Added",
  changed: "Changed",
  fixed: "Fixed",
  security: "Security",
  removed: "Removed",
};

export const AREA_LABEL: Record<Area, string> = {
  install: "Install and update",
  memory: "Memory",
  interface: "Interface",
  safety: "Safety",
  agents: "Agents",
  tools: "Tools",
  site: "Website",
};

export const RELEASES: Release[] = [
  {
    version: "0.1.9",
    date: "2026-10-20",
    headline: "Hooks, scheduled runs, a code index, language-server diagnostics, skills from marketplaces, a remote view, and egress, environment and managed-policy controls.",
    changes: [
      { kind: "added", area: "tools", text: "Hooks", detail: "Your commands run before and after tool calls, prompts and sessions. A hook can stop a call; it cannot approve one the gate refuses." },
      { kind: "added", area: "agents", text: "mnemo schedule", detail: "Run a prompt on a timer. A scheduled run is read-only unless the job says it may act, and its logs are redacted." },
      { kind: "added", area: "tools", text: "A code index", detail: "code_* tools over a per-project index (tree-sitter, embedded in the binary) for TypeScript, JavaScript, Python, Rust and Go. Calls are tied to a definition only when the code says which one. It can be switched off per project." },
      { kind: "added", area: "tools", text: "Language-server diagnostics after an edit", detail: "The result of an edit shows the compiler's errors, so the agent sees them at once." },
      { kind: "added", area: "tools", text: "Skills from marketplaces", detail: "mnemo skills installs a plugin's skills from owner/repo, an https git address or a folder. Nothing runs on install, and a skill whose files changed after install does not load." },
      { kind: "added", area: "interface", text: "/remote", detail: "A read-only view of the session on this machine only, with a token for each start. Off until the remote setting allows it." },
      { kind: "added", area: "interface", text: "Plan mode can ask", detail: "Plan mode tells the model it is planning, and an ask_user tool puts a question to you." },
      { kind: "added", area: "interface", text: "--model, and settings for limits and compaction", detail: "maxTurns, subMaxTurns, subSpend, autoCompact, compactReserve and compactKeep." },
      { kind: "changed", area: "install", text: "Faster start", detail: "Every command used to take about 400 ms because one bundle held everything; pi, Ink and the memory client now load only for a session." },
      { kind: "changed", area: "tools", text: "A folder's resources live in .agents/", detail: "Skills, hooks and extensions are read from .agents/ instead of pi's .pi/." },
      { kind: "security", area: "safety", text: "An allowlisted environment", detail: "Commands and MCP stdio servers get an allowlist, not your whole environment. MCP over HTTP stays off unless the server's entry says allowNetwork." },
      { kind: "security", area: "safety", text: "Egress rules", detail: "net rules test the host of a command, a Python cell and an MCP HTTP server; cloud metadata addresses are refused in any spelling unless a rule allows them." },
      { kind: "security", area: "safety", text: "A managed policy", detail: "An administrator's file that user and project settings cannot widen: models, tools, MCP servers and a mode ceiling. A broken file fails closed." },
      { kind: "security", area: "safety", text: "Deny rules hold inside the Python tool", detail: "An audit hook asks before a cell starts a process or opens, removes or renames a file. It is a filter, not a sandbox." },
      { kind: "security", area: "safety", text: "No network habits of pi's", detail: "No ripgrep or fd download, no model catalog, no attribution headers: Mnemo calls only your provider and the places you name." },
    ],
    known: [
      "The gate filters; it is not a sandbox.",
    ],
  },
  {
    version: "0.1.8",
    date: "2026-10-18",
    headline: "A VS Code extension on a new mnemo --rpc mode, MCP servers as tools, a wider /rewind, a per-prompt budget and a round of security fixes.",
    changes: [
      { kind: "added", area: "interface", text: "mnemo --rpc", detail: "Mnemo as JSON lines for an editor or another front end. A tool call that would ask becomes a dialog the client must answer; nothing answers for it, and a client that disconnects leaves every question answered no. Protocol in docs/RPC.md." },
      { kind: "added", area: "interface", text: "VS Code extension", detail: "A panel with chat, approvals with diffs, agents, memory and every setting, with its own themes. If Mnemo is missing or older than 0.1.8 it offers to download this release, checks it against SHA256SUMS and keeps it in its own storage." },
      { kind: "added", area: "tools", text: "MCP servers as tools", detail: "Servers from ~/.mnemo/agent/mcp.json (and a trusted folder's .pi/mcp.json) load as tools, found with tool_search so their schemas stay out of a small model's prompt. Every call goes through the permission gate, with an always grant per tool." },
      { kind: "added", area: "safety", text: "A dollar budget for a prompt", detail: "A prompt that crosses it stops, sub-agents' calls counted. A -p run prints one line of calls, tokens and dollars on stderr." },
      { kind: "changed", area: "tools", text: "/rewind covers shell commands", detail: "In a git repository it now puts back what bash and Python cells changed, not only the agent's own edits." },
      { kind: "security", area: "safety", text: "Nothing a folder chose runs before it is trusted", detail: "A downloaded folder can no longer run a command through core.fsmonitor, a git hook, or (on Windows) a program named like a system one." },
      { kind: "security", area: "memory", text: "Recalled memory is data", detail: "It reaches the model inside a boundary a fact cannot close, marked as data, and is scanned again on the way out." },
      { kind: "security", area: "safety", text: "Secrets and symlinks", detail: "A project's .env, private keys and .netrc are refused by the read tools; a grant for git --version no longer allows git push; an approved write is refused if its path became a symlink while the question was open." },
    ],
    known: [
      "The extension's download and launch code has not yet been run inside a real VS Code.",
    ],
  },
  {
    version: "0.1.7",
    date: "2026-10-17",
    headline: "A settings menu: /settings tunes the agent limits, the look, the keys, notifications and more, with every default what Mnemo always did.",
    changes: [
      { kind: "added", area: "interface", text: "/settings", detail: "A menu of everything you can tune: type to filter, enter to change. /settings hops 20 sets one in a sentence, /settings reset undoes them, and mnemo settings does the same from a shell. Choices are kept in ~/.mnemo/config.json, and a value that does not fit is refused with the reason." },
      { kind: "added", area: "agents", text: "Agent limits you can set", detail: "The message chain (12), the woken-turn budget ($0.50), sub-agent depth and counts, message length and rate, held messages, and how long message_agent waits for a reply. 0 for the budget means no message ever starts an agent." },
      { kind: "added", area: "interface", text: "Rebindable keys", detail: "Fourteen chords: the palette, sidebar, find, expand, clear, thinking level, hub, playground, project switch, new agent, split, next layout, and previous and next agent. The footer, the ? panel and /help show the chords you set; a key the prompt needs for editing, or one another action holds, is refused." },
      { kind: "added", area: "interface", text: "Look and feel", detail: "Animation, the launch sequence, whether the sidebar starts open and how wide it is, the split layout, wheel speed, expanded output, and how long toasts stay." },
      { kind: "added", area: "tools", text: "Behaviour you can turn down", detail: "Learning after runs, the check after changed code, the escalation model and how many failed checks it takes, how long a Python cell may run, the desktop notice and its delay, and the daily update check." },
      { kind: "security", area: "safety", text: "No setting loosens the gate", detail: "The default mode can be default or plan, never yolo or accept-edits. Values are checked against fixed ranges, flags and environment variables still win for a run, the model has no tool that changes a setting, and an edit to config.json from the agent asks like any file outside the project." },
    ],
    known: [
      "Animation, the launch sequence, the sidebar's starting state, the default mode, the desktop notice and the update check are read at launch.",
      "Keys that belong to one screen (the hub's l and u, the sidebar's panes) are not rebindable.",
    ],
  },
  {
    version: "0.1.6",
    date: "2026-10-17",
    headline: "Agents talk to each other on their own, within a spending allowance; you can type to a running sub-agent, links survive a restart, and the playground shows each conversation as a thread.",
    changes: [
      { kind: "changed", area: "agents", text: "A message wakes an idle agent", detail: "A sibling or sub-agent no longer waits for you to prompt the agent it wrote to: the agent reads it at once and can answer, and the answer wakes the sender in turn. You no longer have to ask 'did you get it?'." },
      { kind: "added", area: "agents", text: "Ask and wait", detail: "message_agent with wait holds the question open for up to two minutes and returns the reply as its result, so an agent can ask a sibling something and use the answer in the same turn." },
      { kind: "security", area: "safety", text: "A chain of messages is bounded", detail: "Each message counts one more than the one that led to it. After 12 in a row since you last prompted, messages wait for your next prompt, so two agents cannot keep each other busy, and spending, forever. The agents page shows '✉ 2 waiting for you' on the agent holding them." },
      { kind: "added", area: "interface", text: "Messages between agents appear in the conversation", detail: "Marked ✉ with who sent them and 'another agent, not you', so an agent that starts on its own shows why. The playground feed says when a message woke an agent or was held." },
      { kind: "changed", area: "interface", text: "Your messages stand out", detail: "What you typed is drawn on a raised band with an accent rule down its left, not just after a ❯." },
      { kind: "changed", area: "interface", text: "Sub-agents join the split by themselves", detail: "A sub-agent that starts while its agent is in the split takes a free pane, or the pane of one that finished. ctrl+s fills spare panes with the active agent's sub-agents." },
      { kind: "added", area: "agents", text: "Type to a running sub-agent", detail: "In a split, alt+, and alt+. move through every pane, sub-agents included. A focused sub-agent pane has a prompt: what you send reaches it after its current step, as your words." },
      { kind: "added", area: "agents", text: "Links survive a restart", detail: "Two projects you linked are linked again when both are open, in a later run too. Unlinking is remembered." },
      { kind: "security", area: "safety", text: "An allowance for woken turns", detail: "Turns that messages start may spend $0.50 per agent until you next prompt it. The call that crosses it stops the turn and the agent waits for you, so siblings left talking cannot run up a bill." },
      { kind: "added", area: "interface", text: "A conversation view in the playground", detail: "c shows the selected agent's messages with one other as a thread; tab goes to its next partner." },
      { kind: "fixed", area: "agents", text: "A sub-agent whose model call fails says why", detail: "It used to finish 'without an answer' and no reason. Now the tool fails with the model's error, so you and the parent agent can see it (a rate limit, say)." },
    ],
    known: [
      "The spending allowance counts what your provider prices: a local model that reports no price is bounded only by the chain of 12 messages.",
      "Links come back when both projects are open; Mnemo does not open a linked project for you.",
      "In yolo mode, a message can now start an agent working without you: it runs commands the way any yolo turn does. In the other modes, its edits and commands still ask you.",
    ],
  },
  {
    version: "0.1.5",
    date: "2026-10-17",
    headline: "Agents work in teams: sub-agents that start sub-agents, sibling agents that see and message each other, split layouts, and a playground to watch them.",
    changes: [
      { kind: "added", area: "agents", text: "Sub-agents can start sub-agents", detail: "Down to three levels, four at a time per agent and sixteen per conversation. A read-only agent can only start read-only ones. Give one a name with spawn_subagent's name field." },
      { kind: "added", area: "agents", text: "Sibling agents", detail: "Press l on one agent in the agents page, then l on another, and the two can see what the other is doing and message each other. A sub-agent can reach its parent's siblings. u unlinks. Only you can link agents; no tool can." },
      { kind: "added", area: "agents", text: "list_agents and message_agent", detail: "A message is delivered as another model's text, not yours: it grants nothing, does not skip the receiver's approvals, and never starts a turn on its own." },
      { kind: "changed", area: "agents", text: "The agents page draws the tree", detail: "Each card says who it is linked with and how many sub-agents it has; below, the selected agent's family as a tree with each sub-agent's task and steps." },
      { kind: "added", area: "interface", text: "Split layouts, never more than four panes", detail: "alt+l cycles columns, rows, grid and main + side. f in the agents page splits an agent with its linked agents and its busiest sub-agents, and the bar says '4 of 9' when more are related. A sub-agent is a read-only pane." },
      { kind: "added", area: "interface", text: "The playground (ctrl+y)", detail: "Every agent, sub-agent and message between them, live, to supervise. It cannot steer: no prompt, no stop, no message. Enter takes you to the agent." },
      { kind: "security", area: "safety", text: "Who may message whom is enforced in code; what agents write is cleaned and redacted", detail: "Control and bidirectional characters are removed and credential shapes redacted before anything an agent writes is shown or delivered. Limits on size, rate, depth and fan-out. See SECURITY.md." },
    ],
    known: [
      "Sub-agents are watched, not typed to: you talk to top-level agents only.",
      "A message never wakes an idle agent, so a sibling reads it at its next prompt.",
      "Links last for the session; they are not restored when Mnemo restarts.",
    ],
  },
  {
    version: "0.1.4",
    date: "2026-10-17",
    headline: "Closes the permission holes v0.1.3 shipped with, and fixes the agents page shortcuts.",
    changes: [
      { kind: "security", area: "safety", text: "An approval no longer covers the form of a command that runs something else", detail: "A grant for git bisect, git submodule, npm install, bun add, cargo install or go get is for the plain subcommand. git bisect run, git submodule foreach, git filter-branch and installing a named package are asked about each time." },
      { kind: "security", area: "safety", text: "Plan mode no longer writes to memory", detail: "memory_remember and memory_steer are refused in plan mode. Reading memory still works." },
      { kind: "fixed", area: "interface", text: "Agents page: n starts a new agent, s and ctrl+s split the chosen agents", detail: "n then Enter used to jump to the first agent. Ctrl keys also fired the page's single-letter keys; they no longer do." },
      { kind: "fixed", area: "interface", text: "esc during a running tool says Interrupted", detail: "It said \"The operation was aborted.\"" },
      { kind: "changed", area: "site", text: "The website is built and checked on every pull request" },
    ],
    known: [
      "The Windows binary is not code-signed, so SmartScreen may warn on a browser download.",
      "Keys typed in the first second after the prompt appears can occasionally be dropped.",
      "The binary reports its version to MCP servers as 0.0.0.",
      "Memory: distrusted is a difference, not a ratio; skill nodes are global by label; a write that times out on the client can still be applied later.",
    ],
  },
  {
    version: "0.1.3",
    date: "2026-10-16",
    headline: "Subscription login works in the downloaded binary; memory no longer reads off; Windows installs itself; about sixty fixes from a full review.",
    changes: [
      { kind: "fixed", area: "install", text: "Subscription /login works in the downloaded binary", detail: "On v0.1.0 to v0.1.2 it failed with Cannot find module './anthropic.js'. Bedrock models and image reads failed the same way. Release builds now fail if a flow would not load." },
      { kind: "fixed", area: "memory", text: "Memory no longer reads off after a while", detail: "The footer shows off only when the memory sidecar is not installed. Installed but slow to answer is busy, and the last count stays." },
      { kind: "changed", area: "memory", text: "Remote embeddings are opt-in", detail: "Set MNEMO_EMBED_URL and MNEMO_EMBED_MODEL. An OPENROUTER_API_KEY alone no longer sends memory anywhere, and the sidecar starts without your provider keys." },
      { kind: "added", area: "install", text: "A downloaded mnemo.exe installs itself on Windows", detail: "It asks once, copies itself and memsrv.exe to %USERPROFILE%\\.mnemo\\bin and adds that folder to your user PATH. mnemo install [--yes] does the same without a question." },
      { kind: "added", area: "install", text: "mnemo doctor checks memory", detail: "It starts the sidecar, times its answer, and names the embedder and the log file. It warns when the mnemo on your PATH is a different file from the one running." },
      { kind: "fixed", area: "install", text: "mnemo uninstall on Windows removes everything at once", detail: "A running mnemo.exe is moved out of the install folder, so the folder and, with --deep, the data folder go immediately. What it cannot remove is named and the exit code is 1." },
      { kind: "fixed", area: "interface", text: "Esc with a message queued no longer crashes the screen", detail: "The message goes back to the prompt. A login waiting on the browser can be cancelled with esc." },
      { kind: "fixed", area: "tools", text: "mnemo -p exits 1 when the model call fails", detail: "It prints the reason. It used to exit 0." },
      { kind: "security", area: "safety", text: "A malformed grants.json no longer switches the gate off", detail: "It fails closed. Plan mode is no longer beaten by an allow rule." },
      { kind: "security", area: "safety", text: "Deny rules resist wrappers", detail: "Quotes, sudo -u, env -u, bash -e -c, eval, timeout, xargs and find -exec no longer get around them." },
      { kind: "security", area: "safety", text: "The agent's tools cannot read the process environment, .env, models.json or grants.json" },
      { kind: "security", area: "memory", text: "Memory redaction catches more credential shapes", detail: "hf_ and ya29. tokens, Basic and Digest auth, webhook URLs, *_PASS= and \"password is\"." },
      { kind: "added", area: "site", text: "A changelog, download, roadmap, security, privacy, terms and shortcuts pages on the project site", detail: "The Windows instructions lead with irm https://mnemo.atmanmishra.dev/install.ps1 | iex." },
    ],
    known: [
      "The Windows binary is not code-signed, so SmartScreen may warn on a browser download. The irm | iex and Scoop paths avoid it.",
      "Keys typed in the first second after the prompt appears can occasionally be dropped.",
      "git bisect run, git submodule foreach and npm install* grants are not yet covered by the gate's option checks (see SECURITY.md).",
    ],
  },
  {
    version: "0.1.2",
    date: "2026-10-13",
    headline: "Install, update and uninstall from the command line; provider keys kept out of the commands the agent runs; rewind; smarter memory; eleven themes.",
    changes: [
      { kind: "added", area: "install", text: "mnemo update", detail: "Installs the latest release with the same checksum-checked installer as the one-liner. --check only says whether there is one; /update does it from inside Mnemo." },
      { kind: "added", area: "install", text: "A daily update check, off by default", detail: "mnemo update --auto on tells you at launch when there is a new version and never installs on its own." },
      { kind: "added", area: "install", text: "mnemo uninstall, and --deep", detail: "Removes the program and keeps what it learned. --deep also deletes ~/.mnemo (memory, sessions, credentials, skills, logs, settings) after you type delete. The install scripts do the same: --uninstall / --deep, or MNEMO_UNINSTALL=1 and deep on Windows." },
      { kind: "added", area: "install", text: "Installers that draw themselves", detail: "On a terminal: the wordmark, a pulse per step with the download counting up, and Mne at the end. Plain lines when piped or with NO_COLOR." },
      { kind: "added", area: "safety", text: "Provider API keys stay out of commands the agent runs", detail: "Bash, the Python kernel and best-of checks start without the model-provider keys. MNEMO_PASS_ENV=NAME hands one back." },
      { kind: "added", area: "safety", text: "A bounded Python kernel", detail: "A timeout per call (up to 600 s), stopped by esc, and an 8 GB memory cap on Linux." },
      { kind: "added", area: "agents", text: "Rewind", detail: "esc esc on an empty prompt (or /rewind) goes back to an earlier message: the conversation, the files the agent edited since, or both. A checkpoint is taken before each edit." },
      { kind: "added", area: "memory", text: "mnemo memory tidy", detail: "Finds duplicate facts and pitfalls, facts about files that are gone, and what you marked wrong. --apply retires them." },
      { kind: "added", area: "memory", text: "Recall weighs trust", detail: "What helped ranks higher; what you marked wrong twice is no longer recalled. In the memory pane + and - vote, e edits, d forgets, and Recalled this session lists what came back." },
      { kind: "added", area: "memory", text: "Your own embedder", detail: "MNEMO_EMBED_URL and MNEMO_EMBED_MODEL point search at an Ollama (or any OpenAI-compatible) embedding server. The address must be https or local." },
      { kind: "added", area: "interface", text: "ctrl+k: one list of commands, agents, sessions and files" },
      { kind: "added", area: "interface", text: "ctrl+f finds in the conversation; ctrl+o expands output that was already printed" },
      { kind: "added", area: "interface", text: "/resume shows titles, cost and how each session ended, and searches everything said in them" },
      { kind: "added", area: "interface", text: "/stats: this session, the last seven days, and which tools failed" },
      { kind: "added", area: "interface", text: "Clickable links", detail: "File paths in tool calls and links in answers open from the terminal (OSC 8). MNEMO_LINKS=0 turns it off." },
      { kind: "added", area: "interface", text: "A desktop notification when a long turn ends or an approval waits while you are in another window", detail: "MNEMO_NOTIFY=0 turns it off." },
      { kind: "added", area: "interface", text: "Full-terminal animations", detail: "The launch, the introduction and the goodbye screen fill the whole window. Engram, the dither field Mne settles out of, also appears in the welcome card and the empty transcript." },
      { kind: "added", area: "interface", text: "Eleven themes (/theme)", detail: "Mnemo Night, Dracula, Nord, Gruvbox, Tokyo Night, Catppuccin Mocha, Synthwave, Amber CRT, Game Boy, Paper, Solarized Light. Each is checked for readable contrast." },
      { kind: "added", area: "interface", text: "The mouse wheel scrolls the conversation", detail: "/mouse (or MNEMO_MOUSE=0) gives selection back to your terminal." },
      { kind: "added", area: "install", text: "mnemo doctor --fix", detail: "Tightens permissions on Mnemo's files, sets a broken settings file aside, and reinstalls a missing memory sidecar." },
      { kind: "changed", area: "interface", text: "Every screen fits the terminal, at any size and across resizes" },
      { kind: "fixed", area: "interface", text: "A long answer streaming in quickly could crash the workspace", detail: "The error was \"Maximum update depth exceeded\"." },
      { kind: "fixed", area: "install", text: "On Windows the installer can replace a running mnemo.exe", detail: "So mnemo update works from inside Mnemo. The PowerShell installer also forces TLS 1.2 and no longer crawls behind PowerShell's progress bar." },
      { kind: "fixed", area: "install", text: "A fresh install made ~/.mnemo readable by other users", detail: "It is now private (mode 0700)." },
      { kind: "fixed", area: "interface", text: "Stale height measurements left a gap or an overlap in the workspace after a resize" },
    ],
    known: [
      "The Windows installer and the Windows build of the new features have had less real-machine testing than macOS and Linux. If something fails on Windows, run mnemo doctor and open an issue with its output.",
      "The background curator (a model that tidies memory and proposes skills while you are away) is not part of this release. It lives on the feature/background-curator branch.",
    ],
  },
  {
    version: "0.1.1",
    date: "2026-10-12",
    headline: "Engram, the field of characters Mne settles out of, in more places; a rebuilt project site; fixes to the release tooling.",
    changes: [
      { kind: "added", area: "interface", text: "Engram variations in the boot sequence and the welcome card" },
      { kind: "added", area: "interface", text: "Engram in the empty transcript, a dither while the model thinks, and a pulse while it writes" },
      { kind: "added", area: "site", text: "The project site at mnemo.atmanmishra.dev", detail: "A prerendered page with a working demo for every feature, neutral light and dark themes, and figures from Hairline." },
      { kind: "fixed", area: "tools", text: "The --demo --dump frame now waits for the turn it dumps" },
      { kind: "changed", area: "tools", text: "The release script installs dependencies before its checks, shows why a check failed, and gives the app tests the timeout CI gives them" },
    ],
  },
  {
    version: "0.1.0",
    date: "2026-10-09",
    headline: "The first public release: a terminal coding agent whose memory learns your projects, as a single binary for macOS, Linux and Windows.",
    changes: [
      { kind: "added", area: "agents", text: "The terminal agent", detail: "An Ink interface on the pi SDK: transcript with diffs and tool output, a multi-line prompt, slash commands, @file mentions, dialogs, sessions and compaction." },
      { kind: "added", area: "memory", text: "Memory that learns", detail: "A local journal in a Rust sidecar (memsrv). After each run Mnemo writes down what it learned, recalls it next session, steers on failure and keeps the fix." },
      { kind: "added", area: "memory", text: "Memory for other agents", detail: "mnemo memory ingest, setup claude-code and setup codex share the same memory with Claude Code (hooks) and Codex, Cursor and opencode (MCP)." },
      { kind: "added", area: "tools", text: "Skills Mnemo writes and revises for itself" },
      { kind: "added", area: "tools", text: "A Python kernel and in-process sub-agents" },
      { kind: "added", area: "agents", text: "Best-of-n attempts in separate worktrees, and escalation to a stronger model after failed checks" },
      { kind: "added", area: "agents", text: "Several agents in one window", detail: "A hub, split view and a project switcher." },
      { kind: "added", area: "safety", text: "Permission modes: default, accept-edits, plan and yolo", detail: "Plus permissions.json rules, per-project grants and an approval dialog. /yolo and /accept-edits toggle the last two." },
      { kind: "added", area: "install", text: "One-line installers and release archives you can verify", detail: "SHA-256 checksums, GitHub build-provenance attestations, and manifests for Homebrew and Scoop." },
      { kind: "security", area: "safety", text: "Permission-gate bypasses found in a security review are closed", detail: "Deny rules look through spacing, VAR=x prefixes, directories, sudo/env wrappers and sh -c; allow rules end on a word and never cover a compound command; accept-edits stays inside the project." },
      { kind: "security", area: "memory", text: "Memory-layer issues found in a security review are fixed", detail: "Facts that look like instructions are refused at write time, and recalled items are labelled as candidates, not facts." },
      { kind: "security", area: "install", text: "The installers and the release workflow were hardened after a supply-chain review", detail: "Pinned actions, truncation-safe scripts and a downloader check." },
    ],
    known: ["Pre-alpha: expect rough edges, and check the permission mode before you point it at a repository you care about."],
  },
];

export const LATEST = RELEASES[0]!;
