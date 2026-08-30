/**
 * 4.1: MCP bridge. The server in these tests is a real child process speaking
 * real JSON-RPC 2.0 over stdio — only the server's behaviour is a fake, not
 * the protocol.
 */
import { test, after } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  EMPTY_CONFIG, McpClient, discoverMcpTools, flattenContent, loadMcpConfig,
  mcpConfigFile, mcpToolName, toSeaTool, getMcpTools, setMcpTools,
} from "../src/mcp.ts";
import { textOf } from "../src/tools/types.ts";

const clients: McpClient[] = [];
after(() => { for (const c of clients) c.stop(); setMcpTools([]); });

/** A minimal MCP server: initialize, tools/list, tools/call. */
const SERVER = `
import sys, json
tools = [{"name": "echo", "description": "echo back",
          "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}}},
         {"name": "boom", "description": "always fails", "inputSchema": {"type": "object"}}]
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    mid, method = msg.get("id"), msg.get("method")
    if mid is None:
        continue  # a notification; nothing to answer
    if method == "initialize":
        r = {"protocolVersion": "2024-11-05", "serverInfo": {"name": "fake"}}
    elif method == "tools/list":
        r = {"tools": tools}
    elif method == "tools/call":
        name = msg["params"]["name"]
        args = msg["params"].get("arguments", {})
        if name == "boom":
            r = {"content": [{"type": "text", "text": "it broke"}], "isError": True}
        else:
            r = {"content": [{"type": "text", "text": "echo: " + args.get("text", "")}]}
    else:
        print(json.dumps({"jsonrpc": "2.0", "id": mid,
                          "error": {"code": -32601, "message": "no method " + str(method)}}), flush=True)
        continue
    print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": r}), flush=True)
`;

function fakeServer(extra: string[] = []): McpClient {
  const c = new McpClient("fake", { command: "python3", args: ["-c", SERVER, ...extra] }, 10_000);
  clients.push(c);
  return c;
}

function tmpHome(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mnemo-mcp-${name}-`));
}

test("config is read, normalised, and never fatal when broken", () => {
  const home = tmpHome("config");
  assert.deepEqual(loadMcpConfig(home), EMPTY_CONFIG, "missing file -> no servers");

  fs.mkdirSync(path.join(home, ".mnemo"), { recursive: true });
  fs.writeFileSync(mcpConfigFile(home), "{{{ not json");
  assert.deepEqual(loadMcpConfig(home), EMPTY_CONFIG, "corrupt file -> no servers");

  fs.writeFileSync(mcpConfigFile(home), JSON.stringify({
    servers: {
      good: { command: "uvx", args: ["graft-mcp"] },
      nocommand: { args: ["x"] },
      off: { command: "x", disabled: true },
    },
  }));
  const cfg = loadMcpConfig(home);
  assert.deepEqual(Object.keys(cfg.servers).sort(), ["good", "off"], "entries without a command are dropped");
  assert.deepEqual(cfg.servers.good!.args, ["graft-mcp"]);
  assert.equal(cfg.servers.off!.disabled, true);
  fs.rmSync(home, { recursive: true, force: true });
});

test("tool names are namespaced by server", () => {
  assert.equal(mcpToolName("graft", "find_code"), "mcp__graft__find_code");
  // two servers exposing the same tool name must not collide
  assert.notEqual(mcpToolName("a", "search"), mcpToolName("b", "search"));
});

test("content blocks flatten to readable text", () => {
  assert.equal(flattenContent([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "ab");
  assert.equal(flattenContent([{ type: "resource", resource: { text: "body" } }]), "body");
  assert.equal(flattenContent([{ type: "resource", resource: { uri: "file://x" } }]), "file://x");
  assert.equal(flattenContent([{ type: "image", data: "..." }]), "[image content]",
    "unknown block types are named, not silently dropped");
  assert.equal(flattenContent(undefined), "");
});

test("handshake and tools/list against a real server process", async () => {
  const c = fakeServer();
  const info = await c.initialize();
  assert.equal(info.protocolVersion, "2024-11-05");
  const tools = await c.listTools();
  assert.deepEqual(tools.map((t: any) => t.name), ["echo", "boom"]);
});

test("an MCP tool becomes a Mnemo tool that actually calls the server", async () => {
  const c = fakeServer();
  await c.initialize();
  const [echo] = await c.listTools();
  const tool = toSeaTool(c, echo);

  assert.equal(tool.name, "mcp__fake__echo");
  assert.match(tool.label, /fake: echo/);
  assert.equal(tool.description, "echo back");
  assert.deepEqual((tool.parameters as any).properties.text, { type: "string" },
    "the server's own JSON Schema is passed through");

  const res = await tool.execute("call-1", { text: "hi" });
  assert.equal(textOf(res), "echo: hi");
});

test("a server-side tool error becomes a thrown error, not a silent empty result", async () => {
  const c = fakeServer();
  await c.initialize();
  const tools = await c.listTools();
  const boom = toSeaTool(c, tools[1]);
  await assert.rejects(() => boom.execute("call-2", {}), /it broke/);
});

test("an unknown method surfaces the server's JSON-RPC error", async () => {
  const c = fakeServer();
  await c.initialize();
  await assert.rejects(() => c.request("resources/list"), /no method resources\/list/);
});

test("discovery collects tools and keeps one broken server from stopping startup", async () => {
  const config = {
    servers: {
      good: { command: "python3", args: ["-c", SERVER] },
      broken: { command: "definitely-not-a-real-binary-xyz", args: [] },
      off: { command: "python3", args: ["-c", SERVER], disabled: true },
    },
  };
  const made: McpClient[] = [];
  const res = await discoverMcpTools(config, (name, cfg) => {
    const c = new McpClient(name, cfg, 4000);
    made.push(c);
    clients.push(c);
    return c;
  });

  assert.deepEqual(res.tools.map((t) => t.name).sort(),
    ["mcp__good__boom", "mcp__good__echo"]);
  assert.equal(res.errors.length, 1, "the broken server is reported");
  assert.equal(res.errors[0]!.server, "broken");
  assert.equal(res.clients.length, 1, "only reachable servers stay connected");
  assert.equal(made.length, 2, "a disabled server is never even spawned");
  for (const c of res.clients) c.stop();
});

test("discovery with no servers configured does nothing at all", async () => {
  const res = await discoverMcpTools(EMPTY_CONFIG);
  assert.deepEqual(res, { tools: [], clients: [], errors: [] });
});

test("discovered tools are handed to the extension through the registry", () => {
  assert.deepEqual(getMcpTools(), [], "empty until discovery runs");
  const fake = { name: "mcp__x__y" } as any;
  setMcpTools([fake]);
  assert.deepEqual(getMcpTools(), [fake]);
  setMcpTools([]);
});
