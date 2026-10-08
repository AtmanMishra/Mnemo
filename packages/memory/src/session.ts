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
import * as path from "node:path";
import { Credit } from "./credit.ts";
import { projectIdentity, type ProjectIdentity } from "./project.ts";
import { redact } from "./redact.ts";
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
    .slice(0, 200);
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
  private readonly painBySubject = new Map<string, number>();
  private readonly credit = new Credit();
  private toolLog: ToolEvent[] = [];
  private readonly files = new Set<string>();
  private readonly skillsRead = new Set<string>();
  private runFailed = false;

  constructor(private readonly o: SessionOptions) {
    this.mem = o.memory;
    this.identity = projectIdentity(o.cwd);
  }

  get episode(): number | undefined {
    return this.episodeId;
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
    this.toolLog = [];
    this.files.clear();
    this.skillsRead.clear();
    this.project ??= await this.mem.project(this.identity.id, this.identity.root);
    this.userNode ??= await this.mem.userNode();
    return this.ensureEpisode(prompt);
  }

  /** `begin`, plus what memory has to say about this message. */
  async recall(prompt: string): Promise<Recalled> {
    const ep = await this.begin(prompt);
    const mem = this.mem;
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
    const lastSession = this.firstRun ? projectFacts.find((f) => f.key === "last session")?.value : undefined;
    this.firstRun = false;
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
  async steer(failure: string, subjectKey?: string): Promise<void> {
    if (this.episodeId === undefined) return;
    const r = await this.mem.steer(this.episodeId, failure);
    if (!r?.pain_node) return;
    if (subjectKey) this.painBySubject.set(subjectKey, r.pain_node);
    if (this.project !== undefined) await this.mem.link(r.pain_node, this.project, "part_of");
    const n = r.occurrences ?? 1;
    this.note({ kind: "steer", text: n > 1 ? `has seen this failure ${n} times` : "noted the failure for next time" });
  }

  toolStart(tool: string, args: Record<string, unknown>): void {
    const file = String(args.path ?? args.file_path ?? "");
    if (tool.toLowerCase() === "read" && file.endsWith("SKILL.md")) this.skillsRead.add(path.basename(path.dirname(file)));
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
        await this.steer(`${tool} failed: ${error?.split("\n").slice(0, 3).join(" ").slice(0, 300)}`, `${tool}(${subject})`);
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
    const digestInput = { messages: run.messages, tools: this.toolLog, files: [...this.files], signals: run.signals ?? [] };
    if (ep !== undefined && !failed) await mem.good(ep, "run completed without errors");
    for (const name of this.skillsRead) {
      const node = await mem.findLabel(`skill ${name}`);
      if (node !== undefined) await mem.log(node, "used", `episode #${ep}: ${failed ? "had failures" : "clean"}`);
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
    for (const f of r.fixes) {
      const words = f.problem.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
      const matched = [...this.painBySubject.entries()].find(([subject]) => words.some((w) => subject.toLowerCase().includes(w)))?.[1];
      let node = matched ?? (this.painBySubject.size === 1 ? [...this.painBySubject.values()][0] : undefined);
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
    if (r.skill) await this.proposeSkill(r.skill);
  }

  /**
   * A procedure the run demonstrated. Saved when the user asked for it, or
   * when the same procedure has now been seen in two sessions; otherwise
   * kept as a candidate. Saving needs an approver, shown the file itself;
   * without one nothing is written.
   */
  private async proposeSkill(s: NonNullable<Reflection["skill"]>): Promise<void> {
    const mem = this.mem;
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
