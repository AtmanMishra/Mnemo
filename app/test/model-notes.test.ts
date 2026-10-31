/** Notes for one model reach that model's system prompt, and no other's. */
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { modelNotesFile, readModelNotes } from "../src/extensions/model-notes.ts";
import { mnemoEnv } from "./helpers.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

test("a model's notes are in its system prompt; another model's are not", async () => {
  const e = await mnemoEnv({ mode: "yolo" });
  cleanup.push(() => e.close());
  const id = e.faux.getModel().id;
  const mine = modelNotesFile(e.home, id);
  fs.mkdirSync(path.dirname(mine), { recursive: true });
  fs.writeFileSync(mine, "Edit files with the edit tool, not here-documents.\n");
  fs.writeFileSync(modelNotesFile(e.home, "some-other-model"), "Think out loud.\n");
  let system = "";
  e.faux.setResponses([
    (context: unknown) => {
      system = JSON.stringify(context);
      return fauxAssistantMessage(fauxText("ok"));
    },
  ]);
  await e.controller.submit("hello there");
  await e.idle();
  expect(system).toContain(`Notes for working as ${id}`);
  expect(system).toContain("Edit files with the edit tool, not here-documents.");
  expect(system).not.toContain("Think out loud.");
});

test("a model id becomes a safe file name, and an empty or missing file is no notes", () => {
  expect(path.basename(modelNotesFile("/h", "anthropic/claude:latest"))).toBe("anthropic_claude_latest.md");
  expect(path.dirname(modelNotesFile("/h", "../../etc/passwd"))).toBe(path.join("/h", "agent", "models"));
  const home = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "mnemo-notes-"));
  cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
  expect(readModelNotes(home, "m")).toBeUndefined();
  fs.mkdirSync(path.join(home, "agent", "models"), { recursive: true });
  fs.writeFileSync(modelNotesFile(home, "m"), "  \n");
  expect(readModelNotes(home, "m")).toBeUndefined();
  fs.writeFileSync(modelNotesFile(home, "m"), "x".repeat(20_000));
  expect(readModelNotes(home, "m")!.length).toBe(16 * 1024);
});
