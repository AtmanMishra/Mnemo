/**
 * The memory loop after the self-evolution audit, end to end on the real
 * sidecar and a real pi session with a scripted model. Each test names the
 * finding it pins (research/self-evolution-audit.md).
 */
import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { Credit, digest, normalizeRemote, parseReflection, projectIdentity, recoveries, worthReflecting } from "@mnemo/memory";
import { MEMSRV, mnemoEnv, nextDialog, texts } from "./helpers.ts";

const envs: Awaited<ReturnType<typeof mnemoEnv>>[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
});
async function env(o: Parameters<typeof mnemoEnv>[0] = {}) {
  const e = await mnemoEnv({ memory: true, reflect: true, ...o });
  envs.push(e);
  return e;
}
async function close(e: Awaited<ReturnType<typeof mnemoEnv>>) {
  await e.close();
  envs.splice(envs.indexOf(e), 1);
}
const call = (name: string, args: Record<string, unknown>) =>
  fauxAssistantMessage([fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1])], { stopReason: "toolUse" });
const say = (t: string) => fauxAssistantMessage(fauxText(t));
const reflect = (r: Record<string, unknown>) => say(JSON.stringify({ facts: [], fixes: [], skill: null, ...r }));
/** A scripted step that records the full request the model received. */
function capture(into: string[], answer: string): FauxResponseStep {
  return (context) => {
    into.push(JSON.stringify(context));
    return say(answer);
  };
}
const mt = MEMSRV ? test : test.skip;

// ── pure parts ───────────────────────────────────────────────────────────────

test("recoveries pair each failure with the successful calls that followed it", () => {
  const r = recoveries([
    { tool: "bash", subject: "pnpm vitest", ok: false, error: "vitest: not found" },
    { tool: "bash", subject: "pnpm install", ok: true },
    { tool: "bash", subject: "pnpm vitest", ok: true },
    { tool: "read", subject: "x", ok: false, error: "ENOENT" },
  ]);
  expect(r).toHaveLength(1);
  expect(r[0]!.then.map((t) => t.subject)).toEqual(["pnpm install", "pnpm vitest"]);
});

test("the digest is grounded: tool calls, recoveries, files and the user's dialog words", () => {
  const d = digest({
    messages: [{ role: "user", content: "fix the tests" }],
    tools: [
      { tool: "bash", subject: "pnpm vitest", ok: false, error: "vitest: not found" },
      { tool: "bash", subject: "pnpm install", ok: true },
    ],
    files: ["src/a.ts"],
    signals: ['The user refused Bash(rm -rf dist) and said: "never delete dist"'],
  });
  expect(d).toContain("USER: fix the tests");
  expect(d).toContain("FAILURES AND WHAT FOLLOWED");
  expect(d).toContain("then: bash(pnpm install)");
  expect(d).toContain("FILES CHANGED: src/a.ts");
  expect(d).toContain("never delete dist");
});

test("a reflection is parsed defensively and a guess is labelled as one", () => {
  const r = parseReflection(
    'Here: {"facts":[{"scope":"project","key":"Test Command","value":"pnpm vitest","source":"observed"},{"scope":"project","key":"x","value":"y"}],' +
      '"episode":{"goal":"fix tests","outcome":"weird","done":"ran install"},"fixes":[{"problem":"vitest not found","fix":"pnpm install"}],' +
      '"skill":{"name":"Run Tests!","description":"run the suite","instructions":"1. install\\n2. test"}}',
  );
  expect(r.facts[0]).toEqual({ scope: "project", key: "test command", value: "pnpm vitest", source: "observed" });
  expect(r.facts[1]!.source).toBe("inferred");
  expect(r.episode?.outcome).toBe("partial");
  expect(r.fixes).toEqual([{ problem: "vitest not found", fix: "pnpm install" }]);
  expect(r.skill?.name).toBe("run-tests");
  expect(parseReflection("not json")).toEqual({ facts: [], fixes: [] });
});

test("small talk is not worth a reflection call; a correction is", () => {
  const msg = (t: string) => ({ messages: [{ role: "user", content: t }], tools: [], files: [], signals: [] });
  expect(worthReflecting(msg("thanks!"))).toBe(false);
  expect(worthReflecting(msg("no, use pnpm"))).toBe(true);
});

test("a project is its git remote, so every clone shares one memory", () => {
  expect(normalizeRemote("git@github.com:Owner/Repo.git")).toBe("github.com/owner/repo");
  expect(normalizeRemote("https://user@github.com/Owner/Repo/")).toBe("github.com/owner/repo");
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "mnemo-git-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["remote", "add", "origin", "git@github.com:Acme/Shop.git"], { cwd: dir });
  fs.mkdirSync(path.join(dir, "packages", "api"), { recursive: true });
  expect(projectIdentity(path.join(dir, "packages", "api")).id).toBe("git:github.com/acme/shop");
});

test("usefulness credit needs distinctive reuse, not an echo of the question", () => {
  const c = new Credit();
  c.recalled(
    [
      { node: 1, text: "pitfall vitest missing fix pnpm install first" },
      { node: 2, text: "deploy uses flyctl staging" },
    ],
    "how do I run vitest",
  );
  expect(c.observe("I will run vitest")).toEqual([]);
  expect(c.observe("Running pnpm install first, then the tests")).toEqual([1]);
});

// ── the loop, live ───────────────────────────────────────────────────────────

mt("F3: profiles stay in the system prompt and per-message recall arrives as a message", async () => {
  const e = await env();
  await e.memory!.learn("project", projectIdentity(e.cwd).id, "package manager", "pnpm");
  await e.memory!.remember("deploys to staging use flyctl deploy --app shop-staging");
  const seen: string[] = [];
  e.faux.setResponses([capture(seen, "ok"), capture(seen, "ok again")]);
  await e.controller.submit("how do deploys to staging work?");
  await e.idle();
  await e.controller.submit("and how do deploys to production work?");
  await e.idle();
  // pi hands the provider a transcript whose first message is the system prompt.
  const parts = seen.map((s) => {
    const messages = (JSON.parse(s) as { messages: { role: string; content: unknown }[] }).messages;
    return { system: JSON.stringify(messages.find((m) => m.role === "system")?.content), rest: JSON.stringify(messages.filter((m) => m.role !== "system")) };
  });
  // The system prompt (the cached prefix) is byte-identical across runs.
  expect(parts[0]!.system).toBe(parts[1]!.system);
  expect(parts[0]!.system).toContain("package manager: pnpm");
  expect(parts[0]!.system).not.toContain("flyctl");
  // The recall rides in the messages, after the prefix.
  expect(parts[0]!.rest).toContain("flyctl deploy --app shop-staging");
});

mt("F10: one project's memories never reach another project's prompt", async () => {
  const a = await env();
  a.faux.setResponses([
    say("noted"),
    reflect({ facts: [{ scope: "project", key: "deploy command", value: "make ship-shop", source: "user" }] }),
  ]);
  await a.controller.submit("remember that in this repo we deploy with make ship-shop, always");
  await a.idle();
  await close(a);

  const b = await env({ home: a.home });
  const seen: string[] = [];
  b.faux.setResponses([capture(seen, "I don't know yet")]);
  await b.controller.submit("how do we deploy this project?");
  await b.idle();
  expect(seen[0]).not.toContain("ship-shop");

  const again = await env({ home: a.home, cwd: a.cwd });
  const seen2: string[] = [];
  again.faux.setResponses([capture(seen2, "make ship-shop")]);
  await again.controller.submit("how do we deploy this project?");
  await again.idle();
  expect(seen2[0]).toContain("make ship-shop");
});

mt("F5 + F21: a failure and its fix are learned once, then recalled as a pitfall with the fix", async () => {
  const one = await env({ mode: "yolo" });
  one.faux.setResponses([
    call("bash", { command: "npx vitest-does-not-exist-xyz" }),
    call("bash", { command: "echo installed" }),
    say("Fixed: the runner was missing, installing first works."),
    reflect({ fixes: [{ problem: "vitest-does-not-exist-xyz not found", fix: "install dependencies with pnpm install before running tests" }] }),
  ]);
  await one.controller.submit("run the test suite for checkout please");
  await one.idle();
  const t1 = texts(one.controller);
  expect(t1.some((t) => t.startsWith("◈ Memory noted the failure"))).toBe(true);
  expect(t1.some((t) => t.includes("fix · vitest-does-not-exist-xyz not found → install dependencies"))).toBe(true);
  await close(one);

  const two = await env({ home: one.home, cwd: one.cwd, mode: "yolo" });
  const seen: string[] = [];
  two.faux.setResponses([capture(seen, "Installing first.")]);
  await two.controller.submit("run the vitest-does-not-exist-xyz tests for payments");
  await two.idle();
  expect(seen[0]).toContain("pitfall:");
  expect(seen[0]).toContain("install dependencies with pnpm install before running tests");
});

mt("F5: the same failure in three sessions is one marker that says how often", async () => {
  let home: string | undefined;
  let cwd: string | undefined;
  for (let i = 0; i < 3; i++) {
    const e = await env({ home, cwd, mode: "yolo", reflect: false });
    home = e.home;
    cwd = e.cwd;
    e.faux.setResponses([call("read", { path: "missing-file.ts" }), say("not there")]);
    await e.controller.submit("open missing-file.ts and summarise it");
    await e.idle();
    if (i === 2) expect(texts(e.controller).some((t) => t.includes("has seen this failure 3 times"))).toBe(true);
    await close(e);
  }
});

mt("L1: a session leaves a record, and the next session starts from its open threads", async () => {
  const one = await env({ mode: "yolo" });
  one.faux.setResponses([
    say("Added the endpoint; the tests for it are still missing."),
    reflect({
      episode: { goal: "add a /health endpoint", outcome: "partial", done: "added GET /health in src/server.ts", decisions: [], open: ["write tests for /health"] },
    }),
  ]);
  await one.controller.submit("add a /health endpoint to the server please");
  await one.idle();
  expect(texts(one.controller).some((t) => t.startsWith("◈ Session partial"))).toBe(true);
  await close(one);

  const two = await env({ home: one.home, cwd: one.cwd });
  const seen: string[] = [];
  two.faux.setResponses([capture(seen, "Let's write those tests.")]);
  await two.controller.submit("where were we?");
  await two.idle();
  expect(seen[0]).toContain("Last session:");
  expect(seen[0]).toContain("write tests for /health");
  expect(texts(two.controller).some((t) => t.startsWith("◈ Recalled") && t.includes("last session"))).toBe(true);
});

mt("a refusal's reason reaches reflection and becomes a preference", async () => {
  const e = await env();
  const seen: string[] = [];
  e.faux.setResponses([
    call("bash", { command: "rm -rf dist" }),
    say("Understood, I will not delete dist."),
    (context) => {
      seen.push(JSON.stringify(context));
      return reflect({ facts: [{ scope: "user", key: "deleting build output", value: "never delete dist; ask first", source: "user" }] }) as never;
    },
  ]);
  const run = e.controller.submit("clean up the build output");
  const d = await nextDialog(e.controller);
  if (d.kind !== "approval") throw new Error("expected approval");
  d.resolve({ kind: "no", feedback: "never delete dist, it is checked in" });
  await run;
  await e.idle();
  expect(seen[0]).toContain("never delete dist, it is checked in");
  const prefs = await e.memory!.profile("user", projectIdentity(e.cwd).id);
  expect(prefs).toContainEqual({ key: "deleting build output", value: "never delete dist; ask first" });
});

mt("F16: a guessed fact is not written; small talk costs no reflection call", async () => {
  const e = await env();
  e.faux.setResponses([
    say("Done, I read the config."),
    reflect({ facts: [{ scope: "project", key: "framework", value: "probably next.js", source: "inferred" }] }),
  ]);
  await e.controller.submit("have a look at the configuration of this project and tell me what you see");
  await e.idle();
  expect(await e.memory!.profile("project", projectIdentity(e.cwd).id)).not.toContainEqual(expect.objectContaining({ key: "framework" }));
  e.faux.setResponses([say("You're welcome!")]);
  const before = e.faux.state.callCount;
  await e.controller.submit("thanks!");
  await e.idle();
  expect(e.faux.state.callCount).toBe(before + 1); // the answer, and no reflection
});

mt("L3: when the user asks to remember a procedure, Mnemo proposes the skill and saves it in the repo", async () => {
  const e = await env({ mode: "yolo" });
  e.faux.setResponses([
    say("Release done: bumped the version, tagged, pushed."),
    reflect({
      skill: {
        name: "cut-release",
        scope: "project",
        description: "Cut a release of this project: bump, tag, push.",
        instructions: "1. bump version in package.json\n2. git tag v<version>\n3. git push --tags",
        explicit: true,
      },
    }),
  ]);
  const run = e.controller.submit("cut a release, and remember how to do it next time");
  await run;
  const d = await nextDialog(e.controller, 5000);
  if (d.kind !== "approval") throw new Error("expected approval");
  expect(d.request.tool).toBe("Save skill");
  expect(d.request.subject).toBe(path.join(e.cwd, ".agents", "skills", "cut-release", "SKILL.md"));
  d.resolve({ kind: "yes" });
  await e.idle();
  expect(fs.readFileSync(path.join(e.cwd, ".agents", "skills", "cut-release", "SKILL.md"), "utf8")).toContain("git push --tags");
  expect(texts(e.controller).some((t) => t.includes("Saved skill cut-release"))).toBe(true);
});

mt("L3: a procedure seen once is only a candidate; the second time it is proposed", async () => {
  const skill = {
    name: "db-migrate",
    scope: "project",
    description: "Apply a schema change.",
    instructions: "1. edit schema.prisma\n2. pnpm prisma migrate dev\n3. pnpm prisma generate",
    explicit: false,
  };
  const one = await env({ mode: "yolo" });
  one.faux.setResponses([say("Migrated."), reflect({ skill })]);
  await one.controller.submit("add a column for the order note and migrate the database");
  await one.idle();
  expect(one.controller.dialogs.current()).toBeUndefined();
  await close(one);

  const two = await env({ home: one.home, cwd: one.cwd, mode: "yolo" });
  two.faux.setResponses([say("Migrated again."), reflect({ skill })]);
  await two.controller.submit("add a column for the refund reason and migrate the database");
  const d = await nextDialog(two.controller, 5000);
  expect(d.kind === "approval" && d.request.reason).toContain("2 sessions");
  if (d.kind === "approval") d.resolve({ kind: "no" });
  await two.idle();
});

mt("F14: a recalled memory that the answer actually uses earns a usefulness vote", async () => {
  const e = await env({ reflect: false });
  const node = await e.memory!.remember("staging deploys use flyctl deploy --app shop-staging");
  e.faux.setResponses([say("Run flyctl deploy --app shop-staging from the repo root.")]);
  await e.controller.submit("how do I deploy to staging?");
  await e.idle();
  await new Promise((r) => setTimeout(r, 50));
  expect(await e.memory!.state(node!)).toContain("usefulness votes: 1 useful");
});

mt("F25: a secret in the conversation never reaches memory", async () => {
  const e = await env();
  e.faux.setResponses([
    say("Stored."),
    reflect({ facts: [{ scope: "project", key: "api key", value: "sk-ant-abcdefghijklmnopqrstuvwxyz0123", source: "user" }] }),
  ]);
  await e.controller.submit("our api key is sk-ant-abcdefghijklmnopqrstuvwxyz0123, use it for the integration tests");
  await e.idle();
  const journal = fs.readFileSync(path.join(e.home, "memory", "journal.jsonl"), "utf8");
  expect(journal).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
});

mt("/forget retires a fact: history keeps it, recall never shows it again", async () => {
  const e = await env({ reflect: false });
  await e.memory!.learn("project", projectIdentity(e.cwd).id, "package manager", "yarn");
  await e.controller.submit("/forget package manager");
  expect(await e.memory!.profile("project", projectIdentity(e.cwd).id)).toEqual([]);
  const seen: string[] = [];
  e.faux.setResponses([capture(seen, "ok")]);
  await e.controller.submit("how do I add a dependency?");
  await e.idle();
  expect(seen[0]).not.toContain("yarn");
});

mt("the reflection call carries the session id, and a failed reflection is reported, not swallowed", async () => {
  const e = await env();
  // Like OpenCode: a call without a session id is refused.
  const runtime = e.host.modelRuntime;
  const original = runtime.completeSimple.bind(runtime);
  const ids: (string | undefined)[] = [];
  let refuse = false;
  runtime.completeSimple = async (model, context, options) => {
    ids.push(options?.sessionId);
    const answer = await original(model, context, options);
    return refuse ? { ...answer, stopReason: "error", errorMessage: "400 MissingSessionID" } : answer;
  };
  e.faux.setResponses([say("noted"), reflect({}), say("noted again"), say("{}")]);
  await e.controller.submit("remember that we always use pnpm in this repository");
  await e.idle();
  expect(ids).toEqual([e.controller.session.sessionManager.getSessionId()]);
  refuse = true;
  await e.controller.submit("remember that we never use yarn in this repository");
  await e.idle();
  expect(texts(e.controller)).toContain("notice: Reflection failed: 400 MissingSessionID");
});

mt("the agent cannot overwrite the session record's \"last session\" fact", async () => {
  const e = await env({ reflect: false });
  e.faux.setResponses([call("memory_remember", { scope: "project", key: "Last Session", value: "ran the tests" }), say("ok")]);
  await e.controller.submit("run the tests and note it");
  await e.idle();
  expect(texts(e.controller).join("\n")).toContain("tool memory_remember error");
  expect(await e.memory!.profile("project", projectIdentity(e.cwd).id)).toEqual([]);
});

// ── accuracy: known fixes first, verify before done ─────────────────────────

mt("a command that failed before is stopped once with its known fix, and runs if the agent insists", async () => {
  const e = await env({ mode: "yolo" });
  const s = await e.memory!.project(projectIdentity(e.cwd).id, e.cwd);
  const pain = await e.memory!.createNode("aspect", "pain: tests need fixtures", "salience");
  await e.memory!.fact(pain!, "failure", "bash(sh scripts/test.sh) failed: error: test fixtures missing");
  await e.memory!.fact(pain!, "fix", "run sh scripts/setup.sh before sh scripts/test.sh");
  await e.memory!.link(pain!, s!, "part_of");
  e.faux.setResponses([
    call("bash", { command: "sh scripts/test.sh" }),
    call("bash", { command: "sh scripts/test.sh" }),
    say("ran it"),
  ]);
  await e.controller.submit("run the tests");
  await e.idle();
  const tools = e.controller.transcript.snapshot().committed.filter((b) => b.kind === "tool") as { output: string }[];
  expect(tools[0]!.output).toContain("Known fix: run sh scripts/setup.sh before sh scripts/test.sh");
  // Said once: the second attempt is not stopped by memory.
  expect(tools[1]!.output).not.toContain("Known fix");
});

mt("a run that changed code and checked nothing is sent back once to verify, with the remembered command", async () => {
  const e = await env({ mode: "yolo", verify: true, reflect: false });
  await e.memory!.learn("project", projectIdentity(e.cwd).id, "verify command", "bun test");
  const seen: string[] = [];
  e.faux.setResponses([
    call("write", { path: "src/add.ts", content: "export const add = (a: number, b: number) => a + b;\n" }),
    say("Added add."),
    (context) => {
      seen.push(JSON.stringify(context));
      return call("bash", { command: "bun test" });
    },
    say("Checked: tests pass."),
  ]);
  await e.controller.submit("add an add function");
  await e.idle();
  expect(seen[0]).toContain("ran no check after the last change");
  expect(seen[0]).toContain("this project's check (bun test)");
  const tools = e.controller.transcript.snapshot().committed.filter((b) => b.kind === "tool") as { name: string }[];
  expect(tools.map((t) => t.name)).toEqual(["write", "bash"]);
  // Once: the verifying turn itself is not sent back again.
  expect(e.faux.state.callCount).toBe(4);
});
