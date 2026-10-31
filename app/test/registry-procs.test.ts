/**
 * The registry across real processes: a Mnemo in another terminal (test/fixtures/registry-proc.ts)
 * is listed by `mnemo agents` run as a third process, takes tell, steer and stop from it, reads
 * as lost once killed and as ended once it quits. Then a real session: the demo registers and
 * ends cleanly, and words sent from another terminal start a turn on a real pi session.
 */
import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { DEMO_PROMPT } from "../src/runtime/demo.ts";
import { agentsCommand, elsewhere } from "../src/registry/cli.ts";
import { joinRegistry, memberOf } from "../src/registry/join.ts";
import { inboxDir, readAll } from "../src/registry/store.ts";
import { mnemoEnv } from "./helpers.ts";
import { waitFor } from "./wait-for.ts";

const APP = path.join(import.meta.dir, "..");
const FIXTURE = path.join(import.meta.dir, "fixtures", "registry-proc.ts");

const homes: string[] = [];
const procs: Bun.Subprocess[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  for (const p of procs.splice(0)) p.kill();
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});
function home(): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-registry-procs-"));
  homes.push(h);
  return h;
}

/** Another Mnemo process; `lines` fills as it prints. */
async function other(h: string, cwd: string) {
  const p = Bun.spawn([process.execPath, FIXTURE, cwd], { env: { ...process.env, MNEMO_HOME: h }, stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  procs.push(p);
  const lines: string[] = [];
  void (async () => {
    let buf = "";
    for await (const chunk of p.stdout) {
      buf += new TextDecoder().decode(chunk);
      const parts = buf.split(/\r?\n/);
      buf = parts.pop()!;
      lines.push(...parts);
    }
  })();
  await waitFor(() => expect(lines.some((l) => l.startsWith("ready "))).toBe(true), 15_000);
  const tag = lines.find((l) => l.startsWith("ready "))!.slice(6);
  return { p, lines, tag };
}

/** `mnemo agents …` as its own process. */
async function mnemoAgents(h: string, ...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn([process.execPath, path.join(APP, "bin", "mnemo.ts"), "agents", ...argv], { cwd: APP, env: { ...process.env, MNEMO_HOME: h }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

/** A project folder whose name has a space and a non-ASCII letter, as Windows home folders often do. */
function project(): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-reg-")), "my proj é");
  fs.mkdirSync(dir);
  homes.push(path.dirname(dir));
  return dir;
}

test("another terminal's agents are listed by mnemo agents in a third process", async () => {
  const h = home();
  const cwd = project();
  const { tag } = await other(h, cwd);
  const r = await mnemoAgents(h, "--json");
  expect(r.code).toBe(0);
  const proc = JSON.parse(r.out).procs.find((x: { tag: string }) => x.tag === tag);
  expect(proc.state).toBe("live");
  expect(proc.agents.map((a: { label: string; status: string; cwd: string }) => [a.label, a.status, a.cwd])).toEqual([
    ["fixture", "idle", cwd],
    ["researcher", "running", cwd],
  ]);
  expect(proc.agents[1].steps).toEqual(["→ read(README.md)"]);
  const text = await mnemoAgents(h);
  expect(text.out).toContain(`${tag}.2`);
  expect(text.out).toContain("researcher");
}, 30_000);

test("tell, steer and stop from another process reach the agent", async () => {
  const h = home();
  const { lines, tag } = await other(h, project());
  let r = await mnemoAgents(h, "tell", `${tag}.2`, "check the error path");
  expect(r).toMatchObject({ code: 0 });
  expect(r.out.trim()).toBe("researcher reads it after its current step");
  await waitFor(() => expect(lines).toContain("told 2 check the error path"));

  r = await mnemoAgents(h, "steer", tag, "also look at web/");
  expect(r.out.trim()).toBe("fixture started a turn with it");
  await waitFor(() => expect(lines).toContain("submit steer also look at web/"));

  r = await mnemoAgents(h, "stop", tag);
  expect(r.out.trim()).toBe("stopped fixture's turn");
  await waitFor(() => expect(lines).toContain("interrupt"));

  r = await mnemoAgents(h, "stop", "researcher");
  expect(r.code).toBe(0);
  await waitFor(() => expect(lines).toContain("stop 2"));
  // The record catches up: the sub-agent is stopped.
  for (let i = 0; ; i++) {
    const j = JSON.parse((await mnemoAgents(h, "--json")).out);
    if (j.procs[0].agents[1].status === "stopped" || i > 20) {
      expect(j.procs[0].agents[1].status).toBe("stopped");
      break;
    }
    await Bun.sleep(200);
  }
}, 60_000);

test("a killed process reads as lost, cannot be told anything, and is forgotten by clear", async () => {
  const h = home();
  const { p, tag } = await other(h, project());
  p.kill(9);
  await p.exited;
  const j = JSON.parse((await mnemoAgents(h, "--json")).out);
  const proc = j.procs.find((x: { tag: string }) => x.tag === tag);
  expect(proc.state).toBe("lost");
  expect(proc.agents.map((a: { status: string }) => a.status)).toEqual(["lost", "lost"]);
  expect((await mnemoAgents(h)).out).toMatch(new RegExp(`${tag}\\.2\\s+lost`));
  const told = await mnemoAgents(h, "tell", `${tag}.2`, "hello");
  expect(told.code).toBe(1);
  expect(told.err).toContain("was lost");
  expect((await mnemoAgents(h, "clear")).out.trim()).toBe("forgot 1 finished or lost process");
  expect(readAll(h)).toEqual([]);
}, 30_000);

test("a process that quits cleanly reads as ended, its agents finished, its inbox gone", async () => {
  const h = home();
  const { p, tag } = await other(h, project());
  p.stdin.write("quit\n");
  p.stdin.flush();
  expect(await p.exited).toBe(0);
  const v = readAll(h).find((x) => x.rec.tag === tag)!;
  expect(v.state).toBe("ended");
  expect(v.rec.agents.map((a) => a.status)).toEqual(["closed", "stopped"]);
  expect(fs.existsSync(inboxDir(h, tag))).toBe(false);
}, 30_000);

test("two processes each see the other in the hub's list, never themselves", async () => {
  const h = home();
  const a = await other(h, project());
  const b = await other(h, project());
  expect(a.tag).not.toBe(b.tag);
  expect(new Set(elsewhere(h, a.tag).map((r) => r.view.rec.tag))).toEqual(new Set([b.tag]));
  expect(new Set(elsewhere(h, b.tag).map((r) => r.view.rec.tag))).toEqual(new Set([a.tag]));
}, 30_000);

test("a real session registers, and says it ended when it quits (mnemo --demo --dump)", async () => {
  const h = home();
  const p = Bun.spawn([process.execPath, path.join(APP, "bin", "mnemo.ts"), "--demo", "--dump", "--no-memory"], { cwd: APP, env: { ...process.env, MNEMO_HOME: h }, stdout: "ignore", stderr: "pipe" });
  expect(await p.exited).toBe(0);
  const views = readAll(h);
  expect(views).toHaveLength(1);
  expect(views[0]!.state).toBe("ended");
  expect(views[0]!.rec.kind).toBe("interactive");
  expect(views[0]!.rec.agents[0]).toMatchObject({ kind: "root", status: "closed", task: DEMO_PROMPT, model: "mnemo-demo/demo-model" });
  expect(views[0]!.rec.agents[0]!.steps.length).toBeGreaterThan(0);
}, 60_000);

test("words from another terminal start a turn on a real session, and its transcript says where they came from", async () => {
  const env = await mnemoEnv();
  cleanups.push(() => env.close());
  env.faux.setResponses([fauxAssistantMessage(fauxText("on it"))]);
  const j = joinRegistry({ home: env.home, kind: "interactive", version: "t", roster: env.host.roster, env: {}, members: () => [memberOf(env.host.node, env.cwd, env.controller)] })!;
  cleanups.push(j.close);
  const fast = setInterval(() => void j.inbox.tick(), 20);
  cleanups.push(() => clearInterval(fast));
  const out: string[] = [];
  const code = await agentsCommand(["tell", j.tag, "summarise the README"], env.home, { out: (s) => out.push(s), err: (s) => out.push(s), cwd: "/elsewhere/web", ackMs: 3000 });
  expect(code).toBe(0);
  expect(out.join("")).toContain("started a turn");
  await env.idle();
  const blocks = env.controller.transcript.snapshot().committed;
  expect(blocks.some((b) => b.kind === "user" && b.text === "summarise the README")).toBe(true);
  expect(JSON.stringify(blocks)).toContain("Sent from another terminal (from web)");
  expect(env.controller.session.getLastAssistantText()).toBe("on it");
  // The record shows the session's model and mode while it lives.
  j.publisher.flush();
  expect(readAll(env.home)[0]!.rec.agents[0]).toMatchObject({ model: "mnemo-demo/demo-model", mode: "default", status: "idle" });
}, 30_000);
