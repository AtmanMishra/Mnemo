/**
 * Commands the agent runs get an allowlisted environment: no model keys, no
 * forge or registry tokens, nothing named by a guess at what a secret looks
 * like. Not in bash, not in the Python kernel. Mnemo's own process keeps them.
 */
import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { childEnv, configuredKeys, envNames } from "../src/runtime/env.ts";
import { mnemoEnv } from "./helpers.ts";

test("only the allowlist is kept: no provider keys, no tokens, no unknown names", () => {
  const env = childEnv({
    OPENAI_API_KEY: "sk-1",
    ANTHROPIC_AUTH_TOKEN: "t",
    GITHUB_TOKEN: "ghp_x",
    GH_TOKEN: "g",
    NPM_TOKEN: "n",
    AWS_ACCESS_KEY_ID: "AKIA",
    AWS_SECRET_ACCESS_KEY: "s",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    DATABASE_URL: "postgres://u:p@h/db",
    CORP_THING: "c",
    PATH: "/bin",
    HOME: "/home/u",
    LC_ALL: "C",
    XDG_CONFIG_HOME: "/home/u/.config",
    HTTPS_PROXY: "http://proxy:3128",
    MNEMO_KERNEL_MEMORY_MB: "512",
  });
  expect(env).toEqual({ PATH: "/bin", HOME: "/home/u", LC_ALL: "C", XDG_CONFIG_HOME: "/home/u/.config", HTTPS_PROXY: "http://proxy:3128", MNEMO_KERNEL_MEMORY_MB: "512" });
});

test("allowlisted names match in any case, as Windows spells them", () => {
  expect(childEnv({ Path: "C:\\Windows", SystemRoot: "C:\\Windows", windir: "C:\\Windows", GitHub_Token: "x" })).toEqual({ Path: "C:\\Windows", SystemRoot: "C:\\Windows", windir: "C:\\Windows" });
});

test("named variables come back: MNEMO_PASS_ENV and the passEnv setting; a custom provider's keys go", () => {
  const env = { GITHUB_TOKEN: "ghp_x", SSH_AUTH_SOCK: "/s", OPENAI_API_KEY: "sk-1", HOME: "/h", MNEMO_PASS_ENV: "OPENAI_API_KEY, SSH_AUTH_SOCK" };
  expect(childEnv(env, [], ["GITHUB_TOKEN"])).toEqual({ GITHUB_TOKEN: "ghp_x", SSH_AUTH_SOCK: "/s", OPENAI_API_KEY: "sk-1", HOME: "/h" });
  // A models.json `$HOME` is a key Mnemo pays with, so even an allowlisted name is held back, unless passed.
  expect(childEnv({ HOME: "/h" }, ["HOME"])).toEqual({});
  expect(childEnv({ HOME: "/h" }, ["HOME"], ["HOME"])).toEqual({ HOME: "/h" });
  expect(envNames(" A,b_2 ,, 3x, $C ")).toEqual(["A", "b_2"]);
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
  delete process.env.GITHUB_TOKEN;
});

test("the bash tool runs without the provider keys or a GITHUB_TOKEN", async () => {
  process.env.OPENAI_API_KEY = "sk-should-not-leak";
  process.env.GITHUB_TOKEN = "ghp_should-not-leak";
  const e = await mnemoEnv({ mode: "yolo" });
  envs.push(e);
  let output = "";
  e.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: 'echo "key=[$OPENAI_API_KEY] gh=[$GITHUB_TOKEN] home=[${HOME:+set}]"' })], { stopReason: "toolUse" }),
    (context) => {
      const last = context.messages.at(-1) as { content?: { type: string; text?: string }[] };
      output = (last.content ?? []).map((c) => c.text ?? "").join("");
      return fauxAssistantMessage(fauxText("done"));
    },
  ]);
  await e.controller.submit("show the env");
  await e.idle();
  expect(output).toContain("key=[] gh=[] home=[set]");
  expect(process.env.OPENAI_API_KEY).toBe("sk-should-not-leak");
});

test("the passEnv setting hands a token to the bash tool", async () => {
  process.env.GITHUB_TOKEN = "ghp_passed-on-purpose";
  const e = await mnemoEnv({ mode: "yolo" });
  envs.push(e);
  e.host.settings.set("passEnv", "GITHUB_TOKEN");
  let output = "";
  e.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: 'echo "gh=[$GITHUB_TOKEN]"' })], { stopReason: "toolUse" }),
    (context) => {
      const last = context.messages.at(-1) as { content?: { type: string; text?: string }[] };
      output = (last.content ?? []).map((c) => c.text ?? "").join("");
      return fauxAssistantMessage(fauxText("done"));
    },
  ]);
  await e.controller.submit("show the token");
  await e.idle();
  expect(output).toContain("gh=[ghp_passed-on-purpose]");
});

test("no key pi-ai reads for a provider is on the allowlist", () => {
  // Read pi-ai itself rather than trusting a copy of its list.
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
  expect(names.size).toBeGreaterThan(30);
  expect(childEnv(Object.fromEntries([...names].map((n) => [n, "x"])))).toEqual({});
});
