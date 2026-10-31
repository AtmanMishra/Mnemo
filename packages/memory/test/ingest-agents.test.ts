/**
 * Learning from Codex's rollouts and opencode's database, as from Claude
 * Code's transcripts: runs start at the person's prompts (never at context the
 * agent injected), tool failures are kept, sub-agent sessions are skipped, and
 * each session is learned once with its agent and model as provenance.
 */
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { codexSessions, factValue, findMemsrv, ingestCodex, ingestOpencode, MemoryService, opencodeDatabase, opencodeSessions, parseCodex, type Reflector } from "../src/index.ts";

const MEMSRV = findMemsrv("/nonexistent");
const t = MEMSRV ? test : test.skip;

/** A Codex rollout, as the lines it writes. */
function rollout(cwd: string, meta: object = {}): string {
  const line = (type: string, payload: object) => ({ timestamp: "2026-10-28T10:00:00.000Z", type, payload });
  const user = (...text: string[]) => line("response_item", { type: "message", role: "user", content: text.map((t) => ({ type: "input_text", text: t })) });
  const call = (id: string, cmd: string) => line("response_item", { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd }), call_id: id });
  const output = (id: string, output: string) => line("response_item", { type: "function_call_output", call_id: id, output });
  const rows = [
    line("session_meta", { id: "019a-codex", cwd, timestamp: "2026-10-28T10:00:00.000Z", originator: "codex_cli_rs", source: "cli", ...meta }),
    line("response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions instructions>…" }] }),
    // Context Codex sends as user messages: not prompts.
    user("# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>use pnpm</INSTRUCTIONS>", "<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>"),
    line("turn_context", { cwd, model: "gpt-5.5-codex", approval_policy: "on-request" }),
    user("run the tests please"),
    line("event_msg", { type: "user_message", message: "run the tests please", kind: "plain" }),
    line("response_item", { type: "reasoning", summary: [], content: null }),
    call("c1", "pnpm vitest"),
    output("c1", "Chunk ID: 1\nWall time: 0.1000 seconds\nProcess exited with code 127\nOutput:\nsh: vitest: not found"),
    call("c2", "pnpm install"),
    output("c2", "Exit code: 0\nWall time: 3.2 seconds\nOutput:\ndone"),
    line("response_item", { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch\n*** End Patch", call_id: "c3" }),
    line("response_item", { type: "custom_tool_call_output", call_id: "c3", output: "Success. Updated the following files:\nM a.ts" }),
    line("response_item", { type: "local_shell_call", call_id: "c4", status: "completed", action: { type: "exec", command: ["pnpm", "vitest"] } }),
    output("c4", JSON.stringify({ output: "12 passed", metadata: { exit_code: 0, duration_seconds: 1.5 } })),
    line("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "All 12 tests pass after installing dependencies." }] }),
    line("event_msg", { type: "task_complete", turn_id: "1", last_agent_message: "All 12 tests pass" }),
    user("<turn_aborted>\nThe user interrupted\n</turn_aborted>"),
    user("now lint it"),
    call("c5", "pnpm lint"),
    line("event_msg", { type: "turn_aborted", reason: "interrupted" }),
  ];
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

test("a Codex rollout splits into runs at the person's prompts, with shell exit codes as outcomes", () => {
  const s = parseCodex(rollout("/repo"))!;
  expect(s).toMatchObject({ id: "019a-codex", cwd: "/repo", model: "gpt-5.5-codex" });
  expect(s.runs.map((r) => [r.prompt, r.finished])).toEqual([
    ["run the tests please", true],
    ["now lint it", false],
  ]);
  const run = s.runs[0]!;
  expect(run.tools.map((x) => [x.name, x.input.cmd ?? x.input.command ?? x.input.input, x.ok])).toEqual([
    ["exec_command", "pnpm vitest", false],
    ["exec_command", "pnpm install", true],
    ["apply_patch", "*** Begin Patch\n*** End Patch", true],
    ["shell", ["pnpm", "vitest"], true],
  ]);
  expect(run.tools[0]!.error).toBe("sh: vitest: not found");
  expect(run.messages.at(-1)).toEqual({ role: "assistant", content: "All 12 tests pass after installing dependencies." });
});

test("a Codex sub-agent's rollout is not a session of its own", () => {
  expect(parseCodex(rollout("/repo", { parent_thread_id: "019a-parent" }))).toBeUndefined();
  expect(parseCodex(rollout("/repo", { source: { subagent: "review" } }))).toBeUndefined();
  expect(parseCodex('{"type":"response_item","payload":{}}\n')).toBeUndefined();
});

test("Codex rollouts are found under sessions/YYYY/MM/DD", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-codex-"));
  const day = path.join(root, "sessions", "2026", "10", "28");
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, "rollout-2026-10-28T10-00-00-019a.jsonl"), rollout("/repo"));
  fs.writeFileSync(path.join(day, "notes.jsonl"), "");
  expect(codexSessions(path.join(root, "sessions")).map((f) => path.basename(f))).toEqual(["rollout-2026-10-28T10-00-00-019a.jsonl"]);
  expect(codexSessions(path.join(root, "missing"))).toEqual([]);
});

/** An opencode 2 database: the tables and columns ingest reads. */
function opencode2(file: string, cwd: string, now = Date.now()): void {
  const db = new Database(file);
  db.run("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, time_created INTEGER, time_updated INTEGER)");
  db.run("CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)");
  db.run("INSERT INTO session_v2 VALUES ('ses_1', NULL, ?, ?, ?), ('ses_sub', 'ses_1', ?, ?, ?)", [cwd, now, now, cwd, now, now]);
  const model = { id: "kimi-k3", providerID: "opencode" };
  const tool = (name: string, state: object) => ({ type: "tool", id: name, name, state, time: { created: now } });
  const rows: [string, string, object][] = [
    ["ses_1", "system", { text: "<system-reminder>plan mode</system-reminder>", time: { created: now } }],
    ["ses_1", "user", { text: "run the tests please", time: { created: now } }],
    ["ses_1", "assistant", { agent: "build", model, time: { created: now }, content: [{ type: "reasoning", text: "…" }, tool("bash", { status: "error", input: { command: "pnpm vitest" }, error: { type: "unknown", message: "sh: vitest: not found" } })] }],
    ["ses_1", "synthetic", { text: "The bash tool was called with invalid arguments", time: { created: now } }],
    ["ses_1", "assistant", { agent: "build", model, time: { created: now }, content: [tool("bash", { status: "completed", input: { command: "pnpm install" }, content: [{ type: "text", text: "done" }] })] }],
    ["ses_1", "assistant", { agent: "build", model, time: { created: now }, content: [{ type: "text", text: "All 12 tests pass." }], finish: "stop" }],
    ["ses_1", "idle", { outcome: "succeeded", time: { created: now } }],
    ["ses_1", "user", { text: "now lint it", time: { created: now } }],
    ["ses_1", "assistant", { agent: "build", model, time: { created: now }, content: [tool("bash", { status: "running", input: { command: "pnpm lint" }, metadata: {} })] }],
    ["ses_sub", "user", { text: "a sub-agent's prompt", time: { created: now } }],
  ];
  rows.forEach(([session, type, data], seq) => db.run("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)", [`msg_${seq}`, session, type, seq, now, now, JSON.stringify(data)]));
  db.close();
}

/** An opencode 1 database: messages with a role, and their parts. */
function opencode1(file: string, cwd: string, now = Date.now()): void {
  const db = new Database(file);
  db.run("CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, time_created INTEGER, time_updated INTEGER)");
  db.run("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)");
  db.run("CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)");
  db.run("INSERT INTO session VALUES ('ses_old', NULL, ?, ?, ?)", [cwd, now, now]);
  const message = (id: string, at: number, data: object) => db.run("INSERT INTO message VALUES (?, 'ses_old', ?, ?, ?)", [id, now + at, now + at, JSON.stringify(data)]);
  const part = (id: string, msg: string, data: object) => db.run("INSERT INTO part VALUES (?, ?, 'ses_old', ?, ?, ?)", [id, msg, now, now, JSON.stringify(data)]);
  message("msg_a", 1, { role: "user", time: { created: now } });
  part("prt_a1", "msg_a", { type: "text", text: "run the tests please" });
  part("prt_a2", "msg_a", { type: "text", text: "Called the Read tool with …", synthetic: true });
  message("msg_b", 2, { role: "assistant", modelID: "glm-5", providerID: "zai", time: { created: now }, finish: "stop" });
  part("prt_b1", "msg_b", { type: "tool", callID: "1", tool: "bash", state: { status: "error", input: { command: "pnpm vitest" }, error: "sh: vitest: not found" } });
  part("prt_b2", "msg_b", { type: "tool", callID: "2", tool: "bash", state: { status: "completed", input: { command: "pnpm install" }, output: "done" } });
  part("prt_b3", "msg_b", { type: "text", text: "Installed; the tests pass." });
  db.close();
}

test("an opencode 2 database: runs at the person's prompts, tool errors kept, sub-agent sessions skipped", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-opencode-"));
  const file = path.join(root, "opencode.db");
  opencode2(file, "/repo");
  const all = [...opencodeSessions(file)];
  expect(all.map((x) => x.session.id)).toEqual(["ses_1"]);
  const s = all[0]!.session;
  expect(s).toMatchObject({ cwd: "/repo", model: "kimi-k3" });
  expect(s.runs.map((r) => [r.prompt, r.finished])).toEqual([
    ["run the tests please", true],
    ["now lint it", false],
  ]);
  expect(s.runs[0]!.tools.map((x) => [x.input.command, x.ok, x.error])).toEqual([
    ["pnpm vitest", false, "sh: vitest: not found"],
    ["pnpm install", true, undefined],
  ]);
  expect(s.runs[0]!.messages.at(-1)).toEqual({ role: "assistant", content: "All 12 tests pass." });
});

test("an opencode 1 database is read from its message and part tables", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-opencode1-"));
  const file = path.join(root, "opencode.db");
  opencode1(file, "/repo");
  const [only, ...rest] = [...opencodeSessions(file)];
  expect(rest).toEqual([]);
  expect(only!.session).toMatchObject({ id: "ses_old", cwd: "/repo", model: "glm-5" });
  const run = only!.session.runs[0]!;
  expect(run).toMatchObject({ prompt: "run the tests please", finished: true });
  expect(run.tools.map((x) => [x.input.command, x.ok])).toEqual([
    ["pnpm vitest", false],
    ["pnpm install", true],
  ]);
  expect([...opencodeSessions(path.join(root, "missing.db"))]).toEqual([]);
});

test("opencode's database is found where opencode puts it", () => {
  expect(opencodeDatabase({ XDG_DATA_HOME: "/data" })).toBe(path.join("/data", "opencode", "opencode.db"));
  expect(opencodeDatabase({ XDG_DATA_HOME: "/data", OPENCODE_DB: "other.db" })).toBe(path.join("/data", "opencode", "other.db"));
  expect(opencodeDatabase({ OPENCODE_DB: path.resolve("/x/y.db") })).toBe(path.resolve("/x/y.db"));
});

t("Codex and opencode sessions are learned once each, with their agent and model as provenance", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-ingest-agents-"));
  const cwd = path.join(root, "repo");
  fs.mkdirSync(cwd);
  const day = path.join(root, "codex", "2026", "10", "28");
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, "rollout-2026-10-28T10-00-00-019a-codex.jsonl"), rollout(cwd));
  const db = path.join(root, "opencode.db");
  opencode2(db, cwd);
  const memory = new MemoryService(MEMSRV!, path.join(root, "journal.jsonl"));
  const seen: string[] = [];
  const reflect: Reflector = async (_system, user) => {
    seen.push(user);
    return JSON.stringify({
      facts: [],
      episode: { goal: "run the tests", outcome: "done", done: "installed, ran vitest", decisions: [], open: [] },
      fixes: [{ problem: "vitest: not found", fix: "pnpm install before pnpm vitest" }],
      skill: null,
    });
  };
  const opts = { memory, home: root, userSkillsDir: path.join(root, "skills"), reflect, codexDir: path.join(root, "codex"), opencodeDb: db, settleMs: 0 };

  // Both runs: the second, interrupted one is still a run worth knowing about.
  expect(await ingestCodex(opts)).toEqual({ sessions: 1, runs: 2, unchanged: 0, active: 0 });
  expect(await ingestOpencode(opts)).toEqual({ sessions: 1, runs: 2, unchanged: 0, active: 0 });
  expect(seen.some((s) => s.includes("vitest: not found"))).toBe(true);
  const sources = (await memory.search("vitest not found", 10)).filter((h) => h.area === "Salience").map((h) => factValue(h.state, "learned from"));
  expect(sources).toContain("codex/gpt-5.5-codex");
  expect(sources).toContain("opencode/kimi-k3");
  expect(JSON.parse(fs.readFileSync(path.join(root, "memory", "ingested.json"), "utf8"))).toEqual({ "codex:019a-codex": 2, "opencode:ses_1": 2 });

  // Nothing new: nothing learned again.
  const calls = seen.length;
  expect(await ingestCodex(opts)).toEqual({ sessions: 0, runs: 0, unchanged: 1, active: 0 });
  expect(await ingestOpencode(opts)).toEqual({ sessions: 0, runs: 0, unchanged: 1, active: 0 });
  expect(seen).toHaveLength(calls);
  memory.stop();
}, 30_000);

t("an opencode session still being written waits until it goes quiet", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-ingest-quiet-"));
  const db = path.join(root, "opencode.db");
  opencode2(db, path.join(root, "repo"));
  const memory = new MemoryService(MEMSRV!, path.join(root, "journal.jsonl"));
  const opts = { memory, home: root, userSkillsDir: root, opencodeDb: db, reflect: async () => "{}" };
  // The first run finished, so it is taken; the second is still going.
  expect(await ingestOpencode({ ...opts, settleMs: 60_000 })).toEqual({ sessions: 1, runs: 1, unchanged: 0, active: 0 });
  expect(await ingestOpencode({ ...opts, settleMs: 60_000 })).toEqual({ sessions: 0, runs: 0, unchanged: 0, active: 1 });
  expect(await ingestOpencode({ ...opts, now: Date.now() + 120_000, settleMs: 60_000 })).toEqual({ sessions: 1, runs: 1, unchanged: 0, active: 0 });
  memory.stop();
}, 30_000);
