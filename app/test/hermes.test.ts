/** The comparison arm behaves as Hermes Agent's documented memory does. */
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { HermesStore, LIMITS } from "../eval/hermes.ts";
import { runSession } from "../eval/harness.ts";
import { createFaux } from "../src/runtime/demo.ts";

test("entries are capped, duplicates refused, replace and remove need one match", () => {
  const s = new HermesStore(fs.mkdtempSync(path.join(os.tmpdir(), "hermes-")));
  expect(s.apply("memory", "add", "uses pnpm")).toContain("add ok");
  expect(s.apply("memory", "add", "uses pnpm")).toBe("Already saved.");
  s.apply("memory", "add", "tests: npm test");
  expect(() => s.apply("memory", "replace", "x", "s")).toThrow("matched 2");
  s.apply("memory", "replace", "uses yarn", "pnpm");
  expect(s.entries("memory")).toEqual(["uses yarn", "tests: npm test"]);
  expect(() => s.apply("user", "add", "x".repeat(LIMITS.user + 1))).toThrow("current_entries");
  s.apply("memory", "remove", "", "yarn");
  expect(s.snapshot()).toContain(`MEMORY (your personal notes) [`);
  expect(s.snapshot()).toContain("tests: npm test");
});

test("the snapshot is frozen for the session: a write shows up in the next session, not this one", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-cwd-"));
  const seen: string[] = [];
  const { modelRuntime, faux } = await createFaux(path.join(home, "agent"));
  const step = (reply: ReturnType<typeof fauxAssistantMessage>) => (context: unknown) => (seen.push(JSON.stringify(context)), reply);
  faux.setResponses([
    step(fauxAssistantMessage([fauxToolCall("memory", { action: "add", target: "user", content: "prefers tabs" })], { stopReason: "toolUse" })),
    step(fauxAssistantMessage(fauxText("saved"))),
    step(fauxAssistantMessage(fauxText('{"ops": [{"target": "memory", "action": "add", "content": "repo uses make"}]}'))),
    step(fauxAssistantMessage(fauxText("hello again"))),
    step(fauxAssistantMessage(fauxText('{"ops": []}'))),
  ]);
  const model = { modelRuntime, model: faux.getModel(), label: "faux", faux };
  await runSession({ home, cwd, model, memory: false, hermes: true }, ["remember I prefer tabs"]);
  const system = (i: number) => JSON.stringify((JSON.parse(seen[i]!) as { messages: { role: string; content: unknown }[] }).messages.find((m) => m.role === "system")?.content);
  expect(system(1)).not.toContain("prefers tabs"); // same session: still the frozen snapshot
  await runSession({ home, cwd, model, memory: false, hermes: true }, ["hi"]);
  expect(system(3)).toContain("prefers tabs");
  expect(system(3)).toContain("repo uses make"); // the background review's write
});

test("the background review creates and patches skills where the agent loads them; a patch needs an existing skill", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-skill-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-skill-cwd-"));
  const { modelRuntime, faux } = await createFaux(path.join(home, "agent"));
  const review = (skills: object[]) => fauxAssistantMessage(fauxText(JSON.stringify({ ops: [], skills })));
  faux.setResponses([
    fauxAssistantMessage(fauxText("released")),
    review([
      { action: "create", name: "release", description: "Cut a release", instructions: "1. npm run build\n2. npm publish" },
      { action: "patch", name: "no-such-skill", description: "x", instructions: "x" },
    ]),
    fauxAssistantMessage(fauxText("released again")),
    review([{ action: "patch", name: "release", description: "Cut a release", instructions: "1. npm run build\n2. npm run sign\n3. npm publish", reason: "publish needs a signature" }]),
  ]);
  const model = { modelRuntime, model: faux.getModel(), label: "faux", faux };
  await runSession({ home, cwd, model, memory: false, hermes: true }, ["cut a release of the package for me please"]);
  const skill = path.join(home, "agent", "skills", "release", "SKILL.md");
  expect(fs.readFileSync(skill, "utf8")).toContain("2. npm publish");
  expect(fs.existsSync(path.join(home, "agent", "skills", "no-such-skill"))).toBe(false);
  await runSession({ home, cwd, model, memory: false, hermes: true }, ["cut another release of the package please"]);
  expect(fs.readFileSync(skill, "utf8")).toContain("2. npm run sign");
});
