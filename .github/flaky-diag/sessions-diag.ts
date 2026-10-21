// Temporary: times each step of packages/memory/test/sessions.test.ts on this machine.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { SessionIndex } from "../../packages/memory/src/index.ts";

const base = process.argv[2] || os.tmpdir();
const runs = Number(process.argv[3] ?? 40);
const max: Record<string, number> = {};
const slow: string[] = [];
function time<T>(label: string, f: () => T): T {
  const t = performance.now();
  const v = f();
  const d = performance.now() - t;
  max[label] = Math.max(max[label] ?? 0, d);
  if (d > 250) slow.push(`${label} ${d.toFixed(0)}ms`);
  return v;
}
const piSession = (id: string, cwd: string, msgs: [string, unknown][]) =>
  [{ type: "session", id, cwd, timestamp: "t" }, ...msgs.map(([role, content], i) => ({ type: "message", id: `m${i}`, parentId: null, timestamp: "t", message: { role, content } }))]
    .map((r) => JSON.stringify(r))
    .join("\n") + "\n";
let total = 0;
for (let i = 0; i < runs; i++) {
  const t0 = performance.now();
  const root = time("mkdtemp", () => fs.mkdtempSync(path.join(base, "sessions-")));
  const shop = path.join(root, "work", "shop");
  const pi = path.join(root, "pi");
  time("write fixtures", () => {
    fs.mkdirSync(path.join(pi, "x"), { recursive: true });
    fs.writeFileSync(path.join(pi, "x", "a.jsonl"), piSession("pi-1", shop, [["user", "the login page throws a 500 after the session cookie expires"]]));
    fs.writeFileSync(path.join(pi, "x", "b.jsonl"), piSession("pi-2", shop, [["user", "login page redesign"]]));
  });
  const index = time("open", () => new SessionIndex(path.join(root, "sessions.db"), [{ agent: "mnemo", dir: pi }]));
  time("search 1 (indexes)", () => index.search("expired cookie login", { under: shop }));
  time("search 2", () => index.search("login page"));
  time("refresh unchanged", () => index.refresh());
  fs.appendFileSync(path.join(pi, "x", "b.jsonl"), JSON.stringify({ type: "message", id: "z", parentId: null, timestamp: "t", message: { role: "user", content: "rate limiter" } }) + "\n");
  fs.rmSync(path.join(pi, "x", "a.jsonl"));
  time("refresh changed", () => index.refresh());
  time("close", () => index.close());
  // The same writes without WAL: is it the -wal/-shm files?
  const db = time("plain open", () => new Database(path.join(root, "plain.db")));
  time("plain writes", () => {
    db.run("CREATE TABLE t (x TEXT)");
    for (let k = 0; k < 4; k++) db.run("INSERT INTO t VALUES (?)", [String(k)]);
  });
  db.close();
  total = Math.max(total, performance.now() - t0);
}
console.log(`base ${base}: worst run ${total.toFixed(0)}ms`);
console.log("worst per step:", Object.entries(max).map(([k, v]) => `${k} ${v.toFixed(0)}ms`).join(", "));
console.log(slow.length ? `slow steps:\n  ${slow.join("\n  ")}` : "no step over 250ms");
