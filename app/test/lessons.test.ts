/**
 * A team run's lesson: when several agents shared a run, its reflection also reads TASK.md and
 * the end of LOG.md and may return one lesson about how the team worked. The user is asked; an
 * accepted lesson is a project fact, recalled in later sessions. A run one agent did alone may
 * offer a lesson about how to work in the project. Runs vote on kept lessons (helped, hurt); a
 * lesson that hurt more than it helped leaves the prompt. Pure parts first, then real pi
 * sessions on the scripted model and the real memory sidecar.
 */
import { test, expect, afterEach, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { digest, parseReflection, projectIdentity, worthReflecting } from "@mnemo/memory";
import { evolveCommand } from "../src/evolve/cli.ts";
import { Roster } from "../src/runtime/roster.ts";
import { TaskBoard } from "../src/runtime/team.ts";
import { MEMSRV, mnemoEnv, nextDialog } from "./helpers.ts";

type Env = Awaited<ReturnType<typeof mnemoEnv>>;
const envs: Env[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
});
async function env(o: Parameters<typeof mnemoEnv>[0] = {}) {
  const e = await mnemoEnv({ memory: true, reflect: true, mode: "yolo", ...o });
  envs.push(e);
  return e;
}
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1])], { stopReason: "toolUse" });
const say = (t: string) => fauxAssistantMessage(fauxText(t));
const mt = MEMSRV ? test : test.skip;
setDefaultTimeout(30_000);

const LESSON = { cue: "splitting a refactor", lesson: "Give each sub-agent whole files, not halves of one file.", evidence: "step 2 was redone after #2 and #3 both edited src/auth.ts", confidence: "high" as const };

test("a team run's record is its plan and the end of its log; a run one agent did has none", () => {
  const roster = new Roster();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-lessons-"));
  const b = new TaskBoard(roster, home, () => Date.parse("2026-10-21T14:32:00"));
  const solo = roster.addRoot("app").id;
  roster.userTurn(solo, "what is 2 + 2?");
  b.log(solo, "read(README.md)");
  expect(b.record(roster.get(solo)!.run!)).toBe("");

  const root = roster.addRoot("app").id;
  roster.userTurn(root, "split the auth refactor");
  const one = roster.addSub(root, { label: "one", task: "auth.ts", access: "full" }).id;
  b.update(root, "add", { text: "move the token code" });
  for (let i = 0; i < 40; i++) b.log(one, `edit(src/auth.ts) ${i}`);
  const record = b.record(roster.get(root)!.run!);
  expect(record).toContain("Goal (the user's words): split the auth refactor");
  expect(record).toContain("1. [open] move the token code");
  expect(record).toContain("## Log (last 30 of 42)");
  expect(record).toContain("edit(src/auth.ts) 39");
  expect(record).not.toContain("edit(src/auth.ts) 9\n");
});

test("the digest shows the team's record after the run, and a team run is always worth reflecting on", () => {
  const base = { messages: [{ role: "user", content: "go" }], tools: [], files: [], signals: [] };
  expect(digest(base)).not.toContain("TEAM RUN");
  expect(worthReflecting(base)).toBe(false);
  const team = { ...base, team: "# Run r1\n\n## Plan\n1. [done #2] fix it" };
  expect(digest(team)).toContain("TEAM RUN (TASK.md and the end of LOG.md, as the agents wrote them):\n# Run r1");
  expect(worthReflecting(team)).toBe(true);
  // Its own allowance: a long run does not crowd it out.
  expect(digest({ ...team, messages: [{ role: "user", content: "x".repeat(20_000) }] })).toContain("1. [done #2] fix it");
});

test("a lesson is parsed defensively", () => {
  expect(parseReflection(JSON.stringify({ lesson: LESSON })).lesson).toEqual(LESSON);
  expect(parseReflection(JSON.stringify({ lesson: { ...LESSON, cue: "Splitting A Refactor", confidence: "sure" } })).lesson).toMatchObject({ cue: "splitting a refactor", confidence: "low" });
  expect(parseReflection(JSON.stringify({ lesson: { cue: "x" } })).lesson).toBeUndefined();
  expect(parseReflection(JSON.stringify({ lesson: null })).lesson).toBeUndefined();
});

/** A root that hands the work to one sub-agent; the reflection's answer is `lesson`. Returns what the reflection was sent. */
function teamRun(e: Env, lesson: unknown) {
  const reflection: { system: string; user: string }[] = [];
  const f: FauxResponseFactory = (context) => {
    const sent = JSON.stringify(context);
    if (sent.includes("You maintain the long-term memory of Mnemo")) {
      reflection.push({ system: sent, user: sent.slice(sent.indexOf("KNOWN:")) });
      return say(JSON.stringify({ facts: [], fixes: [], skill: null, lesson }));
    }
    if (!sent.includes('"text":"PROMPT')) return say("auth.ts is split");
    return sent.includes('"toolName":"spawn_subagent"') ? say("the refactor is done") : call("spawn_subagent", { task: "split src/auth.ts", name: "splitter" });
  };
  e.faux.setResponses(Array.from({ length: 10 }, () => f));
  return reflection;
}

mt("a team run's reflection reads its record and asks for one lesson; the user accepts it and later sessions recall it", async () => {
  const e = await env({ roster: new Roster() });
  const reflection = teamRun(e, LESSON);
  await e.controller.submit("PROMPT split the auth refactor between sub-agents");
  const d = await nextDialog(e.controller, 5000);
  if (d.kind !== "approval") throw new Error(`expected approval, got ${d.kind}`);
  expect(d.request.tool).toBe("Save team lesson");
  expect(d.request.subject).toBe("splitting a refactor");
  expect(d.request.preview.map((l) => l.text)).toEqual(["+ Give each sub-agent whole files, not halves of one file."]);
  expect(d.request.reason).toContain("step 2 was redone");
  d.resolve({ kind: "yes" });
  await e.idle();
  expect(reflection).toHaveLength(1);
  expect(reflection[0]!.system).toContain("This run was a team");
  expect(reflection[0]!.user).toContain("TEAM RUN (TASK.md and the end of LOG.md");
  expect(reflection[0]!.user).toContain('started #2 \\"splitter\\": split src/auth.ts');
  expect(await e.memory!.profile("project", projectIdentity(e.cwd).id)).toContainEqual({ key: "team lesson (splitting a refactor)", value: LESSON.lesson });

  // The next session in this project starts with it.
  const prompts: string[] = [];
  const next = await env({ home: e.home, cwd: e.cwd, reflect: false });
  next.faux.setResponses([
    (context) => {
      prompts.push(JSON.stringify(context));
      return say("hi");
    },
  ]);
  await next.controller.submit("hello");
  await next.idle();
  expect(prompts[0]).toContain("team lesson (splitting a refactor): Give each sub-agent whole files");
});

mt("a lesson the user rejects, or one the reflection only guesses, is not kept", async () => {
  const no = await env({ roster: new Roster() });
  teamRun(no, LESSON);
  await no.controller.submit("PROMPT split the auth refactor between sub-agents");
  const d = await nextDialog(no.controller, 5000);
  if (d.kind !== "approval") throw new Error("expected approval");
  d.resolve({ kind: "no" });
  await no.idle();
  expect((await no.memory!.profile("project", projectIdentity(no.cwd).id)).some((f) => f.key.startsWith("team lesson"))).toBe(false);

  const guess = await env({ roster: new Roster() });
  const reflection = teamRun(guess, { ...LESSON, confidence: "low" });
  await guess.controller.submit("PROMPT split the auth refactor between sub-agents");
  await guess.idle();
  expect(reflection).toHaveLength(1);
  expect(guess.controller.dialogs.current()).toBeUndefined();
  expect((await guess.memory!.profile("project", projectIdentity(guess.cwd).id)).some((f) => f.key.startsWith("team lesson"))).toBe(false);
});

/** A run one agent did: an answer, then the reflection's answer `reflected`. Returns what the reflection was sent. */
function soloRun(e: Env, reflected: Record<string, unknown>) {
  const sent: string[] = [];
  e.faux.setResponses([
    say("The config uses bun and biome; nothing to change."),
    (context) => {
      sent.push(JSON.stringify(context));
      return say(JSON.stringify({ facts: [], fixes: [], skill: null, ...reflected }));
    },
  ]);
  return sent;
}
const PROMPT = "have a look at the configuration of this project and tell me what you see";
const SOLO = { cue: "changing the parser", lesson: "Run the grammar tests before the full suite.", evidence: "the full suite took 4 minutes to show a grammar error", confidence: "medium" as const };

mt("a run one agent did alone may offer a lesson about how to work here; it is kept as \"lesson (cue)\"", async () => {
  const e = await env();
  const sent = soloRun(e, { lesson: SOLO });
  await e.controller.submit(PROMPT);
  const d = await nextDialog(e.controller, 5000);
  if (d.kind !== "approval") throw new Error(`expected approval, got ${d.kind}`);
  expect(d.request.tool).toBe("Save lesson");
  d.resolve({ kind: "yes" });
  await e.idle();
  expect(sent[0]).not.toContain("This run was a team");
  expect(sent[0]).toContain("how to work in this project");
  // No lessons were kept yet: nothing to vote on.
  expect(sent[0]).not.toContain("lesson_votes");
  expect(await e.memory!.profile("project", projectIdentity(e.cwd).id)).toContainEqual({ key: "lesson (changing the parser)", value: SOLO.lesson });
});

mt("runs vote on kept lessons; one that hurt more than it helped leaves the prompt", async () => {
  const first = await env();
  const id = projectIdentity(first.cwd).id;
  await first.memory!.learn("project", id, "lesson (changing the parser)", SOLO.lesson);
  await first.memory!.learn("project", id, "team lesson (splitting a refactor)", LESSON.lesson);
  const sent = soloRun(first, { lesson_votes: { helped: ["team lesson (splitting a refactor)", "lesson (never kept)"], hurt: ["lesson (changing the parser)", "not a lesson key"] } });
  await first.controller.submit(PROMPT);
  await first.idle();
  expect(sent[0]).toContain("lesson_votes");
  // Only kept lessons are counted; a key this project does not hold is ignored.
  expect(Object.fromEntries(await first.memory!.lessonVotes(id))).toEqual({
    "lesson (changing the parser)": { helped: 0, hurt: 1 },
    "team lesson (splitting a refactor)": { helped: 1, hurt: 0 },
  });
  // The nodes that count votes are never recalled as knowledge.
  const project = await first.memory!.project(id);
  expect((await first.memory!.search("playbook changing the parser", 10, project)).some((h) => h.label.startsWith("playbook "))).toBe(true);
  expect((await first.memory!.recall("playbook changing the parser", project, [])).some((h) => h.label.startsWith("playbook "))).toBe(false);
  // One hurt vote is not enough to bench it.
  const promptOf = async () => {
    const prompts: string[] = [];
    const next = await env({ home: first.home, cwd: first.cwd, reflect: false });
    next.faux.setResponses([
      (context) => {
        prompts.push(JSON.stringify(context));
        return say("hi");
      },
    ]);
    await next.controller.submit("hello");
    await next.idle();
    return prompts[0]!;
  };
  expect(await promptOf()).toContain("Run the grammar tests before the full suite.");

  // A lesson named on both sides says nothing; a second hurt vote benches it.
  const second = await env({ home: first.home, cwd: first.cwd });
  soloRun(second, { lesson_votes: { helped: ["team lesson (splitting a refactor)"], hurt: ["lesson (changing the parser)", "team lesson (splitting a refactor)"] } });
  await second.controller.submit(PROMPT);
  await second.idle();
  expect((await first.memory!.lessonVotes(id)).get("lesson (changing the parser)")).toEqual({ helped: 0, hurt: 2 });
  expect((await first.memory!.lessonVotes(id)).get("team lesson (splitting a refactor)")).toEqual({ helped: 1, hurt: 0 });
  const after = await promptOf();
  expect(after).not.toContain("Run the grammar tests before the full suite.");
  expect(after).toContain("Give each sub-agent whole files");
  // Benched, not forgotten: the fact is still in memory.
  expect(await first.memory!.profile("project", id)).toContainEqual({ key: "lesson (changing the parser)", value: SOLO.lesson });

  // mnemo evolve lessons lists them with their votes.
  const out: string[] = [];
  const io = { out: (x: string) => out.push(x), err: (x: string) => out.push(x) };
  expect(await evolveCommand(["lessons", "--cwd", first.cwd], first.home, io)).toBe(0);
  expect(out.join("\n")).toContain("benched lesson (changing the parser)  helped 0 · hurt 2");
  expect(out.join("\n")).toContain("team lesson (splitting a refactor)  helped 1 · hurt 0\n    Give each sub-agent whole files");
  out.length = 0;
  expect(await evolveCommand(["lessons", "--cwd", first.cwd, "--json"], first.home, io)).toBe(0);
  expect(out.map((l) => JSON.parse(l))).toContainEqual({ key: "lesson (changing the parser)", lesson: SOLO.lesson, helped: 0, hurt: 2, benched: true });
});

test("lesson votes are parsed defensively", () => {
  expect(parseReflection(JSON.stringify({ lesson_votes: { helped: ["lesson (a)"], hurt: ["team lesson (b)", "lesson x", 3] } })).votes).toEqual({ helped: ["lesson (a)"], hurt: ["team lesson (b)"] });
  // The KNOWN line's scope, copied with the key, is dropped.
  expect(parseReflection(JSON.stringify({ lesson_votes: { helped: ["project · lesson (a)"], hurt: [] } })).votes).toEqual({ helped: ["lesson (a)"], hurt: [] });
  expect(parseReflection(JSON.stringify({ lesson_votes: { helped: [], hurt: [] } })).votes).toBeUndefined();
  expect(parseReflection(JSON.stringify({ lesson_votes: "lesson (a)" })).votes).toBeUndefined();
  expect(parseReflection(JSON.stringify({})).votes).toBeUndefined();
});
