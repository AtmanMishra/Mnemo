/**
 * The installer's animation and step list. No npm or cargo is run here —
 * what is under test is the arithmetic and the guard rails.
 */
import { test } from "node:test";
import assert from "node:assert";
import * as path from "node:path";
import { pace, steps, canAnimate, plain, WALK_BODY, WALK_LEGS } from "../bin/install.ts";

test("Nyx walks out and back rather than teleporting", () => {
  const cols = 80;
  const w = WALK_BODY[0].length * 2;
  const travel = cols - w;
  const x = (t: number) => pace(t, cols).x;
  assert.equal(x(0), 0);
  assert.equal(x(travel), travel, "reaches the far side");
  assert.equal(x(travel + 1), travel - 1, "and turns around");
  assert.equal(x(travel * 2), 0, "back where she started");
  for (let t = 0; t < travel * 4; t++) {
    assert.ok(x(t) + w <= cols, `tick ${t} put her at ${x(t)} in ${cols} columns`);
  }
});

test("she faces the way she is walking", () => {
  const cols = 80;
  const travel = cols - WALK_BODY[0].length * 2;
  assert.notDeepEqual(pace(1, cols).rows, pace(travel + 1, cols).rows);
});

test("a terminal narrower than the cat does not produce a negative offset", () => {
  for (const cols of [0, 1, 10, 39, 40, 41]) {
    const { x } = pace(7, cols);
    assert.ok(x >= 0 && x <= 1, `cols=${cols} gave x=${x}`);
  }
});

test("the blink is short and the legs cycle", () => {
  const shut = (t: number) => pace(t, 80).rows.join("").includes("_");
  assert.ok(shut(0), "a blink happens");
  assert.equal([...Array(47).keys()].filter(shut).length, 2, "two frames in every 47");
  const seen = new Set([...Array(12).keys()].map((t) => pace(t, 80).rows[7]));
  assert.equal(seen.size, WALK_LEGS.length - 1, "three distinct leg positions");
});

test("animation is off wherever nobody is watching", () => {
  // a redrawing cat in a CI log is thousands of lines of escape codes
  const tty = { isTTY: true } as any;
  assert.equal(canAnimate({}, tty), true);
  assert.equal(canAnimate({ CI: "1" }, tty), false);
  assert.equal(canAnimate({ NO_COLOR: "1" }, tty), false);
  assert.equal(canAnimate({}, { isTTY: false } as any), false, "piped output");
});

test("every step names a real directory of this repo", () => {
  const all = steps("/repo");
  // path.join, not a POSIX literal: steps() builds its cwd values with the
  // platform separator, so hard-coding "/repo/agent" here fails on Windows for
  // a reason that has nothing to do with the directory being wrong.
  assert.deepEqual(all.map((s) => s.cwd), [
    path.join("/repo", "agent"), path.join("/repo", "harness-engine"),
    path.join("/repo", "memory-layer"), path.join("/repo", "tui-go"),
  ]);
  // node before rust: the agent is what the TUI drives, and a cargo build is
  // the slowest thing here — failing fast on a missing npm is kinder
  assert.equal(all[0].cmd, "npm");
  assert.equal(all[3].cmd, "go");
  assert.ok(all.every((s) => s.label && !s.label.endsWith(".")), "labels read as progress, not sentences");
});

test("the art renders at two cells per marker", () => {
  const rows = plain(WALK_BODY);
  assert.ok(rows.every((r) => [...r].length === WALK_BODY[0].length * 2));
  assert.equal(plain(["#"], 1)[0], "█");
  assert.equal(plain(["#"], 2)[0], "██");
});
