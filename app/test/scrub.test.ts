/**
 * Eval results are scrubbed before they are saved: a model that runs `env`
 * must not leave the provider key in results.json.
 */
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scrub, writeScrubbed } from "../eval/scrub.ts";

test("credential shapes and the exact values of secret-named variables are removed", () => {
  const env = { OPENCODE_API_KEY: "zz-an-unusual-shaped-key-1234567890", HOME: "/home/someone", SHORT_TOKEN: "abc", GREETING: "a-long-ordinary-value-here" };
  const out = scrub(`PATH=/bin\nOPENCODE_API_KEY=zz-an-unusual-shaped-key-1234567890\nalso oc_sk_abcdefghijklmnopqrstuvwx and /home/someone/project and abc and a-long-ordinary-value-here`, env);
  expect(out).not.toContain("zz-an-unusual-shaped-key");
  expect(out).not.toContain("oc_sk_abcdefghijkl");
  // Ordinary text and short or non-secret values stay.
  expect(out).toContain("/home/someone/project");
  expect(out).toContain("a-long-ordinary-value-here");
  expect(out).toContain(" abc ");
});

test("writeScrubbed saves the scrubbed text", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-scrub-")), "results.json");
  writeScrubbed(file, '{"output":"MY_SECRET_TOKEN=super-secret-value-0000"}', { MY_SECRET_TOKEN: "super-secret-value-0000" });
  expect(fs.readFileSync(file, "utf8")).not.toContain("super-secret-value-0000");
});
