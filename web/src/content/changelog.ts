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
