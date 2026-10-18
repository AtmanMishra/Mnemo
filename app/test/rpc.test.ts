/**
 * The JSON-lines protocol, through a real pi session with a scripted model: a client
 * sees the same approval the terminal would show and nothing runs until it answers.
 */
import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { demoScript, DEMO_PROMPT } from "../src/runtime/demo.ts";
import { RpcServer } from "../src/runtime/rpc.ts";
import { mnemoEnv } from "./helpers.ts";
import { waitFor } from "./wait-for.ts";

const until = (pred: () => boolean) => waitFor(() => expect(pred()).toBe(true));

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup() {
  const env = await mnemoEnv({ mode: "default" });
  cleanups.push(() => env.runtime.dispose());
  const events: Record<string, any>[] = [];
  let quit = false;
  const server = new RpcServer({ controller: env.controller, version: "test", write: (e) => events.push(e), onQuit: () => (quit = true), flushMs: 0 });
  server.start();
  cleanups.push(() => server.stop());
  const send = (m: object) => server.handle(JSON.stringify(m));
  const last = (type: string) => events.findLast((e) => e.type === type);
  return { ...env, events, send, last, server, quit: () => quit };
}

test("starts with ready, settings definitions and the commands", async () => {
  const { events, last } = await setup();
  expect(events[0]).toMatchObject({ type: "ready", protocol: 1, version: "test" });
  expect(events[0]!.commands.some((c: { name: string }) => c.name === "memory")).toBe(true);
  const settings = last("settings")!;
  expect(settings.defs.items.some((d: { key: string }) => d.key === "theme")).toBe(true);
  expect(settings.values.mode).toBe("default");
});

test("an edit asks, and runs only after the client says yes", async () => {
  const { send, events, faux, cwd } = await setup();
  faux.setResponses(demoScript());
  await send({ type: "submit", text: DEMO_PROMPT });
  await until(() => events.some((e) => e.type === "dialog"));
  const d = events.find((e) => e.type === "dialog")!.dialog;
  expect(d.kind).toBe("approval");
  expect(d.tool).toMatch(/edit/i);
  const file = path.join(cwd, "src", "fetch.ts");
  expect(fs.readFileSync(file, "utf8")).not.toContain("attempt === 3");
  await send({ type: "answer", id: d.id, answer: { kind: "yes" } });
  await until(() => fs.readFileSync(file, "utf8").includes("attempt === 3"));
  expect(events.some((e) => e.type === "dialogClosed" && e.id === d.id)).toBe(true);
});

test("no leaves the file alone, and a stale or wrong id answers nothing", async () => {
  const { send, events, faux, cwd } = await setup();
  faux.setResponses(demoScript());
  await send({ type: "submit", text: DEMO_PROMPT });
  await until(() => events.some((e) => e.type === "dialog"));
  const d = events.find((e) => e.type === "dialog")!.dialog;
  await send({ type: "answer", id: d.id + 99, answer: { kind: "yes" } });
  expect(fs.readFileSync(path.join(cwd, "src", "fetch.ts"), "utf8")).not.toContain("attempt === 3");
  await send({ type: "answer", id: d.id, answer: { kind: "no", feedback: "not now" } });
  await until(() => events.some((e) => e.type === "dialogClosed" && e.id === d.id));
  expect(fs.readFileSync(path.join(cwd, "src", "fetch.ts"), "utf8")).not.toContain("attempt === 3");
});

test("a client cannot grant 'always' when the gate offered none", async () => {
  const { send, events, faux, cwd } = await setup();
  faux.setResponses(demoScript());
  await send({ type: "submit", text: DEMO_PROMPT });
  await until(() => events.some((e) => e.type === "dialog"));
  const d = events.find((e) => e.type === "dialog")!.dialog;
  if (d.always) return; // this request offered it; nothing to assert
  await send({ type: "answer", id: d.id, answer: { kind: "always" } });
  await until(() => events.some((e) => e.type === "dialogClosed" && e.id === d.id));
  expect(fs.readFileSync(path.join(cwd, "src", "fetch.ts"), "utf8")).not.toContain("attempt === 3");
});

test("settings: a valid value is saved and reported, an invalid one is refused with the reason", async () => {
  const { send, last, events } = await setup();
  await send({ type: "setSetting", id: 1, key: "toastMax", value: 5 });
  expect(events.find((e) => e.type === "result" && e.id === 1)).toMatchObject({ ok: true });
  await until(() => last("settings")!.values.toastMax === 5);
  await send({ type: "setSetting", id: 2, key: "toastMax", value: 99 });
  expect(events.find((e) => e.type === "result" && e.id === 2)).toMatchObject({ ok: false });
  await send({ type: "setSetting", id: 3, key: "nope", value: 1 });
  expect(events.find((e) => e.type === "result" && e.id === 3)).toMatchObject({ ok: false, error: "unknown setting" });
  await send({ type: "setSetting", id: 4, key: "mode", value: "yolo" });
  expect(events.find((e) => e.type === "result" && e.id === 4)).toMatchObject({ ok: false });
});

test("a refusal with no request id still reaches the client as an error", async () => {
  const { send, events } = await setup();
  await send({ type: "setSetting", key: "toastMax", value: 99 });
  expect(events.some((e) => e.type === "error" && /between 1 and 6/.test(e.message))).toBe(true);
});

test("mode changes are explicit and reported in the footer", async () => {
  const { send, last, events } = await setup();
  await send({ type: "setMode", id: 1, mode: "plan" });
  await until(() => last("chrome")!.footer.mode === "plan");
  await send({ type: "setMode", id: 2, mode: "everything" });
  expect(events.find((e) => e.type === "result" && e.id === 2)).toMatchObject({ ok: false });
});

test("a slash command that asks becomes a dialog the client answers", async () => {
  const { send, events, last } = await setup();
  await send({ type: "submit", text: "/mode" });
  await until(() => events.some((e) => e.type === "dialog"));
  const d = events.find((e) => e.type === "dialog")!.dialog;
  expect(d.kind).toBe("select");
  await send({ type: "answer", id: d.id, value: "plan" });
  await until(() => last("chrome")!.footer.mode === "plan");
});

test("bad input is an error event, never a crash; memory reports itself off without a sidecar", async () => {
  const { send, events, quit, server } = await setup();
  await server.handle("{not json");
  await send({ type: "submit", id: 5 });
  expect(events.find((e) => e.type === "result" && e.id === 5)).toMatchObject({ ok: false });
  expect(events.some((e) => e.type === "error")).toBe(true);
  await send({ type: "memory", id: 7 });
  expect(events.find((e) => e.type === "result" && e.id === 7)).toMatchObject({ ok: true, value: { available: false } });
  await send({ type: "quit" });
  expect(quit()).toBe(true);
});

test("a plain question streams and commits", async () => {
  const { send, events, last, faux } = await setup();
  faux.setResponses([fauxAssistantMessage(fauxText("hello there"))]);
  await send({ type: "submit", text: "hi" });
  await until(() => last("transcript")!.committed.length + last("transcript")!.live.length > 0 && !last("transcript")!.working);
  const blocks = events.filter((e) => e.type === "transcript").flatMap((e) => e.committed);
  expect(blocks.some((b: { kind: string; text?: string }) => b.kind === "assistant" && b.text === "hello there")).toBe(true);
});
