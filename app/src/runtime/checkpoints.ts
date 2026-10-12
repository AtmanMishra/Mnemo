/**
 * What the project's files looked like before each turn changed them, so a
 * rewind can put them back.
 *
 * Before the first `edit` or `write` of a file in a turn, its bytes (or the
 * fact that it did not exist) are kept under that turn's user message. Turns
 * are named by their user message's session entry id. Rewinding to a turn
 * restores every file any later turn touched to the state the earliest of them
 * found it in. Changes made by shell commands are not seen, and the record
 * lives as long as the process.
 */
import * as fs from "node:fs";

/** null: the file did not exist. */
type Before = Buffer | null;

export class Checkpoints {
  /** The turn edits are filed under now; sub-agents' edits go to their parent's turn. */
  turn: string | undefined;
  readonly #byTurn = new Map<string, Map<string, Before>>();

  /** Keep `file` as it is now, unless this turn already has it. */
  keep(file: string, turn = this.turn): void {
    if (!turn) return;
    let files = this.#byTurn.get(turn);
    if (!files) this.#byTurn.set(turn, (files = new Map()));
    if (files.has(file)) return;
    let before: Before;
    try {
      before = fs.readFileSync(file);
    } catch {
      before = null;
    }
    files.set(file, before);
  }

  /** What a rewind to `turns[0]` would restore: the first state of each file from these turns, in order. */
  plan(turns: readonly string[]): Map<string, Before> {
    const out = new Map<string, Before>();
    for (const t of turns) for (const [file, before] of this.#byTurn.get(t) ?? []) if (!out.has(file)) out.set(file, before);
    return out;
  }

  /** Put the files back; returns the ones that changed. Later turns' records are dropped. */
  restore(turns: readonly string[]): string[] {
    const changed: string[] = [];
    for (const [file, before] of this.plan(turns)) {
      let now: Buffer | null;
      try {
        now = fs.readFileSync(file);
      } catch {
        now = null;
      }
      if (before === null ? now === null : now !== null && before.equals(now)) continue;
      if (before === null) fs.rmSync(file, { force: true });
      else fs.writeFileSync(file, before);
      changed.push(file);
    }
    for (const t of turns) this.#byTurn.delete(t);
    return changed;
  }
}
