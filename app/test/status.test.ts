/**
 * The status line's job: say what is true, say what to do about what is not, and
 * never say anything twice or say it in a colour that overstates it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PRESETS, renderStatusLine, segmentText, segmentsFor, type StatusFacts } from "../src/status/status.ts";

const configured: StatusFacts = {
  runtime: "Bun 1.3.14",
  provider: "openrouter",
  model: "deepseek-v4",
  memory: true,
  kernel: true,
};

const fresh: StatusFacts = {
  runtime: "Bun 1.3.14",
  memory: false,
  kernel: true,
};

test("a configured machine reads as its provider and model", () => {
  assert.equal(renderStatusLine(configured, { width: 80 }), "openrouter  ·  deepseek-v4  ·  memory  ·  kernel");
});

test("a machine with no provider is told what to run, not left blank", () => {
  const line = renderStatusLine(fresh, { width: 80 });
  assert.match(line, /no provider — \/login/);
  assert.equal(segmentsFor(fresh)[0]!.alarm, true, "and it is marked as a problem");
});

test("a missing model is not an alarm", () => {
  // A provider with no default model still runs; it just asks each time.
  const segment = segmentText("model", { ...configured, model: undefined });
  assert.equal(segment.text, "");
  assert.equal(segment.alarm, undefined);
  assert.doesNotMatch(renderStatusLine({ ...configured, model: undefined }, { width: 80 }), /undefined/);
});

test("an off feature says so plainly", () => {
  const line = renderStatusLine({ ...configured, memory: false }, { width: 80 });
  assert.match(line, /memory off/);
  assert.match(line, /kernel/, "and the live one is still listed");
});

test("presets pick different segments", () => {
  assert.equal(renderStatusLine(configured, { width: 80, preset: "minimal" }), "openrouter");
  const full = renderStatusLine(configured, { width: 200, preset: "full" });
  assert.match(full, /Bun 1\.3\.14/);
  assert.match(full, /memory/);
  assert.ok(PRESETS.full!.right.includes("home"));
});

test("an unknown preset falls back rather than throwing", () => {
  assert.equal(renderStatusLine(configured, { width: 80, preset: "nonsense" }), renderStatusLine(configured, { width: 80 }));
});

test("the line is fitted to the width, and never exceeds it", () => {
  for (const width of [10, 20, 41, 200]) {
    const line = renderStatusLine(configured, { width, prefix: "  " });
    assert.ok(line.length <= width, `${line.length} > ${width}: ${JSON.stringify(line)}`);
  }
  assert.match(renderStatusLine(configured, { width: 20 }), /…$/, "what was cut is marked");
});

test("nothing is padded to fill the width", () => {
  const line = renderStatusLine(configured, { width: 200 });
  assert.equal(line, line.trimEnd(), "a line that must be read is not stretched");
});
