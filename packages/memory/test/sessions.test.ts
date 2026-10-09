/** Session search: past exchanges found by their words, within one project, kept current, redacted. */
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionIndex } from "../src/index.ts";

const piSession = (id: string, cwd: string, msgs: [string, unknown][]) =>
  [
    { type: "session", id, cwd, timestamp: "t" },
    ...msgs.map(([role, content], i) => ({ type: "message", id: `m${i}`, parentId: null, timestamp: "t", message: { role, content } })),
  ]
    .map((r) => JSON.stringify(r))
    .join("\n") + "\n";

test("finds the exchange by its words, in this project only, and follows the files as they change", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-"));
  // Real native paths: a session records the folder it ran in, and shop is not
  // the same folder as "D:\\work\\shop" once a platform resolves it.
  const shop = path.join(root, "work", "shop");
  const other = path.join(root, "work", "other");
  const pi = path.join(root, "pi");
  const cc = path.join(root, "cc", "-repo");
  fs.mkdirSync(path.join(pi, "x"), { recursive: true });
  fs.mkdirSync(cc, { recursive: true });
  fs.writeFileSync(
    path.join(pi, "x", "a.jsonl"),
    piSession("pi-1", shop, [
      ["user", "the login page throws a 500 after the session cookie expires"],
      ["assistant", [{ type: "text", text: "Fixed it: refreshSession now catches the expired cookie." }, { type: "toolCall", name: "bash", arguments: { command: "pnpm vitest auth" } }]],
    ]),
  );
  fs.writeFileSync(path.join(pi, "x", "b.jsonl"), piSession("pi-2", other, [["user", "login page redesign for the other app"]]));
  fs.writeFileSync(
    path.join(cc, "c.jsonl"),
    [
      { type: "user", sessionId: "cc-1", cwd: shop, origin: { kind: "human" }, message: { role: "user", content: "deploy the shop with key sk-ant-abcdefghijklmnopqrstuvwx" } },
      { type: "assistant", sessionId: "cc-1", cwd: shop, message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "fly deploy --app shop" } }], stop_reason: "tool_use" } },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n",
  );
  const index = new SessionIndex(path.join(root, "sessions.db"), [
    { agent: "mnemo", dir: pi },
    { agent: "claude-code", dir: path.join(root, "cc") },
  ]);

  const login = index.search("expired cookie login", { under: shop });
  expect(login[0]).toMatchObject({ agent: "mnemo", session: "pi-1" });
  expect(login.some((h) => h.session === "pi-2")).toBe(false);
  expect(index.search("pnpm vitest", { under: shop })[0]!.text).toContain("$ bash: pnpm vitest auth");
  const deploy = index.search("how did we deploy the shop", { under: shop });
  expect(deploy.map((h) => h.session)).toContain("cc-1");
  expect(deploy.map((h) => h.text).join(" ")).toContain("fly deploy --app shop");
  expect(deploy.map((h) => h.text).join(" ")).not.toContain("sk-ant-abcdefghijklmnop");
  // Everywhere, when not scoped.
  expect(index.search("login page").map((h) => h.session).sort()).toEqual(["pi-1", "pi-2"]);

  // Unchanged files are not read again; a changed one is; a deleted one is dropped.
  expect(index.refresh()).toBe(0);
  fs.appendFileSync(path.join(pi, "x", "b.jsonl"), JSON.stringify({ type: "message", id: "z", parentId: null, timestamp: "t", message: { role: "user", content: "rate limiter for checkout" } }) + "\n");
  fs.rmSync(path.join(pi, "x", "a.jsonl"));
  expect(index.refresh()).toBe(1);
  expect(index.search("rate limiter").map((h) => h.session)).toEqual(["pi-2"]);
  expect(index.search("expired cookie")).toEqual([]);
  index.close();
});

test("a folder name's _ and % are letters, not wildcards: a sibling project's sessions stay out", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-like-"));
  const pi = path.join(root, "pi");
  const mine = path.join(root, "proj_1");
  const sibling = path.join(root, "projx1", "sub");
  fs.mkdirSync(pi, { recursive: true });
  fs.writeFileSync(path.join(pi, "a.jsonl"), piSession("mine", mine, [["user", "rotate the staging credentials"]]));
  fs.writeFileSync(path.join(pi, "b.jsonl"), piSession("sibling", sibling, [["user", "rotate the staging credentials too"]]));
  const index = new SessionIndex(path.join(root, "sessions.db"), [{ agent: "mnemo", dir: pi }]);
  expect(index.search("rotate staging credentials", { under: mine }).map((h) => h.session)).toEqual(["mine"]);
  index.close();
});
