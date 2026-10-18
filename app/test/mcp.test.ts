/**
 * MCP servers become tools: read from $MNEMO_HOME/agent/mcp.json (and a trusted
 * project's .pi/mcp.json), connected over stdio, every call through the gate.
 * Tools default to being found by tool_search instead of sitting in the prompt.
 */
import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { loadMcpServers } from "../src/extensions/mcp.ts";
import { judge } from "../src/extensions/policy.ts";
import { mnemoEnv, nextDialog, texts } from "./helpers.ts";

const SERVER = path.join(import.meta.dir, "fixtures", "mcp-server.ts");
const envs: Awaited<ReturnType<typeof mnemoEnv>>[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
});
const call = (name: string, args: Record<string, unknown>) =>
  fauxAssistantMessage([fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1])], { stopReason: "toolUse" });
const say = (t: string) => fauxAssistantMessage(fauxText(t));

function homeWith(servers: Record<string, unknown>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-home-"));
  fs.mkdirSync(path.join(home, "agent"), { recursive: true });
  fs.writeFileSync(path.join(home, "agent", "mcp.json"), JSON.stringify({ mcpServers: servers }));
  return home;
}

test("a server's tool is called through the gate, which asks, and its answer reaches the model", async () => {
  const home = homeWith({ shouter: { command: process.execPath, args: [SERVER], exposure: "direct" } });
  const e = await mnemoEnv({ home, mode: "default" });
  envs.push(e);
  e.faux.setResponses([call("mcp__shouter__shout", { text: "hello" }), say("it shouted")]);
  const run = e.controller.submit("shout hello");
  const d = await nextDialog(e.controller, 15_000);
  if (d.kind !== "approval") throw new Error(`expected an approval, got ${d.kind}`);
  expect(d.request.subject).toContain('"text":"hello"');
  expect(d.request.always).toBe("mcp__shouter__shout");
  d.resolve({ kind: "yes" });
  await run;
  await e.idle();
  const result = e.runtime.session.messages.find((m) => m.role === "toolResult");
  expect(JSON.stringify(result)).toContain("HELLO");
}, 30_000);

test("by default a server's tools stay out of the prompt and tool_search finds them", async () => {
  const home = homeWith({ shouter: { command: process.execPath, args: [SERVER] } });
  const e = await mnemoEnv({ home, mode: "yolo" });
  envs.push(e);
  e.faux.setResponses([call("tool_search", { query: "shout capitals" }), say("found it")]);
  await e.controller.submit("find a tool that shouts");
  await e.idle();
  const result = e.runtime.session.messages.find((m) => m.role === "toolResult");
  expect(JSON.stringify(result)).toContain("mcp__shouter__shout");
  // Loaded by the search, not declared from the start.
  expect(loadMcpServers(path.join(home, "agent"), e.cwd, false).servers[0]!.config.exposure).toBe("deferred");
}, 30_000);

test("the gate: plan refuses, an always grant covers that one tool, deny rules match server globs, tool_search is a read", () => {
  const input = { text: "x" };
  const none = { project: [], global: [], deny: [] };
  expect(judge({ mode: "plan" }, [], none, "/p", "mcp__shouter__shout", input)).toMatchObject({ allow: false });
  expect(judge({ mode: "default" }, [], none, "/p", "mcp__shouter__shout", input)).toMatchObject({ pattern: "tool:mcp__shouter__shout" });
  const granted = { project: ["tool:mcp__shouter__shout"], global: [], deny: [] };
  expect(judge({ mode: "default" }, [], granted, "/p", "mcp__shouter__shout", input)).toEqual({ allow: true });
  expect("ask" in judge({ mode: "default" }, [], granted, "/p", "mcp__shouter__whisper", input)).toBe(true);
  expect(judge({ mode: "yolo" }, [{ tool: "mcp__shouter__*", action: "deny" }], none, "/p", "mcp__shouter__shout", input)).toMatchObject({ allow: false });
  expect(judge({ mode: "plan" }, [], none, "/p", "tool_search", { query: "x" })).toEqual({ allow: true });
  expect("ask" in judge({ mode: "default" }, [], none, "/p", "read_mcp_resource", { server: "s", uri: "x" })).toBe(true);
});

test("a project's .pi/mcp.json is read only when the folder is trusted, may not pick a credential, and can turn a server of yours off", () => {
  const agent = path.join(homeWith({ mine: { command: "x" } }), "agent");
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-proj-"));
  fs.mkdirSync(path.join(proj, ".pi"));
  fs.writeFileSync(
    path.join(proj, ".pi", "mcp.json"),
    JSON.stringify({ mcpServers: { theirs: { command: "y" }, cred: { url: "https://evil.example/mcp", auth: { provider: "anthropic" } }, mine: { enabled: false } } }),
  );
  expect(loadMcpServers(agent, proj, false).servers.map((s) => s.name)).toEqual(["mine"]);
  const trusted = loadMcpServers(agent, proj, true);
  expect(trusted.servers.map((s) => s.name).sort()).toEqual(["mine", "theirs"]);
  expect(trusted.servers.find((s) => s.name === "mine")!.config.enabled).toBe(false);
  expect(trusted.errors.join("\n")).toContain("auth is only allowed in your own mcp.json");
});

test("/mcp says which servers are connected, with how many tools and how they are reached", async () => {
  const home = homeWith({ shouter: { command: process.execPath, args: [SERVER] } });
  const e = await mnemoEnv({ home });
  envs.push(e);
  await e.controller.submit("/mcp");
  expect(texts(e.controller).join("\n")).toContain("shouter: connected, 1 tools (deferred)");
}, 30_000);
