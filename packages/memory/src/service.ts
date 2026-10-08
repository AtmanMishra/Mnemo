/**
 * What Mnemo means by "memory", over the sidecar's protocol.
 *
 * Standing nodes:
 *   - **project profile** (`project <identity>`, Spatial): facts about one
 *     codebase — package manager, test command, conventions, decisions.
 *   - **user profile** (`user preferences`, Semantic): how this person works,
 *     true in every project. The only memory that is global by design.
 *
 * Everything written during a session is attached to its project with
 * `PartOf`, and recall searches with that project as scope (audit F10), so
 * one repo's memories never leak into another.
 *
 * Facts are key → value with one current value per key: a new value under an
 * existing key supersedes the old one (kept as history). Every value is
 * redacted before it is written (audit F25).
 *
 * Every call degrades: a dead sidecar answers `{ ok: false }` through the
 * client, and every method here turns that into "nothing", never a throw.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { MemoryClient, type MemoryChild } from "./client.ts";
import { redact } from "./redact.ts";

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

export const USER_LABEL = "user preferences";
export const projectLabel = (projectId: string) => `project ${projectId}`;

/** Values written by `forget`: still history, never an answer. */
const FORGOTTEN = "(forgotten)";
/** Bookkeeping keys that are not knowledge and are not shown to the model. */
const INTERNAL = new Set(["signature", "occurrences", "path", "failure"]);

/** The `facts:` section of a node's derived state, as key/value pairs. */
export function factsOf(state: string, options: { internal?: boolean } = {}): ProfileFact[] {
  const out: ProfileFact[] = [];
  let inFacts = false;
  for (const line of state.split("\n")) {
    if (/^facts:/.test(line)) {
      inFacts = true;
      continue;
    }
    if (!inFacts) continue;
    const m = /^\s+- ([^:]+): (.*)$/.exec(line);
    if (m) {
      const fact = { key: m[1]!.trim(), value: m[2]!.trim() };
      if (fact.value === FORGOTTEN) continue;
      if (!options.internal && INTERNAL.has(fact.key)) continue;
      out.push(fact);
    } else if (!/^\s/.test(line)) inFacts = false;
  }
  return out;
}

export function factValue(state: string, key: string): string | undefined {
  return factsOf(state, { internal: true }).find((f) => f.key === key)?.value;
}

export function spawnMemsrv(binary: string, args: string[]): MemoryChild {
  return spawn(binary, args, { stdio: ["pipe", "pipe", "ignore"] }) as unknown as MemoryChild;
}

export type EdgeKind = "supplies_context" | "part_of" | "derived_from" | "activated_with";

export class MemoryService {
  private readonly client: MemoryClient;
  private labels = new Map<string, number>();

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

  /** A node's id by exact label, from the sidecar (cached once found). */
  async findLabel(label: string): Promise<number | undefined> {
    const known = this.labels.get(label);
    if (known !== undefined) return known;
    const dump = await this.call<{ nodes: { id: number; label: string }[] }>("dump");
    const found = dump?.nodes.find((n) => n.label === label);
    if (found) this.labels.set(label, found.id);
    return found?.id;
  }

  /** A standing node by label, created on first use. */
  private async standing(label: string, kind: string, area: string): Promise<number | undefined> {
    const found = await this.findLabel(label);
    if (found !== undefined) return found;
    const created = await this.call<{ node: number }>("create_node", { kind, label, area });
    if (created) this.labels.set(label, created.node);
    return created?.node;
  }

  /** The project node for an identity; its root path is recorded once. */
  async project(projectId: string, root?: string): Promise<number | undefined> {
    const known = this.labels.has(projectLabel(projectId));
    const node = await this.standing(projectLabel(projectId), "entity", "spatial");
    if (node !== undefined && !known && root) {
      const st = await this.state(node);
      if (!factValue(st, "path")) await this.call("fact", { node, key: "path", value: root });
    }
    return node;
  }

  userNode(): Promise<number | undefined> {
    return this.standing(USER_LABEL, "entity", "semantic");
  }

  profileNode(scope: Scope, projectId: string): Promise<number | undefined> {
    return scope === "user" ? this.userNode() : this.project(projectId);
  }

  async state(node: number): Promise<string> {
    return (await this.call<{ state: string }>("state", { node }))?.state ?? "";
  }

  async profile(scope: Scope, projectId: string): Promise<ProfileFact[]> {
    const node = await this.profileNode(scope, projectId);
    return node === undefined ? [] : factsOf(await this.state(node));
  }

  /** Write one profile fact; a key that already has a value is superseded. */
  async learn(scope: Scope, projectId: string, key: string, value: string): Promise<{ superseded: boolean } | undefined> {
    const node = await this.profileNode(scope, projectId);
    if (node === undefined) return undefined;
    const r = await this.call<{ fact: number; superseded: number | null }>("fact", { node, key, value: redact(value) });
    return r ? { superseded: r.superseded !== null } : undefined;
  }

  /** Retire a profile fact: kept as history, never recalled again. */
  async forget(scope: Scope, projectId: string, key: string): Promise<boolean> {
    const facts = await this.profile(scope, projectId);
    if (!facts.some((f) => f.key === key)) return false;
    return (await this.learn(scope, projectId, key, FORGOTTEN)) !== undefined;
  }

  /**
   * Search, optionally within one project. Another project's profile node is
   * not attached to anything — it *is* a project — so the sidecar's scope
   * cannot exclude it; it is dropped here.
   */
  async search(query: string, k = 5, scope?: number): Promise<Hit[]> {
    const r = await this.call<{ results: Hit[] }>("search", { query, k, scope });
    const hits = r?.results ?? [];
    return scope === undefined ? hits : hits.filter((h) => h.node === scope || !h.label.startsWith("project "));
  }

  /**
   * What to recall for a message, within one project: knowledge (lessons,
   * skills, remembered notes), pitfalls that have a known fix, and past
   * episodes that have a record. Never the profiles (injected whole), never
   * unresolved pain or gap markers (they say *that* it hurt, not what to do).
   */
  async recall(query: string, project: number | undefined, profileNodes: number[], k = 5): Promise<Hit[]> {
    if (query.trim().split(/\s+/).length < 2) return [];
    const hits = await this.search(query, k * 4, project);
    return hits
      .filter((h) => !profileNodes.includes(h.node) && h.score > 0.05)
      // gap: and lexical "lesson:" nodes are token bags with nothing to act on
      // (audit F6, F7); candidates are not knowledge until saved.
      .filter((h) => !/^(gap:|lesson:|skill candidate)/.test(h.label))
      .filter((h) => h.area !== "Salience" || factValue(h.state, "fix") !== undefined)
      .filter((h) => h.kind !== "TaskEpisode" || factValue(h.state, "goal") !== undefined)
      .slice(0, k);
  }

  async episode(label: string): Promise<number | undefined> {
    return (await this.call<{ episode: number }>("episode", { label: redact(label) }))?.episode;
  }

  async log(node: number, kind: string, detail: string): Promise<void> {
    await this.call("commit_log", { node, kind, detail: redact(detail) });
  }

  async fact(node: number, key: string, value: string): Promise<void> {
    await this.call("fact", { node, key, value: redact(value) });
  }

  async link(src: number, dst: number, kind: EdgeKind = "supplies_context"): Promise<void> {
    await this.call("link", { src, dst, kind });
  }

  /** A failure: one marker per distinct failure (counted), no gap node for tool errors. */
  async steer(episode: number, failure: string): Promise<{ pain_node?: number; occurrences?: number; blamed_feeders?: [number, number][] } | undefined> {
    return this.call("steer", { episode, failure: redact(failure), dedupe: true, gap: false });
  }

  async good(episode: number, detail: string): Promise<void> {
    await this.call("good", { episode, detail });
  }

  async markUseful(node: number, useful = true): Promise<void> {
    await this.call("mark_useful", { node, useful });
  }

  async remember(summary: string, label?: string): Promise<number | undefined> {
    return (await this.call<{ node: number }>("remember", { summary: redact(summary), label: label && redact(label) }))?.node;
  }

  async createNode(kind: string, label: string, area?: string): Promise<number | undefined> {
    const node = (await this.call<{ node: number }>("create_node", { kind, label: redact(label), area }))?.node;
    if (node !== undefined) this.labels.set(label, node);
    return node;
  }

  async consolidate(): Promise<string[]> {
    const r = await this.call<{ lessons: unknown[] }>("consolidate");
    return (r?.lessons ?? []).map((l) => (typeof l === "string" ? l : JSON.stringify(l)));
  }

  /** Every node: id, label, kind and area (for a browser of memory). */
  async nodes(): Promise<{ id: number; label: string; kind: string; area: string }[]> {
    return (await this.call<{ nodes: { id: number; label: string; kind: string; area: string }[] }>("dump"))?.nodes ?? [];
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
