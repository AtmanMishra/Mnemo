/**
 * 11(a): an MCP server is torn down as a process TREE, with escalation.
 *
 * No server is ever started and no pid is ever signalled here: the clients
 * adopt fake process objects and a recording KillSystem, so the whole path —
 * graceful signal, grace period, forced kill, in-flight requests, pipe release
 * — is exercised without a real child process and without a POSIX shell (this
 * file has to pass on Windows, where the real-server tests cannot run at all:
 * their fake servers are `python3`, which Windows does not have).
 */
import { test, after } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_KILL_SYSTEM, MCP_TERMINATE_GRACE_MS, McpClient, defaultTerminationReporter,
  describeTermination, setTerminationReporter, terminateTree,
  type KillSystem, type McpProcess, type TearDownTarget, type TerminationReport,
} from "../src/mcp.ts";

// Nothing in this file may print: several tests deliberately teardown servers
// that ignore every signal, and the default reporter would announce each one.
setTerminationReporter(() => { /* quiet during tests */ });
after(() => setTerminationReporter(() => { /* leave the process quiet */ }));

// --- fakes -----------------------------------------------------------------

/** A readable pipe stand-in: `push` is "the server wrote a line". */
interface FakeStream {
  destroyed: boolean;
  on(event: "data", listener: (chunk: any) => void): unknown;
  destroy(): unknown;
  push(chunk: string): void;
}

function fakeStream(): FakeStream {
  const listeners: Array<(chunk: any) => void> = [];
  return {
    destroyed: false,
    on(_event: "data", listener: (chunk: any) => void) {
      listeners.push(listener);
      return this;
    },
    destroy() {
      this.destroyed = true;
      return this;
    },
    push(chunk: string) {
      for (const fn of [...listeners]) fn(chunk);
    },
  };
}

/**
 * A process stand-in with node's semantics: `exitCode`/`signalCode` are null
 * while it runs, setting them emits 'exit'.
 */
class FakeProcess implements McpProcess {
  pid: number | undefined = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdinEnded = false;
  stdout = fakeStream();
  stderr = fakeStream();
  /** Every direct kill that reached this object (the last-ditch path). */
  directKills: Array<NodeJS.Signals | number | undefined> = [];
  /** Called with each line the client writes to stdin (a scripted server). */
  onWrite: ((line: string) => void) | undefined;
  stdin = {
    write: (chunk: string) => {
      this.onWrite?.(chunk.trim());
      return true;
    },
    end: () => {
      this.stdinEnded = true;
      return true;
    },
  };
  private listeners = new Map<string, Array<(...args: any[]) => void>>();

  once(event: string, listener: (...args: any[]) => void): unknown {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.directKills.push(signal);
    return true;
  }

  /** The process ends, the way node reports it: code set, then 'exit'. */
  exit(code = 0, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    for (const fn of [...(this.listeners.get("exit") ?? [])]) fn(code, signal);
  }

  /** A protocol line from the "server". */
  reply(message: unknown): void {
    this.stdout.push(`${JSON.stringify(message)}\n`);
  }
}

/** Every OS action terminateTree / stop() asked for, and nothing real. */
class FakeKillSystem implements KillSystem {
  platform: NodeJS.Platform;
  signals: Array<[number, string]> = [];
  taskkills: Array<[number, boolean]> = [];
  /** Runs on each action; the hook that makes a fake "honour" the signal. */
  onAction: ((pid: number, action: string) => void) | undefined;
  /** When set, every action throws instead of being delivered. */
  failWith: string | undefined;

  constructor(platform: NodeJS.Platform = "linux") {
    this.platform = platform;
  }

  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
    this.signals.push([pid, signal]);
    if (this.failWith) throw new Error(this.failWith);
    this.onAction?.(pid, signal);
  }

  taskkill(pid: number, force: boolean): void {
    this.taskkills.push([pid, force]);
    if (this.failWith) throw new Error(this.failWith);
    this.onAction?.(pid, force ? "taskkill /T /F" : "taskkill /T");
  }
}

/** A hand-rolled TearDownTarget, for the terminateTree unit tests. */
function fakeTarget(opts: { pid?: number; alive?: boolean; deathsBeforeAliveCheck?: number } = {}) {
  const state = {
    pid: "pid" in opts ? opts.pid : 4242,
    alive: opts.alive ?? true,
    exits: [] as Array<() => void>,
    directKills: [] as Array<NodeJS.Signals | number | undefined>,
    aliveChecks: 0,
  };
  const target: TearDownTarget = {
    pid: state.pid,
    alive: () => {
      state.aliveChecks++;
      return state.alive;
    },
    onExit: (fn) => {
      state.exits.push(fn);
    },
    kill: (signal) => {
      state.directKills.push(signal);
      state.alive = false;
      return true;
    },
  };
  return {
    target,
    state,
    /** The process ends on its own. */
    die: () => {
      state.alive = false;
      for (const fn of [...state.exits]) fn();
    },
  };
}

function client(name = "fake", opts: { pid?: number } = {}): { c: McpClient; proc: FakeProcess; kill: FakeKillSystem } {
  const c = new McpClient(name, { command: "definitely-not-a-real-binary-xyz" });
  const proc = new FakeProcess();
  if (opts.pid !== undefined) proc.pid = opts.pid;
  const kill = new FakeKillSystem();
  c.killSystem = kill;
  c.terminateGraceMs = 20;
  c.adopt(proc);
  return { c, proc, kill };
}

/**
 * The grace timer is unref'd on purpose — a server that ignores SIGTERM must
 * not hold the agent's event loop open while we wait to force it — so a bare
 * test loop has to hold a handle of its own for the escalation to be
 * observable. This stands in for the agent's own work keeping the loop alive.
 */
function keepLoopAlive(): () => void {
  const handle = setInterval(() => { /* a live event loop */ }, 5);
  return () => clearInterval(handle);
}

// --- terminateTree: the escalation itself ----------------------------------

test("a process that never started is not signalled at all", async () => {
  const kill = new FakeKillSystem();
  const { target, state } = fakeTarget({ pid: undefined });
  const r = await terminateTree(target, "gone", { kill, graceMs: 5 });
  assert.deepEqual({ escalated: r.escalated, method: r.method }, { escalated: false, method: "none" });
  assert.equal(r.pid, undefined);
  assert.deepEqual(kill.signals, [], "nothing to signal");
  assert.deepEqual(state.directKills, []);
});

test("an already-exited process is reported as already gone, not escalated", async () => {
  const kill = new FakeKillSystem();
  const { target } = fakeTarget({ alive: false });
  const r = await terminateTree(target, "dead", { kill, graceMs: 5 });
  assert.equal(r.method, "none");
  assert.equal(r.escalated, false);
  assert.deepEqual(kill.signals, []);
});

test("a server that honours the graceful signal dies quietly", async () => {
  const kill = new FakeKillSystem();
  const { target, die } = fakeTarget();
  kill.onAction = () => die(); // the server exits on SIGTERM
  const r = await terminateTree(target, "polite", { kill, graceMs: 20 });
  assert.equal(r.method, "SIGTERM");
  assert.equal(r.escalated, false, "no escalation when the graceful signal was enough");
  assert.deepEqual(kill.signals, [[4242, "SIGTERM"]], "SIGTERM only, to the group");
  // The grace timer was cancelled, not left to fire a late SIGKILL.
  await new Promise((res) => setTimeout(res, 60));
  assert.deepEqual(kill.signals, [[4242, "SIGTERM"]]);
});

test("a server that ignores SIGTERM is escalated to SIGKILL and reported", async () => {
  const kill = new FakeKillSystem(); // onAction unset: the server ignores everything
  const { target } = fakeTarget();
  const release = keepLoopAlive();
  const r = await terminateTree(target, "stubborn", { kill, graceMs: 20 });
  release();
  assert.equal(r.escalated, true);
  assert.equal(r.method, "SIGKILL");
  assert.equal(r.error, undefined);
  assert.deepEqual(kill.signals, [[4242, "SIGTERM"], [4242, "SIGKILL"]],
    "the whole group, gracefully then by force");
  assert.match(describeTermination(r), /ignored SIGTERM/);
  assert.match(describeTermination(r), /pid 4242/);
});

test("Windows escalates taskkill /T to taskkill /T /F", async () => {
  const kill = new FakeKillSystem("win32");
  const { target } = fakeTarget();
  const release = keepLoopAlive();
  const r = await terminateTree(target, "win", { kill, graceMs: 20 });
  release();
  assert.deepEqual(kill.taskkills, [[4242, false], [4242, true]], "taskkill without /F first, then /F");
  assert.deepEqual(kill.signals, [], "no POSIX signals on Windows");
  assert.equal(r.method, "taskkill /T /F");
  assert.equal(r.escalated, true);
});

test("Windows reports a quiet death when taskkill /T is enough", async () => {
  const kill = new FakeKillSystem("win32");
  const { target, die } = fakeTarget();
  kill.onAction = () => die();
  const r = await terminateTree(target, "win", { kill, graceMs: 20 });
  assert.deepEqual(kill.taskkills, [[4242, false]]);
  assert.equal(r.method, "taskkill /T");
  assert.equal(r.escalated, false);
});

test("a forced action that cannot be delivered still falls back to the direct child", async () => {
  const kill = new FakeKillSystem();
  kill.failWith = "EPERM: not permitted";
  const { target, state } = fakeTarget();
  const r = await terminateTree(target, "unreachable", { kill, graceMs: 5 });
  assert.equal(r.escalated, true);
  assert.match(String(r.error), /EPERM/);
  assert.deepEqual(state.directKills, ["SIGKILL"], "last ditch: kill what we hold");
});

test("a signal that cannot be delivered to a process that is already gone is not an escalation", async () => {
  const kill = new FakeKillSystem();
  kill.failWith = "ESRCH: no such process";
  // Alive at the first check, gone by the time the failed signal is handled.
  const { target, state } = fakeTarget();
  const flaky: TearDownTarget = {
    pid: target.pid,
    alive: () => ++state.aliveChecks > 1 ? false : true,
    onExit: target.onExit,
    kill: target.kill,
  };
  const r = await terminateTree(flaky, "vanished", { kill, graceMs: 5 });
  assert.equal(r.escalated, false);
  assert.equal(r.method, "none");
  assert.deepEqual(state.directKills, []);
});

// --- McpClient.stop(): the client's half -----------------------------------

test("stop() settles in-flight requests instead of waiting on a dead pipe", async () => {
  const { c, proc } = client();
  // A server that never answers: the request can only end via stop().
  const inflight = c.request("initialize");
  assert.equal(c.alive, true);
  c.stop();
  await assert.rejects(() => inflight, /mcp server "fake" was stopped/);
  assert.equal(proc.stdinEnded, true, "the server is told EOF");
  assert.equal(proc.stdout.destroyed, true, "our end of the pipe is released");
  assert.equal(proc.stderr.destroyed, true);
  proc.exit(1); // settle the teardown inside this test, not in another one
});

test("stop() reports a server it had to escalate, not one that died quietly", async () => {
  const reports: TerminationReport[] = [];
  setTerminationReporter((r) => reports.push(r));

  const stubborn = client("stubborn");
  const release = keepLoopAlive();
  stubborn.c.stop();
  const forced = await stubborn.c.whenStopped();
  const polite = client("polite");
  polite.kill.onAction = () => polite.proc.exit(0, "SIGTERM");
  polite.c.stop();
  const quiet = await polite.c.whenStopped();
  release();

  assert.equal(forced?.escalated, true);
  assert.equal(forced?.method, "SIGKILL");
  assert.deepEqual(stubborn.kill.signals, [[4242, "SIGTERM"], [4242, "SIGKILL"]]);
  assert.equal(quiet?.escalated, false);
  assert.equal(quiet?.method, "SIGTERM");
  assert.deepEqual(polite.kill.signals, [[4242, "SIGTERM"]]);
  // The reporter sees both; only the escalated one is worth a line.
  assert.deepEqual(reports.map((r) => [r.server, r.escalated]), [["stubborn", true], ["polite", false]]);
});

test("stop() on a client that never started is a no-op", async () => {
  const c = new McpClient("never", { command: "x" });
  c.stop();
  assert.equal(await c.whenStopped(), null);
});

test("a wedged server is still reported, with the grace it was given", async () => {
  const { c, kill } = client("wedged");
  c.killSystem = kill;
  c.terminateGraceMs = 15;
  const release = keepLoopAlive();
  c.stop();
  const r = await c.whenStopped();
  release();
  assert.equal(r?.graceMs, 15);
  assert.equal(r?.escalated, true);
});

test("the exit-time sweep kills a tree that stop() left in its grace period", () => {
  const { c, proc, kill } = client("slowpoke");
  c.terminateGraceMs = 60_000; // still waiting out its grace
  c.stop();
  assert.deepEqual(kill.signals, [[4242, "SIGTERM"]], "the graceful phase is in flight");
  assert.equal(c.alive, false, "not addressable as a live server any more");
  c.forceKillTree(); // what the process-exit hook does
  assert.deepEqual(kill.signals, [[4242, "SIGTERM"], [4242, "SIGKILL"]],
    "the tree is still reachable after stop()");
  proc.exit(0, "SIGKILL");
  kill.signals.length = 0;
  c.forceKillTree();
  assert.deepEqual(kill.signals, [], "an exited server is not signalled again");
});

test("forceKillTree kills a live tree and leaves a dead one alone", () => {
  const live = client("live");
  live.c.forceKillTree();
  assert.deepEqual(live.kill.signals, [[4242, "SIGKILL"]], "no grace period on process exit");

  live.kill.signals.length = 0;
  live.c.stop();
  live.c.forceKillTree();
  assert.deepEqual(live.kill.signals, [[4242, "SIGTERM"], [4242, "SIGKILL"]],
    "a tree mid-teardown is still reachable");
  live.proc.exit(0, "SIGTERM");

  const dead = client("dead");
  dead.proc.exit(0);
  const before = dead.kill.signals.length;
  dead.c.forceKillTree();
  assert.equal(dead.kill.signals.length, before, "nothing to kill");
  dead.c.stop();
});

// --- the seam itself: a fake process drives the real protocol path ----------

test("adopt() runs the real handshake against a fake process object", async () => {
  const { c, proc, kill } = client("scripted");
  proc.onWrite = (line) => {
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      proc.reply({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05" } });
    } else if (msg.method === "tools/list") {
      proc.reply({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", description: "echo back" }] } });
    }
    // notifications carry no id and need no reply
  };
  const info = await c.initialize();
  assert.equal(info.protocolVersion, "2024-11-05");
  assert.deepEqual((await c.listTools()).map((t: any) => t.name), ["echo"]);
  // Noise on stdout and a notification with no id must not break framing.
  proc.stdout.push("not json at all\n");
  proc.reply({ jsonrpc: "2.0", method: "notifications/message" });
  assert.deepEqual((await c.listTools()).map((t: any) => t.name), ["echo"]);
  // Tear down the scripted server the way a polite one goes: it exits on the
  // graceful signal, so this test never has to wait out a grace period.
  kill.onAction = () => proc.exit(0, "SIGTERM");
  c.stop();
  assert.equal((await c.whenStopped())?.escalated, false);
});

test("a server that exits on its own rejects the requests it left hanging", async () => {
  const { c, proc } = client("crashy");
  const inflight = c.request("initialize");
  proc.stderr.push("boom: bad config");
  proc.exit(1);
  await assert.rejects(() => inflight, /mcp server "crashy" exited/);
  assert.equal(c.alive, false);
});

test("the default grace period and kill system are the documented ones", () => {
  assert.equal(MCP_TERMINATE_GRACE_MS, 2_000);
  assert.equal(DEFAULT_KILL_SYSTEM.platform, process.platform);
  // describeTermination is what a log line or the startup banner renders.
  assert.match(describeTermination({ server: "s", escalated: false, method: "SIGTERM", graceMs: 5 }), /exited on SIGTERM/);
  assert.match(describeTermination({ server: "s", escalated: false, method: "none", graceMs: 5 }), /already gone/);
  assert.match(
    describeTermination({ server: "s", escalated: true, method: "SIGKILL", graceMs: 5, error: "EPERM" }),
    /had to be killed as a process tree with SIGKILL.*EPERM/,
  );
});

test("a real launcher and its real grandchild both die (end to end)", async () => {
  // The fakes above pin the logic; this one pins the OS part, with no server
  // and no python: a real launcher process that spawns a real grandchild which
  // INHERITS OUR STDOUT (exactly the process that used to keep the agent's pipe
  // open forever), taken down for real. The grandchild writes a heartbeat, so
  // "it is gone" is provable without depending on how this platform reaps
  // orphans.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-mcptree-"));
  const pidFile = path.join(dir, "pids.json");
  const beat = path.join(dir, "beat.txt");
  const launcher = `
    const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    const beat = ${JSON.stringify(beat)};
    const g = spawn(process.execPath,
      ["-e", "setInterval(() => require('node:fs').appendFileSync(" + JSON.stringify(beat) + ", '.'), 100)"],
      { stdio: ["ignore", "inherit", "ignore"] });
    fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ parent: process.pid, grandchild: g.pid }));
    setInterval(() => {}, 1000);
  `;
  const client = new McpClient("realtree", { command: process.execPath, args: ["-e", launcher] }, 5_000);
  client.terminateGraceMs = 200;
  const lastBeat = () => (fs.existsSync(beat) ? fs.statSync(beat).size : 0);
  let pids: { parent: number; grandchild: number } | undefined;
  try {
    client.start();
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && (!fs.existsSync(pidFile) || lastBeat() < 2)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    pids = JSON.parse(fs.readFileSync(pidFile, "utf8"));
    assert.ok(lastBeat() >= 2, "the grandchild is running before we tear the tree down");

    client.stop();
    const report = await client.whenStopped();
    assert.ok(report && report.method !== "none", `a real teardown was reported: ${JSON.stringify(report)}`);

    // The heartbeat must stop: the grandchild is not running any more.
    const quietSince = Date.now();
    let stable = 0;
    while (Date.now() - quietSince < 5_000 && stable < 600) {
      const n = lastBeat();
      await new Promise((r) => setTimeout(r, 100));
      stable = lastBeat() === n ? stable + 100 : 0;
    }
    assert.ok(stable >= 600, "the grandchild stopped running: no heartbeat for 600ms");
  } finally {
    // Never leave a stray process on this host, whatever happened above.
    for (const pid of [pids?.grandchild, pids?.parent]) {
      if (pid === undefined) continue;
      try {
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
        } else {
          process.kill(pid, "SIGKILL");
        }
      } catch { /* already gone */ }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the default reporter speaks only about servers that had to be forced", () => {
  const lines: string[] = [];
  const real = console.error;
  console.error = (...args: any[]) => { lines.push(args.join(" ")); };
  try {
    defaultTerminationReporter({ server: "quiet", escalated: false, method: "SIGTERM", graceMs: 5 });
    assert.equal(lines.length, 0, "a quiet death is not worth a line");
    defaultTerminationReporter({ server: "loud", escalated: true, method: "SIGKILL", graceMs: 2_000, pid: 7 });
  } finally {
    console.error = real;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^mcp: server "loud" ignored SIGTERM/);
  assert.match(lines[0]!, /pid 7/);
});
