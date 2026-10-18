/**
 * A stand-in MCP server over stdio (line-delimited JSON-RPC), run with `bun`: one tool, `shout`,
 * which answers with its text in capitals.
 */
import * as readline from "node:readline";

const send = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const req = JSON.parse(line) as { id?: number; method: string; params?: { name?: string; arguments?: { text?: string }; protocolVersion?: string } };
  if (req.id === undefined) return;
  if (req.method === "initialize")
    return send({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: req.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "shouter", version: "1.0.0" } } });
  if (req.method === "tools/list")
    return send({
      jsonrpc: "2.0",
      id: req.id,
      result: { tools: [{ name: "shout", description: "Say the text in capitals", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] },
    });
  if (req.method === "tools/call") return send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: String(req.params?.arguments?.text ?? "").toUpperCase() }] } });
  send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `no ${req.method}` } });
});
