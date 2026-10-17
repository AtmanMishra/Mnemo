/**
 * A setting changes the part of Mnemo it names, and only that part: the keys the
 * prompt and the workspace listen to, how long a toast stays, when a turn notifies,
 * when a run escalates, and whether a run reflects or verifies.
 */
import { test, expect, afterEach, setDefaultTimeout } from "bun:test";
import React from "react";
import { cleanup, render } from "ink-testing-library";
import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { projectIdentity } from "@mnemo/memory";
import { Composer, type ComposerProps } from "../src/ui/components/Composer.tsx";
import { Workspace } from "../src/ui/workspace/Workspace.tsx";
import { MotionContext } from "../src/ui/components/motion.ts";
import { SettingsContext } from "../src/ui/settings-context.ts";
import { toastFrame } from "../src/ui/Toasts.tsx";
import { Notifier, NOTIFY_AFTER_MS } from "../src/ui/notify.ts";
import { SettingsStore } from "../src/runtime/settings.ts";
import type { Pane, WorkspaceSource } from "../src/ui/workspace/model.ts";
import { MEMSRV, mnemoEnv } from "./helpers.ts";
import { waitFor } from "./wait-for.ts";

setDefaultTimeout(30_000);
const envs: Awaited<ReturnType<typeof mnemoEnv>>[] = [];
afterEach(async () => {
  cleanup();
  for (const e of envs.splice(0)) await e.close();
});
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// ── the prompt's keys ────────────────────────────────────────────────────────

function prompt(settings: SettingsStore, overrides: Partial<ComposerProps> = {}) {
  const calls = { expanded: 0, cleared: 0, thinking: 0, palette: 0 };
  const props: ComposerProps = {
    working: false,
    active: true,
    commands: () => [],
    files: () => [],
    footer: { model: "m", thinking: "medium", contextPercent: 1, cost: 0, cwd: "/x", branch: "main", mode: "default", memory: { nodes: 0, answering: true } },
    statuses: [],
    onSubmit: () => {},
    onInterrupt: () => {},
    onQuit: () => {},
    onDraft: () => {},
    onToggleExpanded: () => calls.expanded++,
    onClear: () => calls.cleared++,
    onCycleThinking: () => calls.thinking++,
    onCycleMode: () => {},
    onPalette: () => calls.palette++,
    ...overrides,
  };
  const r = render(
    <MotionContext.Provider value={false}>
      <SettingsContext.Provider value={settings}>
        <Composer {...props} />
      </SettingsContext.Provider>
    </MotionContext.Provider>,
  );
  const press = async (s: string) => {
    r.stdin.write(s);
    await tick();
  };
  return { ...r, calls, press };
}

test("the prompt's keys keep their defaults, and follow a rebind (the old chord stops working)", async () => {
  const p = prompt(new SettingsStore());
  await p.press("\x0f"); // ctrl+o
  await p.press("\x0c"); // ctrl+l
  await p.press("\x14"); // ctrl+t
  await p.press("\x0b"); // ctrl+k on an empty prompt
  expect(p.calls).toEqual({ expanded: 1, cleared: 1, thinking: 1, palette: 1 });

  const s = new SettingsStore();
  expect(s.set("keys.expand", "alt+x").ok).toBe(true);
  expect(s.set("keys.clear", "ctrl+x").ok).toBe(true);
  expect(s.set("keys.thinking", "alt+j").ok).toBe(true);
  expect(s.set("keys.hub", "ctrl+q").ok).toBe(true); // frees ctrl+g
  expect(s.set("keys.palette", "ctrl+g").ok).toBe(true);
  const q = prompt(s);
  await q.press("\x0f"); // ctrl+o: no longer bound
  await q.press("\x0c");
  await q.press("\x14");
  await q.press("\x0b");
  expect(q.calls).toEqual({ expanded: 0, cleared: 0, thinking: 0, palette: 0 });
  await q.press("\x1bx"); // alt+x
  await q.press("\x18"); // ctrl+x
  await q.press("\x1bj"); // alt+j
  await q.press("\x07"); // ctrl+g
  expect(q.calls).toEqual({ expanded: 1, cleared: 1, thinking: 1, palette: 1 });
});

test("ctrl+k kills to the end of a typed line, and opens the palette only on an empty prompt", async () => {
  const p = prompt(new SettingsStore());
  for (const ch of "hello world") await p.press(ch);
  for (let i = 0; i < 6; i++) await p.press("\x1b[D");
  await p.press("\x0b");
  expect(p.calls.palette).toBe(0);
  expect(p.lastFrame()).toContain("hello");
  expect(p.lastFrame()).not.toContain("world");
});

test("the shortcut list shows the keys as bound now", async () => {
  const s = new SettingsStore();
  s.set("keys.expand", "alt+x");
  const p = prompt(s);
  await p.press("?");
  expect(p.lastFrame()).toContain("alt+x");
  expect(p.lastFrame()).toContain("expand output");
  expect(p.lastFrame()).not.toContain("ctrl+o");
});

// ── the workspace ────────────────────────────────────────────────────────────

const source = (): WorkspaceSource => ({
  files: () => ["README.md", "src/app.ts"],
  memory: async () => [],
  sessions: async () => [],
  skills: () => [],
  logs: () => [],
  preview: async (_p: Pane, id: string) => ({ title: id, lines: [] }),
  act: async () => {},
});

async function workspace(settings: SettingsStore) {
  const e = await mnemoEnv();
  envs.push(e);
  const r = render(
    <SettingsContext.Provider value={settings}>
      <Workspace controller={e.controller} source={source()} motion={false} />
    </SettingsContext.Provider>,
  );
  await waitFor(() => expect(r.lastFrame()).toContain("Ask anything about this project."));
  return r;
}

test("the sidebar starts open or closed as chosen, and its key is the one chosen", async () => {
  const open = await workspace(new SettingsStore());
  await waitFor(() => expect(open.lastFrame()).toContain("README.md"));
  open.stdin.write("\x02"); // ctrl+b
  await waitFor(() => expect(open.lastFrame()).not.toContain("README.md"));
  cleanup();

  const s = new SettingsStore();
  s.set("sidebar", false);
  const shut = await workspace(s);
  await tick(80);
  expect(shut.lastFrame()).not.toContain("README.md");
  shut.stdin.write("\x02"); // still ctrl+b: shows it
  await waitFor(() => expect(shut.lastFrame()).toContain("README.md"));
  cleanup();

  const k = new SettingsStore();
  k.set("keys.sidebar", "ctrl+x");
  const moved = await workspace(k);
  await waitFor(() => expect(moved.lastFrame()).toContain("README.md"));
  moved.stdin.write("\x02");
  await tick(80);
  expect(moved.lastFrame()).toContain("README.md"); // ctrl+b does nothing now
  moved.stdin.write("\x18");
  await waitFor(() => expect(moved.lastFrame()).not.toContain("README.md"));
});

// ── toasts and notifications ─────────────────────────────────────────────────

test("a toast's life follows the setting (4.5 s unless changed)", () => {
  expect(toastFrame("hello", 4400).text).toMatch(/[▓▒░ ]/);
  expect(toastFrame("hello", 4400, 10_000)).toEqual({ text: "hello", shift: 0 });
  expect(toastFrame("hello", 9800, 10_000).text).toMatch(/[▓▒░ ]/);
});

test("a turn notifies after the time in the settings", () => {
  const out: string[] = [];
  let now = 0;
  let after = NOTIFY_AFTER_MS;
  const n = new Notifier((s) => out.push(s), () => now, () => after);
  let work: (() => void) | undefined;
  let since: { since: number } | null = null;
  n.watch("shop", {
    transcript: {
      subscribe: (l) => {
        work = l;
        return () => {};
      },
      snapshot: () => ({ working: since }),
    },
    dialogs: { subscribe: () => () => {}, current: () => undefined },
  });
  n.input("\x1b[O");
  const turn = (ms: number) => {
    since = { since: now };
    work!();
    now += ms;
    since = null;
    work!();
  };
  turn(8_000);
  expect(out).toEqual([]);
  after = 5_000;
  turn(8_000);
  expect(out).toHaveLength(1);
});

// ── a run ────────────────────────────────────────────────────────────────────

const bash = (command: string) => fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" });
const say = (t: string) => fauxAssistantMessage(fauxText(t));
function recording(seen: string[], steps: ReturnType<typeof fauxAssistantMessage>[]): FauxResponseStep[] {
  return steps.map((m) => (_c, _o, _s, model) => {
    seen.push(model.id);
    return m;
  });
}

test("escalation waits for as many failed checks as the settings say", async () => {
  const s = new SettingsStore();
  s.set("escalateAfter", 1);
  const e = await mnemoEnv({ mode: "yolo", escalate: "mnemo-demo/demo-strong", settings: s });
  envs.push(e);
  const seen: string[] = [];
  e.faux.setResponses(recording(seen, [bash("npm test --nope; exit 1"), bash("echo fixed"), say("done")]));
  await e.controller.submit("fix it");
  await e.idle();
  expect(seen).toEqual(["demo-model", "demo-strong", "demo-strong"]);
});

test("the escalation model can come from the settings when no flag names one", async () => {
  const s = new SettingsStore();
  s.set("escalateModel", "mnemo-demo/demo-strong");
  s.set("escalateAfter", 1);
  const e = await mnemoEnv({ mode: "yolo", escalate: "mnemo-demo/demo-strong", settings: s });
  envs.push(e);
  e.host.escalate = undefined; // no flag: the menu's choice stands
  const seen: string[] = [];
  e.faux.setResponses(recording(seen, [bash("npm test --nope; exit 1"), say("done")]));
  await e.controller.submit("fix it");
  await e.idle();
  expect(seen).toEqual(["demo-model", "demo-strong"]);

  // Nothing set anywhere: nothing escalates.
  s.set("escalateModel", "");
  const again: string[] = [];
  e.faux.setResponses(recording(again, [bash("npm test --nope; exit 1"), say("done")]));
  await e.controller.submit("again");
  await e.idle();
  expect(again).toEqual(["demo-model", "demo-model"]);
});

const mt = MEMSRV ? test : test.skip;
const reflection = JSON.stringify({ facts: [{ scope: "project", key: "package manager", value: "bun", source: "user" }], fixes: [], skill: null });

mt("turning reflection off spends no model call on it, and on again does", async () => {
  const s = new SettingsStore();
  s.set("reflect", false);
  const e = await mnemoEnv({ memory: true, reflect: true, mode: "yolo", settings: s });
  envs.push(e);
  const calls = () => e.faux.state.callCount;
  e.faux.setResponses([bash("echo one"), say("one done"), say(reflection)]);
  await e.controller.submit("please run the echo command called one, and tell me when it is done");
  await e.idle();
  expect(calls()).toBe(2);

  s.set("reflect", true);
  e.faux.setResponses([bash("echo two"), say("two done"), say(reflection)]);
  await e.controller.submit("please run the echo command called two, and tell me when it is done");
  await e.idle();
  expect(calls()).toBe(5);
});

mt("turning the check off lets a run that changed code finish unchecked", async () => {
  const s = new SettingsStore();
  s.set("verify", false);
  const e = await mnemoEnv({ memory: true, reflect: false, verify: true, mode: "yolo", settings: s });
  envs.push(e);
  await e.memory!.learn("project", projectIdentity(e.cwd).id, "verify command", "bun test");
  e.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("write", { path: "src/new.ts", content: "export const n = 1;\n" })], { stopReason: "toolUse" }),
    say("Wrote it."),
    bash("bun test"),
    say("Checked."),
  ]);
  await e.controller.submit("add a file");
  await e.idle();
  expect(e.faux.state.callCount).toBe(2);
});
