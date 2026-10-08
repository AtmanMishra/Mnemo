/**
 * Learning from Claude Code's transcripts: a session is split into runs at
 * the person's prompts (never at injected turns), replayed through the
 * memory loop with its provenance, learned once, and picked up again only
 * for what is new.
 */
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { factValue, findMemsrv, ingestClaudeCode, MemoryService, parseClaudeCode, type Reflector } from "../src/index.ts";

const MEMSRV = findMemsrv("/nonexistent");
const t = MEMSRV ? test : test.skip;
const KEY = "oc_sk_" + "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2";

/** A Claude Code transcript, as the rows it writes. */
function transcript(cwd: string, extra: object[] = []): string {
  const base = { sessionId: "s-1", cwd, isSidechain: false };
  const user = (content: unknown, more: object = {}) => ({ ...base, type: "user", message: { role: "user", content }, ...more });
  const assistant = (content: unknown[], stop: string) => ({ ...base, type: "assistant", message: { role: "assistant", model: "claude-opus-5-5", content, stop_reason: stop } });
  const rows = [
    { type: "ai-title", aiTitle: "tests", sessionId: "s-1" },
    user(`run the tests please, the key is ${KEY}`, { origin: { kind: "human" } }),
    assistant([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm vitest" } }], "tool_use"),
    user([{ type: "tool_result", tool_use_id: "t1", content: "sh: vitest: not found", is_error: true }]),
    assistant([{ type: "tool_use", id: "t2", name: "Bash", input: { command: "pnpm install" } }], "tool_use"),
    user([{ type: "tool_result", tool_use_id: "t2", content: "done", is_error: false }]),
    assistant([{ type: "tool_use", id: "t3", name: "Bash", input: { command: "pnpm vitest" } }], "tool_use"),
    user([{ type: "tool_result", tool_use_id: "t3", content: "12 passed" }]),
    // Injected turns are context, not prompts.
    user("<task-notification>build finished</task-notification>", { origin: { kind: "task-notification" } }),
    user("Stop hook feedback: commit your changes", { isMeta: true }),
    { ...base, isSidechain: true, type: "user", message: { role: "user", content: "a sub-agent's prompt" } },
    assistant([{ type: "text", text: "All 12 tests pass after installing dependencies." }], "end_turn"),
    ...extra,
  ];
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

test("a transcript splits into runs at the person's prompts, with tool outcomes", () => {
  const s = parseClaudeCode(transcript("/repo"))!;
  expect(s).toMatchObject({ id: "s-1", cwd: "/repo", model: "claude-opus-5-5" });
  expect(s.runs).toHaveLength(1);
  const run = s.runs[0]!;
  expect(run.finished).toBe(true);
  expect(run.tools.map((x) => [x.input.command, x.ok])).toEqual([
    ["pnpm vitest", false],
    ["pnpm install", true],
    ["pnpm vitest", true],
  ]);
  expect(run.tools[0]!.error).toBe("sh: vitest: not found");
  expect(run.messages.at(-1)).toEqual({ role: "assistant", content: "All 12 tests pass after installing dependencies." });
});

t("ingest learns a Claude Code session once, with provenance, and only what is new after that", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-ingest-"));
  const cwd = path.join(root, "repo");
  const projects = path.join(root, "claude-projects");
  fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(projects, "-repo"), { recursive: true });
  const file = path.join(projects, "-repo", "s-1.jsonl");
  fs.writeFileSync(file, transcript(cwd));
  const memory = new MemoryService(MEMSRV!, path.join(root, "journal.jsonl"));
  const seen: string[] = [];
  const reflect: Reflector = async (_system, user) => {
    seen.push(user);
    return JSON.stringify({
      facts: [{ scope: "project", key: "test command", value: "pnpm vitest", source: "observed" }],
      episode: { goal: "run the tests", outcome: "done", done: "installed, ran vitest", decisions: [], open: [] },
      fixes: [{ problem: "vitest: not found", fix: "pnpm install before pnpm vitest" }],
      skill: null,
    });
  };
  const opts = { memory, home: root, userSkillsDir: path.join(root, "skills"), reflect, projectsDir: projects, settleMs: 0 };

  expect(await ingestClaudeCode(opts)).toEqual({ sessions: 1, runs: 1, unchanged: 0, active: 0 });
  // The reflection model never saw the pasted key.
  expect(seen[0]).toContain("then: Bash(pnpm install)");
  expect(seen[0]).not.toContain(KEY);
  const profile = await memory.profile("project", `dir:${cwd}`);
  expect(profile).toContainEqual({ key: "test command", value: "pnpm vitest" });
  const pitfall = (await memory.search("vitest not found", 5)).find((h) => h.area === "Salience")!;
  expect(factValue(pitfall.state, "fix")).toBe("pnpm install before pnpm vitest");
  expect(factValue(pitfall.state, "learned from")).toBe("claude-code/claude-opus-5-5");

  // Nothing new: nothing learned, no model call.
  expect(await ingestClaudeCode(opts)).toEqual({ sessions: 0, runs: 0, unchanged: 1, active: 0 });
  expect(seen).toHaveLength(1);

  // The session grew: a new run, still being written, waits; once quiet it is learned.
  const base = { sessionId: "s-1", cwd, isSidechain: false };
  fs.appendFileSync(
    file,
    [
      { ...base, type: "user", origin: { kind: "human" }, message: { role: "user", content: "now lint it with pnpm lint and fix whatever it reports" } },
      { ...base, type: "assistant", message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "t9", name: "Bash", input: { command: "pnpm lint" } }], stop_reason: "tool_use" } },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n",
  );
  expect(await ingestClaudeCode({ ...opts, settleMs: 60_000 })).toEqual({ sessions: 0, runs: 0, unchanged: 0, active: 1 });
  expect(await ingestClaudeCode(opts)).toEqual({ sessions: 1, runs: 1, unchanged: 0, active: 0 });
  expect(seen).toHaveLength(2);
  expect(seen[1]).toContain("now lint it with pnpm lint");
  memory.stop();
}, 30_000);
