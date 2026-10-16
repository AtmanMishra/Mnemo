/**
 * The agents page, the split and the playground on real sessions that share a roster:
 * sub-agents and sibling links in the tree, layouts capped at four panes, and a
 * playground that can look and navigate but change nothing.
 */
import { test, expect, afterEach } from "bun:test";
import React from "react";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cleanup, render } from "ink-testing-library";
import { Fleet } from "../src/runtime/fleet.ts";
import { Roster } from "../src/runtime/roster.ts";
import { workspaceSource } from "../src/runtime/workspace-source.ts";
import { Shell } from "../src/ui/Shell.tsx";
import { mnemoEnv } from "./helpers.ts";
import { waitFor } from "./wait-for.ts";

const envs: Awaited<ReturnType<typeof mnemoEnv>>[] = [];
afterEach(async () => {
  cleanup();
  for (const e of envs.splice(0)) await e.close().catch(() => {});
});
const KEY = { ctrlG: "\x07", ctrlS: "\x13", ctrlY: "\x19", alt: (k: string) => `\x1b${k}`, enter: "\r", right: "\x1b[C", down: "\x1b[B", up: "\x1b[A" };

function project(name: string): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-agents-ui-")), name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  return dir;
}

async function fleetOf(names: string[]) {
  const roster = new Roster();
  const spawn = async (cwd: string, exit: (code?: number) => void) => {
    const e = await mnemoEnv({ cwd, roster });
    envs.push(e);
    (e.controller as unknown as { options: { exit: (c?: number) => void } }).options.exit = exit;
    return { controller: e.controller, host: e.host, source: workspaceSource(e.controller, e.host, e.home) };
  };
  const fleet = new Fleet(spawn, { onEmpty: () => {} });
  for (const n of names) await fleet.open(project(n));
  return { fleet, roster };
}

function size(r: ReturnType<typeof render>, columns: number, rows: number) {
  Object.defineProperty(r.stdout, "columns", { get: () => columns, configurable: true });
  Object.defineProperty(r.stdout, "rows", { get: () => rows, configurable: true });
  r.stdout.emit("resize");
}
const tick = (ms = 60) => new Promise((res) => setTimeout(res, ms));
/** Panes on screen: an agent pane has a prompt, a sub-agent pane its header. */
const paneCount = (frame: string) => (frame.match(/❯/g) ?? []).length + (frame.match(/sub-agent · depth/g) ?? []).length;
const nodeOf = (fleet: Fleet, i: number) => fleet.snapshot().agents[i]!.host.node;
const transcriptSize = (fleet: Fleet) => fleet.snapshot().agents.map((a) => a.controller.transcript.snapshot().committed.length);

test("the agents page shows each agent's sub-agents under it, and what is linked", async () => {
  const { fleet, roster } = await fleetOf(["alpha", "beta"]);
  const alpha = nodeOf(fleet, 0);
  const mapper = roster.addSub(alpha, { label: "mapper", task: "map the modules", access: "read-only" });
  roster.addSub(mapper.id, { label: "reader", task: "read fetch.ts", access: "read-only" });
  fleet.link(fleet.snapshot().agents[0]!.id, fleet.snapshot().agents[1]!.id);
  const r = render(React.createElement(Shell, { fleet, motion: false, initial: { screen: "hub" } }));
  size(r, 140, 45);
  await waitFor(() => {
    const f = r.lastFrame()!;
    expect(f).toContain("⇄ beta"); // the card says alpha is linked with beta
    expect(f).toContain("⑂ 2 sub-agents"); // and has two sub-agents, running
    expect(f).toContain("FAMILY OF ALPHA");
    expect(f).toContain("└─ ● mapper"); // the tree under it …
    expect(f).toContain("   └─ ● reader"); // … two levels deep
  });
  r.unmount();
});

test("l then l links two agents as siblings from the agents page, and u takes one out", async () => {
  const { fleet, roster } = await fleetOf(["alpha", "beta"]);
  const [a, b] = fleet.snapshot().agents;
  expect(roster.canReach(a!.host.node, b!.host.node)).toBe(false);
  const r = render(React.createElement(Shell, { fleet, motion: false, initial: { screen: "hub" } }));
  size(r, 140, 45);
  await waitFor(() => expect(r.lastFrame()).toContain("new · ready"));
  r.stdin.write("l");
  await waitFor(() => expect(r.lastFrame()).toContain("choose the agent to link with"));
  await tick();
  r.stdin.write(KEY.right);
  await tick();
  r.stdin.write("l");
  await waitFor(() => expect(roster.canReach(a!.host.node, b!.host.node)).toBe(true));
  expect(roster.canReach(b!.host.node, a!.host.node)).toBe(true);
  await waitFor(() => expect(r.lastFrame()).toContain("⇄ alpha"));
  r.stdin.write("u"); // beta is selected
  await waitFor(() => expect(roster.canReach(a!.host.node, b!.host.node)).toBe(false));
  r.unmount();
});

test("closing an agent drops its links and its tree from the roster", async () => {
  const { fleet, roster } = await fleetOf(["alpha", "beta"]);
  const [a, b] = fleet.snapshot().agents;
  fleet.link(a!.id, b!.id);
  const sub = roster.addSub(b!.host.node, { label: "child", task: "x", access: "read-only" });
  await fleet.close(b!.id);
  await waitFor(() => expect(fleet.snapshot().agents).toHaveLength(1));
  expect(roster.get(b!.host.node)).toBeUndefined();
  expect(roster.get(sub.id)).toMatchObject({ status: "stopped" });
  expect(roster.canReach(a!.host.node, b!.host.node)).toBe(false);
});

test("the playground shows the forest and the feed, and nothing typed in it changes anything", async () => {
  const { fleet, roster } = await fleetOf(["alpha", "beta"]);
  const [a, b] = fleet.snapshot().agents;
  fleet.link(a!.id, b!.id);
  const scout = roster.addSub(a!.host.node, { label: "scout", task: "look around", access: "read-only" });
  roster.send(scout.id, b!.host.node, "beta: the API moved");
  const r = render(React.createElement(Shell, { fleet, motion: false }));
  size(r, 140, 40);
  await waitFor(() => expect(r.lastFrame()).toContain("Ask anything"));
  r.stdin.write(KEY.ctrlY);
  await waitFor(() => {
    const f = r.lastFrame()!;
    expect(f).toContain("PLAYGROUND");
    expect(f).toContain("supervise only");
    expect(f).toContain("scout");
    expect(f).toContain("✉ scout → beta: beta: the API moved");
    expect(f).toContain("⑂ alpha started scout");
  });

  const before = { version: roster.snapshot().version, transcripts: transcriptSize(fleet), mode: a!.host.mode, nodes: JSON.stringify(roster.snapshot().nodes) };
  // Everything a person might try: text, every command key of the agents page, ctrl+c, quit.
  for (const k of ["hello", "x", "n", "s", "l", "u", "f", "m", "/quit\r", KEY.down, KEY.down, KEY.up, "\x1b", "q"]) r.stdin.write(k);
  r.stdin.write("m"); // messages only is a view toggle
  await new Promise((res) => setTimeout(res, 150));
  expect(r.lastFrame()).toContain("PLAYGROUND");
  expect(roster.snapshot().version).toBe(before.version); // no event, no change of any node
  expect(JSON.stringify(roster.snapshot().nodes)).toBe(before.nodes);
  expect(transcriptSize(fleet)).toEqual(before.transcripts); // nothing reached an agent
  expect(a!.host.mode).toBe(before.mode);
  expect(fleet.snapshot().agents).toHaveLength(2); // nobody was closed
  expect(r.lastFrame()).not.toContain("hello"); // there is no prompt to type into
  r.unmount();
});

test("enter in the playground takes you to the agent that owns the selected node; ctrl+y leaves", async () => {
  const { fleet, roster } = await fleetOf(["alpha", "beta"]);
  const [, b] = fleet.snapshot().agents;
  roster.addSub(b!.host.node, { label: "betas-helper", task: "help", access: "read-only" });
  b!.controller.transcript.notice("this is beta's transcript");
  const r = render(React.createElement(Shell, { fleet, motion: false, initial: { screen: "playground" } }));
  size(r, 140, 40);
  await waitFor(() => expect(r.lastFrame()).toContain("betas-helper"));
  r.stdin.write(KEY.down); // beta
  await tick();
  r.stdin.write(KEY.down); // its helper
  await tick();
  r.stdin.write(KEY.enter);
  await waitFor(() => expect(r.lastFrame()).toContain("this is beta's transcript"));
  expect(r.lastFrame()).not.toContain("PLAYGROUND");
  r.stdin.write(KEY.ctrlY);
  await waitFor(() => expect(r.lastFrame()).toContain("PLAYGROUND"));
  r.stdin.write(KEY.ctrlY);
  await waitFor(() => expect(r.lastFrame()).not.toContain("PLAYGROUND"));
  r.unmount();
});

test("a split shows at most four agents, says how many are related, and alt+l changes the layout", async () => {
  const { fleet } = await fleetOf(["a1", "b2", "c3", "d4", "e5"]);
  const r = render(React.createElement(Shell, { fleet, motion: false }));
  size(r, 160, 50);
  await waitFor(() => expect(r.lastFrame()).toContain("Ask anything"));
  r.stdin.write(KEY.ctrlS);
  await waitFor(() => expect(r.lastFrame()).toContain("◫ grid"));
  expect(paneCount(r.lastFrame()!)).toBe(4); // five agents, four panes
  r.stdin.write(KEY.alt("l"));
  await waitFor(() => expect(r.lastFrame()).toContain("◫ columns"));
  r.stdin.write(KEY.alt("l"));
  await waitFor(() => expect(r.lastFrame()).toContain("◫ rows"));
  r.stdin.write(KEY.alt("l"));
  await waitFor(() => expect(r.lastFrame()).toContain("◫ main + side"));
  expect(paneCount(r.lastFrame()!)).toBe(4);
  r.unmount();
});

test("f splits an agent with its family: linked agents and its busiest sub-agents, four in all, the rest counted", async () => {
  const { fleet, roster } = await fleetOf(["alpha", "beta"]);
  const [a, b] = fleet.snapshot().agents;
  fleet.link(a!.id, b!.id);
  for (const name of ["s1", "s2", "s3", "s4"]) roster.addSub(a!.host.node, { label: name, task: `task of ${name}`, access: "read-only" });
  const r = render(React.createElement(Shell, { fleet, motion: false, initial: { screen: "hub" } }));
  size(r, 160, 50);
  await waitFor(() => expect(r.lastFrame()).toContain("new · ready"));
  r.stdin.write("f"); // alpha is selected
  await waitFor(() => expect(r.lastFrame()).toContain("4 of 6")); // alpha, beta and four sub-agents are related; four fit
  const f = r.lastFrame()!;
  expect(paneCount(f)).toBe(4);
  expect(f).toContain("sub-agent · depth 1"); // a sub-agent is a read-only pane
  expect(f).toContain("beta");
  r.unmount();
});

test("f on an agent with nothing around it says so and splits nothing", async () => {
  const { fleet } = await fleetOf(["alpha", "beta"]);
  const r = render(React.createElement(Shell, { fleet, motion: false, initial: { screen: "hub" } }));
  size(r, 140, 40);
  await waitFor(() => expect(r.lastFrame()).toContain("new · ready"));
  r.stdin.write("f");
  await waitFor(() => expect(r.lastFrame()).toContain("no linked or sub-agents"));
  r.unmount();
});
