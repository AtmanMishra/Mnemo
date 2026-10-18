import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { LineSplitter, MnemoClient } from "../src/client.ts";
import type { RpcEvent } from "../src/protocol.ts";

const fake = path.join(import.meta.dir, "fixtures", "fake-mnemo.js");
const clients: MnemoClient[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.stop();
});

function start(command = process.execPath, args = [fake]) {
  const events: RpcEvent[] = [];
  const problems: string[] = [];
  let exit: Promise<number | null>;
  let done!: (c: number | null) => void;
  exit = new Promise((r) => (done = r));
  const client = new MnemoClient({ command, args, cwd: process.cwd(), onEvent: (e) => events.push(e), onProblem: (m) => problems.push(m), onExit: done });
  clients.push(client);
  client.start();
  return { client, events, problems, exit };
}

const until = async (pred: () => boolean) => {
  for (let i = 0; i < 300 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(pred()).toBe(true);
};

describe("LineSplitter", () => {
  test("holds a partial line, drops blanks and CRs", () => {
    const s = new LineSplitter();
    expect(s.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(s.push(':2}\r\n\n')).toEqual(['{"b":2}']);
  });

  test("a line past the cap is dropped, not buffered forever", () => {
    const s = new LineSplitter(10);
    expect(s.push("x".repeat(50))).toEqual([]);
    expect(s.push("ok\n")).toEqual(["ok"]);
  });
});

describe("MnemoClient", () => {
  test("reads events, reports non-JSON output, answers requests by id", async () => {
    const { client, events, problems } = start();
    await until(() => events.some((e) => e.type === "ready"));
    await until(() => problems.length > 0);
    expect(problems[0]).toContain("unexpected output");
    const r = await client.request({ type: "setMode", mode: "plan" });
    expect(r.ok).toBe(true);
    expect((r.value as { mode: string }).mode).toBe("plan");
  });

  test("a command that cannot start is a problem, not a throw", async () => {
    const { problems, client } = start("mnemo-does-not-exist-anywhere", []);
    await until(() => problems.length > 0);
    expect(problems[0]).toContain("Could not start");
    expect(await client.request({ type: "x" })).toMatchObject({ ok: false });
  });

  test("an exit fails the requests still waiting and reports the code", async () => {
    const { client, exit, problems } = start();
    const waiting = client.request({ type: "crash" });
    expect(await waiting).toMatchObject({ ok: false });
    expect(await exit).toBe(3);
    expect(problems.some((p) => p.includes("code 3"))).toBe(true);
    expect(client.running).toBe(false);
  });

  test("stop quits it", async () => {
    const { client, exit, events } = start();
    await until(() => events.length > 0);
    client.stop();
    expect(await exit).toBe(0);
  });
});
