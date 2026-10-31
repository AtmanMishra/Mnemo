/**
 * Background memory work: tasks run on a timer by one process at a time, learn from Claude Code
 * sessions, report (never apply) what tidy and curate find, say each finding once, and every open
 * conversation hears about the results for its project with its next prompt.
 */
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { journalPath, MemoryService, projectIdentity, type Reflector } from "@mnemo/memory";
import { backgroundCommand } from "../src/background/cli.ts";
import { backgroundMessage, BackgroundFeed, backgroundTick, eventsFor } from "../src/background/feed.ts";
import { dueTasks, runBackground, type RunOptions } from "../src/background/run.ts";
import { appendEvents, eventsFile, loadState, lockFile, MAX_EVENTS, readEvents, saveState, type BackgroundEvent } from "../src/background/store.ts";
import { openSettings, parseValue, SettingsStore } from "../src/runtime/settings.ts";
import { MEMSRV, mnemoEnv } from "./helpers.ts";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `mnemo-bg-${p}-`));
const t = MEMSRV ? test : test.skip;

const event = (over: Partial<BackgroundEvent> = {}): BackgroundEvent => ({ id: Math.random().toString(36).slice(2), at: Date.now(), task: "ingest", text: "learned 1 fact from 1 Claude Code session", items: ["test command: pnpm vitest"], ...over });

test("the events file keeps whole events, skips what is not one, and drops the oldest past its limit", () => {
  const home = tmp("store");
  expect(readEvents(home)).toEqual([]);
  appendEvents(home, [event({ id: "a", at: 1 }), event({ id: "b", at: 2 })]);
  fs.appendFileSync(eventsFile(home), 'not json\n{"id":"x","at":3,"task":"rm -rf","text":"?"}\n{"id":"half"');
  expect(readEvents(home).map((e) => e.id)).toEqual(["a", "b"]);
  fs.writeFileSync(eventsFile(home), "");
  appendEvents(home, Array.from({ length: MAX_EVENTS + 1 }, (_, i) => event({ id: `e${i}`, at: i })));
  const kept = readEvents(home);
  expect(kept.length).toBeLessThan(MAX_EVENTS);
  expect(kept.at(-1)!.id).toBe(`e${MAX_EVENTS}`);
  if (process.platform !== "win32") expect(fs.statSync(eventsFile(home)).mode & 0o777).toBe(0o600);
});

test("a task is due when it never ran or its interval has passed", () => {
  const now = 10 * 60 * 60_000;
  expect(dueTasks({ last: {}, reported: {} }, 60, now)).toEqual(["ingest", "tidy", "curate"]);
  expect(dueTasks({ last: { ingest: now - 30 * 60_000, tidy: now - 60 * 60_000, curate: now }, reported: {} }, 60, now)).toEqual(["tidy"]);
});

test("a conversation hears only finished results about its project or none, after it last looked", () => {
  const events = [
    event({ id: "mine", at: 5, project: "git:a" }),
    event({ id: "other", at: 5, project: "git:b" }),
    event({ id: "everyone", at: 5, task: "curate" }),
    event({ id: "old", at: 1, project: "git:a" }),
    event({ id: "broken", at: 5, failed: true }),
  ];
  expect(eventsFor(events, 2, "git:a").map((e) => e.id)).toEqual(["mine", "everyone"]);
  const note = backgroundMessage(eventsFor(events, 2, "git:a"));
  expect(note).toContain("- ingest: learned 1 fact from 1 Claude Code session\n  - test command: pnpm vitest");
  expect(note).toContain("for the user to apply");
});

test("the feed hands each result over once", () => {
  const home = tmp("feed");
  const feed = new BackgroundFeed(home, 100);
  appendEvents(home, [event({ id: "before", at: 50 }), event({ id: "a", at: 200 }), event({ id: "f", at: 201, failed: true })]);
  expect(feed.poll().map((e) => e.id)).toEqual(["a"]);
  expect(feed.poll()).toEqual([]);
  appendEvents(home, [event({ id: "b", at: 300 })]);
  expect(feed.poll().map((e) => e.id)).toEqual(["b"]);
});

test("an open Mnemo starts a run only when the setting is on, a task is due and nobody else is running", async () => {
  const home = tmp("tick");
  const settings = new SettingsStore();
  const delivered: string[] = [];
  let started = 0;
  let finish!: () => void;
  const o = {
    home,
    settings,
    onEvents: (es: BackgroundEvent[]) => delivered.push(...es.map((e) => e.id)),
    start: () => (started++, { exited: new Promise<void>((r) => (finish = r)) }),
  };
  const feed = new BackgroundFeed(home, 0);
  const running: { child?: Promise<unknown> } = {};
  backgroundTick(o, feed, running);
  expect(started).toBe(0); // off by default
  settings.set("background", true);
  fs.mkdirSync(path.dirname(lockFile(home)), { recursive: true });
  fs.writeFileSync(lockFile(home), "1 elsewhere");
  backgroundTick(o, feed, running);
  expect(started).toBe(0); // another process holds the lock
  fs.rmSync(lockFile(home));
  backgroundTick(o, feed, running);
  backgroundTick(o, feed, running);
  expect(started).toBe(1); // not twice while its run is going
  finish();
  await running.child;
  const now = Date.now();
  saveState(home, { last: { ingest: now, tidy: now, curate: now }, reported: {} });
  appendEvents(home, [event({ id: "landed", at: now })]);
  backgroundTick(o, feed, running);
  expect(started).toBe(1); // nothing due
  expect(delivered).toEqual(["landed"]);
});

test("settings: off by default, an interval in range, a model as provider/id", () => {
  const s = new SettingsStore();
  expect(s.get()).toMatchObject({ background: false, backgroundEvery: 60, backgroundModel: "" });
  expect(parseValue("backgroundEvery", "5").ok).toBe(false);
  expect(parseValue("backgroundModel", "haiku").ok).toBe(false);
  expect(parseValue("backgroundModel", "anthropic/claude-haiku-5-5")).toEqual({ ok: true, value: "anthropic/claude-haiku-5-5" });
});

/** A Claude Code transcript with one finished run that failed, then fixed, a test command. */
function claudeSession(projects: string, cwd: string, id: string): void {
  const base = { sessionId: id, cwd, isSidechain: false };
  const rows = [
    { ...base, type: "user", origin: { kind: "human" }, message: { role: "user", content: "run the tests please, and tell me which of them fail" } },
    { ...base, type: "assistant", message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm vitest" } }], stop_reason: "tool_use" } },
    { ...base, type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "12 passed" }] } },
    { ...base, type: "assistant", message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "All 12 pass." }], stop_reason: "end_turn" } },
  ];
  const dir = path.join(projects, cwd.replace(/[^\w]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  // Quiet for longer than ingest's settle time: finished, not still being written.
  const old = new Date(Date.now() - 60 * 60_000);
  fs.utimesSync(file, old, old);
}

const reflect: Reflector = async () =>
  JSON.stringify({
    facts: [{ scope: "project", key: "test command", value: "pnpm vitest", source: "observed" }],
    episode: { goal: "run the tests", outcome: "done", done: "ran vitest", decisions: [], open: [] },
    fixes: [],
    skill: null,
  });

function setup(name: string) {
  const home = tmp(name);
  const projects = path.join(home, "claude-projects");
  const repo = path.join(home, "repo");
  fs.mkdirSync(repo);
  const memory = new MemoryService(MEMSRV!, journalPath(home));
  let clock = Date.now();
  const o: RunOptions = { home, everyMin: 60, memory, reflect, userSkillsDir: path.join(home, "skills"), projects: async () => [repo], claudeProjectsDir: projects, now: () => clock };
  return { home, projects, repo, memory, o, advance: (ms: number) => (clock += ms) };
}

t("a run learns new Claude Code sessions, says what it learned per project, and is not due again until its interval passes", async () => {
  const s = setup("ingest");
  try {
    claudeSession(s.projects, s.repo, "cc-1");
    const first = await runBackground(s.o);
    expect(first.ran).toEqual(["ingest", "tidy", "curate"]);
    const learned = first.events.find((e) => e.task === "ingest")!;
    expect(learned).toMatchObject({ project: projectIdentity(s.repo).id, name: "repo", text: "learned 1 fact from 1 Claude Code session" });
    expect(learned.items.join("\n")).toContain("pnpm vitest");
    expect(readEvents(s.home).map((e) => e.id)).toContain(learned.id);
    expect(await s.memory.profile("project", projectIdentity(s.repo).id)).toContainEqual({ key: "test command", value: "pnpm vitest" });

    s.advance(10 * 60_000);
    expect(await runBackground(s.o)).toEqual({ ran: [], events: [] });
    // Forced, nothing new: it runs and finds nothing to say.
    const again = await runBackground({ ...s.o, force: true });
    expect(again.ran).toEqual(["ingest", "tidy", "curate"]);
    expect(again.events).toEqual([]);
    s.advance(61 * 60_000);
    expect((await runBackground(s.o)).ran).toEqual(["ingest", "tidy", "curate"]);
  } finally {
    s.memory.stop();
  }
});

t("tidy and curate change nothing, report what they find once, and again only when it changes", async () => {
  const s = setup("tidy");
  try {
    const id = projectIdentity(s.repo).id;
    await s.memory.learn("project", id, "package manager", "pnpm");
    await s.memory.learn("project", id, "pkg", "PNPM");
    const skill = path.join(s.o.userSkillsDir, "old-deploy");
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: old-deploy\ndescription: deploy the old way\n---\nrsync it\n");
    const old = new Date(Date.now() - 200 * 86_400_000);
    fs.utimesSync(path.join(skill, "SKILL.md"), old, old);

    const r = await runBackground({ ...s.o, reflect: undefined, noModel: "no model configured" });
    const tidy = r.events.find((e) => e.task === "tidy")!;
    expect(tidy.text).toContain("1 fact in repo's memory could be retired");
    expect(tidy.items[0]).toContain("duplicate");
    const curate = r.events.find((e) => e.task === "curate")!;
    expect(curate.text).toContain("1 personal skill unused for 90 days");
    expect(curate.project).toBeUndefined();
    // Reported, not applied.
    expect((await s.memory.profile("project", id)).map((f) => f.key).sort()).toEqual(["package manager", "pkg"]);
    expect(fs.existsSync(path.join(skill, "SKILL.md"))).toBe(true);
    // Without a model ingest fails, said in the log and never to a conversation.
    const failed = r.events.find((e) => e.task === "ingest")!;
    expect(failed).toMatchObject({ failed: true, text: "failed: no model configured" });
    expect(eventsFor(r.events, 0, id).some((e) => e.failed)).toBe(false);

    const same = await runBackground({ ...s.o, force: true });
    expect(same.events.filter((e) => e.task !== "ingest")).toEqual([]);
    await s.memory.learn("project", id, "package-manager", "pnpm.");
    const changed = await runBackground({ ...s.o, force: true });
    expect(changed.events.map((e) => e.task)).toEqual(["tidy"]);
  } finally {
    s.memory.stop();
  }
});

t("only one process runs the tasks at a time", async () => {
  const s = setup("lock");
  try {
    fs.mkdirSync(path.dirname(lockFile(s.home)), { recursive: true });
    fs.writeFileSync(lockFile(s.home), `${process.pid} ${os.hostname()}`);
    expect(await runBackground(s.o)).toEqual({ busy: true, ran: [], events: [] });
    expect(loadState(s.home).last).toEqual({});
    fs.rmSync(lockFile(s.home));
    expect((await runBackground(s.o)).ran.length).toBe(3);
    expect(fs.existsSync(lockFile(s.home))).toBe(false);
  } finally {
    s.memory.stop();
  }
});

test("mnemo background: status, log, and run say what happened", async () => {
  const home = tmp("cli");
  const out: string[] = [];
  const say = (l: string) => void out.push(l);
  expect(await backgroundCommand([], home, async () => ({ ran: [], events: [] }), say)).toBe(0);
  expect(out[0]).toContain("off (mnemo settings set background on)");
  openSettings(home).set("background", true);
  appendEvents(home, [event({ id: "a", name: "repo" })]);
  out.length = 0;
  await backgroundCommand([], home, async () => ({ ran: [], events: [] }), say);
  expect(out.join("\n")).toContain("on, every 60 minutes");
  expect(out.join("\n")).toContain("ingest  last ran never · due");
  expect(out.join("\n")).toContain("ingest repo: learned 1 fact");
  out.length = 0;
  expect(await backgroundCommand(["run"], home, async () => ({ busy: true, ran: [], events: [] }), say)).toBe(0);
  expect(out).toEqual(["another Mnemo is running the background tasks now"]);
  let forced = false;
  out.length = 0;
  expect(await backgroundCommand(["run", "--force"], home, async (f) => ((forced = f), { ran: ["ingest"], events: [event({ failed: true, text: "failed: no model" })] }), say)).toBe(1);
  expect(forced).toBe(true);
  expect(out.join("\n")).toContain("ingest failed: no model");
  expect(await backgroundCommand(["bogus"], home, async () => ({ ran: [], events: [] }), say)).toBe(2);
});

test("an open conversation is told, with its next prompt, what background work found for its project, once", async () => {
  const e = await mnemoEnv({});
  try {
    const project = projectIdentity(e.cwd).id;
    const heard: string[] = [];
    const listen = (context: { messages: { role: string; content: unknown }[] }) => {
      heard.push(JSON.stringify(context.messages.filter((m) => m.role === "user").map((m) => m.content)));
      return fauxAssistantMessage(fauxText("ok"));
    };
    e.faux.setResponses([listen, listen, listen]);
    const at = Date.now() + 1;
    appendEvents(e.home, [
      event({ id: "mine", at, project, items: ["deploy: fly from main"] }),
      event({ id: "theirs", at, project: "git:someone/else", items: ["secret plans of another project"] }),
      event({ id: "skills", at, task: "curate", text: "1 personal skill unused for 90 days", items: ["old-deploy"] }),
      event({ id: "broken", at, failed: true, text: "ingest failed: boom" }),
    ]);
    await e.controller.submit("hello");
    await e.idle();
    expect(heard[0]).toContain("Background memory work finished since your last turn");
    expect(heard[0]).toContain("deploy: fly from main");
    expect(heard[0]).toContain("old-deploy");
    expect(heard[0]).not.toContain("secret plans");
    expect(heard[0]).not.toContain("boom");
    await e.controller.submit("again");
    await e.idle();
    // Told once: the second prompt carries the first note in its history, and no new one.
    expect(heard[1]!.split("Background memory work finished").length - 1).toBe(1);
  } finally {
    await e.close();
  }
});
