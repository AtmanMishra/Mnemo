/**
 * The memory loop with no agent framework at all: what another coding agent
 * (a hook, a replayed transcript) does with @mnemo/memory. One agent's run
 * fails, recovers and is reflected on; a second session, as another agent,
 * gets the fix back — and memory knows which agent and model taught it.
 */
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findMemsrv, factValue, MemoryService, MemorySession, subjectOf, type MemoryNote, type Reflector } from "../src/index.ts";

const MEMSRV = findMemsrv("/nonexistent");
const t = MEMSRV ? test : test.skip;

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-session-"));
  const cwd = path.join(root, "repo");
  fs.mkdirSync(cwd);
  const memory = new MemoryService(MEMSRV!, path.join(root, "journal.jsonl"));
  return { root, cwd, memory };
}

const reflection = JSON.stringify({
  facts: [
    { scope: "project", key: "test command", value: "pnpm vitest", source: "observed" },
    { scope: "project", key: "favourite colour", value: "blue", source: "inferred" },
  ],
  episode: { goal: "make the tests pass", outcome: "done", done: "installed deps, ran vitest", decisions: [], open: [] },
  fixes: [{ problem: "vitest: not found", fix: "run pnpm install first" }],
  skill: null,
});

t("a run from another agent is learned with its provenance, and recalled for the next agent", async () => {
  const { cwd, memory } = setup();
  const notes: MemoryNote[] = [];
  const asked: string[] = [];
  const reflect: Reflector = async (_system, user) => {
    asked.push(user);
    return reflection;
  };
  const one = new MemorySession({
    memory,
    cwd,
    userSkillsDir: path.join(cwd, "skills"),
    source: { agent: "claude-code", model: "claude-opus-5-5" },
    reflect,
    notify: (n) => notes.push(n),
  });
  await one.begin("make the tests pass");
  one.toolStart("Bash", { command: "pnpm vitest" });
  await one.toolEnd("Bash", { command: "pnpm vitest" }, false, "sh: vitest: not found");
  await one.toolEnd("Bash", { command: "pnpm install" }, true);
  await one.toolEnd("Bash", { command: "pnpm vitest" }, true);
  await one.end({ messages: [{ role: "user", content: "make the tests pass" }, { role: "assistant", content: "All green." }] });
  await one.close();

  // The reflection saw the failure and what followed it.
  expect(asked[0]).toContain("FAILED: sh: vitest: not found");
  expect(asked[0]).toContain("then: Bash(pnpm install)");
  // Observed facts are kept, guesses are not.
  expect(await memory.profile("project", one.identity.id)).toContainEqual({ key: "test command", value: "pnpm vitest" });
  expect((await memory.profile("project", one.identity.id)).some((f) => f.key === "favourite colour")).toBe(false);
  // Provenance: the episode names the agent and model; the profile's log says who taught each fact.
  const episode = await memory.state(one.episode!);
  expect(factValue(episode, "agent")).toBe("claude-code");
  expect(factValue(episode, "model")).toBe("claude-opus-5-5");
  expect(await memory.state((await memory.project(one.identity.id))!)).toContain("test command from claude-code/claude-opus-5-5");

  // Another agent, a later session, the same repository.
  const two = new MemorySession({ memory, cwd, userSkillsDir: path.join(cwd, "skills"), source: { agent: "mnemo", model: "deepseek-v4.1-flash" } });
  const r = await two.recall("run the vitest tests for me");
  expect(r.system).toContain("test command: pnpm vitest");
  expect(r.message).toContain("pitfall: Bash(pnpm vitest) failed: sh: vitest: not found");
  expect(r.message).toContain("fix: run pnpm install first");
  expect(r.message).toContain("Last session:");
  memory.stop();
}, 30_000);

t("a reflection that fails is reported, and the run is still recorded", async () => {
  const { cwd, memory } = setup();
  const notes: MemoryNote[] = [];
  const s = new MemorySession({
    memory,
    cwd,
    userSkillsDir: path.join(cwd, "skills"),
    reflect: async () => {
      throw new Error("400 MissingSessionID");
    },
    notify: (n) => notes.push(n),
  });
  await s.begin("remember that we always use pnpm in this repository");
  await s.end({ messages: [{ role: "user", content: "remember that we always use pnpm in this repository" }] });
  expect(notes).toContainEqual({ kind: "failed", text: "Reflection failed: 400 MissingSessionID" });
  expect(s.episode).toBeDefined();
  memory.stop();
}, 30_000);

t("the session record's key is reserved", async () => {
  const { cwd, memory } = setup();
  const s = new MemorySession({ memory, cwd, userSkillsDir: path.join(cwd, "skills") });
  await expect(s.remember("project", "Last Session", "x")).rejects.toThrow(/written by Mnemo/);
  memory.stop();
}, 30_000);

t("a fix attaches only to the failure it is about, never to an unrelated one", async () => {
  const { cwd, memory } = setup();
  const answers = [
    // Run 1 fails on an edit and reflects on nothing.
    JSON.stringify({ facts: [], fixes: [], skill: null }),
    // Run 2 fixes something else entirely.
    JSON.stringify({ facts: [], fixes: [{ problem: "two sidecars on one journal corrupted records", fix: "sync the journal under a lock before each request" }], skill: null }),
  ];
  const s = new MemorySession({ memory, cwd, userSkillsDir: path.join(cwd, "skills"), reflect: async () => answers.shift()! });
  await s.begin("edit the readme and then rebuild the docs index");
  await s.toolEnd("Write", { file_path: "README.md" }, false, "File has been modified since read");
  await s.toolEnd("Write", { file_path: "README.md" }, true);
  await s.end({ messages: [{ role: "user", content: "edit the readme and then rebuild the docs index please" }] });
  await s.begin("fix the corruption when two processes share the journal");
  await s.toolEnd("Bash", { command: "cargo test" }, true);
  await s.toolEnd("Bash", { command: "cargo test --release" }, true);
  await s.end({ messages: [{ role: "user", content: "fix the corruption when two processes share the journal" }] });

  const pitfalls = (await memory.search("modified since read journal lock sidecars", 10)).filter((h) => h.area === "Salience");
  const write = pitfalls.find((h) => /modified since read/.test(h.state))!;
  expect(factValue(write.state, "fix")).toBeUndefined();
  const lock = pitfalls.find((h) => factValue(h.state, "fix") !== undefined)!;
  expect(lock.label).toBe("pain: two sidecars on one journal corrupted records");
  memory.stop();
}, 30_000);

t("the guard knows a failed command inside a longer one, and stays quiet for an unrelated one", async () => {
  const { cwd, memory } = setup();
  const s = new MemorySession({ memory, cwd, userSkillsDir: path.join(cwd, "skills") });
  await s.begin("run the tests");
  await s.toolEnd("bash", { command: "npm test" }, false, "error: generated rates missing — run npm run gen first");
  const pain = (await memory.search("generated rates missing", 5)).find((h) => h.area === "Salience")!;
  await memory.fact(pain.node, "fix", "run npm run gen before npm test");

  const later = new MemorySession({ memory, cwd, userSkillsDir: path.join(cwd, "skills") });
  await later.begin("add a feature");
  expect(await later.guard("bash", { command: "npm run lint" })).toBeUndefined();
  expect(await later.guard("bash", { command: `cd ${cwd} && npm test 2>&1 | tail -20` })).toContain("Known fix: «run npm run gen before npm test»");
  memory.stop();
}, 30_000);

t("the guard never stops the fix itself, even when the error text quotes it", async () => {
  const { cwd, memory } = setup();
  const s = new MemorySession({ memory, cwd, userSkillsDir: path.join(cwd, "skills") });
  await s.begin("run the tests");
  await s.toolEnd("bash", { command: "sh scripts/test.sh" }, false, "error: test fixtures missing — run sh scripts/setup.sh first");
  const pain = (await memory.search("test fixtures missing", 5)).find((h) => h.area === "Salience")!;
  await memory.fact(pain.node, "fix", "run sh scripts/setup.sh before sh scripts/test.sh");
  const later = new MemorySession({ memory, cwd, userSkillsDir: path.join(cwd, "skills") });
  await later.begin("run the tests");
  expect(await later.guard("bash", { command: "sh scripts/setup.sh" })).toBeUndefined();
  expect(await later.guard("bash", { command: "sh scripts/test.sh" })).toContain("Known fix");
  memory.stop();
}, 30_000);

test("a command that starts by changing into the project is named by what it runs", () => {
  expect(subjectOf({ command: "cd /tmp/some/long/project && npm test 2>&1 | tail" })).toBe("npm test 2>&1 | tail");
  expect(subjectOf({ command: 'cd "/a b" && make' })).toBe("make");
  expect(subjectOf({ command: "cd src" })).toBe("cd src");
});

t("two processes starting on one project share one project node and one user node", async () => {
  const { root, cwd } = setup();
  const journal = path.join(root, "journal.jsonl");
  const a = new MemoryService(MEMSRV!, journal);
  const b = new MemoryService(MEMSRV!, journal);
  const sa = new MemorySession({ memory: a, cwd, userSkillsDir: root });
  const sb = new MemorySession({ memory: b, cwd, userSkillsDir: root });
  await Promise.all([sa.begin("first task here"), sb.begin("second task here")]);
  const nodes = await a.nodes();
  expect(nodes.filter((n) => n.label === `project ${sa.identity.id}`)).toHaveLength(1);
  expect(nodes.filter((n) => n.label === "user preferences")).toHaveLength(1);
  // What one process learns, a third one reads.
  await sb.remember("project", "test command", "bun test ./packages");
  const fresh = new MemoryService(MEMSRV!, journal);
  expect((await fresh.profile("project", sa.identity.id)).map((f) => f.key)).toEqual(["test command"]);
  a.stop();
  b.stop();
  fresh.stop();
});

t("with copies of a standing node already written, every process picks the lowest id", async () => {
  const { root, memory } = setup();
  const ids: number[] = [];
  for (let i = 0; i < 5; i++) ids.push((await memory.createNode("entity", "user preferences", "semantic"))!);
  memory.stop();
  const fresh = new MemoryService(MEMSRV!, path.join(root, "journal.jsonl"));
  expect(await fresh.findLabel("user preferences")).toBe(Math.min(...ids));
  expect(await fresh.userNode()).toBe(Math.min(...ids));
  fresh.stop();
});

test("a sidecar that was down for the first run does not cost the session its episode, and the episode joins the project later", async () => {
  const calls: [string, unknown[]][] = [];
  let up = false;
  const fake = {
    project: async () => (calls.push(["project", []]), up ? 1 : undefined),
    userNode: async () => (up ? 2 : undefined),
    episode: async () => (up ? 10 : undefined),
    link: async (...args: unknown[]) => void calls.push(["link", args]),
    fact: async () => undefined,
  } as unknown as MemoryService;
  const s = new MemorySession({ memory: fake, cwd: os.tmpdir(), userSkillsDir: os.tmpdir() });
  expect(await s.begin("first try while memory is down")).toBeUndefined();
  up = true;
  expect(await s.begin("second try")).toBe(10);
  expect(calls.filter(([m]) => m === "link")).toEqual([["link", [10, 1, "part_of"]]]);
});

test("an episode made while the project was unreachable is linked to it once the project appears", async () => {
  const links: unknown[][] = [];
  let projectUp = false;
  const fake = {
    project: async () => (projectUp ? 1 : undefined),
    userNode: async () => 2,
    episode: async () => 10,
    link: async (...args: unknown[]) => void links.push(args),
    fact: async () => undefined,
  } as unknown as MemoryService;
  const s = new MemorySession({ memory: fake, cwd: os.tmpdir(), userSkillsDir: os.tmpdir() });
  expect(await s.begin("first")).toBe(10);
  expect(links).toEqual([]);
  projectUp = true;
  await s.begin("second");
  await s.begin("third");
  expect(links).toEqual([[10, 1, "part_of"]]);
});

t("a forgotten node is not found by its label any more, in the process that forgot it", async () => {
  const { memory } = setup();
  const old = (await memory.createNode("harness", "skill deploy", "procedural"))!;
  expect(await memory.findLabel("skill deploy")).toBe(old);
  expect(await memory.forgetNode(old)).toBe(true);
  expect(await memory.findLabel("skill deploy")).toBeUndefined();
  // and the sidecar refuses writes to it
  await memory.fact(old, "last used", "today");
  expect(await memory.state(old)).not.toContain("last used");
  memory.stop();
});

test("recall ranks by the sidecar's score, which already holds the (capped) votes: they are not counted twice", async () => {
  const mem = new MemoryService("/nonexistent/memsrv", path.join(os.tmpdir(), "mnemo-unused", "journal.jsonl"));
  const hit = (node: number, score: number, useful: number) => ({ node, label: `note ${node}`, kind: "Aspect", area: "Semantic", score, state: "", useful, unhelpful: 0 });
  mem.search = async () => [hit(1, 0.5, 0), hit(2, 0.3, 60)];
  expect((await mem.recall("how do we deploy", undefined, [])).map((h) => h.node)).toEqual([1, 2]);
});
