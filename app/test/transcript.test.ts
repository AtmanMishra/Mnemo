/**
 * The transcript contract, tested.
 *
 * These are the questions the old interface could not answer, so each test is
 * about a decision the transcript has to make rather than about formatting:
 * which rows may be rewritten, when a block leaves for scrollback, and what
 * happens when a block lies about its own output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  startsWithRows,
  Transcript,
  type StableRow,
  type TranscriptBlock,
} from "../src/transcript/transcript.ts";

/** A mutable block: its rows are redrawn every frame. */
function mutableBlock(rows: string[], finalized = false): TranscriptBlock {
  return {
    mode: "mutable",
    render: () => rows,
    isFinalized: () => finalized,
  };
}

/**
 * An append-only block that publishes `stable` rows and then renders them plus
 * `live`. Its stable render is always a prefix of its full render, which is what
 * the contract requires of an honest block.
 */
function appendOnlyBlock(opts: {
  stable: string[][];
  live?: string[];
  finalized?: boolean;
  overrides?: Partial<TranscriptBlock>;
}): TranscriptBlock {
  let published = opts.stable.length;
  const block: TranscriptBlock = {
    mode: "appendOnly",
    stableRows: (): readonly StableRow[] =>
      Array.from({ length: published }, (_, i) => ({ key: `row-${i}` })),
    renderStableRows: (count: number) => opts.stable.slice(0, count).flat(),
    render: () => [...opts.stable.flat(), ...(opts.live ?? [])],
    isFinalized: () => opts.finalized ?? false,
    ...opts.overrides,
  };
  // A test needs to simulate a later publication.
  (block as { publish?: (n: number) => void }).publish = (n: number) => {
    published = n;
  };
  return block;
}

function publish(block: TranscriptBlock, n: number): void {
  (block as unknown as { publish: (n: number) => void }).publish(n);
}

test("a mutable block renders live and retires into history when settled", () => {
  const t = new Transcript();
  const entry = t.add(mutableBlock(["hello", "world"], true));

  const first = t.render(80);
  assert.deepEqual(first.history, [], "a live block is not history");
  assert.deepEqual(first.viewport, ["hello", "world"]);

  t.settleFinished();
  assert.equal(entry.state, "settled", "a finalized block settles");
  t.retire(0, 80);

  const second = t.render(80);
  assert.deepEqual(t.history, ["hello", "world"], "settled rows leave for scrollback");
  assert.deepEqual(second.viewport, [], "and are no longer redrawn");
  assert.equal(entry.state, "committed");
});

test("an active block is never retired, however tight the budget", () => {
  const t = new Transcript();
  t.add(mutableBlock(["streaming…"], false));
  t.settleFinished();
  t.retire(0, 80);
  assert.deepEqual(t.render(80).viewport, ["streaming…"], "the row being watched stays");
  assert.deepEqual(t.history, []);
});

test("an append-only block's stable rows leave for history while it streams", () => {
  const t = new Transcript();
  const block = appendOnlyBlock({
    stable: [["thinking…"], ["still thinking…"]],
    live: ["writing the answer"],
  });
  t.add(block);

  assert.deepEqual(t.render(80).history, ["thinking…", "still thinking…"]);
  assert.deepEqual(
    t.render(80).viewport,
    ["writing the answer"],
    "the viewport holds only what has not left",
  );

  // A later publication appends rather than republishes.
  publish(block, 3);
  const grown = appendOnlyBlock({
    stable: [["thinking…"], ["still thinking…"], ["done thinking"]],
    live: ["writing the answer"],
  });
  const t2 = new Transcript();
  t2.add(grown);
  assert.deepEqual(t2.render(80).history, ["thinking…", "still thinking…", "done thinking"]);
});

test("stable rows that go backwards freeze the block instead of throwing", () => {
  const t = new Transcript();
  const block = appendOnlyBlock({ stable: [["a"], ["b"]] });
  const entry = t.add(block);
  t.render(80);

  publish(block, 1); // a retraction: illegal
  const out = t.render(80);

  assert.ok(entry.frozen, "the transcript records why stable emission stopped");
  assert.match(entry.frozen!.reason, /backwards/);
  assert.deepEqual(out.history, [], "nothing more is taken as history");
  // The fallback is deliberate: a block that contradicts itself is drawn in
  // full from the top rather than sliced by a boundary it just denied. Nothing
  // is lost; the rows already in scrollback may show twice, and the count says
  // how many so a duplicate on screen can be traced to its cause.
  assert.deepEqual(out.viewport, ["a", "b"], "the whole block renders live again");
  assert.equal(entry.frozen!.duplicatedRows, 2, "the rows that may now appear twice");
});

test("stable rows that are not a prefix of the full render freeze the block", () => {
  const t = new Transcript();
  const block = appendOnlyBlock({
    stable: [["row one"]],
    overrides: {
      // Renders something else entirely: the rows already in scrollback would
      // disagree with the block.
      render: () => ["a different first row"],
    },
  });
  const entry = t.add(block);
  const out = t.render(80);

  assert.ok(entry.frozen);
  assert.match(entry.frozen!.reason, /prefix/);
  assert.deepEqual(out.history, []);
  assert.deepEqual(out.viewport, ["a different first row"], "it falls back to live rendering");
});

test("a block whose stable render throws is frozen, not fatal", () => {
  const t = new Transcript();
  const entry = t.add(
    appendOnlyBlock({
      stable: [["a"]],
      overrides: {
        renderStableRows: () => {
          throw new Error("renderer exploded");
        },
      },
    }),
  );
  const out = t.render(80);
  assert.ok(entry.frozen);
  assert.match(entry.frozen!.reason, /exploded/);
  assert.deepEqual(out.viewport, ["a"]);
});

test("appendOnly without the required methods is frozen at the first frame", () => {
  const t = new Transcript();
  const entry = t.add({ mode: "appendOnly", render: () => ["x"] });
  t.render(80);
  assert.ok(entry.frozen);
  assert.match(entry.frozen!.reason, /must implement/);
});

test("retire commits settled blocks oldest-first until the live region fits", () => {
  const t = new Transcript();
  const first = t.add(mutableBlock(["1"], true));
  const second = t.add(mutableBlock(["2"], true));
  t.settleFinished();

  t.retire(1, 80); // room for one row only

  assert.equal(first.state, "committed", "the oldest settled block goes first");
  assert.equal(second.state, "settled", "and the budget stops the second");
  assert.deepEqual(t.history, ["1"]);
  assert.deepEqual(t.render(80).viewport, ["2"]);
});

test("stable rows are cached per width, so a frame does not re-render them", () => {
  let calls = 0;
  const t = new Transcript();
  t.add(
    appendOnlyBlock({
      stable: [["a"], ["b"]],
      overrides: {
        renderStableRows: (count: number) => {
          calls += 1;
          return [["a"], ["b"]].slice(0, count).flat();
        },
      },
    }),
  );

  t.render(80);
  const afterFirst = calls;
  t.render(80);
  assert.equal(calls, afterFirst, "the same width reuses the rendered rows");

  t.render(60);
  assert.ok(calls > afterFirst, "a different width renders again — rows are width-dependent");
});

test("startsWithRows is an exact positional check", () => {
  assert.equal(startsWithRows(["a", "b", "c"], ["a", "b"]), true);
  assert.equal(startsWithRows(["a", "b"], ["a", "b"]), true);
  assert.equal(startsWithRows(["a", "b"], []), true);
  assert.equal(startsWithRows(["a", "b"], ["b"]), false, "position matters");
  assert.equal(startsWithRows(["a"], ["a", "b"]), false, "a prefix cannot be longer");
});
