/**
 * `mnemo memory ingest`: names the agents it reads, and refuses one it doesn't
 * know before it looks for a model.
 */
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MEMORY_USAGE, runMemoryCommand } from "../src/memory-cli.ts";
import { MEMSRV } from "./helpers.ts";

function sink() {
  let text = "";
  return { stream: { write: (s: string) => ((text += s), true) } as never, text: () => text };
}

test("the usage names the three agents ingest reads", () => {
  expect(MEMORY_USAGE).toContain("--agent <name>");
  for (const where of ["~/.claude/projects", "~/.codex/sessions", "~/.local/share/opencode/opencode.db"]) expect(MEMORY_USAGE).toContain(where);
});

test.skipIf(!MEMSRV)("ingest --agent refuses an agent it does not read", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-ingest-cli-"));
  process.env.MNEMO_MEMSRV = MEMSRV;
  const out = sink();
  const err = sink();
  expect(await runMemoryCommand(["ingest", "--agent", "cursor"], home, path.join(home, "agent"), out.stream, err.stream)).toBe(1);
  expect(err.text()).toContain("--agent is claude-code, codex or opencode");
});
