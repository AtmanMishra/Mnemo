/**
 * A project's AGENTS.md (or CLAUDE.md, when there is no AGENTS.md) reaches the
 * model, as do the ones in folders above it and one in $MNEMO_HOME/agent. pi
 * reads them; this says Mnemo keeps it that way.
 */
import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mnemoEnv } from "./helpers.ts";

const envs: Awaited<ReturnType<typeof mnemoEnv>>[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
});

test("AGENTS.md, a parent's CLAUDE.md and the global one are in the system prompt", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-ctx-")));
  const cwd = path.join(root, "repo");
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "Parent rule: tabs, never spaces.\n");
  fs.writeFileSync(path.join(cwd, "AGENTS.md"), "Project rule: run `make check` before finishing.\n");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-home-"));
  fs.mkdirSync(path.join(home, "agent"), { recursive: true });
  fs.writeFileSync(path.join(home, "agent", "AGENTS.md"), "Global rule: answer in English.\n");
  const e = await mnemoEnv({ cwd, home });
  envs.push(e);
  const system = e.runtime.session.systemPrompt;
  for (const rule of ["Project rule: run `make check`", "Parent rule: tabs", "Global rule: answer in English"]) expect(system).toContain(rule);
});

test("CLAUDE.md is read when a folder has no AGENTS.md, and only one of the two when it has both", async () => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-ctx-")));
  fs.writeFileSync(path.join(cwd, "CLAUDE.md"), "Claude rule: small commits.\n");
  const one = await mnemoEnv({ cwd });
  envs.push(one);
  expect(one.runtime.session.systemPrompt).toContain("Claude rule: small commits.");

  fs.writeFileSync(path.join(cwd, "AGENTS.md"), "Agents rule: say why.\n");
  const both = await mnemoEnv({ cwd });
  envs.push(both);
  expect(both.runtime.session.systemPrompt).toContain("Agents rule: say why.");
  expect(both.runtime.session.systemPrompt).not.toContain("Claude rule");
});
