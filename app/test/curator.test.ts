/**
 * The background curator: when it may run (idle, not busy, on, within budget),
 * that an unchanged input costs no call, that typing stops it, and end to end
 * on a real session: /curator run, the resurfaced lines reaching the next
 * recall once, and /curator review writing an approved skill.
 */
import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { MemoryService, projectIdentity } from "@mnemo/memory";
import { Curator, IDLE_MS, DAILY_BUDGET } from "../src/runtime/curator.ts";
import { MEMSRV, mnemoEnv, nextDialog, texts } from "./helpers.ts";

const envs: Awaited<ReturnType<typeof mnemoEnv>>[] = [];
const stops: (() => void)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) s();
  for (const e of envs.splice(0)) await e.close();
});

function rig(answer: (system: string) => string, tokens = 100) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-cur-"));
  const mem = new MemoryService(MEMSRV!, path.join(home, "memory", "journal.jsonl"));
  stops.push(() => mem.stop());
  let now = 1_800_000_000_000;
  let busy = false;
  const calls: string[] = [];
  const reports: string[][] = [];
  let hold: Promise<void> | undefined;
  const c = new Curator({
    home,
    memory: mem,
    projectId: "p1",
    projectRoot: home,
    project: async () => undefined,
    userSkillsDir: path.join(home, "skills"),
    ask: async (system) => {
      calls.push(system.slice(0, 40));
      if (hold) await hold;
      return { text: answer(system), tokens };
    },
    busy: () => busy,
    report: (_t, items) => void reports.push(items),
    now: () => now,
  });
  return {
    c, mem, calls, reports,
    pass: (ms: number) => (now += ms),
    setBusy: (b: boolean) => (busy = b),
    holdNext: () => {
      let release!: () => void;
      hold = new Promise((r) => (release = r));
      return () => { hold = undefined; release(); };
    },
  };
}

const FACTS = JSON.stringify({ merge: [{ scope: "project", keys: ["pm", "package manager"], key: "package manager", value: "pnpm" }] });
const ITEMS = JSON.stringify({ items: ["Last time the cookie test was left open."] });
const byPrompt = (s: string) => (s.includes("tidy") ? FACTS : s.includes("remember at the right moment") ? ITEMS : "{}");

test.skipIf(!MEMSRV)("runs only when idle, not busy, on, and within the budget; a job with nothing new makes no call", async () => {
  const r = rig(byPrompt);
  // Not duplicates a word count can see (that is the free tidy's job): the model's.
  await r.mem.learn("project", "p1", "pm", "pnpm with workspaces");
  await r.mem.learn("project", "p1", "package manager", "we install with pnpm");
  await r.mem.learn("project", "p1", "test command", "pnpm test");
  await r.mem.learn("project", "p1", "last session", "2026-10-12: cookies — partial; open: a test");
  expect(r.c.due()).toBeUndefined(); // just started: not idle yet
  r.pass(IDLE_MS);
  expect(r.c.due()).toBe("resurface");
  r.setBusy(true);
  expect(r.c.due()).toBeUndefined();
  r.setBusy(false);
  r.c.setEnabled(false);
  expect(r.c.due()).toBeUndefined();
  r.c.setEnabled(true);

  await r.c.tick(); // resurface
  await r.c.tick(); // facts
  await r.c.tick(); // skills: no evidence, no call
  expect(r.calls.length).toBe(2);
  expect((await r.mem.profile("project", "p1")).map((f) => f.key).sort()).toEqual(["last session", "package manager", "test command"]);
  expect(r.reports.flat().join("\n")).toContain('merged "pm" + "package manager"');
  expect(r.c.takeResurfaced()).toEqual(["Last time the cookie test was left open."]);
  expect(r.c.takeResurfaced()).toEqual([]);
  expect(r.c.due()).toBeUndefined(); // everything ran: nothing due until its interval

  r.pass(12 * 3_600_000);
  await r.c.run(); // all three due again, but nothing changed since: no calls
  expect(r.calls.length).toBe(2);
  expect(r.c.budget().used).toBe(200);
});

test.skipIf(!MEMSRV)("typing stops a pass mid-call: nothing applied, tried again later", async () => {
  const r = rig(byPrompt);
  await r.mem.learn("project", "p1", "last session", "2026-10-12: cookies — partial");
  await r.mem.learn("project", "p1", "test command", "pnpm test");
  r.pass(IDLE_MS);
  const release = r.holdNext();
  const pass = r.c.run(["resurface"]);
  await new Promise((res) => setTimeout(res, 20));
  r.c.activity();
  release();
  await pass;
  expect(r.c.takeResurfaced()).toEqual([]);
  expect(r.c.due()).toBeUndefined(); // you just typed
  r.pass(IDLE_MS);
  expect(r.c.due()).toBe("resurface"); // and it was not marked done
});

test.skipIf(!MEMSRV)("the daily budget stops it", async () => {
  const r = rig(byPrompt, DAILY_BUDGET);
  await r.mem.learn("project", "p1", "last session", "2026-10-12: cookies");
  await r.mem.learn("project", "p1", "a", "1");
  await r.mem.learn("project", "p1", "b", "2");
  await r.mem.learn("project", "p1", "c", "3");
  r.pass(IDLE_MS);
  await r.c.run();
  expect(r.calls.length).toBe(1);
  expect(r.c.budget().left).toBe(0);
  expect(r.c.due()).toBeUndefined();
  r.pass(24 * 3_600_000); // a new day
  expect(r.c.budget().left).toBe(DAILY_BUDGET);
});

test.skipIf(!MEMSRV)("end to end: /curator run, the next recall carries what it resurfaced, /curator review saves a skill", async () => {
  const e = await mnemoEnv({ memory: true });
  envs.push(e);
  const c = e.controller.curator!;
  expect(c).toBeDefined();
  const id = projectIdentity(e.cwd).id;
  await e.memory!.learn("project", id, "last session", "2026-10-12: fix login — partial; open: expired-cookie test");
  await e.memory!.learn("project", id, "test command", "pnpm vitest");
  // The curator asks the session's own (faux) model.
  e.faux.setResponses([fauxAssistantMessage(fauxText(ITEMS))]);
  await e.controller.submit("/curator run");
  expect(texts(e.controller).join("\n")).toContain("↺ Last time the cookie test was left open.");

  let recallMessage = "";
  e.faux.setResponses([
    (context) => {
      recallMessage = JSON.stringify(context.messages);
      return fauxAssistantMessage(fauxText("ok"));
    },
  ]);
  await e.controller.submit("let's continue the login work");
  await e.idle();
  expect(recallMessage).toContain("Brought back from earlier sessions by memory");
  expect(recallMessage).toContain("cookie test was left open");
  expect(texts(e.controller).some((t) => t.startsWith("◈ Resurfaced: "))).toBe(true);
  expect(c.takeResurfaced()).toEqual([]);

  const file = path.join(e.home, "agent", "skills", "cut-release", "SKILL.md");
  c.writeInbox([{ id: "x", kind: "new", name: "cut-release", scope: "user", file, body: '---\nname: cut-release\ndescription: "cutting a release"\n---\n\n1. tag\n', reason: "seen in 2 sessions", at: 0 }]);
  const reviewing = e.controller.submit("/curator review");
  const d = await nextDialog(e.controller);
  if (d.kind !== "approval") throw new Error(d.kind);
  expect(d.request.tool).toBe("Save skill");
  d.resolve({ kind: "yes" });
  await reviewing;
  expect(fs.readFileSync(file, "utf8")).toContain("1. tag");
  expect(c.inbox()).toEqual([]);
  expect(await e.memory!.findLabel("skill cut-release")).toBeDefined();

  await e.controller.submit("/curator off");
  expect(c.enabled).toBe(false);
  await e.controller.submit("/curator");
  expect(texts(e.controller).at(-1)).toContain("off · runs after 3 min idle");
});
