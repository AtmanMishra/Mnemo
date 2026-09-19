/**
 * A streamed answer, end to end, with no model anywhere near it.
 *
 * The invariant this file exists to prove is the one a terminal transcript has
 * to hold and the old interface could not state: **at every frame, the rows in
 * scrollback plus the rows in the live viewport are exactly the rows of the text
 * so far — each one once.** Not once per frame (the viewport is redrawn), not
 * twice (a head that was also redrawn), and nothing lost when a line retires.
 *
 * It runs against a scripted stream, so it needs no key and cannot flake.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AssistantBlock, wrapLine } from "../src/transcript/streaming-block.ts";
import { Transcript } from "../src/transcript/transcript.ts";

/** What the terminal shows: scrollback is append-only, the viewport is redrawn. */
class Screen {
  history: string[] = [];
  viewport: string[] = [];

  /** Every row that has ever been drawn, in order of first appearance. */
  get painted(): string[] {
    return [...this.history, ...this.viewport];
  }

  apply(frame: { history: readonly string[]; viewport: readonly string[] }): void {
    this.history.push(...frame.history);
    this.viewport = [...frame.viewport];
  }
}

function drive(deltas: string[], width: number) {
  const transcript = new Transcript();
  const block = new AssistantBlock();
  const entry = transcript.add(block);
  const screen = new Screen();
  /** Total rows in scrollback after each frame — cumulative, because that is
   *  what "scrollback never shrinks" is about; a frame's *delta* may be empty. */
  const scrollbackTotals: number[] = [];

  for (const delta of deltas) {
    block.append(delta);
    transcript.settleFinished();
    const frame = transcript.render(width);
    screen.apply(frame);
    scrollbackTotals.push(screen.history.length);
  }

  block.finish();
  transcript.settleFinished();
  const last = transcript.render(width);
  screen.apply(last);
  scrollbackTotals.push(screen.history.length);

  return { transcript, block, entry, screen, scrollbackTotals };
}

test("a streamed answer is painted once, in order, and never twice", () => {
  const deltas = [
    "The answer ",
    "is 42 because the ",
    "question was asked in base 13.\n",
    "Second paragraph starts here and ",
    "keeps going for a while.\n",
    "Third line, still streaming",
  ];
  const { screen, transcript, block } = drive(deltas, 40);

  // Everything the user typed at, in scrollback or in the live region, exactly once.
  // The block's own render is the reference: the claim is that scrollback plus
  // the live region reproduce it row for row.
  assert.deepEqual(
    screen.painted,
    [...block.render(40)],
    "scrollback + viewport = the answer, row for row, with nothing repeated",
  );

  // And the first two paragraphs are in scrollback, not still being redrawn.
  assert.ok(screen.history.length > 0, "finished lines retire");
  block.finish();
  transcript.settleFinished();
  transcript.retire(0, 40);
  assert.deepEqual(
    transcript.render(40).viewport,
    [],
    "once finished and under pressure, nothing is left to redraw",
  );
  assert.deepEqual(transcript.history, [...block.render(40)], "and everything is in scrollback");
});

test("history only ever grows, and a frame's viewport never repeats it", () => {
  const { screen, scrollbackTotals } = drive(["one\ntwo\nthree", " four\nfive"], 20);

  let previous = 0;
  for (const total of scrollbackTotals) {
    assert.ok(total >= previous, `scrollback shrank: ${previous} → ${total}`);
    previous = total;
  }
  assert.ok(scrollbackTotals.at(-1)! > 0, "something did retire");
  // Nothing in the live region may also be in scrollback.
  const overlap = screen.viewport.filter((row) => screen.history.includes(row));
  assert.deepEqual(overlap, [], "a drawn row is either scrollback or live, never both");
});

test("a mid-stream width change re-wraps without breaking the contract", () => {
  const transcript = new Transcript();
  const block = new AssistantBlock();
  transcript.add(block);
  block.append("alpha beta gamma delta epsilon zeta\n");

  // First at a wide width, then narrower: the stable rows are re-rendered for the
  // new width, and the narrower render must still be a prefix of the full one.
  const wide = transcript.render(60);
  assert.deepEqual(wide.history, ["alpha beta gamma delta epsilon zeta"]);

  const narrow = transcript.render(20);
  assert.deepEqual(
    narrow.history,
    [],
    "rows already retired at one width are not re-emitted at another",
  );
  const whole = block.render(20);
  assert.ok(whole.length > 1, "the line does wrap at 20 columns");
  assert.deepEqual(
    whole.slice(0, wrapLine("alpha beta gamma delta epsilon zeta", 20).length),
    wrapLine("alpha beta gamma delta epsilon zeta", 20),
    "the stable rows remain a prefix of the full render",
  );
});

test("appending after finish is refused loudly", () => {
  const block = new AssistantBlock();
  block.append("done\n");
  block.finish();
  assert.equal(block.isFinalized(), true);
  assert.throws(() => block.append("more"), /after finish/);
});

test("wrapLine is greedy, hard-splits, and never loses a character", () => {
  assert.deepEqual(wrapLine("a b c", 10), ["a b c"]);
  assert.deepEqual(wrapLine("aaa bbb", 3), ["aaa", "bbb"]);
  assert.deepEqual(wrapLine("abcdefgh", 3), ["abc", "def", "gh"], "a word that cannot fit splits");
  // Nothing lost, whatever the width: joining with single spaces (or none, for a
  // split word) reconstructs the input.
  const text = "the quick brown fox jumps over the lazy dog";
  for (const width of [5, 12, 40]) {
    const joined = wrapLine(text, width).join(width >= 4 ? " " : "");
    assert.equal(joined.replace(/\s+/g, " ").trim(), text);
  }
});
