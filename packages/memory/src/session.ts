/**
 * The memory loop, for any agent.
 *
 * An agent — Mnemo's own, a Claude Code hook, a transcript being replayed —
 * drives one `MemorySession` per conversation with a few verbs:
 *
 *   begin / recall   at the start of each run: the episode exists, and (for
 *                    recall) the profiles and what search finds for this
 *                    message come back as text for the model (audit F3)
 *   toolStart/End    every tool call is logged with its subject; a failure
 *                    steers memory once per distinct failure, counted across
 *                    sessions on one marker (F5), with no gap node (F6)
 *   text             the agent's words, so reused recall earns a vote (F14)
 *   end              after the run: a clean run reinforces its feeders, then
 *                    one grounded reflection writes the session record (F11),
 *                    the facts the user stated or a tool showed (F16), the
 *                    fixes that resolved failures (F21) and — when a reusable
 *                    procedure was shown — a skill (L3)
 *
 * Everything written is attached to the project (F10, F12) and the episode
 * records which agent and model produced it, so knowledge learned from one
 * agent can be weighed when another uses it. Memory never breaks the agent's
 * loop: every call is best-effort.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Credit } from "./credit.ts";
import { projectIdentity, type ProjectIdentity } from "./project.ts";
import { redact } from "./redact.ts";
import { unsafeMemory } from "./safety.ts";
import { describeHit, hitLine, profileBlock, recallMessage } from "./recall.ts";
import { digest, parseReflection, REFLECT_PROMPT, worthReflecting, type Reflection, type ToolEvent } from "./reflect.ts";
import { factValue, factsOf, type MemoryService, type ProfileFact } from "./service.ts";
import { renderSkill, skillPath, writeSkill, type SkillScope } from "./skills.ts";

/** What memory tells the person, for whatever interface the agent has. */
export type MemoryNote =
  | { kind: "recall"; items: string[] }
  | { kind: "learned"; items: string[] }
  | { kind: "steer"; text: string }
  | { kind: "skill"; text: string }
  | { kind: "session"; text: string; items: string[] }
  | { kind: "failed"; text: string };

/** A skill memory would like to write, offered to whoever may approve it. */
export interface SkillOffer {
  name: string;
  scope: SkillScope;
  file: string;
  body: string;
  reason: string;
  /** A correction to an existing skill, not a new one. */
  patch?: boolean;
}

/** Who produced what this session learns. */
export interface Source {
  /** "mnemo", "claude-code", "codex", … */
  agent: string;
  model?: string;
}

/** One model call: system prompt and user message in, text out. Throws on failure. */
export type Reflector = (system: string, user: string) => Promise<string>;

export interface SessionOptions {
  memory: MemoryService;
  cwd: string;
  /** Where a personal (user-scope) skill is written. */
  userSkillsDir: string;
  source?: Source;
  /** A sub-agent's episode is part of its parent's. */
  parentEpisode?: number;
  /** Absent: no reflection (a sub-agent, a headless run with reflection off). */
  reflect?: Reflector;
  notify?: (note: MemoryNote) => void;
  /** Asked before a skill file is written; absent means skills stay candidates. */
  approveSkill?: (offer: SkillOffer) => Promise<boolean>;
  /** A skill file was written: the agent should reload its skills. */
  skillsChanged?: () => void;
}

export interface Recalled {
  /** For the system prompt: the directive and the profiles. Stable across runs. */
  system: string;
  /** For this message only: what search found, and the last session on the first run. */
  message?: string;
  /** One line per thing recalled, for a person to see. */
  items: string[];
}

export interface RunEnd {
  messages: readonly unknown[];
  /** What the user said outside the chat (a refusal with a reason). */
  signals?: readonly string[];
}

const REFUSAL = /declined this call|Refused by a rule|Plan mode is read-only|The user doesn't want to proceed/;

export function subjectOf(args: Record<string, unknown>): string {
  return String(args.command ?? args.path ?? args.file_path ?? args.pattern ?? args.query ?? args.task ?? args.name ?? "")
    .split("\n")[0]!
    // `cd /the/project && npm test` is about `npm test`: the path only hides it.
    .replace(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*/, "")
    .slice(0, 200);
}

/** A command that checks work: tests, types, lint, a build. */
export const VERIFY = /\b(test|tests|vitest|jest|mocha|pytest|tox|tsc|typecheck|lint|eslint|biome|ruff|mypy|clippy|check|build|make)\b/i;
const DOCS = /\.(md|mdx|txt|rst|adoc)$/i;
const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Whether a command is the one a failure was about: the failure names it, or
 * one step of the command line (split on && ; | and with a leading cd and
 * trailing redirections dropped) is the command that failed.
 */
export function sameCommand(command: string, failure: string): boolean {
  const failed = /^\w+\((.+?)\) failed:/.exec(failure)?.[1];
  // A marker that names its command is matched on that command only: its
  // error text may quote the remedy ("run sh scripts/setup.sh first").
  if (!failed) return normalize(failure).includes(command);
  if (failed.length < 4) return false;
  const want = normalize(failed);
  return command
    .split(/&&|\|\||;|\|/)
    .map((step) => normalize(step.replace(/\s+\d?>&?\d?\s*\S*$/, "")))
    .some((step) => step === want);
}

const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9_.-]+/).filter((w) => w.length > 3));

/** The failure a problem statement is about: two or more distinctive words in common, the most wins. */
export function matchPain(problem: string, pains: readonly { node: number; text: string }[]): number | undefined {
  const want = words(problem);
  let best: { node: number; shared: number } | undefined;
  for (const p of pains) {
    const shared = [...words(p.text)].filter((w) => want.has(w)).length;
    if (shared >= 2 && shared > (best?.shared ?? 0)) best = { node: p.node, shared };
  }
  return best?.node;
}

export class MemorySession {
  readonly identity: ProjectIdentity;
  private readonly mem: MemoryService;
  private project: number | undefined;
  private userNode: number | undefined;
  private episodeId: number | undefined;
  private creating: Promise<number | undefined> | undefined;
  private systemText: string | undefined;
  private firstRun = true;
  private readonly linked = new Set<number>();
  /** This run's failure markers, with the failure text a fix is matched against. */
  private pains: { node: number; text: string }[] = [];
  private readonly credit = new Credit();
  private toolLog: ToolEvent[] = [];
  private readonly files = new Set<string>();
  /** Skills read in this run: name → the SKILL.md file. */
  private readonly skillsRead = new Map<string, string>();
  private runFailed = false;
  private nudged = false;
  /** Pitfalls already pointed out in this session: the guard speaks once each. */
  private readonly warned = new Set<number>();

  constructor(private o: SessionOptions) {
    this.mem = o.memory;
    this.identity = projectIdentity(o.cwd);
  }

  get episode(): number | undefined {
    return this.episodeId;
  }

  /**
   * The model working this session changed (an escalation): what is learned
   * from here on is attributed to it, and the episode says it happened.
   */
  async modelChanged(model: string, reason: string): Promise<void> {
    if (this.o.source) this.o.source = { ...this.o.source, model };
    if (this.episodeId !== undefined) {
      await this.mem.fact(this.episodeId, "escalated", `${model}: ${reason}`).catch(() => {});
      await this.mem.log(this.episodeId, "escalated", `${model}: ${reason}`).catch(() => {});
    }
  }

  private note(n: MemoryNote): void {
    this.o.notify?.(n);
  }

  private ensureEpisode(label: string): Promise<number | undefined> {
    if (this.episodeId !== undefined) return Promise.resolve(this.episodeId);
    this.creating ??= (async () => {
      const id = await this.mem.episode(`task: ${label.replace(/\s+/g, " ").slice(0, 80)}`);
      if (id !== undefined) {
        if (this.project !== undefined) await this.mem.link(id, this.project, "part_of");
        if (this.o.parentEpisode !== undefined) await this.mem.link(id, this.o.parentEpisode, "part_of");
        if (this.o.source) {
          await this.mem.fact(id, "agent", this.o.source.agent);
          if (this.o.source.model) await this.mem.fact(id, "model", this.o.source.model);
        }
        this.episodeId = id;
      }
      return id;
    })();
    return this.creating;
  }

  /** A run starts: fresh run state, and the project, user and episode exist. */
  async begin(prompt: string): Promise<number | undefined> {
    this.runFailed = false;
    this.nudged = false;
    this.pains = [];
    this.toolLog = [];
    this.files.clear();
    this.skillsRead.clear();
    this.project ??= await this.mem.project(this.identity.id, this.identity.root);
    this.userNode ??= await this.mem.userNode();
    return this.ensureEpisode(prompt);
  }

  /** `begin`, plus what memory has to say about this message. */
  async recall(prompt: string): Promise<Recalled> {
    await this.begin(prompt);
    const r = await this.context(prompt, { lastSession: this.firstRun });
    this.firstRun = false;
    return r;
  }

  /**
   * What memory has for a message, without starting a run: for a caller that
   * holds no session state between calls (a hook, an MCP request). Recall is
   * linked to the episode as a feeder only when a run is in progress.
   */
  async context(prompt: string, o: { lastSession?: boolean } = {}): Promise<Recalled> {
    const mem = this.mem;
    this.project ??= await mem.project(this.identity.id, this.identity.root);
    this.userNode ??= await mem.userNode();
    const ep = this.episodeId;
    const profiles = [this.project, this.userNode].filter((n): n is number => n !== undefined);
    const [projectFacts, userFacts, hits] = await Promise.all([
      mem.profile("project", this.identity.id),
      mem.profile("user", this.identity.id),
      mem.recall(prompt, this.project, profiles),
    ]);
    // The profiles are what this session's knowledge rests on: link them
    // as feeders once, so a failure can blame them and a success credit them.
    const knowledge = [...profiles, ...hits.filter((h) => h.area !== "Salience" && h.kind !== "TaskEpisode").map((h) => h.node)];
    if (ep !== undefined)
      for (const node of knowledge)
        if (!this.linked.has(node)) {
          this.linked.add(node);
          await mem.link(node, ep);
        }
    this.credit.recalled(
      hits.map((h) => ({ node: h.node, text: `${h.label} ${factsOf(h.state).map((f) => `${f.key} ${f.value}`).join(" ")}` })),
      prompt,
    );
    const lastSession = o.lastSession ? projectFacts.find((f) => f.key === "last session")?.value : undefined;
    this.systemText ??= profileBlock(projectFacts, userFacts, this.identity.name);
    const items = [
      ...(projectFacts.length ? [`${projectFacts.length} fact${projectFacts.length === 1 ? "" : "s"} about ${this.identity.name}`] : []),
      ...(userFacts.length ? [`${userFacts.length} preference${userFacts.length === 1 ? "" : "s"}`] : []),
      ...(lastSession ? [`last session: ${lastSession}`] : []),
      ...hits.map(hitLine),
    ];
    if (items.length) this.note({ kind: "recall", items });
    return { system: this.systemText, message: hits.length || lastSession ? recallMessage(hits, lastSession) : undefined, items };
  }

  /** Search within this project, rendered for a model. */
  async search(query: string, k = 5): Promise<string> {
    this.project ??= await this.mem.project(this.identity.id, this.identity.root);
    const hits = await this.mem.search(query, k, this.project);
    return hits.length ? hits.map(describeHit).join("\n") : "Nothing in memory matches.";
  }

  /** A fact the agent decided to keep. Throws when it cannot be kept. */
  async remember(scope: "project" | "user", key: string, value: string): Promise<{ superseded: boolean }> {
    if (key.toLowerCase() === "last session") throw new Error("\"last session\" is written by Mnemo from the session record; choose another key");
    const unsafe = unsafeMemory(`${key} ${value}`);
    if (unsafe) throw new Error(`memory refused this: it ${unsafe}`);
    const r = await this.learnFact(scope, key.toLowerCase(), value);
    if (!r) throw new Error("memory is not reachable");
    this.note({ kind: "learned", items: [`${scope} · ${key}: ${value}`] });
    return r;
  }

  private async learnFact(scope: "project" | "user", key: string, value: string) {
    const r = await this.mem.learn(scope, this.identity.id, key, value);
    if (r) {
      this.systemText = undefined;
      // Provenance, on the profile's own log: which agent and model taught it.
      const node = await this.mem.profileNode(scope, this.identity.id);
      if (node !== undefined && this.o.source)
        await this.mem.log(node, "learned", `${key} from ${this.o.source.agent}${this.o.source.model ? `/${this.o.source.model}` : ""}${this.episodeId !== undefined ? ` (episode #${this.episodeId})` : ""}`);
    }
    return r;
  }

  /** Something failed: one marker per distinct failure, counted. */
  async steer(failure: string): Promise<void> {
    if (this.episodeId === undefined) return;
    const r = await this.mem.steer(this.episodeId, failure);
    if (!r?.pain_node) return;
    this.pains.push({ node: r.pain_node, text: failure });
    if (this.project !== undefined) await this.mem.link(r.pain_node, this.project, "part_of");
    const n = r.occurrences ?? 1;
    this.note({ kind: "steer", text: n > 1 ? `has seen this failure ${n} times` : "noted the failure for next time" });
  }

  /**
   * Before a command runs: when this exact command failed before in this
   * project and memory holds the fix, and the fix has not been applied in
   * this run, the reason to stop and apply it first. Said once per pitfall
   * per session — an agent that runs the command anyway is not stopped twice.
   */
  async guard(tool: string, args: Record<string, unknown>): Promise<string | undefined> {
    const command = typeof args.command === "string" ? normalize(args.command) : "";
    if (!command || command.length < 4) return undefined;
    try {
      this.project ??= await this.mem.project(this.identity.id, this.identity.root);
      const hits = await this.mem.search(command, 8, this.project);
      for (const h of hits) {
        if (h.area !== "Salience" || this.warned.has(h.node)) continue;
        const fix = factValue(h.state, "fix");
        const failure = factValue(h.state, "failure") ?? h.label.replace(/^pain: /, "");
        if (!fix || !sameCommand(command, failure)) continue;
        // A failure described in words (no named command) may quote its remedy: the fix itself is never stopped.
        if (!/^\w+\(.+?\) failed:/.test(failure) && normalize(fix).includes(command)) continue;
        // Already applied: a successful call in this run that the fix names.
        if (this.toolLog.some((t) => t.ok && t.subject.length > 3 && fix.includes(t.subject))) continue;
        this.warned.add(h.node);
        return `Memory: \`${command}\` failed before in this project — ${failure.replace(/^\S+\(.*?\) failed: /, "").slice(0, 200)}. Known fix: ${fix}. Apply the fix first, then run it again.`;
      }
    } catch {
      /* memory never breaks the loop */
    }
    return undefined;
  }

  /**
   * After a run, before it is called done: when the run changed code and ran
   * no check after its last change, what to ask the agent to do — once per
   * run. The project's remembered verify command is named when there is one.
   */
  async verifyNudge(): Promise<string | undefined> {
    if (this.nudged) return undefined;
    let lastEdit = -1;
    this.toolLog.forEach((t, i) => {
      if (t.ok && /^(edit|write|multiedit)$/i.test(t.tool) && !DOCS.test(t.subject)) lastEdit = i;
    });
    if (lastEdit < 0) return undefined;
    const checked = this.toolLog.slice(lastEdit + 1).some((t) => /bash|shell|ipy/i.test(t.tool) && VERIFY.test(t.subject));
    if (checked) return undefined;
    this.nudged = true;
    const facts = await this.mem.profile("project", this.identity.id).catch(() => []);
    const known = facts.find((f) => /^(verify|test|check|typecheck) command$/.test(f.key))?.value;
    const files = [...this.files].filter((f) => !DOCS.test(f)).slice(0, 4).join(", ");
    return (
      `Before finishing: you changed ${files || "code"} but ran no check after the last change. ` +
      `Run ${known ? `this project's check (${known})` : "this project's tests or typecheck, whichever it has"} and fix what fails. ` +
      `If there is no way to check this change, say so in one line.`
    );
  }

  toolStart(tool: string, args: Record<string, unknown>): void {
    const file = String(args.path ?? args.file_path ?? "");
    if (tool.toLowerCase() === "read" && file.endsWith("SKILL.md")) this.skillsRead.set(path.basename(path.dirname(file)), path.resolve(this.o.cwd, file));
    for (const node of this.credit.observe(JSON.stringify(args))) void this.mem.markUseful(node).catch(() => {});
  }

  async toolEnd(tool: string, args: Record<string, unknown>, ok: boolean, errorText?: string): Promise<void> {
    const subject = subjectOf(args);
    const error = ok ? undefined : (errorText ?? "").slice(0, 400);
    if (ok && /^(edit|write|multiedit)$/i.test(tool) && subject) this.files.add(subject);
    const refused = !!error && REFUSAL.test(error);
    if (!refused) this.toolLog.push({ tool, subject, ok, error });
    if (this.episodeId === undefined) return;
    try {
      await this.mem.log(this.episodeId, ok ? "tool_call" : "tool_error", `${tool}(${subject.slice(0, 120)})${ok ? "" : `: ${error?.split("\n")[0]}`}`);
      if (!ok && !refused) {
        this.runFailed = true;
        await this.steer(`${tool}(${subject.slice(0, 80)}) failed: ${error?.split("\n").slice(0, 3).join(" ").slice(0, 300)}`);
      }
    } catch {
      /* memory never breaks the loop */
    }
  }

  /** The agent's own words: reused recall earns a usefulness vote. */
  text(text: string): void {
    for (const node of this.credit.observe(text)) void this.mem.markUseful(node).catch(() => {});
  }

  async modelError(message: string): Promise<void> {
    this.runFailed = true;
    await this.steer(message || "the model call failed").catch(() => {});
  }

  /** A run finished (not aborted): credit, skill outcomes, then reflection. */
  async end(run: RunEnd): Promise<void> {
    const mem = this.mem;
    const ep = this.episodeId;
    const failed = this.runFailed;
    const skills = [...this.skillsRead.entries()].flatMap(([name, file]) => {
      try {
        return [{ name, body: fs.readFileSync(file, "utf8") }];
      } catch {
        return [];
      }
    });
    const digestInput = { messages: run.messages, tools: this.toolLog, files: [...this.files], signals: run.signals ?? [], skills };
    if (ep !== undefined && !failed) await mem.good(ep, "run completed without errors");
    for (const name of this.skillsRead.keys()) {
      const node = await mem.findLabel(`skill ${name}`);
      if (node === undefined) continue;
      await mem.log(node, "used", `episode #${ep}: ${failed ? "had failures" : "clean"}`);
      // What the curator reads to tell a skill in use from one nobody needs.
      await mem.fact(node, "last used", new Date().toISOString().slice(0, 10));
    }
    if (!this.o.reflect || !worthReflecting(digestInput)) return;
    const [projectFacts, userFacts] = await Promise.all([mem.profile("project", this.identity.id), mem.profile("user", this.identity.id)]);
    const known = [...projectFacts.map((f) => `project · ${f.key}: ${f.value}`), ...userFacts.map((f) => `user · ${f.key}: ${f.value}`)];
    let answer: string;
    try {
      // Redacted: the run may hold a pasted key, and the reflection model may be a third party's.
      answer = await this.o.reflect(REFLECT_PROMPT, redact(`KNOWN:\n${known.join("\n") || "(nothing yet)"}\n\nRUN:\n${digest(digestInput)}`));
    } catch (error) {
      this.note({ kind: "failed", text: `Reflection failed: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    await this.apply(parseReflection(answer), { projectFacts, userFacts, ep });
  }

  /** The conversation is over. */
  async close(): Promise<void> {
    try {
      if (this.episodeId !== undefined) await this.mem.log(this.episodeId, "outcome", "session ended");
    } catch {
      /* ignore */
    }
  }

  /**
   * A skill this run followed and found wrong: the corrected instructions,
   * offered with the reason; on approval the old version is kept as history.
   * Only a skill this run actually read can be patched.
   */
  private async patchSkill(s: NonNullable<Reflection["skill"]>): Promise<void> {
    const file = this.skillsRead.get(s.name);
    if (!file || !fs.existsSync(file) || !this.o.approveSkill) return;
    const old = fs.readFileSync(file, "utf8");
    const description = /description:\s*(.*)/.exec(old)?.[1]?.replace(/^"|"$/g, "") ?? s.description;
    const body = renderSkill(s.name, description, s.instructions);
    if (body === old) return;
    const reason = `skill ${s.name} needs a fix: ${s.reason || "it did not work as written in this run"}`;
    if (!(await this.o.approveSkill({ name: s.name, scope: s.scope, file, body, reason, patch: true }))) return;
    const history = path.join(path.dirname(this.o.userSkillsDir), "skill-history", s.name);
    fs.mkdirSync(history, { recursive: true });
    fs.writeFileSync(path.join(history, `${new Date().toISOString().replace(/[:.]/g, "-")}.md`), old);
    writeSkill(file, body);
    const node = await this.mem.findLabel(`skill ${s.name}`);
    if (node !== undefined) {
      await this.mem.fact(node, "last change", s.reason || "patched after a run that used it");
      await this.mem.log(node, "patched", `episode #${this.episodeId}: ${s.reason}`);
    }
    this.note({ kind: "skill", text: `patched skill ${s.name}: ${s.reason}` });
    this.o.skillsChanged?.();
  }

  /** True (and said) when text may not be kept: see safety.ts. */
  private refuse(text: string): boolean {
    const why = unsafeMemory(text);
    if (why) this.note({ kind: "failed", text: `Memory refused a learned item: it ${why}` });
    return !!why;
  }

  /** Write what one reflection found. Kept separate so its rules read in one place. */
  private async apply(r: Reflection, ctx: { projectFacts: ProfileFact[]; userFacts: ProfileFact[]; ep: number | undefined }): Promise<void> {
    const mem = this.mem;
    const learned: string[] = [];
    // Facts: only what the user said or a tool showed; a guess is not memory.
    const known = new Map<string, string>([
      ...ctx.projectFacts.map((f): [string, string] => [`project:${f.key}`, f.value]),
      ...ctx.userFacts.map((f): [string, string] => [`user:${f.key}`, f.value]),
    ]);
    for (const f of r.facts) {
      if (f.source === "inferred" || f.key === "last session" || known.get(`${f.scope}:${f.key}`) === f.value) continue;
      if (this.refuse(`${f.key} ${f.value}`)) continue;
      await this.learnFact(f.scope, f.key, f.value);
      learned.push(`${f.scope} · ${f.key}: ${f.value}`);
    }
    if (learned.length) this.note({ kind: "learned", items: learned });
    // The session record, on the episode; and the latest one, on the project.
    if (r.episode && ctx.ep !== undefined) {
      const e = r.episode;
      await mem.fact(ctx.ep, "goal", e.goal);
      await mem.fact(ctx.ep, "outcome", e.outcome);
      if (e.done) await mem.fact(ctx.ep, "done", e.done);
      if (e.decisions.length) await mem.fact(ctx.ep, "decisions", e.decisions.join("; "));
      if (e.open.length) await mem.fact(ctx.ep, "open", e.open.join("; "));
      const day = new Date().toISOString().slice(0, 10);
      await this.learnFact("project", "last session", `${day}: ${e.goal} — ${e.outcome}${e.open.length ? `; open: ${e.open.join("; ")}` : ""}`);
      this.note({ kind: "session", text: `Session ${e.outcome}`, items: [e.goal, ...(e.open.length ? [`open: ${e.open.join("; ")}`] : [])] });
    }
    // Fixes: attach to the failure's marker when we know it; otherwise a pitfall of its own.
    const fixed: string[] = [];
    for (const f of r.fixes.filter((x) => !this.refuse(`${x.problem} ${x.fix}`))) {
      // The fix joins a failure marker only when its problem is clearly that
      // failure; otherwise it is a pitfall of its own, in the model's words.
      let node = matchPain(f.problem, this.pains);
      if (node === undefined) {
        node = await mem.createNode("aspect", `pain: ${f.problem.slice(0, 60)}`, "salience");
        if (node !== undefined) {
          await mem.fact(node, "failure", f.problem);
          if (this.project !== undefined) await mem.link(node, this.project, "part_of");
        }
      }
      if (node !== undefined) {
        await mem.fact(node, "fix", f.fix);
        if (this.o.source) await mem.fact(node, "learned from", `${this.o.source.agent}${this.o.source.model ? `/${this.o.source.model}` : ""}`);
        fixed.push(`${f.problem} → ${f.fix}`);
      }
    }
    if (fixed.length) this.note({ kind: "learned", items: fixed.map((x) => `fix · ${x}`) });
    if (r.skill && !this.refuse(`${r.skill.name} ${r.skill.description} ${r.skill.instructions}`)) await this.proposeSkill(r.skill);
  }

  /**
   * A procedure the run demonstrated. Saved when the user asked for it, or
   * when the same procedure has now been seen in two sessions; otherwise
   * kept as a candidate. Saving needs an approver, shown the file itself;
   * without one nothing is written.
   */
  private async proposeSkill(s: NonNullable<Reflection["skill"]>): Promise<void> {
    const mem = this.mem;
    if (s.patch) return this.patchSkill(s);
    const candidateLabel = `skill candidate ${s.name}`;
    let candidate = await mem.findLabel(candidateLabel);
    let seen = 1;
    if (candidate === undefined) {
      candidate = await mem.createNode("harness", candidateLabel, "procedural");
      if (candidate !== undefined && this.project !== undefined) await mem.link(candidate, this.project, "part_of");
    } else {
      seen = Number(factValue(await mem.state(candidate), "seen") ?? "1") + 1;
    }
    if (candidate !== undefined) {
      await mem.fact(candidate, "seen", String(seen));
      await mem.fact(candidate, "description", s.description);
      await mem.fact(candidate, "instructions", s.instructions.slice(0, 1500));
    }
    if ((await mem.findLabel(`skill ${s.name}`)) !== undefined) return;
    if (!s.explicit && seen < 2) return;
    if (!this.o.approveSkill) return;
    const file = skillPath(s.scope, s.name, { projectRoot: this.identity.root, userSkillsDir: this.o.userSkillsDir });
    const body = renderSkill(s.name, s.description, s.instructions);
    const reason = s.explicit ? "you asked Mnemo to remember how to do this" : `Mnemo has now done this procedure in ${seen} sessions`;
    if (!(await this.o.approveSkill({ name: s.name, scope: s.scope, file, body, reason }))) return;
    writeSkill(file, body);
    const node = await mem.createNode("harness", `skill ${s.name}`, "procedural");
    if (node !== undefined) {
      await mem.fact(node, "use when", s.description);
      await mem.fact(node, "file", file);
      if (s.scope === "project" && this.project !== undefined) await mem.link(node, this.project, "part_of");
    }
    this.note({ kind: "skill", text: `saved skill ${s.name}` });
    this.o.skillsChanged?.();
  }
}
