/**
 * What the project's files looked like before each turn changed them, so a
 * rewind can put them back.
 *
 * Before the first `edit` or `write` of a file in a turn, its bytes (or the
 * fact that it did not exist) are kept under that turn's user message. Turns
 * are named by their user message's session entry id. Rewinding to a turn
 * restores every file any later turn touched to the state the earliest of them
 * found it in. What a shell command or a Python cell changed is kept too, in a
 * git repository (runtime/shell-snapshot.ts). The record lives as long as the process.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** null: the file did not exist. */
type Before = Buffer | null;

export class Checkpoints {
  /** The turn edits are filed under now; sub-agents' edits go to their parent's turn. */
  turn: string | undefined;
  readonly #byTurn = new Map<string, Map<string, Before>>();

  /** Keep `file` as it is now (or as `before` says it was), unless this turn already has it. */
  keep(file: string, turn = this.turn, before?: Before): void {
    if (!turn) return;
    let files = this.#byTurn.get(turn);
    if (!files) this.#byTurn.set(turn, (files = new Map()));
    if (files.has(file)) return;
    if (before === undefined) {
      try {
        before = fs.readFileSync(file);
      } catch {
        before = null;
      }
    }
    files.set(file, before);
  }

  /** What a rewind to `turns[0]` would restore: the first state of each file from these turns, in order. */
  plan(turns: readonly string[]): Map<string, Before> {
    const out = new Map<string, Before>();
    for (const t of turns) for (const [file, before] of this.#byTurn.get(t) ?? []) if (!out.has(file)) out.set(file, before);
    return out;
  }

  /**
   * Put the files back; returns the ones that changed. Later turns' records are dropped.
   * Each file on its own: one that cannot be put back does not stop the rest. A
   * symlink now in a file's place is removed, never written through; a folder now
   * in its place is left alone.
   */
  restore(turns: readonly string[]): string[] {
    const changed: string[] = [];
    for (const [file, before] of this.plan(turns)) {
      try {
        let st: fs.Stats | undefined;
        try {
          st = fs.lstatSync(file);
        } catch {
          st = undefined;
        }
        if (st?.isDirectory()) continue;
        if (st?.isFile() && before !== null && before.equals(fs.readFileSync(file))) continue;
        if (!st && before === null) continue;
        if (st?.isSymbolicLink()) fs.unlinkSync(file);
        if (before === null) fs.rmSync(file, { force: true });
        else {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, before);
        }
        changed.push(file);
      } catch {
        // This one stays as it is; the others still go back.
      }
    }
    for (const t of turns) this.#byTurn.delete(t);
    return changed;
  }
}
