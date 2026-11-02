/**
 * `race`: an agent has 2 to 4 sub-agents attempt one task, each in its own git worktree, and the
 * smallest change that passes the check is applied. The user approves the race (it is a command
 * for the gate); the attempts then work unattended in their copies. Real pi sessions on the
 * scripted model in a throwaway repository.
 */
import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { judge } from "../src/extensions/policy.ts";
import { Roster } from "../src/runtime/roster.ts";
import { mnemoEnv, nextDialog } from "./helpers.ts";

type Env = Awaited<ReturnType<typeof mnemoEnv>>;
const envs: Env[] = [];
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
const NO_GRANTS = { project: [], global: [], deny: [] };

function repo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-race-")));
  const git = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: dir });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(dir, "value.txt"), "0\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  return dir;
}

/** Each model call answered by who asks: the parent, or the attempt working in candidate-<n>. */
function route(e: Env, answer: (sent: string, attempt: number | undefined) => ReturnType<FauxResponseFactory>) {
  const f: FauxResponseFactory = (context) => {
    const sent = JSON.stringify(context);
    const m = /candidate-(\d+)/.exec(sent.slice(0, sent.indexOf('"role":"user"')));
    return answer(sent, m ? Number(m[1]) : undefined);
  };
  e.faux.setResponses(Array.from({ length: 40 }, () => f));
}
const toolOutput = (e: Env, name: string) => e.controller.transcript.snapshot().committed.filter((b) => b.kind === "tool" && b.name === name) as unknown as { status: string; output: string }[];

test("the gate asks before a race, showing the check and that the attempts work unattended; plan mode refuses it", () => {
  const input = { task: "make value.txt say 2", check: "grep -qx 2 value.txt", n: 3 };
  const asked = judge({ mode: "accept-edits" }, [], NO_GRANTS, "/p", "race", input);
  if (!("ask" in asked)) throw new Error("expected a question");
  expect(asked.ask.tool).toBe("Race");
  expect(asked.ask.subject).toBe("grep -qx 2 value.txt");
  expect(asked.ask.always).toBeUndefined(); // every race is its own decision
  expect(asked.ask.preview[0]!.text).toContain("3 attempts, each in its own copy of this project, working unattended");
  expect(asked.ask.preview.at(-1)!.text).toBe("make value.txt say 2");
  expect(judge({ mode: "plan" }, [], NO_GRANTS, "/p", "race", input)).toMatchObject({ allow: false });
  expect(judge({ mode: "yolo" }, [], NO_GRANTS, "/p", "race", input)).toEqual({ allow: true });
  expect(judge({ mode: "yolo" }, [{ tool: "race", action: "deny" }], NO_GRANTS, "/p", "race", input)).toMatchObject({ allow: false });
});

test("a race the user approves runs its attempts unattended in worktrees and applies the smallest passing change", async () => {
  const cwd = repo();
  const roster = new Roster();
  const e = await env({ cwd, roster });
  route(e, (sent, attempt) => {
    if (attempt === 1) return sent.includes('"toolName":"write"') ? say("wrote 3") : call("write", { path: "value.txt", content: "3\n" }); // wrong
    if (attempt === 2) return sent.includes('"toolName":"write"') ? say("wrote 2") : call("write", { path: "value.txt", content: "2\n" }); // right
    if (attempt === 3) return sent.includes('"toolName":"write"') ? say("wrote 2 and notes") : call("write", { path: "value.txt", content: "2\nwith\nmore\nlines\n" }); // right, bigger
    return sent.includes('"toolName":"race"') ? say("the race is done") : call("race", { task: "make value.txt say 2", check: "head -1 value.txt | grep -qx 2", n: 3 });
  });
  const run = e.controller.submit("fix value.txt with a race");
  const d = await nextDialog(e.controller);
  if (d.kind !== "approval") throw new Error(`expected approval, got ${d.kind}`);
  expect(d.request.tool).toBe("Race");
  d.resolve({ kind: "yes" });
  await run;
  await e.idle();
  // The attempts' writes asked nothing: the race was the decision.
  expect(e.controller.dialogs.current()).toBeUndefined();
  const out = toolOutput(e, "race")[0]!;
  expect(out.status).toBe("done");
  expect(out.output).toContain("applied candidate 2 (the smallest change that passed)");
  expect(out.output).toContain("candidate 1  ✗ check failed");
  expect(fs.readFileSync(path.join(cwd, "value.txt"), "utf8")).toBe("2\n");
  // Three attempts, one per worktree, all ended; the worktrees are gone.
  expect(roster.snapshot().nodes.filter((n) => n.kind === "sub").map((n) => [n.label, n.status])).toEqual([
    ["attempt 1", "done"],
    ["attempt 2", "done"],
    ["attempt 3", "done"],
  ]);
  expect(Bun.spawnSync(["git", "worktree", "list"], { cwd }).stdout.toString().trim().split("\n")).toHaveLength(1);
});

test("a refused race starts nothing; a race outside a git repository, or with a bad size, says why", async () => {
  const cwd = repo();
  const roster = new Roster();
  const e = await env({ cwd, roster });
  route(e, (sent) => (sent.includes('"toolName":"race"') ? say("ok") : call("race", { task: "x", check: "true", n: 2 })));
  const run = e.controller.submit("race it");
  const d = await nextDialog(e.controller);
  if (d.kind !== "approval") throw new Error("expected approval");
  d.resolve({ kind: "no" });
  await run;
  await e.idle();
  expect(roster.snapshot().nodes.filter((n) => n.kind === "sub")).toHaveLength(0);
  expect(fs.readFileSync(path.join(cwd, "value.txt"), "utf8")).toBe("0\n");

  const plain = await env({ mode: "yolo", cwd: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-norepo-"))) });
  route(plain, (sent) => (sent.includes('"toolName":"race"') ? say("ok") : call("race", { task: "x", check: "true" })));
  await plain.controller.submit("race it");
  await plain.idle();
  expect(toolOutput(plain, "race")[0]).toMatchObject({ status: "error", output: expect.stringContaining("git rev-parse") });

  const big = await env({ mode: "yolo", cwd: repo() });
  route(big, (sent) => (sent.includes('"toolName":"race"') ? say("ok") : call("race", { task: "x", check: "true", n: 9 })));
  await big.controller.submit("race it");
  await big.idle();
  expect(toolOutput(big, "race")[0]).toMatchObject({ status: "error", output: expect.stringContaining("a race has 2 to 4 attempts") });
});

test("only an agent with full access gets race", async () => {
  const roster = new Roster();
  const e = await env({ roster, mode: "yolo" });
  let childTools = "";
  let rootTools = "";
  e.faux.setResponses([
    (context) => {
      rootTools = JSON.stringify(context);
      return call("spawn_subagent", { task: "look around", name: "reader" });
    },
    (context) => {
      childTools = JSON.stringify(context);
      return say("looked");
    },
    say("done"),
  ]);
  await e.controller.submit("delegate");
  await e.idle();
  expect(rootTools).toContain('"name":"race"');
  expect(childTools).toContain('"name":"read"'); // a read-only sub-agent
  expect(childTools).not.toContain('"name":"race"');
});
