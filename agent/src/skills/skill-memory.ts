/**
 * Memory-graph side of the skill self-improvement path.
 *
 * patch_skill / retire_skill record WHAT changed, WHY, and on what EVIDENCE,
 * on a Procedural node for the skill — otherwise the lesson lives and dies in
 * a file diff, and the next session re-learns it the hard way. The record is:
 *
 *   - a skill node (Aspect, procedural, marked by a `skill` fact): found or
 *     created, so all patches of one skill attach to one place;
 *   - a `commit_log` entry naming the reason and the evidence ids/signatures;
 *   - a `fact` (`last patch` / `retired`) with the timestamp and one-line reason;
 *   - a `link` from the skill node to each evidence node that still exists.
 *
 * EVERY function here is best-effort by contract: a dead or missing memsrv
 * must never fail the edit that prompted the record — "memory must never
 * break the agent loop". Failures surface as a note, never as a throw.
 */
import { factsFromState } from "../../extensions/memory-layer.ts";

/** The subset of MemClient this module needs (tests pass a stub). */
export interface MemLike {
  request(method: string, params?: Record<string, unknown>): Promise<{ ok: boolean; result?: any; error?: string }>;
}

export interface SkillEvidence {
  /** Memory node ids the edit answers (linked when they still exist). */
  nodes: number[];
  /** Explicit failure signatures, kept verbatim as evidence. */
  signatures: string[];
}

export interface SkillEventInput {
  action: "patch" | "retire";
  name: string;
  /** Absolute path to the SKILL.md; recorded as the node's `location` fact. */
  path: string;
  reason: string;
  evidence: SkillEvidence;
  /** ISO timestamp of the edit (the history file carries the same stamp). */
  timestamp: string;
}

export interface SkillEventOutcome {
  /** True when node + commit_log + fact all landed. */
  recorded: boolean;
  node: number | null;
  /** Evidence node ids that were linked (skips nodes that do not exist). */
  linked: number[];
  /** One line for the tool result: what memory did, or why it did not. */
  note: string;
}

const clip = (s: string, max = 80): string => (s.length > max ? s.slice(0, max - 1) + "…" : s);

/** Evidence as it reads inside a commit_log line: ids first, signatures quoted. */
export function evidenceSummary(evidence: SkillEvidence): string {
  const parts = [
    ...evidence.nodes.map((n) => `#${n}`),
    ...evidence.signatures.map((s) => `"${clip(s)}"`),
  ];
  return parts.join(", ");
}

interface DumpedNode {
  id: number;
  kind: string;
  area: string;
  label: string;
}

/**
 * The skill's node, identified by label PLUS the `skill: <name>` marker fact
 * (a bare label match could be any node called the same thing). Null when the
 * node does not exist yet or the sidecar cannot be read.
 */
export async function findSkillNode(client: MemLike, name: string): Promise<number | null> {
  try {
    const dump = await client.request("dump");
    if (!dump.ok) return null;
    const nodes = (dump.result?.nodes ?? []) as DumpedNode[];
    for (const n of nodes) {
      if (n?.label !== name) continue;
      const id = Number(n.id);
      if (!Number.isInteger(id)) continue;
      const state = await client.request("state", { node: id });
      if (!state.ok) continue;
      if (factsFromState(String(state.result?.state ?? "")).get("skill") === name) return id;
    }
  } catch {
    /* unreachable sidecar == nothing found */
  }
  return null;
}

/** Find the skill's node or create it (Aspect, procedural) with its facts. */
async function ensureSkillNode(client: MemLike, name: string, file: string): Promise<number> {
  const existing = await findSkillNode(client, name);
  if (existing !== null) return existing;
  const created = await client.request("create_node", { kind: "aspect", area: "procedural", label: name });
  if (!created.ok) throw new Error(`create_node: ${created.error}`);
  const node = Number(created.result?.node);
  if (!Number.isInteger(node)) throw new Error("create_node returned no node id");
  const marked = await client.request("fact", { node, key: "skill", value: name });
  if (!marked.ok) throw new Error(`fact skill: ${marked.error}`);
  const located = await client.request("fact", { node, key: "location", value: file });
  if (!located.ok) throw new Error(`fact location: ${located.error}`);
  return node;
}

/** Link the skill to each evidence node THAT EXISTS; missing ones are skipped. */
async function linkEvidence(client: MemLike, node: number, ids: number[]): Promise<number[]> {
  const linked: number[] = [];
  for (const id of ids) {
    if (!Number.isInteger(id) || id === node) continue; // no self-links
    try {
      const exists = await client.request("state", { node: id });
      if (!exists.ok) continue; // the evidence node is gone: nothing to link to
      const res = await client.request("link", { src: node, dst: id });
      if (res.ok) linked.push(id);
    } catch {
      /* one bad link must not stop the others */
    }
  }
  return linked;
}

/**
 * Record one patch/retirement in the memory graph. Never throws: a partial or
 * impossible record comes back as `recorded: false` with a note the tool
 * result can carry.
 */
export async function recordSkillEvent(client: MemLike, input: SkillEventInput): Promise<SkillEventOutcome> {
  const noun = input.action === "patch" ? "patch" : "retirement";
  const verb = input.action === "patch" ? "patched" : "retired";
  try {
    const node = await ensureSkillNode(client, input.name, input.path);
    const evidence = evidenceSummary(input.evidence);
    const logged = await client.request("commit_log", {
      node,
      kind: input.action === "patch" ? "skill_patch" : "skill_retire",
      detail: `${verb} skill "${input.name}": ${clip(input.reason, 200)} (evidence: ${evidence})`,
    });
    if (!logged.ok) throw new Error(`commit_log: ${logged.error}`);
    const factRes = await client.request("fact", {
      node,
      key: input.action === "patch" ? "last patch" : "retired",
      value: `${input.timestamp}: ${clip(input.reason, 200)}`,
    });
    if (!factRes.ok) throw new Error(`fact: ${factRes.error}`);
    const linked = await linkEvidence(client, node, input.evidence.nodes);
    const linkNote = input.evidence.nodes.length > 0 ? `; linked ${linked.length}/${input.evidence.nodes.length} evidence node(s)` : "";
    return { recorded: true, node, linked, note: `memory: skill node #${node} — ${noun} logged${linkNote}` };
  } catch (err: any) {
    return {
      recorded: false,
      node: null,
      linked: [],
      note: `memory: ${noun} not recorded (${err?.message ?? err})`,
    };
  }
}
