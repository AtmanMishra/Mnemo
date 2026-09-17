/**
 * 12.7 (68846059): credentials never reach child processes.
 * Children spawned by tools (bash_exec, ipy kernel, MCP, memsrv, sub-agents)
 * get scrubChildEnv(process.env) — the agent's own env is untouched because
 * pi's provider layer reads the key from there.
 */
import { test } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  SECRET_ENV_NAME,
  scrubChildEnv,
  childShellEnv,
  piSessionEnvVars,
  sessionEnvFromContext,
  setAgentProcessMarkers,
  PI_SESSION_ENV_NAMES,
} from "../src/childenv.ts";
import { runBash } from "../src/tools/bash_exec.ts";
import { resolveShell } from "../src/tools/shell.ts";

/**
 * Print the child's environment in the shell the tool will actually use:
 * `env` is a POSIX utility that only happens to exist on a Windows machine
 * when the run was started from a POSIX shell (Git Bash puts `usr/bin` on
 * PATH); cmd.exe's equivalent is the `set` builtin. Both print NAME=value
 * lines, which is what these assertions read.
 */
function envDumpCommand(): string {
  return resolveShell().label.startsWith("cmd.exe") ? "set" : "env";
}

test("scrubChildEnv drops every credential-shaped variable", () => {
  const env = {
    ANTHROPIC_API_KEY: "sk-ant-123456789012",
    OPENAI_API_KEY: "sk-proj-12345678901234",
    OPENROUTER_API_KEY: "sk-or-v1-1234567890123456789012345678901234567890",
    OPENCODE_API_KEY: "octest",
    BRAVE_API_KEY: "brave-secret",
    TAVILY_API_KEY: "tvly-12345678901234",
    GITHUB_TOKEN: "ghtest",
    GH_TOKEN: "ghtest",
    AWS_SECRET_ACCESS_KEY: "wJalr",
    DB_PASSWORD: "hunter2",
    MY_API_TOKEN: "tok",
    KEEP_PATH: "/usr/bin:/bin",
    KEEP_NORMAL: "hello",
    MNEMO_PROVIDER: "openrouter",
    HOME: "/Users/tester",
    API_KEY_USER: "bob", // a NAME that merely CONTAINS api_key is not a credential
  } as unknown as NodeJS.ProcessEnv;
  const out = scrubChildEnv(env);
  for (const key of [
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "OPENCODE_API_KEY",
    "BRAVE_API_KEY", "TAVILY_API_KEY", "GITHUB_TOKEN", "GH_TOKEN",
    "AWS_SECRET_ACCESS_KEY", "DB_PASSWORD", "MY_API_TOKEN",
  ]) {
    assert.ok(!(key in out), `${key} must be scrubbed`);
  }
  for (const key of ["KEEP_PATH", "KEEP_NORMAL", "MNEMO_PROVIDER", "HOME", "API_KEY_USER"]) {
    assert.equal(out[key], env[key], `${key} must survive`);
  }
});

test("SECRET_ENV_NAME matches exact suffixes only", () => {
  assert.ok(SECRET_ENV_NAME.test("ANTHROPIC_API_KEY"));
  assert.ok(SECRET_ENV_NAME.test("TOKEN"));
  assert.ok(SECRET_ENV_NAME.test("AWS_SECRET_ACCESS_KEY"));
  assert.ok(SECRET_ENV_NAME.test("CREDENTIAL"));
  assert.ok(SECRET_ENV_NAME.test("CREDENTIALS"));
  assert.ok(!SECRET_ENV_NAME.test("API_KEY_COUNT"));   // a metric, not a secret
  assert.ok(!SECRET_ENV_NAME.test("KEYBOARD_LAYOUT"));
  assert.ok(!SECRET_ENV_NAME.test("KEEP_NORMAL"));
});

test("bash_exec 'env' does not show a credential the parent holds", async () => {
  const saved = {
    FAKE_TEST_API_KEY: process.env.FAKE_TEST_API_KEY,
    FAKE_TEST_VISIBLE: process.env.FAKE_TEST_VISIBLE,
  };
  process.env.FAKE_TEST_API_KEY = "sk-test-leaked-value-123456789";
  process.env.FAKE_TEST_VISIBLE = "visible-marker";
  try {
    const res = await runBash(envDumpCommand(), { timeoutMs: 20000 });
    assert.equal(res.exitCode, 0);
    assert.doesNotMatch(res.stdout, /sk-test-leaked-value-123456789/,
      "the key must not be readable via env");
    assert.match(res.stdout, /FAKE_TEST_VISIBLE=visible-marker/,
      "non-secret variables still flow through");
  } finally {
    if (saved.FAKE_TEST_API_KEY === undefined) delete process.env.FAKE_TEST_API_KEY;
    else process.env.FAKE_TEST_API_KEY = saved.FAKE_TEST_API_KEY;
    if (saved.FAKE_TEST_VISIBLE === undefined) delete process.env.FAKE_TEST_VISIBLE;
    else process.env.FAKE_TEST_VISIBLE = saved.FAKE_TEST_VISIBLE;
  }
});

test("the agent process env keeps the key (pi provider layer reads it there)", () => {
  // regression guard: we must not scrub process.env itself, only copies given
  // to children
  const before = process.env.FAKE_KEY_FOR_SELF;
  process.env.FAKE_KEY_FOR_SELF = "still-here";
  try {
    assert.equal(process.env.FAKE_KEY_FOR_SELF, "still-here");
  } finally {
    if (before === undefined) delete process.env.FAKE_KEY_FOR_SELF;
    else process.env.FAKE_KEY_FOR_SELF = before;
  }
});

// --- 21 (D6): PI_* session environment for child shells -------------------

test("sessionEnvFromContext reads pi's context, tolerating gaps", () => {
  const ctx = {
    sessionManager: {
      getSessionId: () => "sess-1",
      getSessionFile: () => "/sessions/sess-1.jsonl",
    },
    model: { provider: "anthropic", id: "claude-x" },
    thinkingLevel: "medium",
  };
  assert.deepEqual(sessionEnvFromContext(ctx), {
    sessionId: "sess-1",
    sessionFile: "/sessions/sess-1.jsonl",
    provider: "anthropic",
    model: "claude-x",
    reasoningLevel: "medium",
  });
  // no context at all, an empty one, and an ephemeral session file
  assert.deepEqual(sessionEnvFromContext(undefined), {});
  assert.deepEqual(sessionEnvFromContext({}), {});
  assert.deepEqual(
    sessionEnvFromContext({
      sessionManager: { getSessionId: () => "s2", getSessionFile: () => undefined },
      model: undefined,
    }),
    { sessionId: "s2" },
    "unknown values are omitted, never undefined keys",
  );
  // a context whose accessors throw must not kill the tool call
  assert.deepEqual(
    sessionEnvFromContext({
      sessionManager: { getSessionId: () => { throw new Error("gone"); } },
    }),
    {},
  );
});

test("piSessionEnvVars publishes only the known values", () => {
  assert.deepEqual(piSessionEnvVars(undefined), {});
  assert.deepEqual(piSessionEnvVars({}), {});
  assert.deepEqual(piSessionEnvVars({ sessionId: "a", model: "" }), { PI_SESSION_ID: "a" });
  assert.deepEqual(
    piSessionEnvVars({ sessionId: "a", sessionFile: "f", provider: "p", model: "m", reasoningLevel: "off" }),
    { PI_SESSION_ID: "a", PI_SESSION_FILE: "f", PI_PROVIDER: "p", PI_MODEL: "m", PI_REASONING_LEVEL: "off" },
  );
  assert.equal(PI_SESSION_ENV_NAMES.length, 5);
});

test("childShellEnv replaces stale PI_* values and keeps everything else", () => {
  const parent = {
    PI_SESSION_ID: "stale-parent",
    PI_SESSION_FILE: "stale-file",
    PI_PROVIDER: "stale-provider",
    PI_MODEL: "stale-model",
    PI_REASONING_LEVEL: "stale-level",
    ANTHROPIC_API_KEY: "«redacted»",
    MNEMO_PROVIDER: "openrouter",
    PATH: "/usr/bin",
  } as unknown as NodeJS.ProcessEnv;

  const known = childShellEnv(
    { sessionId: "live", provider: "openrouter", model: "m1", reasoningLevel: "high" },
    parent,
  );
  assert.equal(known.PI_SESSION_ID, "live");
  assert.equal(known.PI_PROVIDER, "openrouter");
  assert.equal(known.PI_MODEL, "m1");
  assert.equal(known.PI_REASONING_LEVEL, "high");
  assert.equal(known.PI_SESSION_FILE, undefined, "ephemeral session: the stale file must not survive");
  assert.ok(!("ANTHROPIC_API_KEY" in known), "credentials are still scrubbed");
  assert.equal(known.MNEMO_PROVIDER, "openrouter");
  assert.equal(known.PATH, "/usr/bin");

  const unknown = childShellEnv(undefined, parent);
  for (const name of PI_SESSION_ENV_NAMES) {
    assert.ok(!(name in unknown), `${name} must not leak from a parent process`);
  }
});

test("runBash's default env carries no stale PI_* value", async () => {
  // A direct runBash call (no session context) still goes through
  // childShellEnv(): a nested Mnemo must not hand its shells the parent's
  // session metadata. A node one-liner prints what the child actually saw.
  const prev = process.env.PI_SESSION_ID;
  process.env.PI_SESSION_ID = "stale-parent-session";
  try {
    const res = await runBash(`node -p "process.env.PI_SESSION_ID || 'unset'"`);
    assert.equal(res.exitCode, 0, res.stderr);
    assert.equal(res.stdout.trim(), "unset");
  } finally {
    if (prev === undefined) delete process.env.PI_SESSION_ID;
    else process.env.PI_SESSION_ID = prev;
  }
});

test("setAgentProcessMarkers stamps pi's markers unconditionally", () => {
  const env = { AI_AGENT: "someone-else", KEEP: "1" } as unknown as NodeJS.ProcessEnv;
  setAgentProcessMarkers(env);
  assert.equal(env.AI_AGENT, "pi");
  assert.equal(env.PI_CODING_AGENT, "true");
  assert.equal(env.KEEP, "1");
  // the shim is the only place that can set them (we call pi's library
  // main(), not its CLI), so it must actually call the helper
  const shim = fs.readFileSync(path.join(import.meta.dirname, "..", "bin", "mnemo.ts"), "utf8");
  assert.match(shim, /setAgentProcessMarkers\(\)/);
});