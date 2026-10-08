/**
 * What Mnemo means by "memory", over the sidecar's protocol.
 *
 * The graph has two standing nodes per person and project, and everything else
 * is episodes, lessons and skills:
 *
 *   - **project profile** (`project <cwd>`, Spatial): facts about one codebase —
 *     its package manager, test command, conventions, decisions, pitfalls.
 *   - **user profile** (`user preferences`, Semantic): how this person works,
 *     true in every project.
 *
 * Facts on a profile are key → value, and memsrv keeps one current value per
 * key: writing "package manager = bun" over "package manager = npm" supersedes
 * the old one (kept as history) instead of leaving two to contradict each
 * other. The profiles are small and always relevant, so they are injected into
 * every turn; search adds whatever else matches the message.
 *
 * Every call degrades: a dead sidecar answers `{ ok: false }` through the
 * client, and every method here turns that into "nothing", never a throw.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { MemoryClient, type MemoryChild } from "./client.ts";

export interface Hit {
  node: number;
  label: string;
  kind: string;
  area: string;
  score: number;
  state: string;
}

export interface ProfileFact {
  key: string;
  value: string;
}

export type Scope = "project" | "user";

const USER_LABEL = "user preferences";
const projectLabel = (cwd: string) => `project ${cwd}`;

/** The `facts:` section of a node's derived state, as key/value pairs. */
export function factsOf(state: string): ProfileFact[] {
  const out: ProfileFact[] = [];
  let inFacts = false;
  for (const line of state.split("\n")) {
    if (/^facts:/.test(line)) {
      inFacts = true;
      continue;
    }
    if (inFacts) {
      const m = /^\s+- ([^:]+): (.*)$/.exec(line);
      if (m) out.push({ key: m[1]!.trim(), value: m[2]!.trim() });
      else if (!/^\s/.test(line)) inFacts = false;
    }
  }
  return out;
}

export function spawnMemsrv(binary: string, args: string[]): MemoryChild {
  return spawn(binary, args, { stdio: ["pipe", "pipe", "ignore"] }) as unknown as MemoryChild;
}

export class MemoryService {
  private readonly client: MemoryClient;
  private nodes = new Map<string, number>();

  constructor(
    readonly binary: string,
    readonly journal: string,
    spawnFn: (binary: string, args: string[]) => MemoryChild = spawnMemsrv,
  ) {
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    this.client = new MemoryClient({ binaryPath: binary, journalPath: journal, spawn: spawnFn, timeoutMs: 15_000 });
  }

  private async call<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T | undefined> {
    const r = await this.client.request(method, params);
    return r.ok ? (r.result as T) : undefined;
  }

  async ping(): Promise<boolean> {
    return (await this.call("ping")) !== undefined;
  }

  /** A standing node by label, created on first use. */
  private async standing(label: string, kind: string, area: string): Promise<number | undefined> {
    const known = this.nodes.get(label);
    if (known !== undefined) return known;
    const dump = await this.call<{ nodes: { id: number; label: string }[] }>("dump");
    const found = dump?.nodes.find((n) => n.label === label);
    if (found) {
      this.nodes.set(label, found.id);
      return found.id;
    }
    const created = await this.call<{ node: number }>("create_node", { kind, label, area });
    if (created) this.nodes.set(label, created.node);
    return created?.node;
  }

  profileNode(scope: Scope, cwd: string): Promise<number | undefined> {
    return scope === "user" ? this.standing(USER_LABEL, "entity", "semantic") : this.standing(projectLabel(cwd), "entity", "spatial");
  }

  async profile(scope: Scope, cwd: string): Promise<ProfileFact[]> {
    const node = await this.profileNode(scope, cwd);
    if (node === undefined) return [];
    const st = await this.call<{ state: string }>("state", { node });
    return st ? factsOf(st.state) : [];
  }

  /** Write one profile fact; a key that already has a value is superseded. */
  async learn(scope: Scope, cwd: string, key: string, value: string): Promise<{ superseded: boolean } | undefined> {
    const node = await this.profileNode(scope, cwd);
    if (node === undefined) return undefined;
    const r = await this.call<{ fact: number; superseded: number | null }>("fact", { node, key, value });
    return r ? { superseded: r.superseded !== null } : undefined;
  }

  async search(query: string, k = 5): Promise<Hit[]> {
    const r = await this.call<{ results: Hit[] }>("search", { query, k });
    return r?.results ?? [];
  }

  /**
   * What to recall for a message: search hits that are not the profiles
   * (those are injected whole) and not bare episodes with nothing learned.
   */
  async recall(query: string, cwd: string, k = 4): Promise<Hit[]> {
    if (query.trim().split(/\s+/).length < 2) return [];
    const skip = new Set([USER_LABEL, projectLabel(cwd)]);
    const hits = await this.search(query, k * 3);
    return hits
      .filter((h) => !skip.has(h.label) && h.score > 0.05)
      .filter((h) => h.kind !== "TaskEpisode" || /facts:\n\s+-/.test(h.state))
      .slice(0, k);
  }

  async episode(label: string): Promise<number | undefined> {
    return (await this.call<{ episode: number }>("episode", { label }))?.episode;
  }

  async log(node: number, kind: string, detail: string): Promise<void> {
    await this.call("commit_log", { node, kind, detail });
  }

  async fact(node: number, key: string, value: string): Promise<void> {
    await this.call("fact", { node, key, value });
  }

  /** Mark `src` as having supplied context to `dst` (so steering can blame it). */
  async link(src: number, dst: number): Promise<void> {
    await this.call("link", { src, dst });
  }

  async steer(episode: number, failure: string): Promise<{ pain_node?: number; blamed_feeders?: number[]; gap_node?: number } | undefined> {
    return this.call("steer", { episode, failure });
  }

  async good(episode: number, detail: string): Promise<void> {
    await this.call("good", { episode, detail });
  }

  async remember(summary: string, label?: string): Promise<number | undefined> {
    return (await this.call<{ node: number }>("remember", { summary, label }))?.node;
  }

  async createNode(kind: string, label: string, area?: string): Promise<number | undefined> {
    return (await this.call<{ node: number }>("create_node", { kind, label, area }))?.node;
  }

  async consolidate(): Promise<string[]> {
    const r = await this.call<{ lessons: unknown[] }>("consolidate");
    return (r?.lessons ?? []).map((l) => (typeof l === "string" ? l : JSON.stringify(l)));
  }

  async stats(): Promise<{ nodes: number; episodes: number; byArea: Record<string, number> } | undefined> {
    const dump = await this.call<{ nodes: { kind: string; area: string }[] }>("dump");
    if (!dump) return undefined;
    const byArea: Record<string, number> = {};
    for (const n of dump.nodes) byArea[n.area] = (byArea[n.area] ?? 0) + 1;
    return { nodes: dump.nodes.length, episodes: dump.nodes.filter((n) => n.kind === "TaskEpisode").length, byArea };
  }

  stop(): void {
    this.client.stop();
  }
}
