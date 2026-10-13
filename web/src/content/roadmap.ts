// The roadmap, as the project sees it today. Intent, not a promise: nothing here has a
// date on purpose. Keep it in step with docs/ROADMAP.md (the engineering task list).

export type Stage = "shipped" | "building" | "next" | "later" | "wont";

export interface Item {
  title: string;
  why: string;
  /** The release it shipped in, for the shipped column. */
  in?: string;
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
      { title: "Hooks, schedules and MCP in the app", why: "Run your own commands around the agent's tool calls, run prompts on a schedule, and use MCP servers as tools." },
      { title: "Trace tools", why: "A way to read the redacted per-call logs: mnemo traces." },
      { title: "A sandbox decision", why: "The permission gate filters; it is not a sandbox. Either a real sandbox for the kernel and commands, or a documented reason it stays out." },
      { title: "A retrieval upgrade", why: "Switch the memory sidecar to its approximate-nearest-neighbour path when a project's memory grows past a size where it pays." },
    ],
  },
  {
    stage: "shipped",
    title: "Shipped",
    blurb: "Done, in the release named.",
    items: [
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
