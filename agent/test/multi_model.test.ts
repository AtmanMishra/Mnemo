/**
 * 8.7: a sub-agent can run on a different model from its parent.
 * Every test threads its own temp home — the model list comes from the real
 * auth store, and a default that read $HOME would make these machine-dependent.
 */
import { test } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { availableModels, resolveModelEnv, subagentSpawnTool } from "../src/tools/subagent.ts";
import { setProviderAuth } from "../src/auth/store.ts";

function tmpHome(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mnemo-mm-${name}-`));
}

const MODELS = [
  { provider: "anthropic", model: "claude-opus-5" },
  { provider: "opencode-go", model: "kimi-k2.6" },
];

test("omitting a model inherits the parent's, and costs nothing", () => {
  // the common case must not need any configuration at all
  assert.deepEqual(resolveModelEnv(undefined, MODELS), {});
  assert.deepEqual(resolveModelEnv("", MODELS), {});
  assert.deepEqual(resolveModelEnv("   ", MODELS), {});
});

test("a bare model name resolves to its provider", () => {
  assert.deepEqual(resolveModelEnv("kimi-k2.6", MODELS), {
    MNEMO_PROVIDER: "opencode-go",
    MNEMO_MODEL: "kimi-k2.6",
  });
  assert.deepEqual(resolveModelEnv("  claude-opus-5  ", MODELS), {
    MNEMO_PROVIDER: "anthropic",
    MNEMO_MODEL: "claude-opus-5",
  });
});

test("provider/model is accepted, and the provider must match", () => {
  assert.deepEqual(resolveModelEnv("anthropic/claude-opus-5", MODELS), {
    MNEMO_PROVIDER: "anthropic",
    MNEMO_MODEL: "claude-opus-5",
  });
  // right model name, wrong provider: refused rather than quietly corrected
  assert.throws(() => resolveModelEnv("openai/claude-opus-5", MODELS),
    /not a model of a logged-in provider/);
});

test("an unavailable model is refused with the list, not silently ignored", () => {
  // falling back to the parent's model would look like it worked, which is
  // the worst possible outcome for a multi-model run
  assert.throws(() => resolveModelEnv("gpt-5.5", MODELS), (err: Error) => {
    assert.match(err.message, /"gpt-5\.5" is not a model of a logged-in provider/);
    assert.match(err.message, /anthropic\/claude-opus-5/, "it lists what IS available");
    assert.match(err.message, /opencode-go\/kimi-k2\.6/);
    return true;
  });
});

test("with nothing logged in, the error says so plainly", () => {
  assert.throws(() => resolveModelEnv("anything", []), /\(none logged in\)/);
});

test("the model list comes from logged-in providers with a chosen model", () => {
  const home = tmpHome("models");
  setProviderAuth("anthropic", { kind: "api_key", key: "sk-ant-abcdefghij", defaultModel: "claude-opus-5" }, home);
  setProviderAuth("opencode-go", { kind: "api_key", key: "sk-oc-abcdefghij", defaultModel: "kimi-k2.6" }, home);
  // a key with no model chosen yet is not offerable
  setProviderAuth("openai", { kind: "api_key", key: "sk-oa-abcdefghij" }, home);
  // and a provider entry with no usable key is not either
  setProviderAuth("openrouter", { kind: "api_key", key: "short", defaultModel: "kimi" }, home);

  const models = availableModels(home);
  assert.deepEqual(models.map((m) => `${m.provider}/${m.model}`).sort(), [
    "anthropic/claude-opus-5",
    "opencode-go/kimi-k2.6",
  ]);
  fs.rmSync(home, { recursive: true, force: true });
});

test("the tool exposes model as an optional parameter", () => {
  const props = (subagentSpawnTool.parameters as any).properties;
  assert.ok(props.model, "spawn_subagent must accept a model");
  assert.match(props.model.description, /inherit/i, "the description must say what omitting it does");
  const required: string[] = (subagentSpawnTool.parameters as any).required ?? [];
  assert.ok(!required.includes("model"), "model must stay optional");
  assert.ok(required.includes("task"));
});

test("a bad model fails the tool call before spawning anything", async () => {
  // if this spawned first and failed after, the user would pay for a run on
  // the wrong model
  const res = await subagentSpawnTool.execute("id", {
    task: "anything",
    model: "definitely-not-a-real-model",
  });
  const text = res.content.map((c: any) => c.text ?? "").join("");
  assert.match(text, /not a model of a logged-in provider/);
});
