/**
 * The transcript contract.
 *
 * This is the first piece of the rebuild, and it is first because it is the
 * thing the current interface lacks. Everything you see in a session — a user
 * turn, an assistant answer, a tool call, a diff — is a block, and the question
 * this file answers is the one the old code answered by accident: **which rows
 * may be rewritten, and which have already left for the terminal's scrollback?**
 *
 * The model, learned from reading oh-my-pi's transcript container
 * (research/oh-my-pi-interface-internals.md §2):
 *
 *   - A block is `active` while it can still change, `settled` once it cannot
 *     but is still drawn in the live viewport, and `committed` once it has been
 *     retired into native scrollback. A committed block is never rewound.
 *   - A block is `mutable` (its rows are redrawn every frame) or `appendOnly`
 *     (it publishes *stable rows* that leave for scrollback while it streams,
 *     and only ever appends).
 *   - An append-only block's stable rows must be monotonic and its
 *     `renderStableRows(count)` must prefix its full render at the same width.
 *     A publication that breaks that contract **freezes the block's stable
 *     emission** — it keeps rendering live, and the reason is recorded — rather
 *     than failing the render. A transcript that throws is worse than one that
 *     falls back to redrawing.
 *
 * Rows are strings, and rendering is width-aware: a block may return the same
 * array reference when nothing changed, which is what keeps the diff cheap.
 */

/** Where a block is in its life. */
export type BlockState = "active" | "settled" | "committed";

/** How a block's rows reach the screen. */
export type BlockMode = "mutable" | "appendOnly";

/** One semantic row that has left the live viewport for native scrollback. */
export interface StableRow {
  /**
   * Identity, not display: two publications sharing a key describe the same
   * row, and the transcript may trust the earlier rendering for it.
   */
  readonly key: string;
}

/** What a block is allowed to ask of the transcript. */
export interface TranscriptHost {
  /** Schedule a repaint. Never touches the terminal directly. */
  requestRender(): void;
}

export interface TranscriptBlock {
  /** `appendOnly` opts the block into the stable-row contract below. */
  readonly mode: BlockMode;
  /** Physical rows at this width, in order. May return a cached array. */
  render(width: number): readonly string[];
  /** False while the block is still able to change (e.g. streaming). */
  isFinalized?(): boolean;
  /** Current stable rows, in publication order. Required when appendOnly. */
  stableRows?(): readonly StableRow[];
  /**
   * Render the first `count` stable rows at `width`. The result must prefix
   * `render(width)` for as long as the contract holds.
   */
  renderStableRows?(count: number, width: number): readonly string[];
  /**
   * Drop every published stable row so the head may be re-emitted. Legal only
   * alongside a destructive display reset that also cleared the scrollback
   * those rows sat in.
   */
  resetStableRows?(): void;
  /** The one row that must survive emergency pressure, if any. */
  emergencyRow?(width: number): string | undefined;
}

/** Why a block stopped emitting stable rows, when it did. */
export interface Freeze {
  readonly key: string;
  readonly reason: string;
  /**
   * How many physical rows this block had already pushed into scrollback when
   * the contract broke. A frozen block renders its whole self live from now on,
   * so those rows may appear a second time — content is never lost, and the
   * count is here so a duplicate on screen can be traced to the block that
   * caused it rather than guessed at.
   */
  readonly duplicatedRows: number;
}

/** A block plus the transcript's bookkeeping for it. */
export interface Entry {
  readonly block: TranscriptBlock;
  state: BlockState;
  /** True once stable emission was frozen by a contract violation. */
  frozen?: Freeze;
  /** How many stable rows the transcript has taken from this block. */
  emitted: number;
  /** Physical rows this block has pushed into scrollback. */
  emittedRows: number;
}

export interface TranscriptRender {
  /** Rows that now belong to scrollback, in order. Usually empty. */
  readonly history: readonly string[];
  /** The complete live viewport. */
  readonly viewport: readonly string[];
  /** True when history must be treated as replaced (a reset happened). */
  readonly reset: boolean;
}

const EMPTY: readonly string[] = [];
const NO_STABLE_ROWS: readonly StableRow[] = [];


/**
 * The transcript: an append-only history of rows that have left, plus the live
 * viewport of blocks that can still change.
 *
 * It never infers finality from a row's position — a block says whether it is
 * finished, and the transcript takes stable rows only from blocks that offer
 * them.
 */
export class Transcript {
  #entries: Entry[] = [];
  #history: string[] = [];
  /**
   * How many history rows the caller has already been given.
   *
   * The transcript owns one history; frames carry *the part of it that has not
   * been delivered yet*. Without this cursor, rows appended between two renders
   * — by `retire()`, which commits outside any frame — would never reach the
   * terminal at all: they would be in the transcript's history and in nobody
   * else's, which is how content goes missing while every local assertion
   * still passes.
   */
  #delivered = 0;
  #host: TranscriptHost = { requestRender: () => {} };
  /** Rendered stable-row cache per (block, width). */
  #stableCache = new WeakMap<TranscriptBlock, Map<number, { count: number; rows: readonly string[] }>>();
  #lastViewport: readonly string[] = EMPTY;

  setHost(host: TranscriptHost): void {
    this.#host = host;
  }

  /** Rows already retired into native scrollback. */
  get history(): readonly string[] {
    return this.#history;
  }

  get entries(): readonly Entry[] {
    return this.#entries;
  }

  add(block: TranscriptBlock, options: { state?: BlockState } = {}): Entry {
    const entry: Entry = { block, state: options.state ?? "active", emitted: 0, emittedRows: 0 };
    this.#entries.push(entry);
    this.#host.requestRender();
    return entry;
  }

  /**
   * Retire everything that has stopped changing.
   *
   * `keepLive` is how many rows the live viewport may hold; blocks that are
   * settled are committed oldest-first until the live region fits. A block that
   * is still `active` is never retired, however tight the budget — its rows are
   * the ones the user is watching.
   *
   * A settled block with nothing left to draw is committed even when there is
   * room: its rows are already in scrollback, so keeping it "live" would only
   * mean it is offered for redrawing forever. Getting this wrong is how a
   * finished answer ends up in neither the scrollback nor the viewport.
   */
  retire(keepLive: number, width: number): void {
    let liveRows = 0;
    for (const entry of this.#entries) {
      if (entry.state === "committed") continue;
      liveRows += this.#liveRows(entry, width).length;
    }

    for (const entry of this.#entries) {
      if (entry.state !== "settled") continue;
      const rows = this.#liveRows(entry, width);
      const hasRoom = liveRows > keepLive;
      if (!hasRoom && rows.length > 0) continue;
      this.#commit(entry, rows);
      liveRows -= rows.length;
    }
    this.#host.requestRender();
  }

  /** Mark a block settled when it says it is finished; called before retiring. */
  settleFinished(): void {
    for (const entry of this.#entries) {
      if (entry.state !== "active") continue;
      if (entry.block.isFinalized?.() === true) entry.state = "settled";
    }
  }

  /** The rows of a block that are still the transcript's to redraw. */
  #liveRows(entry: Entry, width: number): readonly string[] {
    const all = entry.block.render(width);
    if (entry.block.mode !== "appendOnly") return all;
    return all.slice(entry.emitted > 0 ? this.#stablePhysicalRows(entry, width) : 0);
  }

  /** Physical rows the block's published stable rows occupy at this width. */
  #stablePhysicalRows(entry: Entry, width: number): number {
    const block = entry.block;
    if (!block.renderStableRows || entry.emitted === 0) return 0;
    const cache = this.#stableCache.get(block) ?? new Map();
    this.#stableCache.set(block, cache);
    const hit = cache.get(width);
    if (hit && hit.count === entry.emitted) return hit.rows.length;

    let rows: readonly string[] = EMPTY;
    try {
      rows = block.renderStableRows(entry.emitted, width);
    } catch (error) {
      // A block that cannot render its stable rows is frozen, not fatal.
      this.#freeze(entry, `renderStableRows threw: ${String(error)}`);
      rows = EMPTY;
    }
    cache.set(width, { count: entry.emitted, rows });
    return rows.length;
  }

  /**
   * Take any newly published stable rows into history.
   *
   * This is where the contract is enforced. Violations do not throw: the block
   * stops being append-only and keeps rendering live, with the reason kept for
   * whoever is debugging it.
   */
  #publish(entry: Entry, width: number): readonly string[] {
    const block = entry.block;
    if (block.mode !== "appendOnly" || entry.frozen) return EMPTY;
    if (!block.stableRows || !block.renderStableRows) {
      this.#freeze(entry, "appendOnly block must implement stableRows() and renderStableRows()");
      return EMPTY;
    }

    let published: readonly StableRow[] = NO_STABLE_ROWS;
    try {
      published = block.stableRows();
    } catch (error) {
      this.#freeze(entry, `stableRows threw: ${String(error)}`);
      return EMPTY;
    }

    // Monotonic: a publication may extend the previous one, never rewrite it.
    if (published.length < entry.emitted) {
      this.#freeze(entry, `stable rows went backwards: ${published.length} < ${entry.emitted}`);
      return EMPTY;
    }

    const fresh = published.length - entry.emitted;
    if (fresh === 0) return EMPTY;

    let rows: readonly string[];
    try {
      rows = block.renderStableRows(published.length, width);
    } catch (error) {
      this.#freeze(entry, `renderStableRows threw: ${String(error)}`);
      return EMPTY;
    }

    // The stable render must prefix the full render at the same width —
    // otherwise the rows already in scrollback disagree with the block.
    const full = block.render(width);
    if (!startsWithRows(full, rows)) {
      this.#freeze(entry, "stable rows are not a prefix of the full render at this width");
      return EMPTY;
    }

    const previous = entry.emitted > 0 ? block.renderStableRows(entry.emitted, width) : EMPTY;
    const added = rows.slice(previous.length);
    entry.emitted = published.length;
    entry.emittedRows += added.length;
    return added;
  }

  #freeze(entry: Entry, reason: string): void {
    entry.frozen = { key: String(entry.emitted), reason, duplicatedRows: entry.emittedRows };
    // Fall back to drawing the whole block live, from the top, forever: the
    // rows already in scrollback cannot be un-drawn, and losing the rest of the
    // block to a slicing guess would be worse than showing them twice.
    entry.emitted = 0;
    entry.emittedRows = 0;
  }

  #commit(entry: Entry, rows: readonly string[]): void {
    entry.state = "committed";
    this.#history.push(...rows);
  }

  /**
   * Render one frame: history is the batch that belongs to scrollback, the
   * viewport is everything still owned by the transcript.
   *
   * Published stable rows are *the* scrollback — they are appended to the
   * transcript's history as they are published, and the returned batch is this
   * frame's share of it. Anything else would mean two histories: the one the
   * caller is told about, and the one the transcript believes.
   */
  render(width: number): TranscriptRender {
    const viewport: string[] = [];

    for (const entry of this.#entries) {
      if (entry.state === "committed") continue;
      this.settleFinished();
      this.#history.push(...this.#publish(entry, width));
      viewport.push(...this.#liveRows(entry, width));
    }

    // History is append-only here: the one thing that may replace it is a
    // destructive reset, and there is no such path yet. When one is added it
    // must set this flag, which is why the field exists before the feature.
    const reset = false;
    const history = this.#history.slice(this.#delivered);
    this.#delivered = this.#history.length;
    this.#lastViewport = viewport;
    return { history, viewport, reset };
  }
}

/** `prefix` must be the leading rows of `rows`, at the same width. */
export function startsWithRows(rows: readonly string[], prefix: readonly string[]): boolean {
  if (prefix.length > rows.length) return false;
  for (let i = 0; i < prefix.length; i += 1) if (rows[i] !== prefix[i]) return false;
  return true;
}
