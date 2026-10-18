/**
 * The extension's decisions, with no `vscode` import so they can be tested
 * alone. `extension.ts` only wires them to the editor.
 */

export type Mode = "default" | "plan";

/**
 * Arguments for a Mnemo terminal. Only `plan` adds a flag: `--yolo` and
 * `--accept-edits` are never passed from here, so an approval prompt cannot be
 * switched off by a setting, a workspace file or this extension.
 */
export function launchArgs(mode: string, resume: boolean): string[] {
  const args: string[] = [];
  if (resume) args.push("--continue");
  if (mode === "plan") args.push("--plan");
  return args;
}

/** Drop control characters (escape sequences, newlines) from text typed into a terminal. */
export function plain(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/ {2,}/g, " ").trim();
}

/**
 * One line that points the agent at code instead of pasting the code in: the
 * terminal is Mnemo's input box, where a newline would submit the prompt and
 * an escape sequence would be read as keys. The agent reads the range through
 * its own tools, so the read goes through the same policy gate as any other.
 * `start`/`end` are 1-based.
 */
export function reference(relPath: string, range?: { start: number; end: number }): string {
  const p = plain(relPath.replace(/\\/g, "/"));
  if (!range) return `Look at ${p}: `;
  const lines = range.start === range.end ? `line ${range.start}` : `lines ${range.start}-${range.end}`;
  return `Look at ${p} ${lines}: `;
}

/** Whether `child` is inside `root` (both absolute, compared as real paths by the caller). */
export function inside(root: string, child: string): boolean {
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
  const r = norm(root);
  const c = norm(child);
  return c === r || c.startsWith(r + "/");
}

/** The workspace-relative path to send, or undefined for a file outside the folder. */
export function relativeTo(root: string, file: string): string | undefined {
  if (!inside(root, file)) return undefined;
  const norm = (s: string) => s.replace(/\\/g, "/");
  return norm(file).slice(norm(root).replace(/\/+$/, "").length + 1);
}

/** Arguments for the background `mnemo --rpc` the panel talks to. */
export function rpcArgs(mode: string, resume: boolean, trustProject: boolean): string[] {
  const args = ["--rpc", ...launchArgs(mode, resume)];
  if (trustProject) args.push("--trust-project");
  return args;
}

/** The commands a webview may send on to Mnemo. Anything else it posts is dropped. */
const FORWARD = new Set(["submit", "interrupt", "answer", "setMode", "cycleThinking", "setSetting", "resetSetting", "memory"]);

/** `msg` as an object safe to forward, or undefined. The webview is our own page, but treat it as input. */
export function forwardable(msg: unknown): Record<string, unknown> | undefined {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return undefined;
  const m = msg as Record<string, unknown>;
  if (typeof m.type !== "string" || !FORWARD.has(m.type)) return undefined;
  if (m.id !== undefined && typeof m.id !== "number") return undefined;
  return m;
}

/** A selection as the text put in the composer: where it is, and the code itself, fenced so it can be edited. */
export function composerDraft(relPath: string, range: { start: number; end: number } | undefined, code: string | undefined, language: string): string {
  const where = reference(relPath, range);
  if (!code) return where;
  let fence = "```";
  while (code.includes(fence)) fence += "`";
  return `${where}\n\n${fence}${plain(language)}\n${code}\n${fence}\n\n`;
}
