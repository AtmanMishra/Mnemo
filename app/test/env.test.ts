/**
 * Commands the agent runs do not see the keys that pay for the model: not in
 * bash, not in the Python kernel. Mnemo's own process keeps them.
 */
import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { PROVIDER_KEYS, childEnv, configuredKeys } from "../src/runtime/env.ts";
import { mnemoEnv } from "./helpers.ts";

test("provider keys are dropped, everything else and MNEMO_PASS_ENV names are kept", () => {
  const env = childEnv({ OPENAI_API_KEY: "sk-1", ANTHROPIC_AUTH_TOKEN: "t", STRIPE_API_KEY: "s", PATH: "/bin", MY_KEY: "m" }, ["MY_KEY"]);
  expect(env).toEqual({ STRIPE_API_KEY: "s", PATH: "/bin" });
  expect(childEnv({ OPENAI_API_KEY: "sk-1", MNEMO_PASS_ENV: "OPENAI_API_KEY" }).OPENAI_API_KEY).toBe("sk-1");
});

test("a custom provider's keys are read from the $NAMEs in models.json", () => {
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "mnemo-models-"));
  expect(configuredKeys(dir)).toEqual([]);
  fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { x: { apiKey: "$CORP_LLM_KEY", headers: { a: "${CORP_HDR}" } } } }));
  expect(configuredKeys(dir).sort()).toEqual(["CORP_HDR", "CORP_LLM_KEY"]);
});

const envs: Awaited<ReturnType<typeof mnemoEnv>>[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
  delete process.env.OPENAI_API_KEY;
});

test("the bash tool runs without the provider keys", async () => {
  process.env.OPENAI_API_KEY = "sk-should-not-leak";
  const e = await mnemoEnv({ mode: "yolo" });
  envs.push(e);
  let output = "";
  e.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: 'echo "key=[$OPENAI_API_KEY] home=[${HOME:+set}]"' })], { stopReason: "toolUse" }),
    (context) => {
      const last = context.messages.at(-1) as { content?: { type: string; text?: string }[] };
      output = (last.content ?? []).map((c) => c.text ?? "").join("");
      return fauxAssistantMessage(fauxText("done"));
    },
  ]);
  await e.controller.submit("show the env");
  await e.idle();
  expect(output).toContain("key=[] home=[set]");
  expect(process.env.OPENAI_API_KEY).toBe("sk-should-not-leak");
});

test("every key pi-ai reads for a provider is dropped", () => {
  // Read pi-ai itself rather than trusting a copy of its list: a provider added
  // upstream must fail here until env.ts knows its key.
  const dist = path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai")));
  const names = new Set<string>();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) for (const m of fs.readFileSync(p, "utf8").matchAll(/"([A-Z][A-Z0-9_]*_(?:API_KEY|TOKEN))"/g)) names.add(m[1]!);
    }
  };
  walk(dist);
  // AWS's own session credentials are inherited on purpose (SECURITY.md).
  names.delete("AWS_SESSION_TOKEN");
  expect(names.size).toBeGreaterThan(30);
  expect([...names].filter((n) => !PROVIDER_KEYS.has(n))).toEqual([]);
});
