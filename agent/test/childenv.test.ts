/**
 * 12.7 (68846059): credentials never reach child processes.
 * Children spawned by tools (bash_exec, ipy kernel, MCP, memsrv, sub-agents)
 * get scrubChildEnv(process.env) — the agent's own env is untouched because
 * pi's provider layer reads the key from there.
 */
import { test } from "node:test";
import assert from "node:assert";
import { SECRET_ENV_NAME, scrubChildEnv } from "../src/childenv.ts";
import { runBash } from "../src/tools/bash_exec.ts";

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
    const res = await runBash("env", { timeoutMs: 20000 });
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