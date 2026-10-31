/**
 * The agent registry in one process: the files (atomic, private, validated), when a process
 * reads as live, ended or lost, what is pruned, the record a roster becomes, the inbox (each
 * request answered once, nothing it cannot do), and `mnemo agents` reading and reaching them.
 * registry-procs.test.ts does the same across real processes.
 */
import { test, expect, afterEach, describe } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Roster } from "../src/runtime/roster.ts";
import { acksDir, claimTag, inboxDir, KEEP_ENDED, KEEP_MS, parseRecord, procFile, procsDir, prune, readAll, readJson, shownStatus, STALE_MS, stateOf, writeJson, type AgentEntry, type ProcRecord } from "../src/registry/store.ts";
import { Publisher } from "../src/registry/publisher.ts";
import { awaitAck, Inbox, parseRequest, sendRequest, type Request } from "../src/registry/inbox.ts";
import { controls, type RootControl } from "../src/registry/controls.ts";
import { joinRegistry } from "../src/registry/join.ts";
import { agentsCommand, elsewhere, renderList, resolve, rows, type CliIo } from "../src/registry/cli.ts";
import { saveJobs } from "../src/schedule/store.ts";
import React from "react";
import { cleanup, render } from "ink-testing-library";
import { Hub } from "../src/ui/Hub.tsx";

const homes: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const c of cleanups.splice(0)) c();
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});
function home(): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-registry-"));
  homes.push(h);
  return h;
}

const DEAD_PID = 2 ** 22 + 12345;
const NOW = 1_800_000_000_000;

function agent(o: Partial<AgentEntry> = {}): AgentEntry {
  return { node: 1, kind: "root", label: "api", task: "", depth: 0, access: "full", status: "idle", steps: [], stepCount: 0, startedAt: NOW - 60_000, spent: 0, pending: 0, cwd: "/work/api", ...o };
}
function record(o: Partial<ProcRecord> = {}): ProcRecord {
  return { v: 1, tag: "abcd", pid: process.pid, kind: "interactive", version: "test", startedAt: NOW - 60_000, heartbeat: NOW - 1000, agents: [agent()], ...o };
}
function put(h: string, rec: ProcRecord): void {
  writeJson(procFile(h, rec.tag), rec);
}

function io(o: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s), width: 120, cwd: "/work/web", ackMs: 1500, ...o } satisfies CliIo, out, err };
}

describe("store", () => {
  test("a record is written whole, private, and read back", () => {
    const h = home();
    const rec = record();
    expect(writeJson(procFile(h, rec.tag), rec)).toBe(true);
    expect(parseRecord(readJson(procFile(h, rec.tag)))).toEqual(rec);
    // Nothing is left beside it.
    expect(fs.readdirSync(procsDir(h))).toEqual(["abcd.json"]);
    if (process.platform !== "win32") {
      expect(fs.statSync(procFile(h, rec.tag)).mode & 0o777).toBe(0o600);
      expect(fs.statSync(procsDir(h)).mode & 0o777).toBe(0o700);
    }
  });

  test("a rewrite replaces the file in place", () => {
    const h = home();
    put(h, record({ heartbeat: 1 }));
    put(h, record({ heartbeat: 2 }));
    expect((readJson(procFile(h, "abcd")) as ProcRecord).heartbeat).toBe(2);
    expect(fs.readdirSync(procsDir(h))).toEqual(["abcd.json"]);
  });

  test("a write that cannot happen says so and leaves nothing behind", () => {
    const h = home();
    // A file where the folder should be.
    fs.writeFileSync(path.join(h, "registry"), "");
    expect(writeJson(procFile(h, "abcd"), record())).toBe(false);
  });

  test("what is not a record is refused, and what is kept is bounded", () => {
    expect(parseRecord(undefined)).toBeUndefined();
    expect(parseRecord({ ...record(), v: 2 })).toBeUndefined();
    expect(parseRecord({ ...record(), tag: "../../etc" })).toBeUndefined();
    expect(parseRecord({ ...record(), kind: "daemon" })).toBeUndefined();
    expect(parseRecord({ ...record(), pid: "1" })).toBeUndefined();
    expect(parseRecord({ ...record(), agents: "x" })).toBeUndefined();
    const r = parseRecord({ ...record(), agents: [agent({ label: "x".repeat(500), steps: ["a", 3, "b"] as unknown as string[] }), { node: 2, kind: "boss", status: "idle" }, { node: 3, kind: "sub", status: "dancing" }, null] })!;
    expect(r.agents).toHaveLength(1);
    expect(r.agents[0]!.label).toHaveLength(80);
    expect(r.agents[0]!.steps).toEqual(["a", "b"]);
  });

  test("live, ended and lost", () => {
    const alive = () => true;
    expect(stateOf(record(), { now: NOW, alive })).toBe("live");
    expect(stateOf(record({ endedAt: NOW - 5 }), { now: NOW, alive: () => false })).toBe("ended");
    // Its pid is gone: it crashed or was killed.
    expect(stateOf(record({ pid: DEAD_PID }), { now: NOW })).toBe("lost");
    // Its pid is there but it stopped writing: the pid was reused, or it hangs.
    expect(stateOf(record({ heartbeat: NOW - STALE_MS - 1 }), { now: NOW, alive })).toBe("lost");
  });

  test("an agent that was working when its process died shows lost; a finished one keeps its outcome", () => {
    expect(shownStatus(agent({ status: "running" }), "lost")).toBe("lost");
    expect(shownStatus(agent({ status: "idle" }), "lost")).toBe("lost");
    expect(shownStatus(agent({ status: "done" }), "lost")).toBe("done");
    expect(shownStatus(agent({ status: "running" }), "live")).toBe("running");
  });

  test("only real records are read: no temporary files, strays or misnamed records", () => {
    const h = home();
    put(h, record());
    fs.writeFileSync(path.join(procsDir(h), ".abcd.json.123.tmp"), JSON.stringify(record({ tag: "zzzz" })));
    fs.writeFileSync(path.join(procsDir(h), "notes.txt"), "hello");
    fs.writeFileSync(path.join(procsDir(h), "broken.json"), "{");
    fs.writeFileSync(path.join(procsDir(h), "wxyz.json"), JSON.stringify(record({ tag: "other" })));
    expect(readAll(h, { now: NOW }).map((v) => v.rec.tag)).toEqual(["abcd"]);
    expect(readAll(path.join(h, "nowhere"))).toEqual([]);
  });

  test("a tag is never one a record already has", () => {
    const h = home();
    const tags = new Set<string>();
    for (let i = 0; i < 40; i++) tags.add(claimTag(h, (t) => JSON.stringify(record({ tag: t }))));
    expect(tags.size).toBe(40);
    for (const t of tags) expect(t).toMatch(/^[a-z0-9]{4}$/);
  });

  test("pruning forgets old and excess finished records, dead inboxes and stale answers; never a live one", () => {
    const h = home();
    put(h, record({ tag: "live", heartbeat: NOW - 1000, startedAt: NOW - 10 * KEEP_MS }));
    put(h, record({ tag: "oldend", endedAt: NOW - KEEP_MS - 1 }));
    put(h, record({ tag: "newend", endedAt: NOW - 1000 }));
    put(h, record({ tag: "oldlost", pid: DEAD_PID, heartbeat: NOW - KEEP_MS - 1 }));
    put(h, record({ tag: "newlost", pid: DEAD_PID, heartbeat: NOW - 1000 }));
    fs.mkdirSync(inboxDir(h, "live"), { recursive: true });
    fs.mkdirSync(inboxDir(h, "newend"), { recursive: true });
    fs.mkdirSync(acksDir(h), { recursive: true });
    fs.writeFileSync(path.join(acksDir(h), "old.json"), "{}");
    fs.utimesSync(path.join(acksDir(h), "old.json"), new Date(NOW - 3600_000), new Date(NOW - 3600_000));
    fs.writeFileSync(path.join(acksDir(h), "new.json"), "{}");
    fs.utimesSync(path.join(acksDir(h), "new.json"), new Date(NOW), new Date(NOW));
    const alive = (pid: number) => pid === process.pid;
    expect(prune(h, { now: NOW, alive })).toBe(2);
    expect(readAll(h, { now: NOW, alive }).map((v) => v.rec.tag).sort()).toEqual(["live", "newend", "newlost"]);
    expect(fs.existsSync(inboxDir(h, "live"))).toBe(true);
    expect(fs.existsSync(inboxDir(h, "newend"))).toBe(false);
    expect(fs.readdirSync(acksDir(h))).toEqual(["new.json"]);
    // A half-written file from a crash mid-write goes once it is old; a fresh one may be a write in progress.
    const half = path.join(procsDir(h), ".live.json.99.abc.tmp");
    const fresh = path.join(procsDir(h), ".live.json.98.def.tmp");
    fs.writeFileSync(half, "{");
    fs.utimesSync(half, new Date(NOW - 3600_000), new Date(NOW - 3600_000));
    fs.writeFileSync(fresh, "{");
    fs.utimesSync(fresh, new Date(NOW), new Date(NOW));
    prune(h, { now: NOW, alive });
    expect(fs.existsSync(half)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    // `clear`: every finished and lost record goes, the live one stays.
    expect(prune(h, { now: NOW, alive, all: true })).toBe(2);
    expect(readAll(h, { now: NOW, alive }).map((v) => v.rec.tag)).toEqual(["live"]);
  });

  test(`at most ${KEEP_ENDED} finished records are kept, the newest`, () => {
    const h = home();
    for (let i = 0; i < KEEP_ENDED + 5; i++) put(h, record({ tag: `e${String(i).padStart(3, "0")}`, startedAt: NOW - 100_000 + i, endedAt: NOW - 1000 }));
    prune(h, { now: NOW });
    const kept = readAll(h, { now: NOW }).map((v) => v.rec.tag);
    expect(kept).toHaveLength(KEEP_ENDED);
    expect(kept).not.toContain("e000");
    expect(kept).toContain(`e0${KEEP_ENDED + 4}`);
  });
});

describe("publisher", () => {
  function setup(o: { describe?: ConstructorParameters<typeof Publisher>[0]["describe"]; throttleMs?: number; now?: () => number } = {}) {
    const h = home();
    const roster = new Roster(o.now);
    const root = roster.addRoot("api");
    const pub = new Publisher({ home: h, kind: "interactive", version: "test", roster, throttleMs: o.throttleMs ?? 10, heartbeatMs: 60_000, describe: o.describe ?? (() => ({ cwd: "/work/api", model: "p/m", mode: "default" })) });
    cleanups.push(() => pub.close());
    const read = () => parseRecord(readJson(procFile(h, pub.tag)))!;
    return { h, roster, root, pub, read };
  }

  test("the record is the roster: conversations, sub-agents, what each is doing", () => {
    const { roster, root, pub, read } = setup();
    pub.start();
    const sub = roster.addSub(root.id, { label: "researcher", task: "find the auth code", access: "read-only" });
    for (let i = 1; i <= 8; i++) roster.step(sub.id, `step ${i}`);
    roster.spend(sub.id, 0.25);
    pub.flush();
    const r = read();
    expect(r.pid).toBe(process.pid);
    expect(r.endedAt).toBeUndefined();
    expect(r.agents.map((a) => [a.node, a.kind, a.label, a.status])).toEqual([
      [root.id, "root", "api", "idle"],
      [sub.id, "sub", "researcher", "running"],
    ]);
    const s = r.agents[1]!;
    expect(s).toMatchObject({ parent: root.id, depth: 1, access: "read-only", task: "find the auth code", stepCount: 8, spent: 0.25, cwd: "/work/api", model: "p/m" });
    // The last few steps, not all of them.
    expect(s.steps).toEqual(["step 4", "step 5", "step 6", "step 7", "step 8"]);
  });

  test("a sub-agent's own model, thinking level, limits and turns are in the record", () => {
    const { roster, root, pub, read } = setup();
    const sub = roster.addSub(root.id, { label: "cheap", task: "", access: "full", model: "anthropic/haiku", thinking: "low", caps: { turns: 60, spend: 0.5, maxTokens: 8000, context: 64000 } });
    roster.turn(sub.id);
    roster.turn(sub.id);
    pub.flush();
    const r = read();
    expect(r.agents.find((a) => a.node === sub.id)).toMatchObject({ model: "anthropic/haiku", thinking: "low", caps: { turns: 60, spend: 0.5, maxTokens: 8000, context: 64000 }, turns: 2 });
    // A conversation's model comes from its session, as before.
    expect(r.agents.find((a) => a.node === root.id)!.model).toBe("p/m");
  });

  test("what an agent writes is cleaned before it reaches the file", () => {
    const { roster, root, pub, read } = setup();
    const sub = roster.addSub(root.id, { label: "x\u001b[31mred", task: `key ${"sk-"}ant-api03-${"A".repeat(40)}`, access: "full" });
    pub.flush();
    const s = read().agents.find((a) => a.node === sub.id)!;
    expect(s.label).not.toContain("\u001b");
    expect(s.task).not.toContain("AAAAAAAAAAAAAAAAAAAA");
  });

  test("a burst of changes is written once the throttle passes", async () => {
    const { roster, root, pub, read } = setup({ throttleMs: 40 });
    pub.start();
    const before = read().agents.length;
    roster.addSub(root.id, { label: "a", task: "", access: "full" });
    roster.addSub(root.id, { label: "b", task: "", access: "full" });
    expect(read().agents.length).toBe(before);
    await Bun.sleep(120);
    expect(read().agents.length).toBe(before + 2);
  });

  test("a closed conversation stays, closed, with what it was last doing; a finished sub-agent keeps its answer", () => {
    const { roster, root, pub, read } = setup();
    const other = roster.addRoot("web");
    const sub = roster.addSub(other.id, { label: "helper", task: "t", access: "full" });
    roster.finish(sub.id, "done", "all good");
    roster.setTask(other.id, "ship it");
    pub.flush();
    roster.removeRoot(other.id);
    pub.flush();
    const r = read();
    const web = r.agents.find((a) => a.node === other.id)!;
    expect(web).toMatchObject({ status: "closed", task: "ship it" });
    expect(web.endedAt).toBeGreaterThan(0);
    expect(r.agents.find((a) => a.node === sub.id)).toMatchObject({ status: "done", answer: "all good" });
    expect(r.agents.find((a) => a.node === root.id)!.status).toBe("idle");
    // Still there on the next write.
    pub.flush();
    expect(read().agents.find((a) => a.node === other.id)!.status).toBe("closed");
  });

  test("closing marks the process ended, its agents finished, and stops writing", () => {
    const { roster, root, pub, read } = setup();
    pub.start();
    const sub = roster.addSub(root.id, { label: "busy", task: "", access: "full" });
    pub.close();
    const r = read();
    expect(r.endedAt).toBeGreaterThan(0);
    expect(r.agents.find((a) => a.node === root.id)!.status).toBe("closed");
    expect(r.agents.find((a) => a.node === sub.id)!.status).toBe("stopped");
    roster.addRoot("late");
    pub.soon();
    expect(read().agents.map((a) => a.label)).not.toContain("late");
    expect(stateOf(r)).toBe("ended");
  });

  test("a long session keeps its live agents and only the newest finished ones", () => {
    // One clock tick for all of them, as on a fast machine: the newest is told apart by its number.
    const { roster, root, pub, read } = setup({ now: () => NOW });
    for (let i = 0; i < 70; i++) {
      const s = roster.addSub(root.id, { label: `s${i}`, task: "", access: "full" });
      roster.finish(s.id, "done", `answer ${i}`);
    }
    const live = roster.addSub(root.id, { label: "still going", task: "", access: "full" });
    pub.flush();
    const r = read();
    expect(r.agents.length).toBe(60);
    expect(r.agents.some((a) => a.node === live.id)).toBe(true);
    expect(r.agents.some((a) => a.node === root.id)).toBe(true);
    expect(r.agents.some((a) => a.label === "s69")).toBe(true);
    expect(r.agents.some((a) => a.label === "s0")).toBe(false);
  });

  test("a describe that throws costs only the extra fields", () => {
    const { pub, read } = setup({
      describe: () => {
        throw new Error("closing");
      },
    });
    expect(pub.flush()).toBe(true);
    expect(read().agents[0]).toMatchObject({ label: "api", status: "idle" });
    expect(read().agents[0]!.cwd).toBeUndefined();
  });

  test("an approval waiting shows on a live agent, never on a finished one", () => {
    const { roster, root, pub, read } = setup({ describe: () => ({ waiting: "approve bash" }) });
    const sub = roster.addSub(root.id, { label: "s", task: "", access: "full" });
    roster.finish(sub.id, "failed");
    pub.flush();
    expect(read().agents.find((a) => a.node === root.id)!.waiting).toBe("approve bash");
    expect(read().agents.find((a) => a.node === sub.id)!.waiting).toBeUndefined();
  });
});

describe("inbox", () => {
  test("a request is carried out once and answered", async () => {
    const h = home();
    const seen: Request[] = [];
    const inbox = new Inbox(h, "abcd", (r) => (seen.push(r), { ok: true, result: `did ${r.op}` })).start();
    cleanups.push(() => inbox.stop());
    const id = sendRequest(h, "abcd", { op: "tell", node: 2, text: "check the tests", from: "web" });
    expect(await inbox.tick()).toBe(1);
    expect(await inbox.tick()).toBe(0);
    expect(seen).toEqual([{ v: 1, id, op: "tell", node: 2, text: "check the tests", at: expect.any(Number), from: "web" }]);
    expect(fs.readdirSync(inboxDir(h, "abcd"))).toEqual([]);
    const ack = await awaitAck(h, id, 1000);
    expect(ack).toMatchObject({ id, ok: true, result: "did tell" });
    // Collected once.
    expect(fs.readdirSync(acksDir(h))).toEqual([]);
  });

  test("what is not a request is answered as such and never applied", async () => {
    const h = home();
    const seen: Request[] = [];
    const inbox = new Inbox(h, "abcd", (r) => (seen.push(r), { ok: true, result: "" }));
    const dir = inboxDir(h, "abcd");
    fs.mkdirSync(dir, { recursive: true });
    const write = (name: string, body: unknown) => fs.writeFileSync(path.join(dir, name), typeof body === "string" ? body : JSON.stringify(body));
    write("1800000000001-aaaaaaaa.json", "{not json");
    write("1800000000002-bbbbbbbb.json", { v: 1, id: "someone-else", op: "tell", node: 1, text: "x" });
    write("1800000000003-cccccccc.json", { v: 1, id: "1800000000003-cccccccc", op: "approve", node: 1 });
    write("1800000000004-dddddddd.json", { v: 1, id: "1800000000004-dddddddd", op: "tell", node: 1, text: "   " });
    write("1800000000005-eeeeeeee.json", { v: 1, id: "1800000000005-eeeeeeee", op: "stop", node: -1 });
    write("1800000000006-ffffffff.json", { v: 1, id: "1800000000006-ffffffff", op: "tell", node: 1, text: "x".repeat(20_000) });
    // Not request names at all: left alone.
    write(".1800000000007-gggggggg.json.1.tmp", { v: 1 });
    write("notes.txt", "hi");
    expect(await inbox.tick()).toBe(6);
    expect(seen).toEqual([]);
    for (const id of ["1800000000001-aaaaaaaa", "1800000000003-cccccccc", "1800000000006-ffffffff"]) expect((await awaitAck(h, id, 100))?.ok).toBe(false);
    expect(fs.readdirSync(dir).sort()).toEqual([".1800000000007-gggggggg.json.1.tmp", "notes.txt"]);
  });

  test("a request's words are bounded", () => {
    const r = parseRequest({ v: 1, id: "x", op: "tell", node: 1, text: "y".repeat(9000) }, "x")!;
    expect(r.text!.length).toBe(8000);
  });

  test("a failure while applying is the answer, not a crash", async () => {
    const h = home();
    const inbox = new Inbox(h, "abcd", () => {
      throw new Error("the agent is gone");
    });
    const id = sendRequest(h, "abcd", { op: "stop", node: 1 });
    await inbox.tick();
    expect(await awaitAck(h, id, 500)).toMatchObject({ ok: false, result: "the agent is gone" });
  });

  test("two readers of one inbox apply a request once", async () => {
    const h = home();
    let applied = 0;
    const apply = async () => (applied++, await Bun.sleep(5), { ok: true, result: "" });
    const a = new Inbox(h, "abcd", apply);
    const b = new Inbox(h, "abcd", apply);
    for (let i = 0; i < 10; i++) sendRequest(h, "abcd", { op: "stop", node: 1 }, NOW + i);
    await Promise.all([a.tick(), b.tick(), a.tick(), b.tick()]);
    await Promise.all([a.tick(), b.tick()]);
    expect(applied).toBe(10);
  });

  test("a flood is taken twenty at a time", async () => {
    const h = home();
    const inbox = new Inbox(h, "abcd", () => ({ ok: true, result: "" }));
    for (let i = 0; i < 25; i++) sendRequest(h, "abcd", { op: "stop", node: 1 }, NOW + i);
    expect(await inbox.tick()).toBe(20);
    expect(await inbox.tick()).toBe(5);
  });

  test("no answer in time is undefined", async () => {
    expect(await awaitAck(home(), "1800000000000-nobody00", 50, 10)).toBeUndefined();
  });

  test("stopping removes the inbox", () => {
    const h = home();
    const inbox = new Inbox(h, "abcd", () => ({ ok: true, result: "" })).start();
    expect(fs.existsSync(inboxDir(h, "abcd"))).toBe(true);
    inbox.stop();
    expect(fs.existsSync(inboxDir(h, "abcd"))).toBe(false);
  });
});

describe("controls", () => {
  function setup(root: Partial<RootControl> | null = {}) {
    const roster = new Roster();
    const r = roster.addRoot("api");
    const told: string[] = [];
    const stopped: number[] = [];
    const sub = roster.addSub(r.id, { label: "helper", task: "t", access: "full" });
    roster.attach(sub.id, { deliver: () => true, tell: (t) => (told.push(t), true), stop: () => stopped.push(sub.id) });
    const calls: string[] = [];
    let running = false;
    const control: RootControl | undefined =
      root === null
        ? undefined
        : {
            running: () => running,
            submit: (text, how) => (calls.push(`${how}:${text}`), (running = true)) && undefined,
            notice: (t) => calls.push(`notice:${t}`),
            interrupt: () => (calls.push("interrupt"), (running = false)) && undefined,
            ...root,
          };
    const apply = controls(roster, (n) => (n === r.id ? control : undefined));
    const req = (o: Partial<Request>): Request => ({ v: 1, id: "1", op: "tell", node: r.id, at: 0, ...o });
    return { roster, root: r, sub, told, stopped, calls, apply, req, setRunning: (v: boolean) => (running = v) };
  }

  test("telling a sub-agent is the user's words after its current step", async () => {
    const { sub, told, apply, req, roster } = setup();
    expect(await apply(req({ node: sub.id, text: "use the v2 API" }))).toEqual({ ok: true, result: "helper reads it after its current step" });
    expect(told).toEqual(["use the v2 API"]);
    expect(roster.snapshot().events.at(-1)).toMatchObject({ kind: "told", node: sub.id });
    // steer is the same thing for a sub-agent.
    expect((await apply(req({ op: "steer", node: sub.id, text: "faster" }))).ok).toBe(true);
  });

  test("stopping a sub-agent stops it and what it started", async () => {
    const { sub, stopped, apply, req, roster } = setup();
    const grandchild = roster.addSub(sub.id, { label: "deeper", task: "", access: "full" });
    expect((await apply(req({ op: "stop", node: sub.id }))).ok).toBe(true);
    expect(roster.get(sub.id)!.status).toBe("stopped");
    expect(roster.get(grandchild.id)!.status).toBe("stopped");
    expect(stopped).toEqual([sub.id]);
  });

  test("a finished sub-agent or an unknown id is refused", async () => {
    const { sub, apply, req, roster } = setup();
    roster.finish(sub.id, "done", "ok");
    expect(await apply(req({ node: sub.id, text: "x" }))).toEqual({ ok: false, result: "helper has finished" });
    expect((await apply(req({ node: 99, text: "x" }))).result).toContain("no agent 99");
  });

  test("an idle conversation starts a turn with the words, and says where they came from", async () => {
    const { calls, apply, req } = setup();
    expect(await apply(req({ text: "run the tests", from: "web" }))).toEqual({ ok: true, result: "api started a turn with it" });
    expect(calls).toEqual(["notice:Sent from another terminal (from web)", "followUp:run the tests"]);
  });

  test("a running conversation queues tell and steers steer", async () => {
    const { calls, apply, req, setRunning } = setup();
    setRunning(true);
    expect((await apply(req({ text: "after this, deploy" }))).result).toBe("api reads it when its current turn ends");
    expect((await apply(req({ op: "steer", text: "wrong file" }))).result).toBe("api reads it after its current step");
    expect(calls.filter((c) => !c.startsWith("notice"))).toEqual(["followUp:after this, deploy", "steer:wrong file"]);
  });

  test("a command is never sent: it would change that terminal's mode or model", async () => {
    const { calls, apply, req } = setup();
    for (const text of ["/yolo", "  /model x", "/settings mode yolo"]) expect((await apply(req({ text }))).ok).toBe(false);
    expect(calls).toEqual([]);
  });

  test("stopping a conversation interrupts its turn; an idle one has nothing to stop", async () => {
    const { calls, apply, req, setRunning } = setup();
    expect(await apply(req({ op: "stop" }))).toEqual({ ok: false, result: "api is not working on anything" });
    setRunning(true);
    expect((await apply(req({ op: "stop" }))).ok).toBe(true);
    expect(calls).toContain("interrupt");
  });

  test("a headless run takes a stop and nothing else", async () => {
    const { apply, req, calls } = setup({ submit: undefined, running: () => true });
    expect((await apply(req({ text: "hi" }))).result).toContain("headless");
    expect((await apply(req({ op: "stop" }))).ok).toBe(true);
    expect(calls).toContain("interrupt");
  });

  test("a conversation with no controller cannot be reached", async () => {
    const { apply, req } = setup(null);
    expect((await apply(req({ text: "hi" }))).result).toContain("cannot be reached");
  });

  test("control characters in the words are cleaned", async () => {
    const { calls, apply, req } = setup();
    await apply(req({ text: "hi\u001b]0;pwned\u0007 there" }));
    expect(calls.at(-1)).not.toContain("\u001b");
  });
});

describe("joining", () => {
  test("MNEMO_REGISTRY=0 keeps a process out", () => {
    const h = home();
    expect(joinRegistry({ home: h, kind: "print", version: "t", roster: new Roster(), members: () => [], env: { MNEMO_REGISTRY: "0" } })).toBeUndefined();
    expect(fs.existsSync(path.join(h, "registry"))).toBe(false);
  });

  test("a home that cannot be written to never stops Mnemo starting", () => {
    const h = home();
    fs.writeFileSync(path.join(h, "registry"), "");
    expect(joinRegistry({ home: h, kind: "print", version: "t", roster: new Roster(), members: () => [], env: {} })).toBeUndefined();
  });

  test("joined: a record with the conversation's folder and model, an inbox, and both gone on close", () => {
    const h = home();
    const roster = new Roster();
    const root = roster.addRoot("api");
    const sub = roster.addSub(root.id, { label: "s", task: "", access: "full" });
    const j = joinRegistry({ home: h, kind: "rpc", version: "t", roster, env: {}, members: () => [{ node: root.id, cwd: "/work/api", model: () => "p/m", mode: () => "plan", waiting: () => "approve edit", control: { running: () => false, interrupt: () => {} } }] })!;
    cleanups.push(j.close);
    const r = readAll(h)[0]!;
    expect(r.state).toBe("live");
    expect(r.rec.kind).toBe("rpc");
    expect(r.rec.agents.find((a) => a.node === root.id)).toMatchObject({ cwd: "/work/api", model: "p/m", mode: "plan", waiting: "approve edit" });
    // A sub-agent works in its conversation's folder; the question is the conversation's.
    expect(r.rec.agents.find((a) => a.node === sub.id)).toMatchObject({ cwd: "/work/api", model: "p/m" });
    expect(r.rec.agents.find((a) => a.node === sub.id)!.waiting).toBeUndefined();
    expect(fs.existsSync(inboxDir(h, j.tag))).toBe(true);
    j.close();
    expect(readAll(h)[0]!.state).toBe("ended");
    expect(fs.existsSync(inboxDir(h, j.tag))).toBe(false);
  });
});

describe("mnemo agents", () => {
  function fleet(h: string) {
    put(h, record({ tag: "k3f9", agents: [agent({ node: 1, label: "api", task: "fix login", status: "running", steps: ["→ bash(bun test)"], mode: "default", model: "p/m" }), agent({ node: 2, parent: 1, kind: "sub", depth: 1, label: "researcher", status: "running", task: "find callers", spent: 0.031 }), agent({ node: 3, parent: 1, kind: "sub", depth: 1, label: "old", status: "done", answer: "found 3", endedAt: NOW - 30_000 })] }));
    put(h, record({ tag: "w2x8", startedAt: NOW - 30_000, agents: [agent({ node: 1, label: "web", cwd: "/work/web", waiting: "approve edit" })] }));
    put(h, record({ tag: "dead", pid: DEAD_PID, startedAt: NOW - 50_000, agents: [agent({ node: 1, label: "crashed", status: "running" })] }));
    put(h, record({ tag: "done", startedAt: NOW - 90_000, endedAt: NOW - 2 * 3600_000, agents: [agent({ node: 1, label: "yesterday", status: "closed" })] }));
  }

  test("rows: trees in order, refs, lost for a crashed process, last hour unless --all", () => {
    const h = home();
    fleet(h);
    const r = rows(readAll(h, { now: NOW }), { now: NOW });
    expect(r.map((x) => `${x.ref} ${x.status}`)).toEqual(["w2x8.1 idle", "dead.1 lost", "k3f9.1 running", "k3f9.2 running", "k3f9.3 done"]);
    expect(rows(readAll(h, { now: NOW }), { now: NOW, all: true }).map((x) => x.ref)).toContain("done.1");
  });

  test("a sub-agent whose parent was trimmed is still shown", () => {
    const h = home();
    put(h, record({ agents: [agent({ node: 7, parent: 3, kind: "sub", depth: 2, label: "orphan" })] }));
    expect(rows(readAll(h, { now: NOW }), { now: NOW }).map((x) => x.agent.label)).toEqual(["orphan"]);
  });

  test("a ref is tag.number, a tag alone (its conversation), or a name only one live agent has", () => {
    const h = home();
    fleet(h);
    put(h, record({ tag: "dup1", agents: [agent({ label: "twin" })] }));
    put(h, record({ tag: "dup2", agents: [agent({ label: "twin" })] }));
    const all = rows(readAll(h, { now: NOW }), { now: NOW, all: true });
    const ref = (s: string) => {
      const r = resolve(all, s);
      return typeof r === "string" ? r : r.ref;
    };
    expect(ref("k3f9.2")).toBe("k3f9.2");
    expect(ref("K3F9.2")).toBe("k3f9.2");
    expect(ref("k3f9")).toBe("k3f9.1");
    expect(ref("researcher")).toBe("k3f9.2");
    expect(ref("k3f9.9")).toBe("process k3f9 has no agent 9");
    expect(ref("twin")).toContain("2 live agents are called twin");
    expect(ref("nobody")).toContain("no agent nobody");
    // A finished agent can still be shown by its name.
    expect(ref("yesterday")).toBe("done.1");
  });

  test("the list says what each agent is doing, who waits for you, what was lost, and what is queued", () => {
    const h = home();
    fleet(h);
    saveJobs(h, [{ name: "nightly", cron: "0 3 * * *", prompt: "summarise the day", cwd: "/work/api", enabled: true, created: NOW }, { name: "off", cron: "0 3 * * *", prompt: "x", cwd: "/w", enabled: false, created: NOW }]);
    const { io: o, out } = io({ read: { now: NOW } });
    return agentsCommand([], h, o).then((code) => {
      expect(code).toBe(0);
      const text = out.join("\n");
      expect(text).toContain("REF");
      expect(text).toMatch(/k3f9\.1\s+running\s+api/);
      expect(text).toContain("→ bash(bun test)");
      expect(text).toMatch(/k3f9\.2\s+running\s+└ researcher/);
      expect(text).toContain("$0.031");
      expect(text).toMatch(/w2x8\.1\s+waiting\s+web/);
      expect(text).toContain("waiting for you: approve edit");
      expect(text).toMatch(/dead\.1\s+lost\s+crashed/);
      expect(text).toContain("found 3");
      expect(text).not.toContain("yesterday");
      expect(text).toContain("QUEUED (mnemo schedule)");
      expect(text).toContain("nightly");
      expect(text).not.toMatch(/\boff\b/);
    });
  });

  test("nothing running says so", () => {
    expect(renderList([], [])).toContain("No Mnemo agents are running");
  });

  test("--json is every record shown, with its state and each agent's shown status", async () => {
    const h = home();
    fleet(h);
    const { io: o, out } = io({ read: { now: NOW } });
    expect(await agentsCommand(["--json"], h, o)).toBe(0);
    const j = JSON.parse(out.join(""));
    expect(j.procs.map((p: { tag: string; state: string }) => `${p.tag}:${p.state}`)).toEqual(["w2x8:live", "dead:lost", "k3f9:live"]);
    expect(j.procs[1].agents[0].status).toBe("lost");
    expect(j.queued).toEqual([]);
  });

  test("show is everything about one agent", async () => {
    const h = home();
    fleet(h);
    const { io: o, out } = io({ read: { now: NOW } });
    expect(await agentsCommand(["show", "k3f9.1"], h, o)).toBe(0);
    const text = out.join("\n");
    for (const s of ["k3f9.1  api  (conversation)", "running", "model    p/m", "mode     default", "task     fix login", "→ bash(bun test)", "k3f9.2", "researcher", "terminal"]) expect(text).toContain(s);
    out.length = 0;
    expect(await agentsCommand(["show", "k3f9.2"], h, o)).toBe(0);
    expect(out.join("\n")).toContain("(sub-agent of k3f9.1 api, depth 1)");
    out.length = 0;
    expect(await agentsCommand(["show", "dead.1"], h, o)).toBe(0);
    expect(out.join("\n")).toContain("lost: last seen");
    out.length = 0;
    expect(await agentsCommand(["show", "k3f9.2", "--json"], h, o)).toBe(0);
    expect(JSON.parse(out.join(""))).toMatchObject({ ref: "k3f9.2", label: "researcher", process: { tag: "k3f9", state: "live" } });
  });

  test("show gives a sub-agent's model, thinking level and how much of its limits it used", async () => {
    const h = home();
    put(h, record({ tag: "k3f9", agents: [agent({ node: 1 }), agent({ node: 2, parent: 1, kind: "sub", depth: 1, label: "cheap", status: "running", model: "anthropic/haiku", thinking: "low", caps: { turns: 60, spend: 0.5, maxTokens: 8000, context: 64000 }, turns: 12, spent: 0.031 })] }));
    const { io: o, out } = io({ read: { now: NOW } });
    expect(await agentsCommand(["show", "k3f9.2"], h, o)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("model    anthropic/haiku · thinking low");
    expect(text).toContain("limits   12/60 turns · $0.03/$0.50 · 8,000 output tokens · 64,000 context");
    // No limits line for an agent that has none.
    out.length = 0;
    await agentsCommand(["show", "k3f9.1"], h, o);
    expect(out.join("\n")).not.toContain("limits");
  });

  test("limits from disk are numbers or nothing", () => {
    const r = parseRecord({ ...record(), agents: [agent({ caps: { turns: "lots", spend: 1 } as unknown as AgentEntry["caps"], turns: "x" as unknown as number })] })!;
    expect(r.agents[0]!.caps).toEqual({ turns: 0, spend: 1, maxTokens: 0, context: 0 });
    expect(r.agents[0]!.turns).toBeUndefined();
  });

  test("usage mistakes exit 2 and say what is wrong", async () => {
    const h = home();
    for (const argv of [["--bogus"], ["show"], ["tell"], ["tell", "k3f9.1"], ["stop", "k3f9.1", "now"], ["dance"], ["list", "x"], ["clear", "x"]]) {
      const { io: o, err } = io();
      expect(await agentsCommand(argv, h, o)).toBe(2);
      expect(err.join("")).toContain("mnemo agents:");
    }
    const { io: o, out } = io();
    expect(await agentsCommand(["--help"], h, o)).toBe(0);
    expect(out.join("")).toContain("approvals are answered only in the terminal that asks");
  });

  test("a finished agent or a process that is gone cannot be told anything", async () => {
    const h = home();
    fleet(h);
    for (const [ref, msg] of [
      ["dead.1", "was lost"],
      ["done.1", "has exited"],
      ["k3f9.3", "has finished"],
      ["nobody", "no agent nobody"],
    ]) {
      const { io: o, err } = io({ read: { now: NOW } });
      expect(await agentsCommand(["tell", ref!, "hello"], h, o)).toBe(1);
      expect(err.join("")).toContain(msg!);
    }
    // Nothing was written for any of them.
    expect(fs.existsSync(path.join(h, "registry", "inbox"))).toBe(false);
  });

  test("tell, steer and stop reach a live process and print its answer", async () => {
    const h = home();
    const roster = new Roster();
    const root = roster.addRoot("api");
    const sub = roster.addSub(root.id, { label: "helper", task: "", access: "full" });
    const told: string[] = [];
    roster.attach(sub.id, { deliver: () => true, tell: (t) => (told.push(t), true), stop: () => {} });
    const submitted: string[] = [];
    const j = joinRegistry({ home: h, kind: "interactive", version: "t", roster, env: {}, members: () => [{ node: root.id, cwd: "/work/api", control: { running: () => false, submit: (t, how) => void submitted.push(`${how}:${t}`), interrupt: () => {} } }] })!;
    cleanups.push(j.close);
    const fast = setInterval(() => void j.inbox.tick(), 20);
    cleanups.push(() => clearInterval(fast));

    let r = io();
    expect(await agentsCommand(["tell", `${j.tag}.${sub.id}`, "use", "--force", "carefully"], h, r.io)).toBe(0);
    expect(r.out.join("")).toBe("helper reads it after its current step");
    // The words are taken as typed, a "--" in them included.
    expect(told).toEqual(["use --force carefully"]);

    r = io();
    expect(await agentsCommand(["steer", j.tag, "look at web/ too"], h, r.io)).toBe(0);
    expect(submitted).toEqual(["steer:look at web/ too"]);

    r = io();
    expect(await agentsCommand(["tell", "api", "/yolo"], h, r.io)).toBe(1);
    expect(r.err.join("")).toContain("typed in that agent's own terminal");

    r = io();
    expect(await agentsCommand(["stop", `${j.tag}.${sub.id}`], h, r.io)).toBe(0);
    expect(roster.get(sub.id)!.status).toBe("stopped");
  });

  test("a process that does not pick a request up in time is reported, not waited on forever", async () => {
    const h = home();
    const roster = new Roster();
    const root = roster.addRoot("busy");
    const j = joinRegistry({ home: h, kind: "interactive", version: "t", roster, env: {}, members: () => [{ node: root.id, cwd: "/w", control: { running: () => false, interrupt: () => {} } }] })!;
    cleanups.push(j.close);
    // Its inbox is not read (it hangs).
    j.inbox.stop();
    const { io: o, out } = io({ ackMs: 100 });
    expect(await agentsCommand(["tell", j.tag, "hello"], h, o)).toBe(0);
    expect(out.join("")).toContain("has not picked it up yet");
  });

  test("clear forgets what finished and what was lost", async () => {
    const h = home();
    fleet(h);
    const { io: o, out } = io({ read: { now: NOW } });
    expect(await agentsCommand(["clear"], h, o)).toBe(0);
    expect(out.join("")).toBe("forgot 2 finished or lost processes");
    expect(readAll(h, { now: NOW }).map((v) => v.rec.tag).sort()).toEqual(["k3f9", "w2x8"]);
  });

  test("the hub's list: other processes' live agents and what was lost, never this process's own", () => {
    const h = home();
    fleet(h);
    const r = elsewhere(h, "k3f9", { now: NOW });
    expect(r.map((x) => `${x.ref} ${x.status}`)).toEqual(["w2x8.1 idle", "dead.1 lost"]);
  });

  test("the hub shows other terminals' agents, who waits there, and what was lost", () => {
    const h = home();
    fleet(h);
    const others = elsewhere(h, undefined, { now: NOW });
    const noop = () => {};
    const r = render(React.createElement(Hub, { agents: [], states: new Map(), recent: [], split: [], width: 120, height: 30, active: false, onOpen: noop, onSplit: noop, onClose: noop, onNew: noop, onOpenProject: noop, elsewhere: others }));
    const frame = r.lastFrame()!;
    expect(frame).toContain("ELSEWHERE");
    expect(frame).toContain("w2x8.1");
    expect(frame).toContain("waiting for you there · approve edit");
    expect(frame).toContain("lost: its process ended without saying so");
    expect(frame).toContain("→ bash(bun test)");
    // Finished ones are not news here.
    expect(frame).not.toContain("k3f9.3");
  });

  test("with nothing elsewhere the hub has no such section", () => {
    const noop = () => {};
    const r = render(React.createElement(Hub, { agents: [], states: new Map(), recent: [], split: [], width: 120, height: 30, active: false, onOpen: noop, onSplit: noop, onClose: noop, onNew: noop, onOpenProject: noop, elsewhere: [] }));
    expect(r.lastFrame()).not.toContain("ELSEWHERE");
  });
});
