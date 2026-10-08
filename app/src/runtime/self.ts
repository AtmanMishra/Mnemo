/**
 * The command that runs this program again: the compiled binary itself, or
 * bun on the source entry. Best-of-n starts its candidates with it.
 */
import * as path from "node:path";

export function selfCommand(): string[] {
  const exe = process.execPath;
  return /bun(\.exe)?$/.test(path.basename(exe)) ? [exe, path.resolve(import.meta.dir, "..", "..", "bin", "mnemo.ts")] : [exe];
}
