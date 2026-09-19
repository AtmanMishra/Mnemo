/**
 * The figure, tested on the rules that make it readable rather than on its
 * exact pixels — the art may be redrawn; the rules may not be broken.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { KARKINOS, MIN_FIGURE_COLS, TAGLINE, paint, splash, widthOf } from "../src/brand/brand.ts";

test("a mark draws at two cells for the figure, one for the wordmark", () => {
  assert.deepEqual(paint(["#"], 2), ["██"]);
  assert.deepEqual(paint(["#"], 1), ["█"]);
  assert.deepEqual(paint(["v"], 2), ["▄▄"], "claws are lower half-blocks");
});

test("an eye is a hole, not a shape", () => {
  const drawn = paint(["#O#"], 2).join("");
  assert.equal(drawn, "██  ██", "the eye is negative space");
  assert.doesNotMatch(drawn, /[^█ ]/, "nothing is drawn in the eye itself");
});

test("a marker nobody defined draws nothing at all", () => {
  // Silence, not a block — but silence still occupies its cell, or a typo would
  // silently close a gap in the figure and the art would quietly change shape.
  assert.deepEqual(paint(["?z"], 2), ["    "], "two unknown marks, two empty cells each");
  assert.deepEqual(paint(["?"], 1), [" "]);
});

test("the figure is ten cells wide at mascot scale", () => {
  assert.equal(widthOf(KARKINOS.idle, 2), 10);
  for (const row of paint(KARKINOS.idle, 2)) {
    assert.equal(widthOf([row[0] === "█" || row[0] === "▄" ? "#" : "#"], 2), 2, "sanity");
  }
});

test("a figure wider than the terminal is not shown at all", () => {
  assert.deepEqual(splash(30), [], "half a crab is worse than no crab");
  assert.deepEqual(splash(MIN_FIGURE_COLS - 1), []);
  const wide = splash(60);
  assert.equal(wide.length, 7, "five rows of figure, the tagline, and a blank");
  assert.match(wide.at(-2)!, new RegExp(TAGLINE.replace(/ /g, " ")), "the tagline is under it, whole");
});

test("the tagline is centred with the figure, not left behind", () => {
  const wide = splash(60);
  const figure = wide[1]!;
  const tagline = wide.at(-2)!;
  // Compare centres, not left edges: a centred line's *start* differs with its
  // length, which is exactly what centring means.
  const centreOf = (line: string) => {
    const trimmed = line.trim();
    return line.indexOf(trimmed) + trimmed.length / 2;
  };
  assert.ok(
    Math.abs(centreOf(figure) - centreOf(tagline)) <= 1,
    `both lines are centred on the same axis:\n${wide.join("\n")}`,
  );
});
