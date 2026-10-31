/**
 * What a session leaves on disk for its agents: each sub-agent's transcript beside the
 * conversation's, a state file that keeps every agent the session started (also the ones
 * the live roster let go of), and old sub-agent transcripts pruned. Real pi sessions on the
 * scripted model, in a throwaway home.
 */
import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { LIMITS, Roster } from "../src/runtime/roster.ts";
import { pruneSubTranscripts, readState, stateFileOf, subDirOf } from "../src/runtime/session-files.ts";
import { SettingsStore, parseValue, showValue } from "../src/runtime/settings.ts";
import { mnemoEnv } from "./helpers.ts";

const envs: Awaited<ReturnType<typeof mnemoEnv>>[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
});
async function env(o: Parameters<typeof mnemoEnv>[0] = {}) {
  const e = await mnemoEnv(o);
  envs.push(e);
  return e;
}
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1])], { stopReason: "toolUse" });
const say = (t: string) => fauxAssistantMessage(fauxText(t));
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-persist-")));
const fileOf = (e: Awaited<ReturnType<typeof env>>) => e.runtime.session.sessionManager.getSessionFile()!;
/** The state file is written a moment after the roster settles. */
async function stateOf(e: Awaited<ReturnType<typeof env>>, until: (s: NonNullable<ReturnType<typeof readState>>) => boolean = () => true) {
  for (let i = 0; i < 100; i++) {
    const s = readState(stateFileOf(fileOf(e)));
    if (s && until(s)) return s;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("no state file");
}

test("a sub-agent's transcript is saved in its session's folder, any depth flat, and /resume does not list it", async () => {
  const roster = new Roster();
  const e = await env({ mode: "yolo", roster, persistent: true });
  e.faux.setResponses([
    call("spawn_subagent", { task: "map the modules", name: "mapper" }),
    call("spawn_subagent", { task: "read src/fetch.ts", name: "reader" }),
    say("fetch.ts has getJson"),
    say("modules mapped"),
    say("all done"),
  ]);
  await e.controller.submit("map it");
  await e.idle();
  const dir = subDirOf(fileOf(e));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  expect(files).toHaveLength(2); // the child and the grandchild, side by side
  const [mapper, reader] = ["mapper", "reader"].map((l) => roster.snapshot().nodes.find((n) => n.label === l)!);
  expect(path.dirname(mapper!.transcript!)).toBe(dir);
  expect(path.dirname(reader!.transcript!)).toBe(dir);
  const text = fs.readFileSync(reader!.transcript!, "utf8");
  expect(text).toContain("read src/fetch.ts"); // its brief
  expect(text).toContain("fetch.ts has getJson"); // its answer
  // It is a session pi can open, and it names the conversation it belongs to.
  const opened = SessionManager.open(mapper!.transcript!);
  expect(opened.getHeader()?.parentSession).toBe(fileOf(e));
  expect(opened.getEntries().some((x) => x.type === "message")).toBe(true);
  // The list /resume reads holds the conversation only.
  const listed = await SessionManager.list(e.cwd);
  expect(listed.map((s) => s.path)).toEqual([fileOf(e)]);
});

test("a session that is not saved saves no sub-agent transcript either", async () => {
  const roster = new Roster();
  const e = await env({ mode: "yolo", roster });
  e.faux.setResponses([call("spawn_subagent", { task: "look", name: "kid" }), say("looked"), say("done")]);
  await e.controller.submit("delegate");
  await e.idle();
  expect(roster.snapshot().nodes.find((n) => n.label === "kid")!.transcript).toBeUndefined();
  expect(fs.existsSync(path.join(e.home, "agent", "sessions"))).toBe(false);
});

test("the state file says what the session and its sub-agents did: models, limits, spend and answers", async () => {
  const roster = new Roster();
  const e = await env({ mode: "yolo", roster, persistent: true, label: "app" });
  e.faux.setResponses([call("spawn_subagent", { task: "count files", name: "counter", maxTurns: 7 }), say("3 files"), say("there are 3")]);
  await e.controller.submit("how many files?");
  await e.idle();
  const s = await stateOf(e, (x) => x.status === "idle" && x.nodes.length === 2);
  expect(s).toMatchObject({ version: 1, session: e.runtime.session.sessionManager.getSessionId(), transcript: fileOf(e), pid: process.pid, cwd: e.cwd, mode: "yolo", model: "mnemo-demo/demo-model", status: "idle" });
  expect(s.nodes[0]).toMatchObject({ kind: "root", label: "app", task: "how many files?" });
  expect(s.nodes[1]).toMatchObject({ kind: "sub", parent: e.host.node, label: "counter", status: "done", answer: "3 files", model: "mnemo-demo/demo-model", caps: { turns: 7 }, turns: 1 });
  expect(fs.existsSync(s.nodes[1]!.transcript!)).toBe(true);
  if (process.platform !== "win32") expect(fs.statSync(stateFileOf(fileOf(e))).mode & 0o777).toBe(0o600);
  // Written whole, by rename: no temporary file is left beside it.
  expect(fs.readdirSync(path.dirname(fileOf(e))).filter((f) => f.endsWith(".tmp"))).toEqual([]);
});

test("what a sub-agent wrote is redacted in the state file", async () => {
  const roster = new Roster();
  const e = await env({ mode: "yolo", roster, persistent: true });
  const key = `sk-ant-api03-${"A".repeat(28)}`;
  e.faux.setResponses([call("spawn_subagent", { task: "find the key", name: "finder" }), say(`the key is ${key}`), say("found")]);
  await e.controller.submit("go");
  await e.idle();
  const s = await stateOf(e, (x) => x.nodes.some((n) => n.status === "done"));
  const raw = fs.readFileSync(stateFileOf(fileOf(e)), "utf8");
  expect(raw).not.toContain(key);
  expect(s.nodes[1]!.answer).toContain("the key is");
});

test("ended sub-agents past keepEnded leave the live roster, and the state file still has them all", async () => {
  const roster = new Roster();
  roster.setLimits({ keepEnded: 2 });
  const e = await env({ mode: "yolo", roster, persistent: true });
  const four = ["a", "b", "c", "d"].flatMap((n) => [call("spawn_subagent", { task: `job ${n}`, name: n }), say(`${n} done`)]);
  e.faux.setResponses([...four, say("all four done")]);
  await e.controller.submit("four jobs, one after another");
  await e.idle();
  expect(roster.snapshot().nodes.filter((n) => n.kind === "sub").map((n) => n.label)).toEqual(["c", "d"]);
  // Their names stay for the feed.
  expect(roster.snapshot().labels.get(2)).toBe("a");
  const s = await stateOf(e, (x) => x.nodes.length === 5 && x.status === "idle");
  expect(s.nodes.slice(1).map((n) => [n.label, n.status, n.answer])).toEqual([
    ["a", "done", "a done"],
    ["b", "done", "b done"],
    ["c", "done", "c done"],
    ["d", "done", "d done"],
  ]);
});

test("the roster never lets go of an ended sub-agent whose own sub-agents still run", () => {
  const r = new Roster(Date.now, { ...LIMITS, keepEnded: 0 });
  const root = r.addRoot("app").id;
  const parent = r.addSub(root, { label: "parent", task: "t", access: "read-only" }).id;
  const kid = r.addSub(parent, { label: "kid", task: "t", access: "read-only" }).id;
  r.finish(parent, "done", "x");
  const other = r.addSub(root, { label: "other", task: "t", access: "read-only" }).id;
  r.finish(other, "done", "y");
  expect(r.get(parent)).toBeDefined(); // its child is running
  expect(r.get(kid)!.status).toBe("running");
  r.finish(kid, "done", "z");
  r.finish(r.addSub(root, { label: "last", task: "t", access: "read-only" }).id, "done");
  expect(r.get(parent)).toBeUndefined(); // now the whole subtree has ended, and goes together
  expect(r.get(kid)).toBeUndefined();
});

test("old sub-agent transcripts are pruned, the user's own conversations never, and 0 keeps everything", () => {
  const sessions = tmp();
  const project = path.join(sessions, "--project--");
  const conv = path.join(project, "2026-01-01_abc.jsonl");
  const sub = subDirOf(conv);
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(conv, "{}\n");
  const old = path.join(sub, "old.jsonl");
  const fresh = path.join(sub, "fresh.jsonl");
  fs.writeFileSync(old, "{}\n");
  fs.writeFileSync(fresh, "{}\n");
  const long = (Date.now() - 40 * 86_400_000) / 1000;
  fs.utimesSync(old, long, long);
  fs.utimesSync(conv, long, long);
  expect(pruneSubTranscripts(sessions, 0)).toBe(0);
  expect(fs.existsSync(old)).toBe(true);
  expect(pruneSubTranscripts(sessions, 30)).toBe(1);
  expect([fs.existsSync(old), fs.existsSync(fresh), fs.existsSync(conv)]).toEqual([false, true, true]);
  // Once nothing is left the folders go too; the conversation stays.
  fs.utimesSync(fresh, long, long);
  expect(pruneSubTranscripts(sessions, 30)).toBe(1);
  expect(fs.existsSync(path.dirname(sub))).toBe(false);
  expect(fs.existsSync(conv)).toBe(true);
  expect(pruneSubTranscripts(path.join(sessions, "missing"), 30)).toBe(0);
});

test("a saved session prunes old sub-agent transcripts when it starts, as keepSubTranscripts says", async () => {
  const home = tmp();
  const cwd = tmp();
  const sessions = path.join(home, "agent", "sessions", "--elsewhere--");
  const sub = subDirOf(path.join(sessions, "2026-01-01_old.jsonl"));
  fs.mkdirSync(sub, { recursive: true });
  const old = path.join(sub, "x.jsonl");
  fs.writeFileSync(old, "{}\n");
  const long = (Date.now() - 10 * 86_400_000) / 1000;
  fs.utimesSync(old, long, long);
  const settings = new SettingsStore();
  settings.set("keepSubTranscripts", 30);
  await env({ home, cwd, persistent: true, settings });
  expect(fs.existsSync(old)).toBe(true); // 10 days is within 30
  settings.set("keepSubTranscripts", 7);
  await env({ home, cwd, persistent: true, settings });
  expect(fs.existsSync(old)).toBe(false);
  expect(parseValue("keepSubTranscripts", "0")).toEqual({ ok: true, value: 0 });
  expect(showValue("keepSubTranscripts", 0)).toBe("forever");
});
