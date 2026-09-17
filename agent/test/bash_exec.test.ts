import { test } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bashExecTool, runBash } from "../src/tools/index.ts";
import { textOf } from "../src/tools/types.ts";
import {
  IS_WINDOWS,
  bashCommandParamHint,
  bashToolDescription,
  readPiShellPath,
  resolveShell,
  shellLabel,
} from "../src/tools/shell.ts";

/**
 * The tool runs commands through the platform's shell: POSIX `/bin/sh` on
 * POSIX, cmd.exe on Windows (D7). Test commands are therefore written for the
 * shell they will actually reach — `>&2; exit 3` is POSIX, and cmd.exe reads
 * the `;` as a literal argument, so the command "succeeds" with exit code 0,
 * nothing is redirected, and the test fails for a reason that has nothing to
 * do with bash_exec.
 */
function forShell(posix: string, cmd: string): string {
  return resolveShell().label.startsWith("cmd.exe") ? cmd : posix;
}

test("bash_exec captures stdout and exit code", async () => {
  const res = await bashExecTool.execute("t1", { command: "echo hello" });
  assert.match(textOf(res), /hello/);
  assert.equal((res.details as any).exitCode, 0);
});

test("bash_exec captures stderr without throwing", async () => {
  const res = await bashExecTool.execute("t2", {
    command: forShell("echo oops >&2; exit 3", "echo oops 1>&2 & exit /b 3"),
  });
  assert.match(textOf(res), /oops/);
  assert.equal((res.details as any).exitCode, 3);
  assert.match(textOf(res), /exit code: 3/);
});

test("bash_exec times out and throws", async () => {
  // a command that blocks for ~5s in the shell that will run it: `sleep` is
  // POSIX (and only accidentally on PATH in a Windows run started from a POSIX
  // shell), ping is the portable Windows one
  await assert.rejects(
    () => bashExecTool.execute("t3", {
      command: forShell("sleep 5", "ping -n 6 127.0.0.1"),
      timeout_ms: 300,
    }),
    /timed out/,
  );
});

test("runBash honors cwd", async () => {
  // A directory the test owns: `/tmp` is POSIX-only, and on Windows it resolves
  // to C:\tmp, which normally does not exist (and is machine state either way).
  // `pwd` is POSIX-only too, so the child prints its cwd through node, which is
  // on PATH wherever the suite can run at all.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sea-cwd-"));
  try {
    const res = await runBash(`node -p "process.cwd()"`, { cwd: dir });
    assert.equal(res.exitCode, 0, res.stderr);
    // realpath on both sides: macOS reports /private/tmp for /tmp, and a
    // Windows temp path can come back in its 8.3 short form
    assert.equal(fs.realpathSync(res.stdout.trim()), fs.realpathSync(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- 22 (D7): the description tells the truth about the shell ------------

test("the tool description names the shell commands actually run under", () => {
  const d = bashExecTool.description;
  if (IS_WINDOWS) {
    assert.match(d, /cmd\.exe/, "Windows runs commands through cmd.exe");
    assert.match(d, /Git Bash/, "and says how to get a POSIX shell instead");
    assert.doesNotMatch(d, /run via \/bin\/sh/, "must not promise POSIX sh on Windows");
  } else {
    assert.match(d, /\/bin\/sh/);
  }
  // the `command` parameter and the description agree
  const paramDesc = (bashExecTool.parameters as any).properties.command.description as string;
  assert.match(paramDesc, /^Shell command to execute \(run via /);
});

test("the description documents the PI_* session variables (D6)", () => {
  const d = bashToolDescription();
  for (const name of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) {
    assert.ok(d.includes(name), `${name} must be documented for the model`);
  }
  assert.match(d, /AI_AGENT/);
  assert.match(d, /PI_CODING_AGENT/);
});

test("resolveShell defaults to the platform shell and reports it", () => {
  const r = resolveShell({} as NodeJS.ProcessEnv);
  assert.equal(r.source, "platform-default");
  assert.equal(r.shell, true);
  assert.match(r.label, IS_WINDOWS ? /cmd\.exe/ : /\/bin\/sh/);
});

const realShell = IS_WINDOWS ? (process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe") : "/bin/sh";

test("MNEMO_SHELL overrides the platform shell", () => {
  const r = resolveShell({ MNEMO_SHELL: realShell } as NodeJS.ProcessEnv);
  assert.equal(r.shell, realShell);
  assert.equal(r.source, "mnemo-shell");
});

test("a broken shell override fails loudly instead of silently falling back", () => {
  assert.throws(
    () => resolveShell({ MNEMO_SHELL: path.join(os.tmpdir(), "no-such-shell-zzz") } as NodeJS.ProcessEnv),
    /does not exist/,
  );
});

test("pi's global shellPath is honoured, and MNEMO_SHELL wins over it", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sea-shell-"));
  try {
    fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({ shellPath: realShell }),
    );
    assert.equal(readPiShellPath({} as NodeJS.ProcessEnv, home), realShell);
    const viaPi = resolveShell({} as NodeJS.ProcessEnv, home);
    assert.equal(viaPi.source, "pi-shellpath");
    assert.equal(viaPi.shell, realShell);

    const override = resolveShell({ MNEMO_SHELL: realShell } as NodeJS.ProcessEnv, home);
    assert.equal(override.source, "mnemo-shell", "the tool's own override outranks the setting");

    // an unreadable/garbage settings file must not throw
    fs.writeFileSync(path.join(home, ".pi", "agent", "settings.json"), "{not json");
    assert.equal(readPiShellPath({} as NodeJS.ProcessEnv, home), undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("shellLabel calls a bash.exe what it is", () => {
  const label = shellLabel("C:/Program Files/Git/bin/bash.exe");
  assert.match(label, IS_WINDOWS ? /Git Bash/ : /bash/);
  assert.match(shellLabel("C:/Windows/System32/cmd.exe"), /cmd\.exe/);
});

test("runBash actually runs through MNEMO_SHELL", async () => {
  const prev = process.env.MNEMO_SHELL;
  process.env.MNEMO_SHELL = realShell;
  try {
    const res = await runBash("echo override-ran");
    assert.equal(res.exitCode, 0);
    assert.match(res.stdout, /override-ran/);
  } finally {
    if (prev === undefined) delete process.env.MNEMO_SHELL;
    else process.env.MNEMO_SHELL = prev;
  }
});

test("a Windows user can point MNEMO_SHELL at Git Bash (POSIX semantics)", { skip: !IS_WINDOWS }, async () => {
  const gitBash = "C:/Program Files/Git/bin/bash.exe";
  if (!fs.existsSync(gitBash)) return; // Git for Windows not installed: nothing to prove here
  const prev = process.env.MNEMO_SHELL;
  process.env.MNEMO_SHELL = gitBash;
  try {
    const res = await runBash("uname -s");
    assert.equal(res.exitCode, 0, res.stderr);
    assert.match(res.stdout, /MINGW|MSYS|CYGWIN/, "the command ran under Git Bash, not cmd.exe");
  } finally {
    if (prev === undefined) delete process.env.MNEMO_SHELL;
    else process.env.MNEMO_SHELL = prev;
  }
});

test("the description reflects a configured override", () => {
  const d = bashToolDescription({ shell: realShell, source: "mnemo-shell", label: shellLabel(realShell) });
  assert.match(d, /MNEMO_SHELL/);
  assert.ok(!/write cmd syntax/.test(d), "an override is not the cmd.exe default");
});

// --- 21 (D6): the child shell gets the session environment ---------------

/** A fake child that writes the env it received to a JSON file. Never a shell script. */
function envDumpScript(dir: string): string {
  const script = path.join(dir, "dump-env.mjs");
  fs.writeFileSync(script, `
    import { writeFileSync } from "node:fs";
    import { dirname, join } from "node:path";
    import { fileURLToPath } from "node:url";
    const out = join(dirname(fileURLToPath(import.meta.url)), "seen.json");
    const pick = (k) => process.env[k] ?? null;
    writeFileSync(out, JSON.stringify({
      PI_SESSION_ID: pick("PI_SESSION_ID"),
      PI_SESSION_FILE: pick("PI_SESSION_FILE"),
      PI_PROVIDER: pick("PI_PROVIDER"),
      PI_MODEL: pick("PI_MODEL"),
      PI_REASONING_LEVEL: pick("PI_REASONING_LEVEL"),
      CREDENTIAL: pick("SEA_TEST_FAKE_API_KEY"),
      VISIBLE: pick("SEA_TEST_VISIBLE"),
    }));
  `);
  return script;
}

test("bash_exec hands the child the session's PI_* env and nothing stale", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sea-env-"));
  const saved = {
    stale: process.env.PI_SESSION_ID,
    cred: process.env.SEA_TEST_FAKE_API_KEY,
    visible: process.env.SEA_TEST_VISIBLE,
  };
  process.env.PI_SESSION_ID = "stale-parent-session"; // must be replaced, not inherited
  process.env.SEA_TEST_FAKE_API_KEY = "«redacted:sk-…»";
  process.env.SEA_TEST_VISIBLE = "visible-marker";
  try {
    const script = envDumpScript(dir);
    const ctx = {
      sessionManager: {
        getSessionId: () => "sess-abc",
        getSessionFile: () => "/tmp/sessions/sess-abc.jsonl",
      },
      model: { provider: "acme", id: "model-x" },
      thinkingLevel: "high",
    };
    const res = await bashExecTool.execute(
      "t-env", { command: `node "${script}"` }, undefined, undefined, ctx as any,
    );
    assert.equal((res.details as any).exitCode, 0, textOf(res));
    const seen = JSON.parse(fs.readFileSync(path.join(dir, "seen.json"), "utf8"));
    assert.equal(seen.PI_SESSION_ID, "sess-abc", "the live session id, not the stale one");
    assert.equal(seen.PI_SESSION_FILE, "/tmp/sessions/sess-abc.jsonl");
    assert.equal(seen.PI_PROVIDER, "acme");
    assert.equal(seen.PI_MODEL, "model-x");
    assert.equal(seen.PI_REASONING_LEVEL, "high");
    assert.equal(seen.CREDENTIAL, null, "credentials are still scrubbed");
    assert.equal(seen.VISIBLE, "visible-marker", "non-secret variables still flow");
  } finally {
    for (const [k, v] of Object.entries({
      PI_SESSION_ID: saved.stale,
      SEA_TEST_FAKE_API_KEY: saved.cred,
      SEA_TEST_VISIBLE: saved.visible,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("bash_exec strips inherited PI_* when the session knows nothing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sea-env-"));
  const saved = process.env.PI_SESSION_ID;
  process.env.PI_SESSION_ID = "stale-parent-session";
  try {
    const script = envDumpScript(dir);
    const res = await bashExecTool.execute("t-env2", { command: `node "${script}"` });
    assert.equal((res.details as any).exitCode, 0, textOf(res));
    const seen = JSON.parse(fs.readFileSync(path.join(dir, "seen.json"), "utf8"));
    assert.equal(seen.PI_SESSION_ID, null, "a stale parent value must not leak into the shell");
  } finally {
    if (saved === undefined) delete process.env.PI_SESSION_ID;
    else process.env.PI_SESSION_ID = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("bashCommandParamHint matches the resolved shell", () => {
  assert.match(bashCommandParamHint({ shell: true, source: "platform-default", label: "X" }), /run via X/);
});
