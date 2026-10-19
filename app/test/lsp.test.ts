/**
 * After an edit the model is told what the user's language server says about the file, in the
 * same result. The server here is a script that flags BAD and WARN (fixtures/fake-lsp.js), run by
 * the test runtime: no shell script, no real server needed.
 */
import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { LspClient } from "../src/lsp/client.ts";
import { describe as describeDiagnostics, loadLsp, serverFor } from "../src/extensions/lsp.ts";
import { createDemoProject } from "../src/runtime/demo.ts";
import { mnemoEnv } from "./helpers.ts";

const envs: Awaited<ReturnType<typeof mnemoEnv>>[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
});

const tmp = (prefix: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

/** A copy of the fake server in its own folder, so its markers do not mix with another test's. */
function fake(): { dir: string; script: string } {
  const dir = tmp("mnemo-lsp-");
  const script = path.join(dir, "server.js");
  fs.copyFileSync(path.join(import.meta.dir, "fixtures", "fake-lsp.js"), script);
  return { dir, script };
}

/** The servers are read when the session starts, so the home is written before the env is built. */
function home(servers: Record<string, unknown>): string {
  const dir = tmp("mnemo-lsp-home-");
  fs.writeFileSync(path.join(dir, "lsp.json"), JSON.stringify({ servers }));
  return dir;
}
const fakeServer = (script: string) => ({ fake: { command: [process.execPath, script], files: { "*.txt": "plaintext" } } });

const call = (name: string, input: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall(name, input)], { stopReason: "toolUse" });
const results = (e: Awaited<ReturnType<typeof mnemoEnv>>) => e.runtime.session.messages.filter((m) => (m as { role?: string }).role === "toolResult").map((m) => JSON.stringify(m));

async function run(e: Awaited<ReturnType<typeof mnemoEnv>>, responses: ReturnType<typeof call>[]) {
  e.faux.setResponses([...responses, fauxAssistantMessage(fauxText("done"))]);
  await e.controller.submit("go");
  await e.idle();
}

test("an edit's result carries what the server reports, the next edit is checked on the same server, and a fixed file reports nothing", async () => {
  const s = fake();
  const e = await mnemoEnv({ mode: "yolo", home: home(fakeServer(s.script)) });
  envs.push(e);
  await run(e, [call("write", { path: "a.txt", content: "fine\nthis is BAD here\nWARN me\nHINT only\n" })]);
  const first = results(e).join("\n");
  expect(first).toContain("Language server (fake) reports on a.txt after this change");
  // Errors before warnings, 1-based positions, the first line of a message, no hints.
  expect(first).toContain("a.txt:2:9 error fake E1: bad thing");
  expect(first).toContain("a.txt:3:1 warning: careful");
  expect(first).not.toContain("second line");
  expect(first).not.toContain("just a hint");
  expect(first.indexOf("error fake")).toBeLessThan(first.indexOf("warning"));
  const pid = fs.readFileSync(path.join(s.dir, "started"), "utf8");
  // The server asked for configuration while starting and was answered.
  expect(JSON.parse(fs.readFileSync(path.join(s.dir, "configured"), "utf8"))).toEqual([null]);

  await run(e, [call("edit", { path: "a.txt", edits: [{ oldText: "this is BAD here", newText: "this is fine here" }, { oldText: "WARN me", newText: "all good" }] })]);
  const second = results(e).at(-1)!;
  expect(second).not.toContain("Language server");
  expect(fs.readFileSync(path.join(s.dir, "started"), "utf8")).toBe(pid);
});

test("a server that checks syntax first and types later is waited for", async () => {
  const s = fake();
  const e = await mnemoEnv({ mode: "yolo", home: home(fakeServer(s.script)) });
  envs.push(e);
  await run(e, [call("write", { path: "b.txt", content: "TWOPHASE BAD\n" })]);
  expect(results(e).join("\n")).toContain("b.txt:1:10 error");
});

test("the server is stopped when the session ends", async () => {
  const s = fake();
  const e = await mnemoEnv({ mode: "yolo", home: home(fakeServer(s.script)) });
  await run(e, [call("write", { path: "c.txt", content: "BAD\n" })]);
  expect(fs.existsSync(path.join(s.dir, "closed"))).toBe(false);
  await e.close();
  expect(fs.readFileSync(path.join(s.dir, "closed"), "utf8")).toBe("yes");
});

test("nothing starts without a configured server, for a file no server claims, or in a folder that is not trusted", async () => {
  const s = fake();
  const plain = await mnemoEnv({ mode: "yolo" });
  envs.push(plain);
  await run(plain, [call("write", { path: "a.txt", content: "BAD\n" })]);
  expect(results(plain).join("\n")).not.toContain("Language server");

  const other = await mnemoEnv({ mode: "yolo", home: home(fakeServer(s.script)) });
  envs.push(other);
  await run(other, [call("write", { path: "a.md", content: "BAD\n" })]);
  expect(results(other).join("\n")).not.toContain("Language server");

  // A folder that carries extensions nobody trusted: its code does not run, and neither does a server in it.
  const cwd = createDemoProject();
  fs.mkdirSync(path.join(cwd, CONFIG_DIR_NAME, "extensions"), { recursive: true });
  fs.writeFileSync(path.join(cwd, CONFIG_DIR_NAME, "extensions", "x.ts"), "export default function () {}");
  const untrusted = await mnemoEnv({ mode: "yolo", cwd, home: home(fakeServer(s.script)) });
  envs.push(untrusted);
  await run(untrusted, [call("write", { path: "a.txt", content: "BAD\n" })]);
  expect(results(untrusted).join("\n")).not.toContain("Language server");
  expect(fs.existsSync(path.join(s.dir, "started"))).toBe(false);
});

test("a server that is not installed is said once and the edit goes on unchanged", async () => {
  const e = await mnemoEnv({ mode: "yolo", home: home({ gone: { command: ["mnemo-no-such-language-server", "--stdio"], files: { "*.txt": "plaintext" } } }) });
  envs.push(e);
  await run(e, [call("write", { path: "a.txt", content: "BAD\n" }), call("write", { path: "b.txt", content: "BAD\n" })]);
  expect(fs.readFileSync(path.join(e.cwd, "b.txt"), "utf8")).toBe("BAD\n");
  expect(results(e).join("\n")).not.toContain("Language server");
  const said = JSON.stringify(e.controller.transcript.snapshot()).match(/mnemo-no-such-language-server is not on PATH/g) ?? [];
  expect(said).toHaveLength(1);
});

test("the client gives up on a server that dies and reports nothing it did not hear", async () => {
  const dir = tmp("mnemo-lsp-");
  const script = path.join(dir, "dies.js");
  fs.writeFileSync(script, "process.stdin.once('data', () => process.exit(3));");
  await expect(LspClient.start({ command: [process.execPath, script], cwd: dir, env: process.env, startMs: 5000 })).rejects.toThrow(/exited with 3/);

  const s = fake();
  const client = await LspClient.start({ command: [process.execPath, s.script], cwd: s.dir, env: process.env });
  expect(await client.diagnose(path.join(s.dir, "a.txt"), "BAD", "plaintext", 3000)).toHaveLength(1);
  await client.close();
  expect(await client.diagnose(path.join(s.dir, "a.txt"), "BAD", "plaintext", 3000)).toBeUndefined();
});

test("the config is read from the home only and a malformed server is reported, not run", () => {
  const home = tmp("mnemo-lsp-home-");
  expect(loadLsp(home)).toEqual({ servers: [], errors: [] });
  fs.writeFileSync(path.join(home, "lsp.json"), JSON.stringify({ servers: { ok: { command: ["x", "--stdio"], files: { "*.ts": "typescript" }, timeout: 5 }, noFiles: { command: ["x"] }, shell: { command: "x --stdio", files: { "*.ts": "typescript" } }, slow: { command: ["x"], files: { "*": "a" }, timeout: -1 } } }));
  const { servers, errors } = loadLsp(home);
  expect(servers.map((s) => s.name)).toEqual(["ok"]);
  expect(servers[0]!.timeout).toBe(5);
  expect(errors).toHaveLength(3);
  expect(serverFor(servers, "/p/src/a.ts")?.languageId).toBe("typescript");
  expect(serverFor(servers, "/p/src/a.py")).toBeUndefined();
  fs.writeFileSync(path.join(home, "lsp.json"), "{");
  expect(loadLsp(home).errors[0]).toContain("lsp.json");
});

test("only errors and warnings are shown, the worst first, and a long list is cut", () => {
  const errors = (n: number) => Array.from({ length: n }, (_, i) => ({ line: i + 1, column: 1, severity: 1, message: `e${i}` }));
  const mixed = describeDiagnostics("a.ts", "ts", [{ line: 1, column: 1, severity: 2, message: "w" }, { line: 2, column: 1, severity: 3, message: "i" }, ...errors(3)])!;
  expect(mixed.indexOf("e2")).toBeLessThan(mixed.indexOf("warning"));
  expect(mixed).not.toContain("info");
  const text = describeDiagnostics("a.ts", "ts", errors(20))!;
  expect(text.split("\n")).toHaveLength(1 + 15 + 1);
  expect(text).toContain("…and 5 more");
  expect(describeDiagnostics("a.ts", "ts", [{ line: 1, column: 1, severity: 4, message: "hint" }])).toBeUndefined();
});
