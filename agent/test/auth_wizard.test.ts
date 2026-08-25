import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { loadAuth, getProviderAuth } from "../src/auth/store.ts";
import { runWizard, parseProviderChoice, providerMenu, type AuthIO } from "../src/auth/wizard.ts";

function scripted(lines: string[]): AuthIO & { transcript: () => string } {
  // deterministic fake: answers come from a queue, no stream timing involved
  const written: string[] = [];
  let qi = 0;
  return {
    write: (s: string) => written.push(s),
    question: async () => {
      const line = lines[qi++];
      if (line === undefined) throw new Error("wizard asked more questions than scripted");
      return line;
    },
    transcript: () => written.join(""),
  };
}

describe("auth wizard", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(path.join(tmpdir(), "mnemo-wiz-")); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test("parseProviderChoice accepts numbers and names", () => {
    assert.equal(parseProviderChoice("1"), "anthropic");
    assert.equal(parseProviderChoice("3"), "openrouter");
    assert.equal(parseProviderChoice("4"), "opencode");
    assert.equal(parseProviderChoice("5"), "opencode-go");
    assert.equal(parseProviderChoice("opencode-go"), "opencode-go");
    assert.equal(parseProviderChoice("OpenRouter"), "openrouter");
    assert.equal(parseProviderChoice("bogus"), null);
    assert.equal(parseProviderChoice("99"), null);
  });

  test("providerMenu lists all providers", () => {
    const menu = providerMenu();
    for (const p of ["Anthropic", "OpenAI", "OpenRouter", "OpenCode"]) {
      assert.ok(menu.includes(p), `menu missing ${p}`);
    }
  });

  test("full wizard flow saves provider + key + default model", async () => {
    const io = scripted(["3", "sk-or-test-12345", "stealth/ox-alpha"]);
    const res = await runWizard(io, home);
    assert.equal(res.provider, "openrouter");
    assert.equal(res.defaultModel, "stealth/ox-alpha");
    const a = getProviderAuth("openrouter", home)!;
    assert.equal(a.key, "sk-or-test-12345");
    assert.equal(loadAuth(home).defaultProvider, "openrouter");
  });

  test("rejects short keys and unknown provider, then succeeds", async () => {
    const io = scripted([
      "99",          // bad provider
      "opencode-go", // good provider
      "short",       // key too short -> retry
      "sk-qvalid-key-0001",
      "",            // skip model
    ]);
    const res = await runWizard(io, home);
    assert.equal(res.provider, "opencode-go");
    assert.equal(res.defaultModel, undefined);
    assert.equal(getProviderAuth("opencode-go", home)!.key, "sk-qvalid-key-0001");
  });
});
