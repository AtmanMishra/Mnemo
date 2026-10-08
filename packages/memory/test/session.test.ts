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
import { findMemsrv, factValue, MemoryService, MemorySession, type MemoryNote, type Reflector } from "../src/index.ts";

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
