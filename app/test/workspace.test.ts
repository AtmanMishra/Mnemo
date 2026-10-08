/**
 * The workspace on a real session with a stand-in data source: focus moves
 * with tab and comes back with esc, the sidebar's selection previews in the
 * main area, panes switch with 1–5, a pane's keys reach the source, ctrl+b
 * hides the sidebar, and the file tree opens and closes.
 */
import { test, expect, afterEach } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { Workspace } from "../src/ui/workspace/Workspace.tsx";
import { fileTree, type Item, type Pane, type WorkspaceSource } from "../src/ui/workspace/model.ts";
import { mnemoEnv } from "./helpers.ts";

const envs: Awaited<ReturnType<typeof mnemoEnv>>[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
});
const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const KEY = { tab: "\t", esc: "\x1b", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", ctrlB: "\x02" };

function fakeSource(acts: string[]): WorkspaceSource {
  return {
    files: () => ["README.md", "src/app.ts", "src/lib/util.ts"],
    memory: async () => [
      { id: "h", label: "This project", kind: "head", detail: "1" },
      { id: "p:pm", label: "package manager", detail: "pnpm", kind: "fact", depth: 1 },
    ],
    sessions: async () => [{ id: "/s/1.jsonl", label: "fix the login bug", detail: "today", kind: "session" }],
    skills: () => [{ id: "/k/release/SKILL.md", label: "release", detail: "Cut a release", kind: "skill" }],
    logs: () => [{ id: "0", label: "12:00 bash", detail: "pnpm test", kind: "log" }],
    preview: async (pane: Pane, id: string) => ({ title: id, lines: [{ text: `contents of ${pane}:${id}`, gutter: "1" }] }),
    act: (pane: Pane, id: string, key: string) => void acts.push(`${pane}:${id}:${key}`),
  };
}

async function mount() {
  const e = await mnemoEnv();
  envs.push(e);
  const acts: string[] = [];
  const r = render(React.createElement(Workspace, { controller: e.controller, source: fakeSource(acts), motion: false }));
  await wait(80);
  return { ...r, e, acts };
}

test("the file tree: directories first, opened and closed, with counts", () => {
  const closed = fileTree(["README.md", "src/app.ts", "src/lib/util.ts"], new Set());
  expect(closed.map((i: Item) => [i.label, i.kind, i.detail ?? ""])).toEqual([
    ["src", "dir", "2"],
    ["README.md", "file", ""],
  ]);
  const open = fileTree(["README.md", "src/app.ts", "src/lib/util.ts"], new Set(["src", "src/lib"]));
  expect(open.map((i) => `${"  ".repeat(i.depth ?? 0)}${i.label}`)).toEqual(["src", "  lib", "    util.ts", "  app.ts", "README.md"]);
});

test("tab moves focus to the sidebar, moving the selection previews it, esc comes back", async () => {
  const r = await mount();
  expect(r.lastFrame()).toContain("FILES");
  expect(r.lastFrame()).toContain("TRANSCRIPT");
  r.stdin.write(KEY.tab);
  await wait();
  r.stdin.write(KEY.down); // README.md
  await wait(150);
  expect(r.lastFrame()).toContain("contents of files:README.md");
  r.stdin.write(KEY.esc);
  await wait(150);
  expect(r.lastFrame()).toContain("TRANSCRIPT");
  r.unmount();
});

test("a directory opens with → and closes with ←", async () => {
  const r = await mount();
  r.stdin.write(KEY.tab);
  await wait();
  r.stdin.write(KEY.right);
  await wait();
  expect(r.lastFrame()).toContain("app.ts");
  r.stdin.write(KEY.left);
  await wait();
  expect(r.lastFrame()).not.toContain("app.ts");
  r.unmount();
});

test("1–5 switch panes, and a pane's own keys reach the source", async () => {
  const r = await mount();
  r.stdin.write(KEY.tab);
  await wait();
  r.stdin.write("2");
  await wait(80);
  expect(r.lastFrame()).toContain("MEMORY");
  expect(r.lastFrame()).toContain("package manager");
  r.stdin.write("3");
  await wait(80);
  expect(r.lastFrame()).toContain("fix the login bug");
  r.stdin.write("r");
  await wait();
  expect(r.acts).toEqual(["sessions:/s/1.jsonl:r"]);
  r.unmount();
});

test("ctrl+b hides and shows the sidebar", async () => {
  const r = await mount();
  expect(r.lastFrame()).toContain("FILES");
  r.stdin.write(KEY.ctrlB);
  await wait();
  expect(r.lastFrame()).not.toContain("FILES");
  r.stdin.write(KEY.ctrlB);
  await wait();
  expect(r.lastFrame()).toContain("FILES");
  r.unmount();
});

test("a turn's answer appears in the transcript viewport", async () => {
  const r = await mount();
  r.e.faux.setResponses([fauxAssistantMessage(fauxText("The answer is forty-two."))]);
  await r.e.controller.submit("what is the answer?");
  await r.e.idle();
  await wait(80);
  expect(r.lastFrame()).toContain("The answer is forty-two.");
  r.unmount();
});

test("files the agent changed are marked, a failing tool's files flagged, sizes weighed", async () => {
  const { decorateFiles } = await import("../src/ui/workspace/decorate.ts");
  const { sizeBar } = await import("../src/ui/workspace/Sidebar.tsx");
  const items = fileTree(["a.ts", "b.ts", "c.ts"], new Set());
  const out = decorateFiles(
    items,
    [
      { kind: "tool", id: "1", name: "edit", args: { path: "/p/a.ts" }, status: "done", output: "" },
      { kind: "tool", id: "2", name: "bash", args: { command: "tsc" }, status: "error", output: "c.ts(3,1): error TS2304" },
    ],
    "/p",
    (rel) => ({ "a.ts": 10, "b.ts": 10_000, "c.ts": 100 })[rel],
  );
  expect(out.map((i) => i.badge?.ch ?? "")).toEqual(["✎", "", "!"]);
  expect(out[1]!.weight).toBe(1);
  expect(out[0]!.weight).toBeLessThan(out[2]!.weight!);
  expect(sizeBar(1)).toBe("████");
  expect(sizeBar(0)).toBe("░░░░");
  expect(sizeBar(0.6)).toBe("██▒░");
});

test("the memory map places each group in its own arc around the project", async () => {
  const { layoutMap } = await import("../src/ui/workspace/MemoryMap.tsx");
  const { nodes, cx, cy } = layoutMap(
    [
      { id: "h", label: "This project", kind: "head" },
      { id: "p:pm", label: "package manager", kind: "fact", depth: 1 },
      { id: "u:editor", label: "editor", kind: "fact", depth: 1 },
      { id: "n:9", label: "npm test on node 22", kind: "pitfall", depth: 1 },
      { id: "n:4", label: "fix the login bug", kind: "session", depth: 1 },
    ],
    100,
    30,
  );
  const at = (id: string) => nodes.find((n) => n.id === id)!;
  expect(nodes).toHaveLength(4);
  expect(at("p:pm").x).toBeGreaterThan(cx); // project facts to the right
  expect(at("u:editor").x).toBeLessThan(cx); // yours to the left
  expect(at("n:9").y).toBeGreaterThan(cy); // pitfalls below
  expect(at("n:4").y).toBeLessThan(cy); // sessions above
});

test("m in the memory pane opens the map; [ ] walk the timeline of turns", async () => {
  const r = await mount();
  r.e.faux.setResponses([fauxAssistantMessage(fauxText("first answer")), fauxAssistantMessage(fauxText("second answer"))]);
  await r.e.controller.submit("one");
  await r.e.idle();
  await r.e.controller.submit("two");
  await r.e.idle();
  await wait(80);
  r.stdin.write(KEY.tab);
  await wait();
  r.stdin.write("2");
  await wait(80);
  r.stdin.write("m");
  await wait(120);
  expect(r.lastFrame()).toContain("MEMORY MAP");
  expect(r.lastFrame()).toContain("package manager");
  r.stdin.write(KEY.esc);
  await wait();
  expect(r.lastFrame()).toContain("TRANSCRIPT");
  r.stdin.write("[");
  await wait();
  r.stdin.write("[");
  await wait(120);
  expect(r.lastFrame()).toContain("turn 1/2");
  expect(r.lastFrame()).toContain("first answer");
  r.stdin.write(KEY.esc);
  await wait();
  expect(r.lastFrame()).not.toContain("turn 1/2");
  r.unmount();
});
