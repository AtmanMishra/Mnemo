// A language server for tests: a line containing BAD is an error, WARN a warning. TWOPHASE publishes
// nothing first and the error 100ms later, as servers that check syntax before types do.
// Writes `started` and `closed` markers next to itself when it starts and when told to exit.
const fs = require("node:fs");
const path = require("node:path");
const here = path.dirname(process.argv[1]);
fs.writeFileSync(path.join(here, "started"), String(process.pid));
let buf = Buffer.alloc(0);
const send = (m) => {
  const body = JSON.stringify({ jsonrpc: "2.0", ...m });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};
function diagnostics(text) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    if (line.includes("BAD")) out.push({ range: { start: { line: i, character: line.indexOf("BAD") }, end: { line: i, character: line.indexOf("BAD") + 3 } }, severity: 1, code: "E1", source: "fake", message: "bad thing\nsecond line" });
    if (line.includes("WARN")) out.push({ range: { start: { line: i, character: 0 }, end: { line: i, character: 4 } }, severity: 2, message: "careful" });
    if (line.includes("HINT")) out.push({ range: { start: { line: i, character: 0 }, end: { line: i, character: 4 } }, severity: 4, message: "just a hint" });
  });
  return out;
}
function publish(doc) {
  const list = diagnostics(doc.text);
  if (doc.text.includes("TWOPHASE")) {
    send({ method: "textDocument/publishDiagnostics", params: { uri: doc.uri, version: doc.version, diagnostics: [] } });
    setTimeout(() => send({ method: "textDocument/publishDiagnostics", params: { uri: doc.uri, version: doc.version, diagnostics: list } }), 100);
  } else send({ method: "textDocument/publishDiagnostics", params: { uri: doc.uri, version: doc.version, diagnostics: list } });
}
function handle(m) {
  if (m.method === "initialize") {
    send({ id: m.id, result: { capabilities: { textDocumentSync: 1 } } });
    // Servers ask the client things while it starts; one that is not answered would wait forever.
    send({ id: 900, method: "workspace/configuration", params: { items: [{ section: "x" }] } });
  } else if (m.method === "textDocument/didOpen") publish(m.params.textDocument);
  else if (m.method === "textDocument/didChange") publish({ uri: m.params.textDocument.uri, version: m.params.textDocument.version, text: m.params.contentChanges[0].text });
  else if (m.method === "shutdown") send({ id: m.id, result: null });
  else if (m.method === "exit") {
    fs.writeFileSync(path.join(here, "closed"), "yes");
    process.exit(0);
  } else if (m.id === 900) fs.writeFileSync(path.join(here, "configured"), JSON.stringify(m.result));
}
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const end = buf.indexOf("\r\n\r\n");
    if (end < 0) return;
    const len = Number(/content-length: (\d+)/i.exec(buf.subarray(0, end).toString())[1]);
    if (buf.length < end + 4 + len) return;
    const m = JSON.parse(buf.subarray(end + 4, end + 4 + len).toString());
    buf = buf.subarray(end + 4 + len);
    handle(m);
  }
});
