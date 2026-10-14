/** Memory over MCP, the way a client drives it: initialize, list, call. */
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { findMemsrv, MemoryService, serveMcp } from "../src/index.ts";

const MEMSRV = findMemsrv("/nonexistent");
const t = MEMSRV ? test : test.skip;

t("a client initializes, lists the tools, remembers a fact and recalls it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-mcp-"));
  const memory = new MemoryService(MEMSRV!, path.join(root, "journal.jsonl"));
  const input = new PassThrough();
  const output = new PassThrough();
  let buffered = "";
  output.on("data", (d) => (buffered += d));
  const done = serveMcp({ memory, userSkillsDir: path.join(root, "skills"), cwd: root, source: { agent: "codex" } }, input, output);
  const send = (msg: object) => input.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  send({ method: "notifications/initialized" });
  send({ id: 2, method: "tools/list" });
  send({ id: 3, method: "tools/call", params: { name: "memory_remember", arguments: { scope: "project", key: "test command", value: "pnpm vitest" } } });
  send({ id: 4, method: "tools/call", params: { name: "memory_recall", arguments: { task: "run the tests" } } });
  send({ id: 5, method: "tools/call", params: { name: "memory_remember", arguments: { scope: "project", key: "last session", value: "x" } } });
  send({ id: 6, method: "no/such" });
  input.end();
  await done;
  const replies = buffered.trim().split("\n").map((l) => JSON.parse(l));
  const by = (id: number) => replies.find((r) => r.id === id);
  expect(replies.some((r) => r.id === undefined)).toBe(false); // no answer to a notification
  expect(by(1).result.protocolVersion).toBe("2025-03-26");
  expect(by(2).result.tools.map((x: { name: string }) => x.name)).toEqual(["memory_recall", "memory_search", "memory_remember"]);
  expect(by(3).result.content[0].text).toBe("Remembered test command.");
  expect(by(4).result.content[0].text).toContain("- test command: pnpm vitest");
  expect(by(5).result.isError).toBe(true);
  expect(by(6).error.code).toBe(-32601);
  memory.stop();
}, 30_000);

t("a call's cwd must be an existing folder, inside the server's --cwd when it has one", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-mcp-cwd-"));
  const project = path.join(root, "project");
  fs.mkdirSync(path.join(project, "sub"), { recursive: true });
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-mcp-other-"));
  const memory = new MemoryService(MEMSRV!, path.join(root, "journal.jsonl"));
  const input = new PassThrough();
  const output = new PassThrough();
  let buffered = "";
  output.on("data", (d) => (buffered += d));
  const done = serveMcp({ memory, userSkillsDir: path.join(root, "skills"), cwd: project, root: project }, input, output);
  const call = (id: number, cwd: string) =>
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "memory_search", arguments: { query: "anything at all", cwd } } })}\n`);
  call(1, path.join(project, "sub"));
  call(2, elsewhere);
  call(3, path.join(root, "no-such-dir"));
  call(4, path.join(project, "sub", "..", "..", path.basename(elsewhere)));
  input.end();
  await done;
  const by = (id: number) => buffered.trim().split("\n").map((l) => JSON.parse(l)).find((r) => r.id === id);
  expect(by(1).result.isError).toBeUndefined();
  expect(by(2).result.isError).toBe(true);
  expect(by(3).result.isError).toBe(true);
  expect(by(4).result.isError).toBe(true);
  memory.stop();
}, 30_000);
