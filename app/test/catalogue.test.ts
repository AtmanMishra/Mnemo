/**
 * The catalogue: what the provider says it can run, and choosing from it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fetchModels, parseModels, renderModels, setModel } from "../src/models/catalogue.ts";
import { readAuth, saveKey } from "../src/commands/store.ts";

const envelope = {
  data: [
    { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5", context_length: 200000 },
    { id: "openai/gpt-5", name: "GPT-5", context_length: 400000 },
    { id: "deepseek/deepseek-v3.2", context_length: 128000 },
  ],
};

function fakeFetch(payload: unknown, status = 200) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = (async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: String(url), headers: init?.headers ?? {} });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("the provider's answer is parsed, in either shape", () => {
  assert.equal(parseModels(envelope).length, 3);
  assert.equal(parseModels(envelope.data).length, 3, "a bare array works too");
  assert.deepEqual(parseModels({ nonsense: true }), [], "and nothing else invents models");
  assert.equal(parseModels(envelope)[0]?.context, 200000);
  assert.equal(parseModels(envelope)[2]?.name, "deepseek/deepseek-v3.2", "a missing name falls back to the id");
});

test("the list is bounded, says how much it hid, and names the command", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `model-${i}`, name: `Model ${i}` }));
  const lines = renderModels(many, { limit: 5 }).join("\n");
  assert.match(lines, /model-0/);
  assert.doesNotMatch(lines, /model-9/, "only what fits");
  assert.match(lines, /and 25 more/, "the count is what is there, not what is drawn");
  assert.match(lines, /\/model <id>/, "and how to choose");
});

test("a key is sent when there is one, and not when there isn't", async () => {
  const withKey = fakeFetch(envelope);
  await fetchModels({ provider: "openrouter", key: "sk-or-abc", fetchImpl: withKey.impl });
  assert.equal(withKey.calls[0]?.headers.authorization, "Bearer sk-or-abc");
  assert.match(withKey.calls[0]!.url, /openrouter\.ai/);

  const without = fakeFetch(envelope);
  await fetchModels({ provider: "openrouter", fetchImpl: without.impl });
  assert.equal(without.calls[0]?.headers.authorization, undefined, "a public catalogue needs no key");
});

test("each failure is its own sentence", async () => {
  const refused = fakeFetch({}, 401);
  const unauthorized = await fetchModels({ provider: "openai", key: "bad", fetchImpl: refused.impl });
  assert.ok("error" in unauthorized && /refused/.test(unauthorized.error), "401 says the key was refused");
  assert.ok("error" in unauthorized && /\/login/.test(unauthorized.error), "and what fixes it");

  const broken = (async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  }) as unknown as typeof fetch;
  const unreachable = await fetchModels({ provider: "openrouter", fetchImpl: broken });
  assert.ok("error" in unreachable && /could not reach/.test(unreachable.error), "a network failure says so");

  const unknown = await fetchModels({ provider: "mystery", fetchImpl: fakeFetch({}).impl });
  assert.ok("error" in unknown && /no catalogue is known/.test(unknown.error), "an unknown provider is named");
});

test("choosing a model records it in the slot the schema already has", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-model-"));
  try {
    saveKey(home, "openrouter", "sk-or-key", 1);
    setModel(home, "openrouter", "anthropic/claude-sonnet-4.5");

    const file = readAuth(home);
    assert.equal(file.providers.openrouter?.defaultModel, "anthropic/claude-sonnet-4.5");
    assert.equal(file.providers.openrouter?.key, "sk-or-key", "the key is untouched");
    assert.equal(file.defaultProvider, "openrouter");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("choosing a model for a provider with no key is refused, with the step to take", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-model-"));
  try {
    assert.throws(() => setModel(home, "openrouter", "x"), /\/login openrouter first/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
