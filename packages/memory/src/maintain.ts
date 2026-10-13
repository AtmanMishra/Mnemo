/**
 * What the background curator does with a model, between sessions. Three
 * jobs, each one call, each reading only what memory already holds:
 *
 *   facts      the profiles, tidied: duplicates merged into one clear fact,
 *              facts a newer one contradicts retired. Applied at once; every
 *              old value stays in the journal as history.
 *   skills     skill candidates seen in two or more sessions become skills,
 *              and a skill whose recent uses failed is rewritten. Proposed,
 *              never written: a person approves each one (the inbox).
 *   resurface  the few things worth putting in front of the agent next time,
 *              given what was worked on last: an open thread, a pitfall near
 *              that work, a convention easy to forget. Handed to the next recall.
 *
 * The model is `ask(system, user)`; the caller owns which model, the budget,
 * and cancelling. Pure of scheduling, so each job is tested with a script.
 */
import * as fs from "node:fs";
import { redact } from "./redact.ts";
import { unsafeMemory } from "./safety.ts";
import { factValue, type MemoryService, type ProfileFact, type Scope } from "./service.ts";
import { renderSkill, skillPath } from "./skills.ts";

export type Ask = (system: string, user: string) => Promise<string>;

function json<T>(answer: string): T | undefined {
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(answer.slice(start, end + 1)) as T;
  } catch {
    return undefined;
  }
}

const str = (v: unknown, max = 600) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const key = (v: unknown) => str(v, 120).toLowerCase();

// ── facts ────────────────────────────────────────────────────────────────

export const FACTS_PROMPT = `You keep the long-term memory of Mnemo, a coding agent, tidy. Below are the facts it holds about one project and about its user, as "scope · key: value".

Return JSON only:
{"merge": [{"scope": "project"|"user", "keys": ["old key", "..."], "key": "kept key", "value": "one clear value", "why": "..."}],
 "retire": [{"scope": "project"|"user", "key": "...", "why": "..."}]}

merge — two or more facts that say the same thing, or parts of one thing, written once: the kept key is short, lowercase and stable; the value keeps every detail the old ones had. Never merge facts that are about different things.
retire — a fact another fact in the list plainly contradicts or replaces (keep the newer, more specific one), or one that only describes a single past task.
Change nothing that is fine. At most 5 changes. Never invent details. Output the JSON object and nothing else.`;

export async function curateFacts(mem: MemoryService, projectId: string, ask: Ask): Promise<string[]> {
  const scopes: Scope[] = ["project", "user"];
  const held = new Map<Scope, ProfileFact[]>();
  for (const s of scopes) held.set(s, (await mem.profile(s, projectId)).filter((f) => f.key !== "last session"));
  const lines = scopes.flatMap((s) => held.get(s)!.map((f) => `${s} · ${f.key}: ${f.value}`));
  if (lines.length < 3) return [];
  const answer = json<{ merge?: unknown[]; retire?: unknown[] }>(await ask(FACTS_PROMPT, redact(lines.join("\n"))));
  if (!answer) return [];
  const has = (s: Scope, k: string) => held.get(s)!.some((f) => f.key === k);
  const scopeOf = (v: unknown): Scope | undefined => (v === "project" || v === "user" ? v : undefined);
  const done: string[] = [];
  for (const raw of (answer.merge ?? []).slice(0, 5) as Record<string, unknown>[]) {
    const s = scopeOf(raw.scope);
    const keys = Array.isArray(raw.keys) ? raw.keys.map(key).filter(Boolean) : [];
    const k = key(raw.key);
    const value = str(raw.value);
    // Only facts that exist, only two or more of them, and only a value memory may keep.
    if (!s || !k || !value || keys.length < 2 || !keys.every((x) => has(s, x)) || unsafeMemory(`${k} ${value}`)) continue;
    await mem.learn(s, projectId, k, value);
    for (const old of keys) if (old !== k) await mem.forget(s, projectId, old);
    done.push(`merged ${keys.map((x) => `"${x}"`).join(" + ")} → ${k}: ${value}`);
  }
  for (const raw of (answer.retire ?? []).slice(0, 5) as Record<string, unknown>[]) {
    const s = scopeOf(raw.scope);
    const k = key(raw.key);
    if (!s || !has(s, k) || done.some((d) => d.includes(`"${k}"`))) continue;
    await mem.forget(s, projectId, k);
    done.push(`retired "${k}"${raw.why ? ` (${str(raw.why, 120)})` : ""}`);
  }
  return done;
}

// ── skills ───────────────────────────────────────────────────────────────

export interface SkillProposalItem {
  id: string;
  kind: "new" | "update";
  name: string;
  scope: "project" | "user";
  file: string;
  body: string;
  reason: string;
  at: number;
}

export const SKILLS_PROMPT = `You maintain the skills of Mnemo, a coding agent: markdown procedures it loads when a task matches. Below are CANDIDATES (procedures seen in past sessions, with how many sessions) and SKILLS THAT FAILED (a skill's text and what happened when it was followed).

Return JSON only:
{"new": [{"name": "kebab-case", "scope": "project"|"user", "description": "when to use it", "instructions": "markdown steps", "reason": "..."}],
 "update": [{"name": "existing skill", "instructions": "the complete corrected markdown steps", "reason": "what was wrong"}]}

new — only for a candidate seen in 2 or more sessions; merge candidates that are the same procedure into one skill. Steps a future run can follow: commands, checks, the order that works.
update — only for a skill listed as failed, fixing what the record shows went wrong; keep what worked.
Empty lists when nothing qualifies. Output the JSON object and nothing else.`;

/** What memory holds that a skills pass could act on; empty when there is nothing (and no call is made). */
export async function skillEvidence(mem: MemoryService): Promise<{ candidates: string[]; failed: { name: string; file: string; text: string }[] }> {
  const nodes = await mem.nodes();
  const candidates: string[] = [];
  const failed: { name: string; file: string; text: string }[] = [];
  for (const n of nodes) {
    if (n.label.startsWith("skill candidate ")) {
      const st = await mem.state(n.id);
      const seen = Number(factValue(st, "seen") ?? "1");
      if (seen < 2 || factValue(st, "proposed") === "yes") continue;
      candidates.push(`- ${n.label.slice(16)} (seen in ${seen} sessions): ${factValue(st, "description") ?? ""}\n  ${(factValue(st, "instructions") ?? "").slice(0, 800)}`);
    } else if (n.label.startsWith("skill ")) {
      const st = await mem.state(n.id);
      const uses = [...st.matchAll(/used: (episode #\d+: (?:had failures|clean))/g)].map((m) => m[1]!);
      const failures = uses.filter((u) => u.endsWith("had failures")).length;
      const handled = Number(factValue(st, "failures curated") ?? "0");
      const file = factValue(st, "file");
      if (failures <= handled || !file || !fs.existsSync(file)) continue;
      failed.push({ name: n.label.slice(6), file, text: `--- ${n.label.slice(6)} (${failures} of ${uses.length} uses had failures; last uses: ${uses.slice(-4).join(", ")})\n${fs.readFileSync(file, "utf8").slice(0, 1500)}` });
    }
  }
  return { candidates, failed };
}

export async function proposeSkillChanges(
  mem: MemoryService,
  ask: Ask,
  where: { projectRoot: string; userSkillsDir: string },
  now = Date.now(),
): Promise<SkillProposalItem[]> {
  const ev = await skillEvidence(mem);
  if (!ev.candidates.length && !ev.failed.length) return [];
  const user = [`CANDIDATES:\n${ev.candidates.join("\n") || "(none)"}`, `SKILLS THAT FAILED:\n${ev.failed.map((f) => f.text).join("\n") || "(none)"}`].join("\n\n");
  const answer = json<{ new?: unknown[]; update?: unknown[] }>(await ask(SKILLS_PROMPT, redact(user)));
  if (!answer) return [];
  const out: SkillProposalItem[] = [];
  for (const raw of (answer.new ?? []).slice(0, 3) as Record<string, unknown>[]) {
    const name = key(raw.name).replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
    const scope = raw.scope === "project" ? "project" : "user";
    const description = str(raw.description, 200);
    const instructions = typeof raw.instructions === "string" ? raw.instructions.trim().slice(0, 6000) : "";
    if (!name || !description || !instructions || unsafeMemory(`${description} ${instructions}`)) continue;
    if ((await mem.findLabel(`skill ${name}`)) !== undefined) continue;
    out.push({ id: `${now.toString(36)}-${out.length}`, kind: "new", name, scope, file: skillPath(scope, name, where), body: renderSkill(name, description, instructions), reason: str(raw.reason, 300) || "seen in several sessions", at: now });
  }
  for (const raw of (answer.update ?? []).slice(0, 3) as Record<string, unknown>[]) {
    const name = key(raw.name);
    const target = ev.failed.find((f) => f.name === name);
    const instructions = typeof raw.instructions === "string" ? raw.instructions.trim().slice(0, 6000) : "";
    if (!target || !instructions || unsafeMemory(instructions)) continue;
    const old = fs.readFileSync(target.file, "utf8");
    const description = /description:\s*(.*)/.exec(old)?.[1]?.replace(/^"|"$/g, "") ?? name;
    const body = renderSkill(name, description, instructions);
    if (body === old) continue;
    out.push({ id: `${now.toString(36)}-${out.length}`, kind: "update", name, scope: target.file.split(/[\\/]/).includes(".agents") ? "project" : "user", file: target.file, body, reason: str(raw.reason, 300) || "recent uses failed", at: now });
  }
  // What was looked at is not offered again until there is new evidence.
  for (const n of await mem.nodes()) {
    if (n.label.startsWith("skill candidate ") && ev.candidates.some((c) => c.startsWith(`- ${n.label.slice(16)} `))) await mem.fact(n.id, "proposed", "yes");
    const f = ev.failed.find((x) => n.label === `skill ${x.name}`);
    if (f) await mem.fact(n.id, "failures curated", String((/(\d+) of \d+ uses had failures/.exec(f.text)?.[1]) ?? "0"));
  }
  return out;
}

// ── resurfacing ──────────────────────────────────────────────────────────

export const RESURFACE_PROMPT = `You help Mnemo, a coding agent, remember at the right moment. Below is what was worked on most recently in a project (LAST SESSION) and what memory holds about it (MEMORY).

Return JSON only: {"items": ["...", "..."]}

Pick at most 3 items from MEMORY that the agent should have in mind when work resumes: an open thread from the last session, a pitfall and its fix near that work, a convention that is easy to forget there. One line each, under 160 characters, in plain words, said as memory ("Last time … was left open: …", "When … fails, …"). Only what MEMORY says; nothing generic. An empty list when nothing is worth it. Output the JSON object and nothing else.`;

export async function resurface(mem: MemoryService, projectId: string, project: number | undefined, ask: Ask): Promise<string[]> {
  const facts = await mem.profile("project", projectId);
  const last = facts.find((f) => f.key === "last session")?.value;
  if (!last) return [];
  const hits = project === undefined ? [] : await mem.search(last, 10, project);
  const memory = [
    ...facts.filter((f) => f.key !== "last session").map((f) => `fact · ${f.key}: ${f.value}`),
    ...hits
      .filter((h) => h.node !== project && !/^(gap:|lesson:|skill candidate)/.test(h.label))
      .map((h) => {
        const fix = factValue(h.state, "fix");
        return fix ? `pitfall · ${factValue(h.state, "failure") ?? h.label}: fix ${fix}` : h.kind === "TaskEpisode" ? `session · ${factValue(h.state, "goal") ?? h.label}; open: ${factValue(h.state, "open") ?? "-"}` : `note · ${h.label}`;
      }),
  ];
  if (!memory.length) return [];
  const answer = json<{ items?: unknown[] }>(await ask(RESURFACE_PROMPT, redact(`LAST SESSION:\n${last}\n\nMEMORY:\n${memory.join("\n")}`)));
  return (answer?.items ?? [])
    .map((x) => str(x, 200))
    .filter((x) => x && !unsafeMemory(x))
    .slice(0, 3);
}
