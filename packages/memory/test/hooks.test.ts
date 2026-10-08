/** Claude Code's context hooks: profiles at session start, recall per prompt, nothing to say → silence. */
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { contextHook, findMemsrv, MemoryService, MemorySession } from "../src/index.ts";

const MEMSRV = findMemsrv("/nonexistent");
const t = MEMSRV ? test : test.skip;

t("session start carries the profiles, a prompt carries what search finds, and an empty memory says nothing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-hooks-"));
  const cwd = path.join(root, "repo");
  fs.mkdirSync(cwd);
  const memory = new MemoryService(MEMSRV!, path.join(root, "journal.jsonl"));
  const o = { memory, userSkillsDir: path.join(root, "skills") };
  const parse = (s: string | undefined) => JSON.parse(s!).hookSpecificOutput as { hookEventName: string; additionalContext: string };

  expect(await contextHook({ hook_event_name: "UserPromptSubmit", cwd, prompt: "deploy the staging app" }, o)).toBeUndefined();

  const s = new MemorySession({ memory, cwd, userSkillsDir: o.userSkillsDir });
  await s.remember("project", "package manager", "pnpm");
  await memory.remember("deploys to staging use flyctl deploy --app shop-staging");

  const start = parse(await contextHook({ hook_event_name: "SessionStart", source: "startup", cwd }, o));
  expect(start.hookEventName).toBe("SessionStart");
  expect(start.additionalContext).toContain("- package manager: pnpm");
  const prompt = parse(await contextHook({ hook_event_name: "UserPromptSubmit", cwd, prompt: "how do deploys to staging work?" }, o));
  expect(prompt.additionalContext).toContain("flyctl deploy --app shop-staging");
  expect(prompt.additionalContext).not.toContain("package manager");
  expect(await contextHook({ hook_event_name: "SessionStart" }, o)).toBeUndefined();
  memory.stop();
}, 30_000);
