/**
 * The frame's job, stated as tests: a first run is taught, a configured run is
 * not, and nothing ever exceeds the width it was handed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { banner, fit, renderFrame, rule, type FrameOptions } from "../src/frame/frame.ts";

const fresh: FrameOptions = {
  rows: 24, cols: 96,
  runtime: "Bun 1.3.14",
  home: "/home/u/.mnemo",
  memory: false,
  kernel: false,
};

const configured: FrameOptions = {
  ...fresh,
  provider: "openrouter",
  model: "deepseek-v4",
  memory: true,
  kernel: true,
};

test("a first run is told what to do, in order", () => {
  const frame = renderFrame(fresh);
  assert.match(frame, /MNEMO/);
  assert.match(frame, /Bun 1\.3\.14/, "the runtime is stated, not implied");
  assert.match(frame, /nothing is set up yet/);
  assert.match(frame, /1\. \/login/);
  assert.match(frame, /2\. \/model/);
  assert.match(frame, /3\. ask for something/);
  assert.match(frame, /memory off.*kernel off/s, "what is off is said plainly");
});

test("a configured machine is not onboarded", () => {
  const frame = renderFrame(configured);
  // The facts come from the status module now, so the line reads as its
  // segments rather than as a hand-built sentence.
  assert.match(frame, /ready\. openrouter {2}· {2}deepseek-v4/);
  assert.doesNotMatch(frame, /nothing is set up/);
  assert.doesNotMatch(frame, /\/login/, "no setup instructions it does not need");
  // An on feature is named, an off one says "off": a status line that appended
  // "on" to everything would be noise where it is read most.
  assert.match(frame, /memory {2}· {2}kernel/s);
});

test("no line exceeds the width, whatever the width is", () => {
  for (const cols of [40, 60, 96, 200]) {
    const frame = renderFrame({ ...configured, cols });
    for (const line of frame.split("\n")) {
      assert.ok(line.length <= cols, `line longer than ${cols}: ${JSON.stringify(line)}`);
    }
  }
});

test("the height is respected by dropping the tail, never the head", () => {
  const frame = renderFrame({ ...fresh, rows: 6 });
  const lines = frame.split("\n");
  assert.ok(lines.length <= 5, "rows - 1: the frame never overflows its height");
  assert.match(lines[0], /MNEMO/, "identity survives");
  assert.match(lines[2], /TRANSCRIPT/);
});

test("fit marks what it cut rather than silently truncating", () => {
  assert.equal(fit("short", 20), "short");
  assert.equal(fit("exactly-ten", 11), "exactly-ten");
  assert.equal(fit("abcdefgh", 5), "abcd…");
  assert.equal(fit("anything", 0), "", "no width means no output, not a crash");
});

test("the banner and rules fill their width exactly", () => {
  for (const cols of [30, 96]) {
    assert.equal(banner(cols, "Bun 1.3.14").length, cols);
    assert.equal(rule("TRANSCRIPT", cols).length, cols);
  }
});
