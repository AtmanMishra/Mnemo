/**
 * The events `mnemo --rpc` writes and the commands it reads (see docs/RPC.md in the
 * repository). Types only: both the extension host and the webview import them.
 */

export type Tone = "info" | "warn" | "error";

export type Block =
  | { kind: "welcome"; id: string }
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; done: boolean }
  | { kind: "thinking"; id: string; text: string; done: boolean; startedAt: number; durationMs?: number }
  | { kind: "tool"; id: string; name: string; args: Record<string, unknown>; status: "pending" | "running" | "done" | "error"; output: string; details?: unknown; durationMs?: number }
  | { kind: "notice"; id: string; tone: Tone; text: string; extra?: { code?: string; links?: { url: string; label?: string }[] } }
  | { kind: "memory"; id: string; title: string; items: string[] }
  | { kind: "peer"; id: string; from: number; label: string; text: string };

export type Mode = "default" | "accept-edits" | "plan" | "yolo";

export interface Footer {
  model: string;
  thinking: string;
  contextPercent: number | null;
  cost: number;
  cwd: string;
  branch?: string;
  mode: Mode;
  memory: { nodes: number | null; answering: boolean } | null;
}

export interface CommandInfo {
  name: string;
  description: string;
  source: "builtin" | "extension" | "prompt" | "skill";
}

export interface Choice {
  value: string;
  label: string;
  description?: string;
  keywords?: string;
}

export type Dialog =
  | { id: number; kind: "approval"; tool: string; subject: string; preview: { text: string; tone?: "add" | "remove" | "muted" }[]; always?: string; reason?: string }
  | { id: number; kind: "select"; title: string; choices: Choice[]; initial?: string }
  | { id: number; kind: "confirm"; title: string; message: string }
  | { id: number; kind: "text"; title: string; placeholder?: string; initial?: string; secret?: boolean };

export interface RosterNode {
  id: number;
  kind: "root" | "sub";
  parent?: number;
  label: string;
  task: string;
  access: "read-only" | "full";
  status: "idle" | "running" | "done" | "failed" | "stopped";
  steps: string[];
  stepCount: number;
  answer?: string;
  startedAt: number;
  endedAt?: number;
  woken: boolean;
  wakeSpend: number;
}

export interface SettingDef {
  key: string;
  group: string;
  label: string;
  help: string;
  kind: "bool" | "int" | "number" | "enum" | "text" | "chord";
  default: unknown;
  min?: number;
  max?: number;
  unit?: string;
  options?: string[];
  restart?: boolean;
}

export interface MemoryView {
  available: boolean;
  project?: { key: string; value: string }[];
  user?: { key: string; value: string }[];
  hits?: { node: number; label: string; kind: string; area: string; score: number; state: string }[];
}

export type RpcEvent =
  | { type: "ready"; protocol: number; version: string; cwd: string; hasModel: boolean; commands: CommandInfo[] }
  | { type: "transcript"; reset: boolean; epoch: number; from: number; committed: Block[]; live: Block[]; working: { since: number; tokens: number } | null; queue: string[] }
  | { type: "chrome"; footer: Footer; statuses: [string, string][]; workingMessage?: string; race?: unknown; activity?: { seq: number; kind: string; text: string; ok?: boolean }; draft?: { text: string; seq: number } }
  | { type: "dialog"; dialog: Dialog }
  | { type: "dialogClosed"; id: number }
  | { type: "roster"; nodes: RosterNode[]; self: number }
  | { type: "settings"; values: Record<string, unknown>; defs?: { groups: string[]; items: SettingDef[] } }
  | { type: "result"; id: number; ok: boolean; value?: unknown; error?: string }
  | { type: "error"; message: string };

/** The commands a webview may ask the host to forward; anything else is dropped. */
export const FORWARDED = ["submit", "interrupt", "answer", "setMode", "cycleThinking", "setSetting", "resetSetting", "memory"] as const;
export type Forwarded = (typeof FORWARDED)[number];
