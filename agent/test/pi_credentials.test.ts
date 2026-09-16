/**
 * #23: a tester whose only credential is a pi subscription, or a local
 * llama.cpp router, must not be locked out.
 *
 * Mnemo used to refuse to start unless one of its five API-key providers was
 * configured. That is a gate on a question it cannot answer alone: pi holds
 * subscription tokens (its own /login) and drives local model servers that
 * need no key at all, and both live in pi's files under ~/.pi/agent.
 *
 * Everything here threads its own temp home and env — nothing reads the
 * developer's real ~/.pi or ~/.mnemo. A test that did would pass for the wrong
 * reason on a machine that happens to have a credential.
 */
import { test } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pickProvider, canStart, piDefaultModel, missingKeyMessage } from "../src/provider.ts";
import { agentDir, credentials, hasCredential, defaults } from "../src/auth/pi_store.ts";

/** A temp home with pi's stores written under it, as pi would have them. */
function piHome(name: string, files: { auth?: unknown; settings?: unknown }): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `mnemo-pi-${name}-`));
  const dir = path.join(home, ".pi", "agent");
  fs.mkdirSync(dir, { recursive: true });
  if (files.auth !== undefined) {
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify(files.auth, null, 2));
  }
  if (files.settings !== undefined) {
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(files.settings, null, 2));
  }
  return home;
}

// ---------- the provider pi can drive is passed through, not refused -------

test("a provider Mnemo cannot key is passed to pi instead of throwing", () => {
  for (const id of ["llama.cpp", "xai", "deepseek", "github-copilot", "ant-ling"]) {
    const sel = pickProvider({ MNEMO_PROVIDER: id } as NodeJS.ProcessEnv);
    assert.equal(sel?.provider, id, `${id} must reach pi`);
    assert.equal(sel?.apiKeyEnv, "", `${id} is pi's credential: Mnemo must not demand a key for it`);
    // And the run is allowed to start: there is nothing for us to check that
    // pi cannot check better.
    assert.equal(canStart(sel, {} as NodeJS.ProcessEnv, os.tmpdir()), true,
      `${id} must not be refused — pi is the authority on what it supports`);
  }
});

test("an unknown name is pi's error to give, not a hard exit from us", () => {
  // We cannot enumerate pi's catalogue (subscriptions, packages, models.json),
  // so the honest move is to hand the name over. pi says "unknown provider";
  // that message reaches the transcript the same way any startup failure does.
  const sel = pickProvider({ MNEMO_PROVIDER: "not-a-provider" } as NodeJS.ProcessEnv);
  assert.equal(sel?.provider, "not-a-provider");
  assert.equal(canStart(sel, {} as NodeJS.ProcessEnv, os.tmpdir()), true);
});

test("Mnemo's own five still resolve to the key Mnemo can supply", () => {
  const sel = pickProvider({ MNEMO_PROVIDER: "opencode-go" } as NodeJS.ProcessEnv);
  assert.deepEqual(sel, { provider: "opencode-go", apiKeyEnv: "OPENCODE_API_KEY", modelId: undefined });
  assert.equal(canStart(sel, {} as NodeJS.ProcessEnv, os.tmpdir()), false,
    "with no key anywhere, running on it is what the message is for");
  assert.equal(canStart(sel, { OPENCODE_API_KEY: "k" } as NodeJS.ProcessEnv, os.tmpdir()), true);
});

test("MNEMO_PROVIDER is read case-insensitively for our own providers", () => {
  assert.equal(pickProvider({ MNEMO_PROVIDER: "OpenAI" } as NodeJS.ProcessEnv)?.apiKeyEnv, "OPENAI_API_KEY");
});

// ---------- a subscription in pi's store counts as a credential -----------

test("a pi credential for the provider means no Mnemo key is needed", () => {
  const home = piHome("sub", { auth: { anthropic: { type: "oauth", access: "sk-ant-oat", refresh: "r", expires: 1 } } });
  const sel = pickProvider({ MNEMO_PROVIDER: "anthropic" } as NodeJS.ProcessEnv);
  assert.equal(sel?.apiKeyEnv, "ANTHROPIC_API_KEY");
  assert.equal(canStart(sel, {} as NodeJS.ProcessEnv, home), true,
    "a Claude Pro/Max login is a credential; demanding ANTHROPIC_API_KEY locks that tester out");
});

test("a pi credential for one provider does not vouch for another", () => {
  const home = piHome("other", { auth: { openai: { type: "api_key", key: "sk-x" } } });
  const sel = pickProvider({ MNEMO_PROVIDER: "anthropic" } as NodeJS.ProcessEnv);
  assert.equal(canStart(sel, {} as NodeJS.ProcessEnv, home), false);
});

test("no provider named: pi having any credential is enough to start", () => {
  const home = piHome("any", { auth: { "github-copilot": { type: "oauth", access: "tok", refresh: "r", expires: 1 } } });
  assert.equal(canStart(null, {} as NodeJS.ProcessEnv, home), true);
  assert.equal(canStart(null, {} as NodeJS.ProcessEnv, piHome("empty", {})), false);
});

test("an entry pi itself would reject is not a credential", () => {
  // oauth without an access token, api_key with neither a key nor scoped env
  const home = piHome("junk", {
    auth: { anthropic: { type: "oauth", refresh: "r", expires: 1 }, openai: { type: "api_key", env: {} } },
  });
  assert.deepEqual(credentials({} as NodeJS.ProcessEnv, home), [],
    "counting those would send us into a start that fails somewhere less obvious");
  assert.equal(hasCredential(undefined, {} as NodeJS.ProcessEnv, home), false);
});

test("an api_key entry with provider-scoped env values is usable", () => {
  const home = piHome("scoped", { auth: { "cloudflare-ai-gateway": { type: "api_key", env: { CLOUDFLARE_API_KEY: "k" } } } });
  assert.deepEqual(credentials({} as NodeJS.ProcessEnv, home), ["cloudflare-ai-gateway"]);
});

test("a corrupt or missing auth.json is no credential, never a crash", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-pi-broken-"));
  fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  fs.writeFileSync(path.join(home, ".pi", "agent", "auth.json"), "{ not json");
  assert.deepEqual(credentials({} as NodeJS.ProcessEnv, home), []);
});

test("PI_CODING_AGENT_DIR moves where pi's stores are read from", () => {
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-pi-dir-"));
  fs.writeFileSync(path.join(elsewhere, "auth.json"), JSON.stringify({ xai: { type: "api_key", key: "x" } }));
  const env = { PI_CODING_AGENT_DIR: elsewhere } as NodeJS.ProcessEnv;
  assert.equal(agentDir(env, os.tmpdir()), elsewhere);
  assert.deepEqual(credentials(env, os.tmpdir()), ["xai"]);
  assert.deepEqual(credentials({} as NodeJS.ProcessEnv, os.tmpdir()), [],
    "and the default home is not where it was found");
});

// ---------- pi's stored default model fills the gap ------------------------

test("pi's default model is used when Mnemo's is unset, for the same provider", () => {
  const home = piHome("model", { settings: { defaultProvider: "llama.cpp", defaultModel: "gemma-3-4b-it" } });
  assert.equal(piDefaultModel("llama.cpp", {} as NodeJS.ProcessEnv, home), "gemma-3-4b-it");
  assert.equal(piDefaultModel("anthropic", {} as NodeJS.ProcessEnv, home), undefined,
    "a model id belongs to a provider; handing it to another one invents an answer");
});

test("with no stored default, there is nothing to fill in", () => {
  const home = piHome("nomodel", { settings: { defaultProvider: "llama.cpp" } });
  assert.equal(piDefaultModel("llama.cpp", {} as NodeJS.ProcessEnv, home), undefined);
  assert.deepEqual(defaults({} as NodeJS.ProcessEnv, piHome("nosettings", {})), { provider: undefined, model: undefined });
});

test("MNEMO_MODEL still wins over pi's default", () => {
  const sel = pickProvider({ MNEMO_PROVIDER: "llama.cpp", MNEMO_MODEL: "qwen3-coder" } as NodeJS.ProcessEnv);
  assert.equal(sel?.modelId, "qwen3-coder");
});

// ---------- the message names the options that work ------------------------

test("the refusal names the credentials that do work", () => {
  const msg = missingKeyMessage(null);
  for (const want of [
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "OPENCODE_API_KEY",
    "/login",          // pi's subscription route
    "llama.cpp",       // the local-model route
    "MNEMO_PROVIDER",  // and that any provider pi knows is passed through
  ]) {
    assert.ok(msg.includes(want), `the failure must name ${want}:\n${msg}`);
  }
  assert.ok(msg.includes("no usable credential"),
    "it must be honest that this is the nothing-at-all case, not one missing variable");
});

test("a named provider says which provider it could not find a credential for", () => {
  const msg = missingKeyMessage(pickProvider({ MNEMO_PROVIDER: "anthropic" } as NodeJS.ProcessEnv));
  assert.ok(msg.includes("anthropic"), msg);
  assert.ok(msg.includes("not in pi's"), "and it must have checked pi before refusing:\n" + msg);
});
