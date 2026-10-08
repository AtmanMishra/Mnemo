/**
 * The interface driven with real keystrokes, asserted on the frame text.
 */
import { test, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Composer, type ComposerProps } from "../src/ui/components/Composer.tsx";
import { DialogView, filterChoices } from "../src/ui/components/Dialogs.tsx";
import { BlockView } from "../src/ui/components/Blocks.tsx";
import { Dialogs } from "../src/runtime/dialogs.ts";
import { MotionContext } from "../src/ui/components/motion.ts";
import type { CommandInfo } from "../src/runtime/controller.ts";

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const KEY = { enter: "\r", esc: "\x1b", up: "\x1b[A", down: "\x1b[B", tab: "\t", ctrlC: "\x03", backspace: "\x7f" };

const COMMANDS: CommandInfo[] = [
  { name: "help", description: "commands and keys", source: "builtin" },
  { name: "model", description: "choose the model", source: "builtin" },
  { name: "resume", description: "continue an earlier session", source: "builtin" },
  { name: "skill:review", description: "review a diff", source: "skill" },
];

function composer(overrides: Partial<ComposerProps> = {}) {
  const calls = { submit: [] as [string, string][], interrupt: 0, quit: 0, expanded: 0 };
  const props: ComposerProps = {
    working: false,
    active: true,
    commands: () => COMMANDS,
    files: () => ["src/fetch.ts", "src/net/retry.ts", "README.md"],
    footer: { model: "demo-model", thinking: "medium", contextPercent: 12, cost: 0.04, cwd: "/x", branch: "main" },
    statuses: [],
    onSubmit: (t, m) => calls.submit.push([t, m]),
    onInterrupt: () => calls.interrupt++,
    onQuit: () => calls.quit++,
    onDraft: () => {},
    onToggleExpanded: () => calls.expanded++,
    onClear: () => {},
    onCycleThinking: () => {},
    ...overrides,
  };
  const r = render(
    <MotionContext.Provider value={false}>
      <Composer {...props} />
    </MotionContext.Provider>,
  );
  const type = async (s: string) => {
    for (const ch of s.match(/\x1b\[[A-D]|./gs) ?? []) {
      r.stdin.write(ch);
      await tick(5);
    }
    await tick();
  };
  return { ...r, calls, type };
}

test("typing and enter sends the message and empties the box", async () => {
  const c = composer();
  await c.type("hello mnemo");
  expect(c.lastFrame()).toContain("hello mnemo");
  await c.type(KEY.enter);
  expect(c.calls.submit).toEqual([["hello mnemo", "auto"]]);
  expect(c.lastFrame()).toContain("Ask Mnemo anything");
});

test("the footer shows model, thinking, context, cost and branch", () => {
  const c = composer();
  const f = c.lastFrame()!;
  for (const s of ["demo-model", "think:medium", "12% context", "$0.04", "main", "? for shortcuts"]) expect(f).toContain(s);
});

test("/ opens the command menu, filtered by name, and enter runs the highlighted one", async () => {
  const c = composer();
  await c.type("/mo");
  const f = c.lastFrame()!;
  expect(f).toContain("/model");
  expect(f).not.toContain("/resume");
  await c.type(KEY.enter);
  expect(c.calls.submit).toEqual([["/model", "auto"]]);
});

test("tab completes a command without running it", async () => {
  const c = composer();
  await c.type("/res");
  await c.type(KEY.tab);
  expect(c.calls.submit).toEqual([]);
  expect(c.lastFrame()).toContain("/resume ");
});

test("@ suggests files and tab inserts the path", async () => {
  const c = composer();
  await c.type("look at @retry");
  expect(c.lastFrame()).toContain("src/net/retry.ts");
  await c.type(KEY.tab);
  await c.type(KEY.enter);
  expect(c.calls.submit).toEqual([["look at @src/net/retry.ts ", "auto"]]);
});

test("↑ recalls the previous message", async () => {
  const c = composer();
  await c.type("first");
  await c.type(KEY.enter);
  await c.type(KEY.up);
  expect(c.lastFrame()).toContain("first");
});

test("a trailing backslash makes a newline instead of sending", async () => {
  const c = composer();
  await c.type("line one\\");
  await c.type(KEY.enter);
  await c.type("line two");
  expect(c.calls.submit).toEqual([]);
  await c.type(KEY.enter);
  expect(c.calls.submit).toEqual([["line one\nline two", "auto"]]);
});

test("esc interrupts while the agent works", async () => {
  const c = composer({ working: true });
  expect(c.lastFrame()).toContain("Queue a follow-up");
  await c.type(KEY.esc);
  await tick(60);
  expect(c.calls.interrupt).toBe(1);
});

test("ctrl+c clears the draft, then asks before quitting", async () => {
  const c = composer();
  await c.type("draft");
  await c.type(KEY.ctrlC);
  expect(c.lastFrame()).not.toContain("draft");
  await c.type(KEY.ctrlC);
  expect(c.lastFrame()).toContain("press ctrl+c again to quit");
  await c.type(KEY.ctrlC);
  expect(c.calls.quit).toBe(1);
});

test("? on an empty box shows the shortcuts", async () => {
  const c = composer();
  await c.type("?");
  expect(c.lastFrame()).toContain("expand output");
});

test("a select dialog filters as you type and enter picks", async () => {
  const dialogs = new Dialogs();
  const answer = dialogs.select("Choose a model", [
    { value: "a/opus", label: "opus" },
    { value: "a/sonnet", label: "sonnet" },
    { value: "o/gpt", label: "gpt" },
  ]);
  const r = render(<DialogView dialog={dialogs.current()!} />);
  for (const ch of "son") {
    r.stdin.write(ch);
    await tick(5);
  }
  await tick();
  expect(r.lastFrame()).toContain("sonnet");
  expect(r.lastFrame()).not.toContain("gpt");
  r.stdin.write(KEY.enter);
  expect(await answer).toBe("a/sonnet");
});

test("a confirm dialog answers y and n", async () => {
  const dialogs = new Dialogs();
  const answer = dialogs.confirm("Run this command?", "rm -rf build");
  const r = render(<DialogView dialog={dialogs.current()!} />);
  expect(r.lastFrame()).toContain("rm -rf build");
  r.stdin.write("y");
  expect(await answer).toBe(true);
});

test("filtering matches one field at a time", () => {
  const out = filterChoices([{ value: "x", label: "alpha", description: "beta" }], "ab");
  expect(out).toEqual([]);
});

test("a secret text dialog never shows what was typed", async () => {
  const dialogs = new Dialogs();
  const answer = dialogs.text("API key", { secret: true });
  const r = render(<DialogView dialog={dialogs.current()!} />);
  for (const ch of "sk-123") {
    r.stdin.write(ch);
    await tick(5);
  }
  await tick();
  expect(r.lastFrame()).not.toContain("sk-123");
  expect(r.lastFrame()).toContain("••••••");
  r.stdin.write(KEY.enter);
  expect(await answer).toBe("sk-123");
});

test("a running tool shows its title; a failed one shows why", () => {
  const welcome = { version: "0", cwd: "/p", model: "m", needsLogin: false, columns: 80 };
  const running = render(
    <MotionContext.Provider value={false}>
      <BlockView
        block={{ kind: "tool", id: "1", name: "bash", args: { command: "npm test" }, status: "running", output: "" }}
        cwd="/p"
        expanded={false}
        welcome={welcome}
      />
    </MotionContext.Provider>,
  );
  expect(running.lastFrame()).toContain("Bash(npm test)");
  expect(running.lastFrame()).toContain("running");
  const failed = render(
    <BlockView
      block={{ kind: "tool", id: "2", name: "read", args: { path: "/p/missing.ts" }, status: "error", output: "ENOENT: no such file" }}
      cwd="/p"
      expanded={false}
      welcome={welcome}
    />,
  );
  expect(failed.lastFrame()).toContain("✗ Read(missing.ts)");
  expect(failed.lastFrame()).toContain("ENOENT");
});

test("finished answers render markdown", () => {
  const welcome = { version: "0", cwd: "/p", model: "m", needsLogin: false, columns: 80 };
  const r = render(
    <BlockView
      block={{ kind: "assistant", id: "a", text: "# Title\n\n- one\n- two\n\n```js\nlet x = 1\n```", done: true }}
      cwd="/p"
      expanded={false}
      welcome={welcome}
    />,
  );
  const f = r.lastFrame()!;
  expect(f).toContain("Title");
  expect(f).toContain("• one");
  expect(f).toContain("let x = 1");
  expect(f).not.toContain("```");
});
