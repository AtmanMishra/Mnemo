// The roadmap, as the project sees it today. Intent, not a promise: nothing here has a
// date on purpose. Keep it in step with docs/ROADMAP.md (the engineering task list).

export type Stage = "shipped" | "unreleased" | "review" | "building" | "next" | "later" | "wont";

export interface Item {
  title: string;
  why: string;
  /** The release it shipped in, for the shipped column. */
  in?: string;
  /** A badge for work that is on main but in no release yet. */
  badge?: string;
  /** Where to follow it. */
  link?: { label: string; href: string };
}

export interface Lane {
  stage: Stage;
  title: string;
  blurb: string;
  items: Item[];
}

const REPO = "https://github.com/AtmanMishra/Mnemo";

export const LANES: Lane[] = [
  {
    stage: "review",
    title: "Coming next: open for review",
    blurb: "Written and tested, in a draft pull request that has not been merged. Not in any release, and it may change in review.",
    items: [
      { title: "Hooks", why: "Run your own commands before and after tool calls and sessions. A hook can block a call, and no hook can loosen the permission gate.", link: { label: "Pull request #62", href: `${REPO}/pull/62` } },
      { title: "Schedules", why: "mnemo schedule runs a prompt on a timer. Jobs live only in your own ~/.mnemo/schedules.json, never in a project, and a run is read-only plan mode unless you gave the job actions.", link: { label: "Pull request #68", href: `${REPO}/pull/68` } },
      { title: "Language-server diagnostics", why: "After an edit, the agent is told about the errors your language server reports. Opt-in through lsp.json, and only in a folder you trust.", link: { label: "Pull request #67", href: `${REPO}/pull/67` } },
      { title: ".agents/ as the project folder", why: "A project's own settings, skills and MCP config move from .pi/ to .agents/. Breaking for a repository that only has .pi/.", link: { label: "Pull request #65", href: `${REPO}/pull/65` } },
    ],
  },
  {
    stage: "building",
    title: "In progress",
    blurb: "Being built or tested now.",
    items: [
      {
        title: "Background curator",
        why: "While you are away, it uses your default model to tidy memory, merge duplicate facts, resurface forgotten knowledge and propose skill changes. Facts apply on their own; skills wait for your review. It runs only when idle and within a daily token budget.",
        link: { label: "feature/background-curator", href: `${REPO}/tree/feature/background-curator` },
      },
      {
        title: "Remote view",
        why: "Watch and answer a running session from a browser. Loopback only, behind a token, and off by default. Being built; no pull request yet.",
      },
      {
        title: "A marketplace for skills and MCP servers",
        why: "Read-only, and every entry pinned by content hash so what you install is what was reviewed. Being built; no pull request yet.",
      },
      {
        title: "A pass in real terminals",
        why: "Every screen checked by eye in iTerm2, Ghostty, Windows Terminal and a 16-colour fallback, with screenshots in the docs.",
      },
    ],
  },
  {
    stage: "next",
    title: "Next",
    blurb: "The work most likely to land in the next releases.",
    items: [
      { title: "A text index behind grep", why: "The code index finds definitions and calls today; the plan adds a trigram text index so grep is fast on a large repository too." },
      { title: "Memories pinned to definitions", why: "A fact can point at a function and go stale when that function's body changes." },
      { title: "Call-graph ranking", why: "Order code search results by how much of the project calls them, not only by words." },
      { title: "The VS Code extension on the Marketplace", why: "It works from a downloaded .vsix today; publishing it means it installs and updates like any extension." },
      { title: "The memory claim, measured again", why: "The first result (memory 3/3, no memory 0/3) is three tasks on a free model. The aim is a larger set of repeated sessions where the second run is the measurement, published with its method." },
      { title: "A review of the curator against real models", why: "It has been tested with scripted models only. Before it ships it needs weeks of real use and a revert path you have seen work." },
      { title: "More agents' transcripts for ingest", why: "mnemo memory ingest reads Claude Code sessions today. Codex and opencode transcripts would let the memory learn from them after the fact." },
      { title: "Skills that cite their evidence", why: "A skill change should point at the sessions that justified it, and a skill that stops helping should be retired." },
      { title: "A clean-machine install test on every OS", why: "A person follows the README on a fresh virtual machine per system, with nothing preinstalled." },
    ],
  },
  {
    stage: "later",
    title: "Later",
    blurb: "Wanted, not yet scheduled.",
    items: [
      { title: "Trace tools", why: "A way to read the redacted per-call logs: mnemo traces." },
      { title: "A sandbox", why: "Decided: an OS sandbox is deliberately skipped for now, because it needs a native helper per system that cannot be tested here. The permission gate filters; it is not a sandbox, and the docs keep saying so." },
      { title: "A retrieval upgrade", why: "Switch the memory sidecar to its approximate-nearest-neighbour path when a project's memory grows past a size where it pays." },
    ],
  },
  {
    stage: "unreleased",
    title: "Merged, in the next release",
    blurb: "On the main branch and tested, but not yet in a downloadable release (the newest is 0.1.8).",
    items: [
      { badge: "main", title: "A code index for the agent", why: "code_search, code_symbol, code_refs and code_map answer where something is defined and what calls it, and after an edit the agent is told what elsewhere calls what it changed. Two settings, codeIndex and codeImpact, turn it down.", link: { label: "Pull request #66", href: `${REPO}/pull/66` } },
      { badge: "main", title: "Commands get an allowlisted environment", why: "bash and the Python kernel no longer inherit your whole environment, only a short list. passEnv names more. MCP servers over stdio get the same list, and MCP over HTTP stays off unless your own mcp.json says allowNetwork.", link: { label: "Pull requests #53 and #61", href: `${REPO}/pull/61` } },
      { badge: "main", title: "Managed policy and network egress rules", why: "A policy file user and project settings cannot widen, and outbound rules that refuse cloud metadata addresses by default.", link: { label: "Pull requests #52 and #58", href: `${REPO}/pull/58` } },
      { badge: "main", title: "Deny rules hold inside the Python tool", why: "A path the gate refuses in bash is refused in a Python cell too.", link: { label: "Pull request #50", href: `${REPO}/pull/50` } },
      { badge: "main", title: "Plan mode asks before it plans", why: "Clarifying questions with choices, answered before a plan is written.", link: { label: "Pull request #57", href: `${REPO}/pull/57` } },
      { badge: "main", title: "--model, and a provider's preferred model", why: "Pick the model on the command line. Bedrock is no longer the default because one AWS variable is set, and a provider starts on its preferred model.", link: { label: "Pull requests #51 and #63", href: `${REPO}/pull/63` } },
      { badge: "main", title: "Stop at the first 401, 402 or 403", why: "A refused key or an empty balance ends the run with the reason instead of retrying.", link: { label: "Pull request #49", href: `${REPO}/pull/49` } },
      { badge: "main", title: "mnemo -p says where it works", why: "When the folder has unfinished work or no git, a headless run says so up front.", link: { label: "Pull request #64", href: `${REPO}/pull/64` } },
    ],
  },
  {
    stage: "shipped",
    title: "Shipped",
    blurb: "Done, in the release named.",
    items: [
      { title: "A VS Code extension, MCP servers as tools, a wider /rewind, a prompt budget", why: "mnemo --rpc for editors, MCP through the permission gate, shell changes rewound, a dollar cap per prompt, and nothing a folder chose runs before it is trusted.", in: "0.1.8" },
      { title: "Agents that talk to each other on their own", why: "A message wakes an idle agent, which can answer; bounded at 12 messages in a row and a $0.50 allowance for turns messages start, until you prompt again.", in: "0.1.6" },
      { title: "Type to a running sub-agent; links that survive a restart", why: "A focused sub-agent pane in the split is a prompt to it, and linked projects are linked again when both are open.", in: "0.1.6" },
      { title: "The playground's conversation view", why: "One pair of agents' messages as a thread.", in: "0.1.6" },
      { title: "Agents in teams", why: "Sub-agents that start sub-agents, sibling agents that see and message each other, split layouts and the playground.", in: "0.1.5" },
      { title: "Permission holes from v0.1.3 closed", why: "An approval no longer covers a subcommand that runs something else, and plan mode does not write memory.", in: "0.1.4" },
      { title: "Login, memory and Windows install fixes from a full review", why: "Subscription login in the downloaded binary, memory that stays on, a Windows exe that installs itself, about sixty fixes.", in: "0.1.3" },
      { title: "Install, update and uninstall commands, animated installers", why: "mnemo update, mnemo uninstall --deep and installers that draw themselves.", in: "0.1.2" },
      { title: "Provider keys kept out of agent commands; a bounded Python kernel", why: "The model's commands no longer inherit your API keys.", in: "0.1.2" },
      { title: "Rewind, with a checkpoint before each edit", why: "Go back to an earlier message, the files, or both.", in: "0.1.2" },
      { title: "Trust-weighted recall, memory tidy, edit in the memory pane, your own embedder", why: "What helped ranks higher; duplicates and stale facts get retired.", in: "0.1.2" },
      { title: "ctrl+k palette, ctrl+f search, /resume search, /stats, clickable links, notifications", why: "Find and reach things faster.", in: "0.1.2" },
      { title: "Eleven themes and full-terminal animations", why: "Mnemo Night to Paper, filling the whole window.", in: "0.1.2" },
      { title: "Engram in more places", why: "Boot, welcome card, empty transcript.", in: "0.1.1" },
      { title: "The first public release", why: "Memory, skills, kernel, sub-agents, best-of-n, escalation, several agents at once, four permission modes, one-line installers.", in: "0.1.0" },
    ],
  },
  {
    stage: "wont",
    title: "Not planned",
    blurb: "Said plainly so nobody waits for it.",
    items: [
      { title: "Telemetry", why: "There is none and there will not be. The only network traffic is your model provider and what you start yourself." },
      { title: "Hosted memory", why: "Memory stays on your machine. Syncing it through a service we run is not the plan." },
      { title: "The previous Go and Node stack", why: "It lives on the legacy branch and is not maintained." },
    ],
  },
];
