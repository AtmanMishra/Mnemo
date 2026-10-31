/**
 * What each run came to, on disk: the measurement every later evolve step reads.
 *
 * A run (one prompt, with its verify follow-up) leaves one line in
 * `$MNEMO_HOME/evolve/outcomes/<project>.jsonl`: the checks it ran after its
 * last edit and whether they passed, refusals, cost, turns, the files it
 * changed, and the git state it started from. Nothing a model says is taken
 * on trust: the verdict comes from the commands that ran and their exit
 * status. Records stay on this machine, redacted, readable by this user only.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { redact, subjectOf, VERIFY } from "@mnemo/memory";

/**
 *   no-edits   changed no file
 *   unchecked  changed files and ran no check after the last change
 *   passed     the last check after the last change passed
 *   failed     the last check after the last change failed
 *   error      the model call failed
 *   stopped    the user stopped it, or a limit did
 */
export type Verdict = "no-edits" | "unchecked" | "passed" | "failed" | "error" | "stopped";

export interface CheckRun {
  /** The command as the agent ran it. */
  command: string;
  ok: boolean;
}

export interface OutcomeRecord {
  v: 1;
  /** ISO time the run ended. */
  at: string;
  project: { id: string; name: string; root: string };
  /** The folder the run worked in, relative to the project root ("" for the root). */
  sub: string;
  session?: string;
  model?: string;
  prompt: string;
  /** The prompt reads as a correction of the run before it ("no, …", "that's wrong"). */
  correction: boolean;
  /** HEAD when the run started, and whether the working tree had no changes then. */
  git?: { head: string; clean: boolean };
  turns: number;
  tools: number;
  toolErrors: number;
  /** Calls the user or a rule refused. */
  refusals: number;
  cost: number;
  tokens: { input: number; output: number };
  /** Files changed, relative to the project root. */
  files: string[];
  /** Checks run after the last change, in order. */
  checks: CheckRun[];
  verdict: Verdict;
  /** One short signature per failed call, to see a failure come back in a later run. */
  failures: string[];
  escalated: boolean;
  ms: number;
  /** The task card this run became (evolve/cards.ts). */
  card?: string;
  /** The version of your profiles, skills and model notes in force (evolve/surface.ts). */
  surface?: string;
}

const REFUSAL = /declined this call|Refused by a rule|Plan mode is read-only|The user doesn't want to proceed/;
const CORRECTION = /^\s*(no\b|nope\b|wrong\b|that'?s (wrong|not (it|right|what))|this is wrong|actually\b|undo\b|revert\b|you (broke|didn'?t|forgot|missed))/i;
const EDIT = /^(edit|write|multiedit)$/i;
const SHELL = /bash|shell/i;

export function isCorrection(prompt: string): boolean {
  return CORRECTION.test(prompt);
}

/** `npm test -- --watch=false` → `bash:npm test`: the tool and the first two words of what it ran. */
export function failureSignature(tool: string, args: Record<string, unknown>): string {
  return `${tool}:${subjectOf(args).split(/\s+/).slice(0, 2).join(" ")}`.toLowerCase();
}

interface Call {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  /** The error, or a shell command's output (its end). */
  text?: string;
}

/**
 * A shell command that may change files: a redirection into a file, a here-document,
 * an in-place edit, a move or delete, a script on stdin. Agents edit with these as
 * often as with the edit tool. A false positive only makes a run look unchecked.
 */
const MUTATES = /<<|(^|[^0-9&])>{1,2}\s*(?!&|\/dev\/null)[^\s|;&]|\b(sed|perl)\s+(-\w*\s+)*-i|\btee\b|(^|[;&|]\s*)(mv|cp|rm|touch|mkdir|patch|truncate|install|ln)\s|\bgit\s+(apply|am|checkout|restore|mv|rm|reset|stash|cherry-pick|merge|rebase)\b|\b(python3?|node|bun|ruby|perl)\s+-[ec]?\s/;

/** A command whose own exit status is hidden: `; echo $?`, `|| true`, piped into tail or grep. */
const MASKED = /;\s*echo\b[^;&|]*\$\?|\|\|\s*(true|:)\s*$|\|\s*(tail|head|grep|tee|cat|less|sed|awk)\b/;

/**
 * Whether a check passed. A command that hides its exit status counts only when its
 * output says the status (`exit=0`, `exit code: 1`); otherwise it is not known.
 */
export function checkPassed(command: string, ok: boolean, output = ""): boolean | undefined {
  if (!ok) return false;
  if (!MASKED.test(command)) return true;
  const said = [...output.matchAll(/\bexit(?:\s*code|\s*status)?\s*[=:]?\s*(\d+)\b/gi)].at(-1);
  return said ? said[1] === "0" : undefined;
}

export function mutates(command: string): boolean {
  return !VERIFY.test(command.split("\n")[0]!.replace(/^cd\s+\S+\s*&&\s*/, "")) && MUTATES.test(command);
}

/** Collects one run from pi's events; `finish` turns it into a record. */
export class RunTracker {
  readonly calls: Call[] = [];
  /** Messages of the part before a verify follow-up. */
  readonly held: unknown[] = [];
  readonly started = Date.now();
  constructor(
    readonly prompt: string,
    readonly git: { head: string; clean: boolean } | undefined,
  ) {}

  call(tool: string, args: Record<string, unknown>, ok: boolean, text?: string): void {
    this.calls.push({ tool, args, ok, text: text?.slice(-2000) });
  }

  finish(o: {
    project: OutcomeRecord["project"];
    cwd: string;
    session?: string;
    model?: string;
    messages: readonly unknown[];
    stopReason?: string;
    escalated: boolean;
    /** Files changed since the run started, from git; more complete than the edit calls. */
    changed?: string[];
  }): OutcomeRecord {
    const refused = (c: Call) => !c.ok && REFUSAL.test(c.text ?? "");
    const isCheck = (c: Call) => SHELL.test(c.tool) && typeof c.args.command === "string" && VERIFY.test(subjectOf(c.args));
    let lastEdit = -1;
    const files = new Set<string>(o.changed ?? []);
    this.calls.forEach((c, i) => {
      if (!c.ok) return;
      if (SHELL.test(c.tool) && typeof c.args.command === "string" && mutates(c.args.command)) lastEdit = i;
      if (!EDIT.test(c.tool)) return;
      const file = String(c.args.path ?? c.args.file_path ?? "");
      if (!file) return;
      lastEdit = i;
      if (!o.changed) files.add(path.relative(o.project.root, path.resolve(o.cwd, file)).split(path.sep).join("/"));
    });
    const checks = this.calls
      .slice(lastEdit + 1)
      .filter((c) => isCheck(c) && !refused(c))
      .flatMap((c) => {
        const command = String(c.args.command);
        const ok = checkPassed(command, c.ok, c.text);
        return ok === undefined ? [] : [{ command: redact(command).slice(0, 500), ok }];
      });
    let turns = 0;
    let cost = 0;
    let input = 0;
    let output = 0;
    for (const m of o.messages as { role?: string; usage?: { input?: number; output?: number; cost?: { total?: number } } }[]) {
      if (m.role !== "assistant") continue;
      turns++;
      cost += m.usage?.cost?.total ?? 0;
      input += m.usage?.input ?? 0;
      output += m.usage?.output ?? 0;
    }
    const verdict: Verdict =
      o.stopReason === "aborted"
        ? "stopped"
        : o.stopReason === "error"
          ? "error"
          : files.size === 0
            ? "no-edits"
            : checks.length === 0
              ? "unchecked"
              : // The last word: a flaky first run that passes on the second is a pass.
                checks.at(-1)!.ok
                ? "passed"
                : "failed";
    return {
      v: 1,
      at: new Date().toISOString(),
      project: o.project,
      sub: path.relative(o.project.root, path.resolve(o.cwd)).split(path.sep).join("/"),
      session: o.session,
      model: o.model,
      prompt: redact(this.prompt).slice(0, 2000),
      correction: isCorrection(this.prompt),
      git: this.git,
      turns,
      tools: this.calls.length,
      toolErrors: this.calls.filter((c) => !c.ok && !refused(c)).length,
      refusals: this.calls.filter(refused).length,
      cost: Math.round(cost * 1e6) / 1e6,
      tokens: { input, output },
      files: [...files].sort(),
      checks,
      verdict,
      failures: [...new Set(this.calls.filter((c) => !c.ok && !refused(c)).map((c) => failureSignature(c.tool, c.args)))],
      escalated: o.escalated,
      ms: Date.now() - this.started,
    };
  }
}

/** The project's file name: a hash, so the folder name carries no part of the user's paths. */
export function projectSlug(projectId: string): string {
  return crypto.createHash("sha256").update(projectId).digest("hex").slice(0, 16);
}

export function evolveDir(home: string): string {
  return path.join(home, "evolve");
}

export function outcomesFile(home: string, projectId: string): string {
  return path.join(evolveDir(home), "outcomes", `${projectSlug(projectId)}.jsonl`);
}

export function appendOutcome(home: string, record: OutcomeRecord): void {
  const file = outcomesFile(home, record.project.id);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

/** Every record for a project, oldest first; a damaged line is skipped. */
export function readOutcomes(home: string, projectId: string): OutcomeRecord[] {
  return readFile(outcomesFile(home, projectId));
}

/** Every record in a home, oldest first. */
export function readAllOutcomes(home: string): OutcomeRecord[] {
  const dir = path.join(evolveDir(home), "outcomes");
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return [];
  }
  return names.flatMap((n) => readFile(path.join(dir, n))).sort((a, b) => a.at.localeCompare(b.at));
}

function readFile(file: string): OutcomeRecord[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: OutcomeRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as OutcomeRecord;
      if (r && r.v === 1 && typeof r.at === "string") out.push(r);
    } catch {
      /* a line cut short by a crash */
    }
  }
  return out;
}
