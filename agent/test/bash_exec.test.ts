import { test } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import { bashExecTool, runBash } from "../src/tools/index.ts";
import { textOf } from "../src/tools/types.ts";

test("bash_exec captures stdout and exit code", async () => {
  const res = await bashExecTool.execute("t1", { command: "echo hello" });
  assert.match(textOf(res), /hello/);
  assert.equal((res.details as any).exitCode, 0);
});

test("bash_exec captures stderr without throwing", async () => {
  const res = await bashExecTool.execute("t2", { command: "echo oops >&2; exit 3" });
  assert.match(textOf(res), /oops/);
  assert.equal((res.details as any).exitCode, 3);
  assert.match(textOf(res), /exit code: 3/);
});

test("bash_exec times out and throws", async () => {
  await assert.rejects(
    () => bashExecTool.execute("t3", { command: "sleep 5", timeout_ms: 300 }),
    /timed out/,
  );
});

test("runBash honors cwd", async () => {
  const res = await runBash("pwd", { cwd: "/tmp" });
  // macOS reports the physical path (/tmp is a symlink to /private/tmp).
  assert.equal(res.stdout.trim(), fs.realpathSync("/tmp"));
});
