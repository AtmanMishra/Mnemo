import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createModelRuntime } from "../src/runtime/runtime.ts";
import { chooseModel } from "../src/runtime/model-choice.ts";
import { envHints } from "../src/runtime/doctor.ts";

const dirs: string[] = [];
const saved = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** An agent dir with a custom provider "mock" that has a key, and the environment of a user with AWS_PROFILE set. */
async function agent(env: Record<string, string>, settings?: object) {
  for (const k of Object.keys(process.env)) if (/^(AWS_|AZURE_|.*_API_KEY$|.*_TOKEN$)/.test(k)) delete process.env[k];
  Object.assign(process.env, env);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-model-"));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { mock: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "k", models: [{ id: "mock-1", contextWindow: 8000, maxTokens: 1000 }] } } }));
  if (settings) fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings));
  return { dir, rt: await createModelRuntime(dir) };
}

test("--model picks a model by provider/id", async () => {
  const { dir, rt } = await agent({});
  const c = chooseModel(rt, { flag: "mock/mock-1", agentDir: dir, continuing: false });
  expect(c.error).toBeUndefined();
  expect(`${c.model?.provider}/${c.model?.id}`).toBe("mock/mock-1");
});

test("--model refuses an unknown model and a provider with no credentials, and says what to do", async () => {
  const { dir, rt } = await agent({});
  expect(chooseModel(rt, { flag: "no-such-model", agentDir: dir, continuing: false }).error).toContain("not found");
  const c = chooseModel(rt, { flag: "anthropic/claude-opus-4-8", agentDir: dir, continuing: false });
  expect(c.error).toContain("no credentials for anthropic");
  expect(c.error).not.toContain("--list-models");
});

test("an AWS variable alone does not make Bedrock the default when another provider is ready", async () => {
  const { dir, rt } = await agent({ AWS_PROFILE: "work" });
  const c = chooseModel(rt, { agentDir: dir, continuing: false });
  expect(c.model?.provider).toBe("mock");
});

test("a saved default, a resumed session and Bedrock alone are left to pi", async () => {
  const a = await agent({ AWS_PROFILE: "work" }, { defaultProvider: "amazon-bedrock", defaultModel: "us.anthropic.claude-opus-4-6-v1" });
  expect(chooseModel(a.rt, { agentDir: a.dir, continuing: false })).toEqual({});
  const b = await agent({ AWS_PROFILE: "work" });
  expect(chooseModel(b.rt, { agentDir: b.dir, continuing: true })).toEqual({});
  const c = await agent({ AWS_PROFILE: "work" });
  fs.rmSync(path.join(c.dir, "models.json"));
  const rt = await createModelRuntime(c.dir);
  expect(chooseModel(rt, { agentDir: c.dir, continuing: false }).model).toBeUndefined();
});

test("doctor names a misspelled key variable", () => {
  expect(envHints({ OPEN_CODE_API_KEY: "x" })).toEqual(["OPEN_CODE_API_KEY is set but ignored: the variable is named OPENCODE_API_KEY"]);
  expect(envHints({ OPEN_CODE_API_KEY: "x", OPENCODE_API_KEY: "y" })).toEqual([]);
  expect(envHints({})).toEqual([]);
});
