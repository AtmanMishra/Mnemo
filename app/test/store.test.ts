/**
 * The key store: merged, private, and never echoed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readAuth, saveKey, authPath, describeKeyShape } from "../src/commands/store.ts";

function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-auth-"));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("a key is written in the shape the rest of Mnemo reads", () => {
  const h = home();
  try {
    const written = saveKey(h.dir, "openrouter", "sk-or-a-real-looking-key-1234", 1700000000000);
    assert.equal(written, authPath(h.dir));

    const file = JSON.parse(fs.readFileSync(written, "utf8"));
    assert.equal(file.version, 1, "the version the loader checks before trusting the file");
    assert.deepEqual(file.providers.openrouter, {
      kind: "api_key",
      key: "sk-or-a-real-looking-key-1234",
      updated_at: 1700000000000,
    });
    assert.equal(file.defaultProvider, "openrouter");
  } finally {
    h.cleanup();
  }
});

test("adding a second provider keeps the first, and does not move the default", () => {
  const h = home();
  try {
    saveKey(h.dir, "openrouter", "sk-or-first", 1);
    saveKey(h.dir, "openai", "sk-openai-second", 2);

    const file = readAuth(h.dir);
    assert.equal(file.providers.openrouter?.key, "sk-or-first", "logging in again must not log you out");
    assert.equal(file.providers.openai?.key, "sk-openai-second");
    assert.equal(file.defaultProvider, "openrouter", "a second key is not a change of mind about what runs");
  } finally {
    h.cleanup();
  }
});

test("a re-login replaces that provider's key rather than duplicating it", () => {
  const h = home();
  try {
    saveKey(h.dir, "openrouter", "old", 1);
    saveKey(h.dir, "openrouter", "new", 2);
    const file = readAuth(h.dir);
    assert.equal(file.providers.openrouter?.key, "new");
    assert.equal(file.providers.openrouter?.updated_at, 2);
    assert.equal(Object.keys(file.providers).length, 1);
  } finally {
    h.cleanup();
  }
});

test("a corrupt or hand-edited file does not block a login", () => {
  const h = home();
  try {
    fs.writeFileSync(authPath(h.dir), "{ this is not json");
    const file = readAuth(h.dir);
    assert.deepEqual(file, { version: 1, providers: {} }, "start clean rather than refuse");

    saveKey(h.dir, "openrouter", "sk-or-fresh", 3);
    assert.equal(readAuth(h.dir).providers.openrouter?.key, "sk-or-fresh");
  } finally {
    h.cleanup();
  }
});

test("the key is nowhere but the file", () => {
  const h = home();
  try {
    const secret = "sk-or-should-never-be-logged";
    const written = saveKey(h.dir, "openrouter", secret, 4);
    // What a caller can accidentally print: the return value.
    assert.equal(written.includes(secret), false, "the path, not the value");

    const entries = fs.readdirSync(h.dir);
    assert.deepEqual(entries, ["auth.json"], "no stray key material beside it");
    assert.equal(fs.readFileSync(written, "utf8").includes(secret), true, "and it is in the file, as intended");
  } finally {
    h.cleanup();
  }
});

test("a wrong-looking key is described, not just rejected", () => {
  assert.match(describeKeyShape("abc"), /too short/);
  assert.match(describeKeyShape("sk-or with spaces"), /no spaces/);
  assert.equal(describeKeyShape("sk-or-1234567890"), "", "nothing to say about a plausible key");
});
