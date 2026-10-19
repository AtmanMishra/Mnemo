/**
 * What the user can tune, in one place: each setting's name, bounds and default,
 * how a typed value becomes a valid one, and where the choices are kept.
 *
 * Every default is what Mnemo did before there was a menu, so an empty file changes
 * nothing. Only choices that differ from the default are written, to `config.json` in
 * the Mnemo home (mode 0600), apart from the theme and the update check, which stay
 * in `state.json` where `mnemo update --auto` already puts them. A value that does not
 * parse or is out of range is ignored on load (the default stands), never clamped
 * silently into something the user did not pick.
 *
 * What a setting cannot do: none of them loosens the permission gate. The default
 * mode offers `default` and `plan` only; `yolo` and `accept-edits` stay a choice made
 * in a session (`--yolo`, shift+tab), never a thing a file can switch on at launch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Limits } from "./roster.ts";

export const THEME_NAMES = ["night", "gameboy", "paper", "dracula", "nord", "gruvbox", "tokyo", "mocha", "solarized", "amber", "synthwave"] as const;
export const LAYOUT_CHOICES = ["auto", "grid", "cols", "rows", "main-left"] as const;
export const MODE_CHOICES = ["default", "plan"] as const;

/** Things a key can be bound to, with the chord each has today. */
export const KEY_DEFAULTS = {
  "keys.palette": "ctrl+k",
  "keys.sidebar": "ctrl+b",
  "keys.find": "ctrl+f",
  "keys.expand": "ctrl+o",
  "keys.clear": "ctrl+l",
  "keys.thinking": "ctrl+t",
  "keys.hub": "ctrl+g",
  "keys.playground": "ctrl+y",
  "keys.projects": "ctrl+p",
  "keys.newAgent": "ctrl+n",
  "keys.split": "ctrl+s",
  "keys.layout": "alt+l",
  "keys.prevAgent": "alt+,",
  "keys.nextAgent": "alt+.",
} as const;

export type KeyAction = keyof typeof KEY_DEFAULTS;

export interface Settings extends Record<KeyAction, string> {
  // Look
  theme: (typeof THEME_NAMES)[number];
  motion: boolean;
  bootAnimation: boolean;
  mouse: boolean;
  wheelRows: number;
  sidebar: boolean;
  sidebarWidth: number;
  splitLayout: (typeof LAYOUT_CHOICES)[number];
  expandOutput: boolean;
  toastSeconds: number;
  toastMax: number;
  // Behaviour
  mode: (typeof MODE_CHOICES)[number];
  reflect: boolean;
  verify: boolean;
  escalateModel: string;
  escalateAfter: number;
  kernelTimeout: number;
  kernelMaxTimeout: number;
  runSpend: number;
  passEnv: string;
  // Agents
  maxDepth: number;
  maxChildren: number;
  maxLive: number;
  hops: number;
  wakeSpend: number;
  replyWait: number;
  messageChars: number;
  sendsPerMinute: number;
  inbox: number;
  // Notifications and updates
  notify: boolean;
  notifyAfter: number;
  autoUpdate: boolean;
}

export type SettingKey = keyof Settings;
export type Group = "Look" | "Behaviour" | "Agents" | "Notifications" | "Keys";

export interface Def {
  group: Group;
  label: string;
  help: string;
  kind: "bool" | "int" | "number" | "enum" | "text" | "chord";
  default: Settings[SettingKey];
  min?: number;
  max?: number;
  unit?: string;
  options?: readonly string[];
  /** Takes effect at the next launch (or the next conversation), not at once. */
  restart?: boolean;
}

const bool = (group: Group, label: string, help: string, def: boolean, restart = false): Def => ({ group, label, help, kind: "bool", default: def, restart });
const int = (group: Group, label: string, help: string, def: number, min: number, max: number, unit?: string, restart = false): Def => ({
  group,
  label,
  help,
  kind: "int",
  default: def,
  min,
  max,
  unit,
  restart,
});
const keyDef = (label: string, action: KeyAction, help: string): Def => ({ group: "Keys", label, help, kind: "chord", default: KEY_DEFAULTS[action] });

/** In menu order. */
export const DEFS: Record<SettingKey, Def> = {
  theme: { group: "Look", label: "Theme", help: "the palette", kind: "enum", default: "night", options: THEME_NAMES },
  motion: bool("Look", "Animation", "pixel art, the working indicator and the memory graph move", true, true),
  bootAnimation: bool("Look", "Launch sequence", "the boot animation when Mnemo starts", true, true),
  mouse: bool("Look", "Mouse wheel", "the wheel scrolls the conversation (off: your terminal selects text)", true),
  wheelRows: int("Look", "Wheel speed", "lines the conversation moves per wheel notch", 3, 1, 20, "lines"),
  sidebar: bool("Look", "Sidebar open", "start with the sidebar (files, memory, sessions) shown", true, true),
  sidebarWidth: int("Look", "Sidebar width", "columns the sidebar takes", 34, 24, 60, "columns"),
  splitLayout: { group: "Look", label: "Split layout", help: "how split panes are arranged (auto picks by terminal width)", kind: "enum", default: "auto", options: LAYOUT_CHOICES },
  expandOutput: bool("Look", "Expand output", "start with tool output fully shown (ctrl+o toggles it)", false),
  toastSeconds: { group: "Look", label: "Toast time", help: "seconds a notice from another agent stays", kind: "number", default: 4.5, min: 1, max: 30, unit: "s" },
  toastMax: int("Look", "Toasts at once", "how many notices show together", 3, 1, 6),

  mode: { group: "Behaviour", label: "Default mode", help: "how much Mnemo may do without asking (bypass modes are never a default)", kind: "enum", default: "default", options: MODE_CHOICES, restart: true },
  reflect: bool("Behaviour", "Learn after runs", "write durable facts to memory after each run (--no-reflect overrides)", true),
  verify: bool("Behaviour", "Check changed code", "send a run that changed code back to run a check (--no-verify overrides)", true),
  escalateModel: { group: "Behaviour", label: "Escalation model", help: "provider/id to finish a run on after failed checks; empty for none", kind: "text", default: "" },
  escalateAfter: int("Behaviour", "Escalate after", "failed checks in one run before escalating", 2, 1, 10, "checks"),
  kernelTimeout: int("Behaviour", "Python cell time", "seconds a Python cell may run when it names no limit", 120, 5, 3600, "s"),
  kernelMaxTimeout: int("Behaviour", "Python cell ceiling", "the longest a Python cell may ask to run", 600, 5, 3600, "s"),
  runSpend: { group: "Behaviour", label: "Run budget", help: "dollars one prompt may spend, sub-agents included, before Mnemo stops it (0: no limit)", kind: "number", default: 0, min: 0, max: 1000, unit: "$" },
  passEnv: { group: "Behaviour", label: "Pass to commands", help: "variables bash and Python also get, comma-separated, such as GITHUB_TOKEN, SSH_AUTH_SOCK (they get no tokens otherwise)", kind: "text", default: "" },

  maxDepth: int("Agents", "Sub-agent depth", "how deep sub-agents nest (0: none; raising it reaches conversations opened after)", 3, 0, 6),
  maxChildren: int("Agents", "Sub-agents per agent", "live sub-agents one agent may have", 4, 1, 16),
  maxLive: int("Agents", "Sub-agents per conversation", "live sub-agents under one conversation, at any depth", 16, 1, 64),
  hops: int("Agents", "Message chain", "messages agents may pass in a row before waiting for you", 12, 1, 100, "messages"),
  wakeSpend: { group: "Agents", label: "Woken-turn budget", help: "dollars an agent may spend on turns that messages start, between your prompts (0: messages never wake it)", kind: "number", default: 0.5, min: 0, max: 100, unit: "$" },
  replyWait: int("Agents", "Reply wait", "seconds an agent waits for an answer it asked another agent for", 120, 5, 900, "s"),
  messageChars: int("Agents", "Message length", "characters in one agent-to-agent message", 2000, 100, 20000, "chars"),
  sendsPerMinute: int("Agents", "Message rate", "messages one agent may send per minute", 30, 1, 300),
  inbox: int("Agents", "Held messages", "messages an agent may hold for your next prompt", 20, 1, 200),

  notify: bool("Notifications", "Desktop notice", "tell the terminal when a long turn ends or Mnemo asks, while it is in the background (MNEMO_NOTIFY=0 overrides)", true, true),
  notifyAfter: int("Notifications", "Notify after", "a turn must run this long to notify", 20, 0, 3600, "s"),
  autoUpdate: bool("Notifications", "Update check", "once a day at launch, ask GitHub whether a newer Mnemo exists (never installs)", false, true),

  "keys.palette": keyDef("Palette", "keys.palette", "go to a command, agent, session or file; in the prompt, only while it is empty"),
  "keys.sidebar": keyDef("Sidebar", "keys.sidebar", "show or hide the sidebar"),
  "keys.find": keyDef("Find", "keys.find", "find in the conversation"),
  "keys.expand": keyDef("Expand output", "keys.expand", "expand thinking and tool output"),
  "keys.clear": keyDef("Clear screen", "keys.clear", "clear the screen"),
  "keys.thinking": keyDef("Thinking level", "keys.thinking", "cycle the thinking level"),
  "keys.hub": keyDef("Hub", "keys.hub", "the hub: a card per agent"),
  "keys.playground": keyDef("Playground", "keys.playground", "the playground: every agent and the messages between them"),
  "keys.projects": keyDef("Switch project", "keys.projects", "switch project, or open one by typing its path"),
  "keys.newAgent": keyDef("New agent", "keys.newAgent", "another agent on this project, in parallel"),
  "keys.split": keyDef("Split view", "keys.split", "split the screen between agents"),
  "keys.layout": keyDef("Next layout", "keys.layout", "in a split, the next layout"),
  "keys.prevAgent": keyDef("Previous agent", "keys.prevAgent", "previous agent (every pane, in a split)"),
  "keys.nextAgent": keyDef("Next agent", "keys.nextAgent", "next agent (every pane, in a split)"),
};

export const SETTING_KEYS = Object.keys(DEFS) as SettingKey[];
export const GROUPS: Group[] = ["Look", "Behaviour", "Agents", "Notifications", "Keys"];

export function defaults(): Settings {
  return Object.fromEntries(SETTING_KEYS.map((k) => [k, DEFS[k].default])) as unknown as Settings;
}

/** The roster's caps, from the settings that name them. */
export function limitsOf(s: Settings): Partial<Limits> {
  return { maxDepth: s.maxDepth, maxChildren: s.maxChildren, maxLive: s.maxLive, hops: s.hops, wakeSpend: s.wakeSpend, runSpend: s.runSpend, messageChars: s.messageChars, sendsPerWindow: s.sendsPerMinute, inbox: s.inbox };
}

export const isKey = (k: string): k is SettingKey => Object.hasOwn(DEFS, k);

// ── chords ──────────────────────────────────────────────────────────────────

/** Line editing and signals the prompt owns; a binding on one of these would eat it. */
const CTRL_RESERVED = new Set(["c", "d", "a", "e", "u", "w", "h", "i", "j", "m", "z"]);
/** Word motion in the prompt. */
const ALT_RESERVED = new Set(["b", "f"]);

/** `Ctrl+O` → `ctrl+o`; undefined when it is not a chord Mnemo can bind. */
export function normalizeChord(text: string, action?: KeyAction): string | undefined {
  const m = /^(ctrl|alt)\s*\+\s*(.)$/i.exec(text.trim());
  if (!m) return undefined;
  const mod = m[1]!.toLowerCase();
  const ch = m[2]!.toLowerCase();
  // ctrl+k kills to the end of the line; only the palette (which yields to it on a typed prompt) may share it.
  if (mod === "ctrl") return /^[a-z]$/.test(ch) && !CTRL_RESERVED.has(ch) && (ch !== "k" || action === "keys.palette") ? `ctrl+${ch}` : undefined;
  return /^[a-z,./;-]$/.test(ch) && !ALT_RESERVED.has(ch) ? `alt+${ch}` : undefined;
}

/** What Ink reports for a key press, as much as a chord needs. */
export interface KeyPress {
  ctrl?: boolean;
  meta?: boolean;
}

export function chordMatches(chord: string, input: string, key: KeyPress): boolean {
  const [mod, ch] = [chord.slice(0, chord.indexOf("+")), chord.slice(chord.indexOf("+") + 1)];
  return input === ch && (mod === "ctrl" ? !!key.ctrl : !!key.meta);
}

/** The chord as a tight footer shows it: `^g` for `ctrl+g`. */
export const caret = (chord: string): string => (chord.startsWith("ctrl+") ? `^${chord.slice(5)}` : chord);

// ── values ──────────────────────────────────────────────────────────────────

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const YES = ["on", "true", "yes", "y", "1", "enabled"];
const NO = ["off", "false", "no", "n", "0", "disabled"];

/** A typed value for `key`, or why it is not one. */
export function parseValue(key: SettingKey, raw: unknown): Parsed<Settings[SettingKey]> {
  const def = DEFS[key];
  const text = typeof raw === "string" ? raw.trim() : raw;
  switch (def.kind) {
    case "bool": {
      if (typeof text === "boolean") return { ok: true, value: text };
      const t = String(text).toLowerCase();
      if (YES.includes(t)) return { ok: true, value: true };
      if (NO.includes(t)) return { ok: true, value: false };
      return { ok: false, error: `${key} is on or off` };
    }
    case "int":
    case "number": {
      const n = typeof text === "number" ? text : typeof text === "string" && /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : Number.NaN;
      if (!Number.isFinite(n) || (def.kind === "int" && !Number.isInteger(n))) return { ok: false, error: `${key} is ${def.kind === "int" ? "a whole number" : "a number"}` };
      if (n < def.min! || n > def.max!) return { ok: false, error: `${key} is between ${def.min} and ${def.max}` };
      return { ok: true, value: n };
    }
    case "enum": {
      const t = String(text).toLowerCase();
      const hit = def.options!.find((o) => o.toLowerCase() === t);
      return hit ? { ok: true, value: hit } : { ok: false, error: `${key} is one of ${def.options!.join(", ")}` };
    }
    case "text": {
      const t = String(text ?? "");
      if (t === "") return { ok: true, value: "" };
      if (key === "escalateModel" && !/^[\w.-]+\/[\w.:/@+-]+$/.test(t)) return { ok: false, error: "escalateModel is provider/model-id, or empty" };
      if (key === "passEnv" && !/^\s*[A-Za-z_]\w*(\s*,\s*[A-Za-z_]\w*)*\s*$/.test(t)) return { ok: false, error: "passEnv is variable names separated by commas, or empty" };
      return t.length <= 100 ? { ok: true, value: t } : { ok: false, error: `${key} is at most 100 characters` };
    }
    case "chord": {
      const c = typeof text === "string" ? normalizeChord(text, key as KeyAction) : undefined;
      return c ? { ok: true, value: c } : { ok: false, error: `${key} is ctrl+<letter> or alt+<letter, comma, period, slash, semicolon or dash>; line-editing keys (including ctrl+k) and alt+b/f are taken` };
    }
  }
}

/** The action another key already holds `chord`, if any. */
export function chordTakenBy(settings: Settings, key: KeyAction, chord: string): KeyAction | undefined {
  return (Object.keys(KEY_DEFAULTS) as KeyAction[]).find((k) => k !== key && settings[k] === chord);
}

/** Settings from whatever was read off disk: each good value kept, every other one its default. */
export function sanitize(raw: unknown): Settings {
  const out = defaults() as unknown as Record<string, unknown>;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      if (!isKey(k)) continue;
      const p = parseValue(k, v);
      if (p.ok) out[k] = p.value;
    }
  }
  const s = out as unknown as Settings;
  // Two actions on one chord make both unreachable: all bindings go back rather than guessing which to keep.
  const chords = (Object.keys(KEY_DEFAULTS) as KeyAction[]).map((k) => s[k]);
  if (new Set(chords).size !== chords.length) for (const k of Object.keys(KEY_DEFAULTS) as KeyAction[]) s[k] = KEY_DEFAULTS[k];
  // The ceiling is never below the default a cell gets.
  if (s.kernelMaxTimeout < s.kernelTimeout) s.kernelMaxTimeout = s.kernelTimeout;
  return s;
}

/** Set `key` from a typed value: the new settings, or why not. */
export function change(current: Settings, key: SettingKey, raw: unknown): Parsed<Settings> {
  const p = parseValue(key, raw);
  if (!p.ok) return p;
  if (key in KEY_DEFAULTS) {
    const other = chordTakenBy(current, key as KeyAction, p.value as string);
    if (other) return { ok: false, error: `${p.value} already does "${DEFS[other].label}"; rebind that first` };
  }
  const next = { ...current, [key]: p.value } as Settings;
  if (key === "kernelTimeout" && next.kernelMaxTimeout < next.kernelTimeout) return { ok: false, error: "kernelTimeout cannot be above kernelMaxTimeout" };
  if (key === "kernelMaxTimeout" && next.kernelMaxTimeout < next.kernelTimeout) return { ok: false, error: "kernelMaxTimeout cannot be below kernelTimeout" };
  return { ok: true, value: next };
}

/** A value as the menu and `mnemo settings` show it. */
export function showValue(key: SettingKey, value: Settings[SettingKey]): string {
  const def = DEFS[key];
  if (def.kind === "bool") return value ? "on" : "off";
  if (def.kind === "text") return value === "" ? "none" : String(value);
  if (key === "wakeSpend") return `$${(value as number).toFixed(2)}`;
  return def.unit && def.kind !== "chord" ? `${value} ${def.unit}` : String(value);
}

// ── storage ─────────────────────────────────────────────────────────────────

/** Settings that live in `state.json`, where the update check and the theme command already write them. */
const IN_STATE: ReadonlySet<SettingKey> = new Set<SettingKey>(["theme", "autoUpdate"]);

const configFile = (home: string) => path.join(home, "config.json");
const stateFile = (home: string) => path.join(home, "state.json");

function readJson(file: string): Record<string, unknown> {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Written beside, then moved over: a crash leaves the old file, never half of a new one.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function loadSettings(home: string): Settings {
  const state = readJson(stateFile(home));
  return sanitize({ ...readJson(configFile(home)), ...(state.theme !== undefined && { theme: state.theme }), ...(state.autoUpdate !== undefined && { autoUpdate: state.autoUpdate }) });
}

/** Write every setting that differs from its default (and clear the ones that no longer do). */
export function saveSettings(home: string, s: Settings): void {
  const own: Record<string, unknown> = {};
  for (const k of SETTING_KEYS) if (!IN_STATE.has(k) && s[k] !== DEFS[k].default) own[k] = s[k];
  if (Object.keys(own).length) writeJson(configFile(home), own);
  else fs.rmSync(configFile(home), { force: true });
  const state = readJson(stateFile(home));
  // state.json is shared with the rest of Mnemo: touched only when one of its two settings moved.
  let moved = false;
  for (const k of ["theme", "autoUpdate"] as const) {
    if (s[k] === (state[k] ?? DEFS[k].default)) continue;
    state[k] = s[k];
    moved = true;
  }
  if (moved) writeJson(stateFile(home), state);
}

/** The live settings: one object every part of the program reads, and tells when it changes. */
export class SettingsStore {
  private value: Settings;
  private listeners = new Set<(key: SettingKey | undefined) => void>();

  constructor(
    initial: Settings = defaults(),
    private readonly save?: (s: Settings) => void,
  ) {
    this.value = initial;
  }

  get = (): Settings => this.value;

  subscribe = (fn: (key: SettingKey | undefined) => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Set one setting from a typed value; the error says why not. */
  set(key: SettingKey, raw: unknown): Parsed<Settings> {
    const next = change(this.value, key, raw);
    if (!next.ok) return next;
    return this.commit(next.value, key);
  }

  /** One setting back to its default, or all of them. */
  reset(key?: SettingKey): Settings {
    const next = key ? ({ ...this.value, [key]: DEFS[key].default } as Settings) : defaults();
    const done = this.commit(next, key);
    return done.ok ? done.value : this.value;
  }

  private commit(next: Settings, key: SettingKey | undefined): Parsed<Settings> {
    try {
      this.save?.(next);
    } catch (e) {
      return { ok: false, error: `could not save: ${e instanceof Error ? e.message : String(e)}` };
    }
    this.value = next;
    for (const l of this.listeners) l(key);
    return { ok: true, value: next };
  }
}

/** The settings kept in `home`. */
export function openSettings(home: string): SettingsStore {
  return new SettingsStore(loadSettings(home), (s) => saveSettings(home, s));
}
