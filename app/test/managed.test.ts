/**
 * Managed policy: what an administrator sets holds over the user's own settings and a
 * project's. Each test is one way a lower layer could have widened it.
 */
import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { allowedMode, enforceModels, loadManaged, managedPath } from "../src/policy/managed.ts";
import { loadMcpServers } from "../src/extensions/mcp.ts";
import { mnemoEnv, nextDialog } from "./helpers.ts";

const tmp = (prefix: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const envs: Awaited<ReturnType<typeof mnemoEnv>>[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
});

function policy(value: unknown): string {
  const file = path.join(tmp("mnemo-managed-"), "managed.json");
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
}

test("the managed file is in a place only an administrator writes, whatever the environment says", () => {
  expect(managedPath("linux", { MNEMO_HOME: "/tmp/x" })).toBe("/etc/mnemo/managed.json");
  expect(managedPath("darwin", {})).toBe("/Library/Application Support/Mnemo/managed.json");
  expect(managedPath("win32", { ProgramData: "D:\\PD" })).toBe("D:\\PD\\Mnemo\\managed.json");
});

test("no file is no policy; a file that cannot be understood stops every change", () => {
  expect(loadManaged(path.join(tmp("mnemo-managed-"), "none.json"))).toBeUndefined();
  for (const bad of ["{", "null", "[]", { rules: null }, { rules: [{ tool: 1 }] }, { modes: [] }, { modes: ["god"] }, { models: "x" }]) {
    const m = loadManaged(policy(bad))!;
    expect(m.error, JSON.stringify(bad)).toBeDefined();
    expect(m.rules.some((r) => r.tool === "bash" && r.action === "deny")).toBe(true);
  }
});

test("a mode the policy leaves out falls to the strictest allowed one no looser than it", () => {
  const m = loadManaged(policy({ modes: ["default", "plan", "accept-edits"] }));
  expect(allowedMode("yolo", m)).toBe("accept-edits");
  expect(allowedMode("default", m)).toBe("default");
  expect(allowedMode("accept-edits", loadManaged(policy({ modes: ["plan", "default"] })))).toBe("default");
  expect(allowedMode("default", loadManaged(policy({ modes: ["yolo"] })))).toBe("yolo");
  expect(allowedMode("yolo", undefined)).toBe("yolo");
});

test("a managed deny beats the user's allow, and a managed ask beats yolo and an always grant", async () => {
  const e = await mnemoEnv({ mode: "yolo" });
  envs.push(e);
  fs.writeFileSync(path.join(e.home, "permissions.json"), JSON.stringify({ rules: [{ tool: "bash", pattern: "touch *", action: "allow" }] }));
  e.host.managedFile = policy({ rules: [{ tool: "bash", pattern: "touch *", action: "deny" }] });
  const marker = path.join(e.cwd, "DENIED");
  e.faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: `touch ${marker}` })], { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("done"))]);
  await e.controller.submit("go");
  await e.idle();
  expect(fs.existsSync(marker)).toBe(false);

  e.host.managedFile = policy({ rules: [{ tool: "write", action: "ask" }] });
  e.faux.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: "x.txt", content: "x" })], { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("done"))]);
  const run = e.controller.submit("write it");
  const dialog = await nextDialog(e.controller);
  if (dialog.kind !== "approval") throw new Error(`expected approval, got ${dialog.kind}`);
  dialog.resolve({ kind: "always" });
  await run;
  await e.idle();
  // "Always" for an edit is accept-edits, and a managed ask still asks under it.
  e.faux.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: "z.txt", content: "z" })], { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("done"))]);
  const again = e.controller.submit("write it again");
  const second = await nextDialog(e.controller);
  if (second.kind !== "approval") throw new Error(`expected approval, got ${second.kind}`);
  second.resolve({ kind: "no" });
  await again;
  await e.idle();
  expect(fs.existsSync(path.join(e.cwd, "z.txt"))).toBe(false);
});

test("a mode ruled out is not the mode the gate applies, and switching to it says so", async () => {
  const e = await mnemoEnv();
  envs.push(e);
  e.host.managedFile = policy({ modes: ["default", "plan"] });
  e.controller.setMode("yolo");
  expect(e.host.mode).toBe("default");
  // A mode set around the controller (a sub-agent, a test) still meets the ceiling at the gate.
  e.host.mode = "yolo";
  e.faux.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: "y.txt", content: "y" })], { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("done"))]);
  const run = e.controller.submit("write it");
  const dialog = await nextDialog(e.controller);
  if (dialog.kind !== "approval") throw new Error(`expected approval, got ${dialog.kind}`);
  dialog.resolve({ kind: "no" });
  await run;
  await e.idle();
  expect(fs.existsSync(path.join(e.cwd, "y.txt"))).toBe(false);
});

test("MCP servers the policy does not list are not started, from any mcp.json", () => {
  const agentDir = tmp("mnemo-agent-");
  const cwd = tmp("mnemo-proj-");
  fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { github: { command: "gh-mcp" }, shady: { command: "x" } } }));
  fs.mkdirSync(path.join(cwd, ".agents"));
  fs.writeFileSync(path.join(cwd, ".agents", "mcp.json"), JSON.stringify({ mcpServers: { repo_one: { command: "y" } } }));
  const loaded = loadMcpServers(agentDir, cwd, true, policy({ mcpServers: ["github"] }));
  expect(loaded.servers.map((s) => s.name)).toEqual(["github"]);
  expect(loaded.errors.join("\n")).toContain("shady");
  expect(loadMcpServers(agentDir, cwd, true, policy("{")).servers).toEqual([]);
  expect(loadMcpServers(agentDir, cwd, true, path.join(cwd, "none.json")).servers).toHaveLength(3);
});

test("a model the policy does not list is refused before any request is sent", async () => {
  const e = await mnemoEnv();
  envs.push(e);
  enforceModels(e.host.modelRuntime, loadManaged(policy({ models: ["anthropic/*"] })));
  e.faux.setResponses([fauxAssistantMessage(fauxText("should never be sent"))]);
  await e.controller.submit("hello");
  await e.idle();
  const shown = JSON.stringify(e.controller.transcript.snapshot());
  expect(shown).toContain("not allowed by the managed policy");
  expect(shown).not.toContain("should never be sent");
});
