import { test, beforeEach } from "node:test";
import assert from "node:assert";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import {
  approve,
  approvalGate,
  approvalConfig,
  resetApprovalState,
  isAlwaysAllowed,
} from "../src/approval.ts";
import { bashExecTool, writeFileTool, applyEditTool } from "../src/tools/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const childFixture = path.join(here, "fixtures", "approval_child.ts");

interface Scripted {
  input: PassThrough;
  output: PassThrough;
  written: () => string;
}

function scripted(answer: string): Scripted {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  // Feed each scripted line ONLY after its prompt appeared in the output.
  // Pre-writing answers loses all but the first line (readline drops
  // unmatched 'line' events), which starved later prompts -> suite hang.
  const queue = answer.split("\n").filter((l) => l.length > 0);
  output.on("data", (d: Buffer) => {
    text += d.toString("utf8");
    if (text.includes("[y]es") && queue.length > 0 && !input.writableEnded) {
      const line = queue.shift();
      if (line !== undefined) input.write(`${line}\n`);
    }
  });
  approvalConfig.input = input;
  approvalConfig.output = output;
  approvalConfig.forceTty = true; // simulate a TTY without a real terminal
  return { input, output, written: () => text };
}

function autoMode(): void {
  approvalConfig.input = new PassThrough(); // no isTTY -> non-TTY
  approvalConfig.output = new PassThrough();
  approvalConfig.forceTty = false;
}

function setInteractiveMode(): () => void {
  const prev = process.env.SEA_APPROVAL_MODE;
  process.env.SEA_APPROVAL_MODE = "interactive";
  return () => {
    if (prev === undefined) delete process.env.SEA_APPROVAL_MODE;
    else process.env.SEA_APPROVAL_MODE = prev;
  };
}

beforeEach(() => {
  resetApprovalState();
});

test("auto-approves when SEA_APPROVAL_MODE is not interactive", async () => {
  assert.equal(await approve({ tool: "bash_exec", summary: "$ echo hi" }), true);
  assert.equal(await approvalGate("bash_exec", "$ echo hi"), null);
});

test("auto-approves when mode=0 even with TTY forced", async () => {
  const restore = setInteractiveMode();
  try {
    process.env.SEA_APPROVAL_MODE = "0";
    autoMode();
    approvalConfig.forceTty = true;
    assert.equal(await approve({ tool: "bash_exec", summary: "$ echo hi" }), true);
  } finally {
    restore();
  }
});

test("auto-approves in interactive mode when stdin is not a TTY", async () => {
  const restore = setInteractiveMode();
  try {
    autoMode();
    assert.equal(await approve({ tool: "bash_exec", summary: "$ echo hi" }), true);
  } finally {
    restore();
  }
});

for (const yes of ["y", "yes"]) {
  test(`'${yes}' approves`, async () => {
    const restore = setInteractiveMode();
    try {
      scripted(yes);
      assert.equal(await approve({ tool: "t", summary: "s" }), true);
    } finally {
      restore();
    }
  });
}

test("'n' denies and gate returns denial message for the model", async () => {
  const restore = setInteractiveMode();
  try {
    // two prompts happen: one for approve(), one for the gate's own call
    // (denials are NOT cached -- each action asks fresh by design)
    const io = scripted("n\nn");
    assert.equal(await approve({ tool: "t", summary: "s" }), false);
    const denial = await approvalGate("bash_exec", "$ rm -rf build");
    assert.match(denial!, /user denied bash_exec/);
    assert.match(io.written(), /\[approval\] t: s/);
    assert.match(io.written(), /\[y\]es \/ \[n\]o \/ \[a\]lways-this-tool/);
  } finally {
    restore();
  }
});

test("unrecognized input re-prompts, then 'y' approves", async () => {
  const restore = setInteractiveMode();
  try {
    scripted("wat\ny");
    assert.equal(await approve({ tool: "t", summary: "s" }), true);
  } finally {
    restore();
  }
});

test("'a' adds tool to session allowlist for the rest of the session", async () => {
  const restore = setInteractiveMode();
  try {
    const io = scripted("a");
    assert.equal(await approve({ tool: "write_file", summary: "s1" }), true);
    assert.ok(isAlwaysAllowed("write_file"));
    // Second call must not prompt at all: no pending input, would hang if asked.
    approvalConfig.input = new PassThrough();
    approvalConfig.output = new PassThrough();
    assert.equal(await approve({ tool: "write_file", summary: "s2" }), true);
    assert.ok(!io.written().includes("s2"));
    assert.ok(!isAlwaysAllowed("bash_exec")); // allowlist is per-tool
  } finally {
    restore();
  }
});

test("wiring: bash_exec denied by user returns error result to model", async () => {
  const restore = setInteractiveMode();
  try {
    scripted("n");
    const res = await bashExecTool.execute("t1", { command: "echo should-not-run" });
    assert.match(res.content[0].text, /user denied bash_exec/);
    // The command must NOT have executed.
    assert.doesNotMatch(res.content[0].text, /should-not-run\n/);
  } finally {
    restore();
  }
});

test("wiring: write_file 'a' allowlists then later writes proceed unprompted", async () => {
  const restore = setInteractiveMode();
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sea-appr-"));
    const file = path.join(dir, "out.txt");
    try {
      scripted("a");
      const res1 = await writeFileTool.execute("t2", { path: file, content: "one\ntwo\nthree" });
      assert.match(res1.content[0].text, /Wrote/);
      approvalConfig.input = new PassThrough();
      approvalConfig.output = new PassThrough();
      const res2 = await writeFileTool.execute("t3", { path: file, content: "second write" });
      assert.match(res2.content[0].text, /Wrote/);
      assert.equal(fs.readFileSync(file, "utf8"), "second write");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    restore();
  }
});

test("wiring: apply_edit denied returns denial result", async () => {
  const restore = setInteractiveMode();
  try {
    scripted("n");
    const res = await applyEditTool.execute("t4", {
      path: "/tmp/whatever.txt",
      old_str: "aaa",
      new_str: "bbb",
    });
    assert.match(res.content[0].text, /user denied apply_edit/);
  } finally {
    restore();
  }
});

function runChild(env: Record<string, string>): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childFixture, "bash_exec", "$ echo hi"], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"], // deliberately NOT a TTY
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve({ stdout }) : reject(new Error(`child exit ${code}: ${stderr}`)),
    );
  });
}

test("child process with piped stdio auto-approves in interactive mode (documented limitation)", async () => {
  const res = await runChild({ SEA_APPROVAL_MODE: "interactive" });
  assert.deepEqual(JSON.parse(res.stdout), { approved: true }); // fail-open, no TTY
});

test("child process with SEA_APPROVAL_MODE=0 auto-approves", async () => {
  const res = await runChild({ SEA_APPROVAL_MODE: "0" });
  assert.deepEqual(JSON.parse(res.stdout), { approved: true });
});
