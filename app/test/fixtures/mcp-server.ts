/**
 * A stand-in MCP server over stdio (line-delimited JSON-RPC), run with `bun`: one tool, `shout`,
 * which answers with its text in capitals. Started with `env`, it also has `getenv`, which answers
 * with the server's own environment variable of that name (or `<unset>`).
 */
import * as readline from "node:readline";

const send = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const tools = [{ name: "shout", description: "Say the text in capitals", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }];
if (process.argv.includes("env")) tools.push({ name: "getenv", description: "Read an environment variable", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } });

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const req = JSON.parse(line) as { id?: number; method: string; params?: { name?: string; arguments?: { text?: string }; protocolVersion?: string } };
  if (req.id === undefined) return;
  if (req.method === "initialize")
    return send({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: req.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "shouter", version: "1.0.0" } } });
  if (req.method === "tools/list")
    return send({ jsonrpc: "2.0", id: req.id, result: { tools } });
  if (req.method === "tools/call" && req.params?.name === "getenv")
    return send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: process.env[String(req.params.arguments?.text)] ?? "<unset>" }] } });
  if (req.method === "tools/call") return send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: String(req.params?.arguments?.text ?? "").toUpperCase() }] } });
  send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `no ${req.method}` } });
});
