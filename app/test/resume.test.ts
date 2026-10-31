/**
 * Finding and resuming every conversation on the machine: pi's saved sessions in every project,
 * read against the registry so each shows as open (another terminal has it), interrupted (its
 * process died) or saved; `mnemo agents resume` continues one from any folder, a sub-agent's ref
 * leads to its conversation, and an open one is never opened twice.
 */
import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { agentsCommand, interruptedHere, type CliIo } from "../src/registry/cli.ts";
import { classify, findSaved, interruptedIn, type SessionLike } from "../src/registry/saved.ts";
import { procFile, readAll, writeJson, type AgentEntry, type ProcRecord } from "../src/registry/store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (p: string) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `mnemo-resume-${p}-`)));
  dirs.push(d);
  return d;
};

const DEAD_PID = 2 ** 22 + 12345;
const NOW = Date.now();

function agent(o: Partial<AgentEntry> = {}): AgentEntry {
  return { node: 1, kind: "root", label: "api", task: "", depth: 0, access: "full", status: "idle", steps: [], stepCount: 0, startedAt: NOW - 60_000, spent: 0, pending: 0, ...o };
}
function put(home: string, o: Partial<ProcRecord>): void {
  const rec: ProcRecord = { v: 1, tag: "abcd", pid: process.pid, kind: "interactive", version: "test", startedAt: NOW - 60_000, heartbeat: NOW - 1000, agents: [], ...o };
  writeJson(procFile(home, rec.tag), rec);
}
function session(file: string, cwd: string, over: Partial<SessionLike> = {}): SessionLike {
  return { path: file, id: path.basename(file, ".jsonl"), cwd, firstMessage: "fix the flaky test", created: new Date(NOW - 3_600_000), modified: new Date(NOW - 60_000), ...over };
}

/** A home where one conversation is open, one was cut off, one closed cleanly and one is only saved. */
function world() {
  const home = tmp("home");
  const api = tmp("api");
  const web = tmp("web");
  const f = (n: string) => path.join(home, "agent", "sessions", `${n}.jsonl`);
  const sessions = [
    session(f("0aa-open"), api, { modified: new Date(NOW - 5_000) }),
    session(f("0bb-lost"), api, { firstMessage: "migrate the\n  database", modified: new Date(NOW - 600_000) }),
    session(f("0cc-closed"), web, { modified: new Date(NOW - 7_200_000) }),
    session(f("0dd-old"), web, { name: "an old one", modified: new Date(NOW - 30 * 86_400_000) }),
  ];
  put(home, { tag: "live", agents: [agent({ cwd: api, session: f("0aa-open"), status: "running" }), agent({ node: 2, kind: "sub", parent: 1, depth: 1, label: "tester", status: "running" })] });
  put(home, {
    tag: "dead",
    pid: DEAD_PID,
    startedAt: NOW - 900_000,
    agents: [agent({ cwd: api, session: f("0bb-lost"), status: "running" }), agent({ node: 3, kind: "sub", parent: 1, depth: 1, label: "migrator", status: "running" })],
  });
  put(home, { tag: "gone", startedAt: NOW - 8_000_000, endedAt: NOW - 7_000_000, agents: [agent({ cwd: web, session: f("0cc-closed"), status: "closed" })] });
  // The cut-off conversation had a sub-agent whose transcript was saved beside it.
  fs.mkdirSync(path.join(home, "agent", "sessions", "0bb-lost", "sub"), { recursive: true });
  fs.writeFileSync(path.join(home, "agent", "sessions", "0bb-lost", "sub", "3-migrator.jsonl"), "{}\n");
  return { home, api, web, sessions, f };
}

test("every saved conversation shows whether it is open, was cut off, or is saved, newest first", () => {
  const w = world();
  const saved = classify(w.sessions, readAll(w.home));
  expect(saved.map((s) => [s.id, s.state, s.ref ?? ""])).toEqual([
    ["0aa-open", "open", "live.1"],
    ["0bb-lost", "interrupted", "dead.1"],
    ["0cc-closed", "saved", ""],
    ["0dd-old", "saved", ""],
  ]);
  expect(saved[1]).toMatchObject({ title: "migrate the database", subs: 1 });
  expect(saved[3]!.title).toBe("an old one");
  expect(interruptedIn(saved, w.api).map((s) => s.id)).toEqual(["0bb-lost"]);
  expect(interruptedIn(saved, w.web)).toEqual([]);
});

test("a ref finds a conversation by registry ref, by a sub-agent's ref, or by the start of its id", () => {
  const w = world();
  const views = readAll(w.home);
  const saved = classify(w.sessions, views);
  const id = (r: ReturnType<typeof findSaved>) => (typeof r === "string" ? r : r.id);
  expect(id(findSaved(saved, views, "dead"))).toBe("0bb-lost");
  expect(id(findSaved(saved, views, "dead.3"))).toBe("0bb-lost"); // the sub-agent's conversation
  expect(id(findSaved(saved, views, "0CC"))).toBe("0cc-closed");
  expect(findSaved(saved, views, "0")).toContain("4 sessions start with 0");
  expect(findSaved(saved, views, "dead.9")).toBe("process dead has no agent 9");
  expect(findSaved(saved, views, "zzzz")).toContain("no agent or saved session zzzz");
  put(w.home, { tag: "nosv", agents: [agent({ cwd: w.api })] });
  expect(findSaved(saved, readAll(w.home), "nosv")).toContain("has no saved session");
});

function io(w: ReturnType<typeof world>, o: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const launched: string[][] = [];
  const cli: CliIo = { out: (s) => out.push(s), err: (s) => err.push(s), width: 140, sessions: async () => w.sessions, launch: async (a) => (launched.push(a), 0), ...o };
  return { cli, out, err, launched };
}

test("mnemo agents saved lists the last week across projects, --all everything", async () => {
  const w = world();
  const a = io(w);
  expect(await agentsCommand(["saved"], w.home, a.cli)).toBe(0);
  const text = a.out.join("\n");
  expect(text).toContain("open live.1");
  expect(text).toContain("interrupted dead.1");
  expect(text).toContain("migrate the database (+1 sub-agent)");
  expect(text).toContain("mnemo agents resume <id> continues it");
  expect(text).not.toContain("an old one");
  const b = io(w);
  await agentsCommand(["saved", "--all"], w.home, b.cli);
  expect(b.out.join("\n")).toContain("an old one");
  const c = io(w);
  await agentsCommand(["saved", "--json"], w.home, c.cli);
  expect((JSON.parse(c.out[0]!) as { id: string }[]).map((s) => s.id)).toEqual(["0aa-open", "0bb-lost", "0cc-closed"]);
});

test("mnemo agents resume continues a conversation in its own folder, never one that is open", async () => {
  const w = world();
  const a = io(w);
  expect(await agentsCommand(["resume", "dead.3"], w.home, a.cli)).toBe(0);
  expect(a.launched).toEqual([["--cwd", w.api, "--session", w.f("0bb-lost")]]);

  const b = io(w);
  expect(await agentsCommand(["resume", "0aa"], w.home, b.cli)).toBe(1);
  expect(b.err[0]).toContain('open in another terminal (live.1); mnemo agents tell live.1 "…" reaches it');
  expect(b.launched).toEqual([]);

  fs.rmSync(w.web, { recursive: true });
  const c = io(w);
  expect(await agentsCommand(["resume", "0cc"], w.home, c.cli)).toBe(1);
  expect(c.err[0]).toContain("is not there any more");
  expect(await agentsCommand(["resume"], w.home, io(w).cli)).toBe(2);
});

test("at start, a conversation in this folder cut off by a dead process is found; nothing is read when none was", async () => {
  const w = world();
  const found = await interruptedHere(w.home, w.api, undefined, async () => w.sessions);
  expect(found.map((s) => s.id)).toEqual(["0bb-lost"]);
  // The one being resumed right now is not news.
  expect(await interruptedHere(w.home, w.api, w.f("0bb-lost"), async () => w.sessions)).toEqual([]);
  const quiet = tmp("quiet");
  put(quiet, { tag: "live", agents: [agent({ cwd: w.api, session: w.f("0aa-open") })] });
  let read = false;
  expect(await interruptedHere(quiet, w.api, undefined, async () => ((read = true), w.sessions))).toEqual([]);
  expect(read).toBe(false);
});

test("pi's own session list feeds it: a real saved session is listed and resumable", async () => {
  const home = tmp("pi");
  const cwd = tmp("proj");
  const dir = path.join(home, "sessions");
  const sm = SessionManager.create(cwd, dir);
  sm.appendMessage({ role: "user", content: "fix the flaky test", timestamp: Date.now() } as never);
  sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "done" }], api: "x", provider: "x", model: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } as never);
  const out: string[] = [];
  const launched: string[][] = [];
  const cli: CliIo = { out: (s) => out.push(s), err: (s) => out.push(s), width: 140, sessions: () => SessionManager.listAll(dir), launch: async (a) => (launched.push(a), 0) };
  expect(await agentsCommand(["saved"], home, cli)).toBe(0);
  expect(out.join("\n")).toContain("fix the flaky test");
  expect(await agentsCommand(["resume", sm.getSessionId().slice(0, 12)], home, cli)).toBe(0);
  expect(launched[0]).toEqual(["--cwd", cwd, "--session", sm.getSessionFile()!]);
});

test("mnemo --session refuses a file that is not there", () => {
  const r = Bun.spawnSync([process.execPath, path.join(import.meta.dir, "..", "bin", "mnemo.ts"), "--session", "/nonexistent/x.jsonl", "-p", "hi"], { env: { ...process.env, MNEMO_HOME: tmp("cli") } });
  expect(r.exitCode).toBe(2);
  expect(r.stderr.toString()).toContain("no saved session at /nonexistent/x.jsonl");
});
