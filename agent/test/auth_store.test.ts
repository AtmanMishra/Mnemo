import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  loadAuth, saveAuth, setProviderAuth, getProviderAuth, clearProviderAuth,
  setDefaultProvider, resolveApiKey, authFile,
} from "../src/auth/store.ts";

describe("auth store", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(path.join(tmpdir(), "mnemo-auth-")); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test("set/get/clear provider auth roundtrip", () => {
    assert.equal(getProviderAuth("opencode-go", home), null);
    setProviderAuth("opencode-go", { kind: "api_key", key: "sk-test" }, home);
    const a = getProviderAuth("opencode-go", home)!;
    assert.equal(a.kind, "api_key");
    assert.equal(a.key, "sk-test");
    assert.ok(a.updated_at > 0);
    assert.equal(clearProviderAuth("opencode-go", home), true);
    assert.equal(getProviderAuth("opencode-go", home), null);
    assert.equal(clearProviderAuth("opencode-go", home), false);
  });

  test("auth file has 0600 permissions and valid json", () => {
    setProviderAuth("anthropic", { kind: "api_key", key: "sk-ant" }, home);
    const f = authFile(home);
    assert.ok(existsSync(f));
    const mode = statSync(f).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600 got ${mode.toString(8)}`);
    JSON.parse(readFileSync(f, "utf8")); // valid json
  });

  test("corrupt file loads as fresh store", () => {
    fs.mkdirSync(path.join(home, ".mnemo"), { recursive: true });
    fs.writeFileSync(authFile(home), "{broken json");
    assert.deepEqual(loadAuth(home).providers, {});
  });

  test("default provider persists with model", () => {
    setProviderAuth("openrouter", { kind: "api_key", key: "sk-or" }, home);
    setDefaultProvider("openrouter", "stealth/ox-alpha", home);
    const a = loadAuth(home);
    assert.equal(a.defaultProvider, "openrouter");
    assert.equal(a.providers.openrouter?.defaultModel, "stealth/ox-alpha");
  });

  test("resolveApiKey: env wins over store; store used when no env", () => {
    process.env.OPENCODE_API_KEY = "env-key";
    try {
      setProviderAuth("opencode-go", { kind: "api_key", key: "stored-key" }, home);
      assert.deepEqual(resolveApiKey("opencode-go", process.env, home), { key: "env-key", source: "env" });
      delete process.env.OPENCODE_API_KEY;
      assert.deepEqual(resolveApiKey("opencode-go", process.env, home), { key: "stored-key", source: "store" });
      assert.deepEqual(resolveApiKey("anthropic", process.env, home), null);
    } finally {
      delete process.env.OPENCODE_API_KEY;
    }
  });

  test("saveAuth creates missing directory", () => {
    saveAuth({ version: 1, providers: {} }, home);
    assert.ok(existsSync(authFile(home)));
  });
});
