/**
 * Where Mnemo keeps per-user state — one definition.
 *
 * `~/.mnemo` (or `$MNEMO_HOME` when it is set and not blank), and it is the
 * same answer for every consumer: the memory sidecar and its journal
 * (`src/hooks/memory.ts`), reversible skill edits (`src/skills/skill-history.ts`)
 * and the tool exposure policy (`src/tools/policy.ts`).
 *
 * It lives here rather than in any of those because two of them had their own
 * copy — `hooks/memory.ts` honoured `MNEMO_HOME`, `skills/skill-history.ts` did
 * not — and a relocated home that moves the journal but not the skill history
 * is one fact stored twice, which is how one of the copies starts lying (issue
 * #20 is the ledger of exactly that class of bug).
 *
 * Not every path under the home came through here yet, and the divergence is
 * worth knowing rather than assuming: `permissions.json`, `mcp.json` and
 * `schedules.json` resolve `os.homedir()` directly, so `MNEMO_HOME` does not
 * move them. tools.json follows MNEMO_HOME; copying permissions.json's
 * resolution would have copied the divergence.
 */
import * as os from "node:os";
import * as path from "node:path";

/** The per-user Mnemo home an installed build keeps its state in. */
export function mnemoHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MNEMO_HOME?.trim();
  if (override) return override;
  return path.join(os.homedir(), ".mnemo");
}
