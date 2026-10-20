/**
 * The limits the settings give: turns for a prompt, turns and dollars for a sub-agent (which
 * returns what it has), and auto-compaction following the settings, on real pi sessions.
 */
import { test, expect, afterEach } from "bun:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { SettingsStore } from "../src/runtime/settings.ts";
import { Roster } from "../src/runtime/roster.ts";
import { mnemoEnv, texts } from "./helpers.ts";

const envs: Awaited<ReturnType<typeof mnemoEnv>>[] = [];
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
const looking = (n: number) => Array.from({ length: n }, () => call("read", { path: "package.json" }));

test("maxTurns stops a prompt after that many model calls and says so", async () => {
  const settings = new SettingsStore();
  settings.set("maxTurns", 3);
  const e = await env({ mode: "yolo", settings });
  e.faux.setResponses([...looking(10), say("done")]);
  await e.controller.submit("look around");
  await e.idle();
  expect(e.faux.state.callCount).toBe(3);
  expect(texts(e.controller).join("\n")).toContain("Stopped after 3 turns in one prompt (/settings maxTurns)");
  // The next prompt gets a fresh count.
  e.faux.setResponses([say("again")]);
  await e.controller.submit("and now?");
  await e.idle();
  expect(e.faux.state.callCount).toBe(4);
});

test("with the default (no limit) a long prompt runs to its end", async () => {
  const e = await env({ mode: "yolo" });
  e.faux.setResponses([...looking(8), say("done")]);
  await e.controller.submit("look around");
  await e.idle();
  expect(e.faux.state.callCount).toBe(9);
});

test("a sub-agent past subMaxTurns is stopped and returns what it has, with the reason", async () => {
  const settings = new SettingsStore();
  settings.set("subMaxTurns", 2);
  const roster = new Roster();
  const e = await env({ mode: "yolo", settings, roster });
  e.faux.setResponses([
    call("spawn_subagent", { task: "read everything", name: "reader" }),
    ...looking(6), // the sub-agent keeps reading
    say("the sub-agent was cut off"), // the parent, once the sub-agent returns
  ]);
  await e.controller.submit("delegate");
  await e.idle();
  const sub = roster.snapshot().nodes.find((n) => n.kind === "sub")!;
  expect(sub.answer).toContain("stopped at its limit of 2 turns (/settings subMaxTurns)");
  expect(sub.stepCount).toBe(2);
});

test("a sub-agent past subSpend is stopped the same way", async () => {
  const settings = new SettingsStore();
  settings.set("subSpend", 0.01);
  const roster = new Roster();
  const e = await env({ mode: "yolo", settings, roster });
  // The scripted provider prices nothing, so the sub-agent's first call is made to cost $0.02.
  const priced = () => {
    roster.spend(roster.snapshot().nodes.find((n) => n.kind === "sub")!.id, 0.02);
    return call("read", { path: "package.json" });
  };
  e.faux.setResponses([call("spawn_subagent", { task: "read", name: "reader" }), priced, call("read", { path: "package.json" }), say("cut off")]);
  await e.controller.submit("delegate");
  await e.idle();
  const sub = roster.snapshot().nodes.find((n) => n.kind === "sub")!;
  expect(sub.answer).toContain("stopped at its limit of $0.01 (/settings subSpend)");
});

test("auto-compaction follows the settings at once, also for a conversation already open", async () => {
  const settings = new SettingsStore();
  settings.set("autoCompact", false);
  settings.set("compactReserve", 5000);
  settings.set("compactKeep", 3000);
  const e = await env({ settings });
  expect(e.runtime.session.settingsManager.getCompactionSettings()).toEqual({ enabled: false, reserveTokens: 5000, keepRecentTokens: 3000 });
  const d = await env();
  expect(d.runtime.session.settingsManager.getCompactionSettings()).toEqual({ enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 });
});
