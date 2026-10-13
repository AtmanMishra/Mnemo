/**
 * The background curator: while you are away, it spends a little of your
 * default model on memory itself (the jobs are in @mnemo/memory's maintain.ts):
 *
 *   facts      every 6 h    merge duplicates, retire contradicted facts (applied)
 *   skills     every 12 h   new skills from repeated procedures, fixes for failing
 *                           ones (proposed: /curator review)
 *   resurface  every 2 h    what to put in front of the agent next time (used once,
 *                           by the next recall)
 *
 * It runs only after the agent has been idle for a while (3 minutes), one job
 * at a time across every agent of this process, never past a daily token
 * budget (50k), and stops the moment you type or a turn starts. A job with
 * nothing new to look at (the same facts as last time, no new evidence, no new
 * session) makes no call at all. On by default; /curator off turns it off.
 * State and the review inbox live in $MNEMO_HOME/curator/.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { curateFacts, planTidy, applyTidy, proposeSkillChanges, resurface, type MemoryService, type SkillProposalItem } from "@mnemo/memory";

export type Job = "facts" | "skills" | "resurface";
export const JOBS: Job[] = ["resurface", "facts", "skills"];
const HOUR = 3_600_000;
export const EVERY: Record<Job, number> = { resurface: 2 * HOUR, facts: 6 * HOUR, skills: 12 * HOUR };
export const IDLE_MS = Number(process.env.MNEMO_CURATOR_IDLE_MS ?? 180_000);
export const DAILY_BUDGET = Number(process.env.MNEMO_CURATOR_BUDGET ?? 50_000);

export interface CuratorState {
  enabled?: boolean;
  day?: string;
  tokens?: number;
  /** `${project}:${job}` → when it last ran. */
  last?: Record<string, number>;
  /** `${project}:${job}` → what it last looked at, so an unchanged input costs nothing. */
  basis?: Record<string, string>;
  /** project → items for its next recall. */
  resurfaced?: Record<string, string[]>;
}

export interface CuratorDeps {
  home: string;
  memory: MemoryService;
  projectId: string;
  projectRoot: string;
  project: () => Promise<number | undefined>;
  userSkillsDir: string;
  /** One model call. `tokens`: what it used, for the budget. */
  ask: (system: string, user: string, signal: AbortSignal) => Promise<{ text: string; tokens: number }>;
  /** Whether the agent is working or waiting on you (then the curator waits too). */
  busy: () => boolean;
  /** What a pass did, for the transcript. */
  report: (title: string, items: string[]) => void;
  now?: () => number;
}

/** One job at a time in this process, whichever agent's curator wants it. */
let running = false;

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

export class Curator {
  #lastActivity: number;
  #abort?: AbortController;
  #timer?: ReturnType<typeof setInterval>;
  constructor(private readonly d: CuratorDeps) {
    this.#lastActivity = this.now();
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }
  private get dir(): string {
    return path.join(this.d.home, "curator");
  }
  readState(): CuratorState {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, "state.json"), "utf8")) as CuratorState;
    } catch {
      return {};
    }
  }
  private writeState(s: CuratorState): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(this.dir, "state.json"), JSON.stringify(s, null, 2), { mode: 0o600 });
  }
  private update(fn: (s: CuratorState) => void): CuratorState {
    const s = this.readState();
    fn(s);
    this.writeState(s);
    return s;
  }

  get enabled(): boolean {
    return this.readState().enabled !== false;
  }
  setEnabled(on: boolean): void {
    this.update((s) => (s.enabled = on));
    if (!on) this.#abort?.abort();
  }

  /** Tokens spent today and what is left. */
  budget(): { used: number; left: number } {
    const s = this.readState();
    const used = s.day === this.today() ? (s.tokens ?? 0) : 0;
    return { used, left: Math.max(0, DAILY_BUDGET - used) };
  }
  private today(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  /** You typed, or a turn started: stop whatever is running, and wait for quiet again. */
  activity(): void {
    this.#lastActivity = this.now();
    this.#abort?.abort();
  }

  start(everyMs = 30_000): void {
    this.#timer ??= setInterval(() => void this.tick(), everyMs);
    this.#timer.unref?.();
  }
  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#abort?.abort();
  }

  /** The next job that is due, if the curator may run now. */
  due(): Job | undefined {
    if (!this.enabled || running || this.d.busy() || this.now() - this.#lastActivity < IDLE_MS || this.budget().left <= 0) return undefined;
    const last = this.readState().last ?? {};
    return JOBS.find((j) => this.now() - (last[`${this.d.projectId}:${j}`] ?? 0) >= EVERY[j]);
  }

  async tick(): Promise<void> {
    const job = this.due();
    if (job) await this.run([job]);
  }

  /** Run these jobs now (/curator run runs all of them), within the budget. Returns what each did. */
  async run(jobs: Job[] = JOBS): Promise<Record<Job, string[]>> {
    const out = { facts: [], skills: [], resurface: [] } as Record<Job, string[]>;
    if (running) return out;
    running = true;
    const abort = (this.#abort = new AbortController());
    try {
      for (const job of jobs) {
        if (abort.signal.aborted || this.budget().left <= 0) break;
        try {
          out[job] = await this.job(job, abort.signal);
        } finally {
          // Interrupted, it is tried again at the next quiet moment; done (or failed), it waits its interval.
          if (!abort.signal.aborted) this.update((s) => ((s.last ??= {})[`${this.d.projectId}:${job}`] = this.now()));
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) this.d.report("Curator stopped", [error instanceof Error ? error.message : String(error)]);
    } finally {
      running = false;
      if (this.#abort === abort) this.#abort = undefined;
    }
    const lines = [...out.facts, ...(out.skills.length ? [`${out.skills.length} skill change${out.skills.length === 1 ? "" : "s"} to review: /curator review`] : []), ...out.resurface.map((x) => `↺ ${x}`)];
    if (lines.length) this.d.report("Curator", lines);
    return out;
  }

  /** A model call that counts against the budget and dies with the signal. */
  private ask(signal: AbortSignal) {
    return async (system: string, user: string): Promise<string> => {
      if (signal.aborted) throw new Error("stopped");
      const r = await this.d.ask(system, user, signal);
      this.update((s) => {
        if (s.day !== this.today()) [s.day, s.tokens] = [this.today(), 0];
        s.tokens = (s.tokens ?? 0) + r.tokens;
      });
      if (signal.aborted) throw new Error("stopped");
      return r.text;
    };
  }

  /** A job whose input has not changed since it last looked is skipped: undefined. Else the mark to save once it is done. */
  private fresh(job: Job, input: string): string | undefined {
    const h = hash(input);
    return this.readState().basis?.[`${this.d.projectId}:${job}`] === h ? undefined : h;
  }
  private looked(job: Job, mark: string): void {
    this.update((s) => ((s.basis ??= {})[`${this.d.projectId}:${job}`] = mark));
  }

  private async job(job: Job, signal: AbortSignal): Promise<string[]> {
    const mem = this.d.memory;
    const ask = this.ask(signal);
    if (job === "facts") {
      // The free part first: duplicates, files that are gone, what was marked wrong.
      const tidy = await planTidy(mem, this.d.projectId, this.d.projectRoot);
      const retired = tidy.length ? await applyTidy(mem, this.d.projectId, tidy) : 0;
      const profiles = async () => JSON.stringify([...(await mem.profile("project", this.d.projectId)), ...(await mem.profile("user", this.d.projectId))]);
      const mark = this.fresh("facts", await profiles());
      const merged = mark ? await curateFacts(mem, this.d.projectId, ask) : [];
      // Its own changes do not make the facts new again: the mark is what it left.
      if (mark) this.looked("facts", hash(await profiles()));
      return [...(retired ? [`tidied ${retired} item${retired === 1 ? "" : "s"} (duplicates, stale, marked wrong)`] : []), ...merged];
    }
    if (job === "skills") {
      const proposals = await proposeSkillChanges(mem, ask, { projectRoot: this.d.projectRoot, userSkillsDir: this.d.userSkillsDir }, this.now());
      if (proposals.length) this.writeInbox([...this.inbox(), ...proposals]);
      return proposals.map((p) => `${p.kind} skill ${p.name}`);
    }
    const last = (await mem.profile("project", this.d.projectId)).find((f) => f.key === "last session")?.value ?? "";
    const mark = last ? this.fresh("resurface", last) : undefined;
    if (!mark) return [];
    const items = await resurface(mem, this.d.projectId, await this.d.project(), ask);
    this.looked("resurface", mark);
    if (items.length) this.update((s) => ((s.resurfaced ??= {})[this.d.projectId] = items));
    return items;
  }

  /** What resurfacing found for this project, handed over once. */
  takeResurfaced(): string[] {
    const items = this.readState().resurfaced?.[this.d.projectId] ?? [];
    if (items.length) this.update((s) => delete s.resurfaced?.[this.d.projectId]);
    return items;
  }

  inbox(): SkillProposalItem[] {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, "inbox.json"), "utf8")) as SkillProposalItem[];
    } catch {
      return [];
    }
  }
  writeInbox(items: SkillProposalItem[]): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(this.dir, "inbox.json"), JSON.stringify(items, null, 2), { mode: 0o600 });
  }
}
