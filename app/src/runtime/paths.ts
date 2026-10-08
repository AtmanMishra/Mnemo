/**
 * Where Mnemo keeps its state, and where it finds its two sidecars. One home,
 * decided here; nothing else resolves `os.homedir()` on its own (the old
 * credentials store did, and read the wrong file while believing it was
 * somewhere else).
 */
import * as path from "node:path";

type Env = Record<string, string | undefined>;

// Home, sidecar and journal are memory's, shared with every agent it is attached to.
export { findMemsrv, journalPath, memsrvName, mnemoHome } from "@mnemo/memory";

/**
 * pi's agent directory inside the Mnemo home: auth.json, models.json,
 * settings.json, sessions/, skills/, prompts/, extensions/. Kept apart from a
 * standalone pi install (`~/.pi/agent`) so the two never fight over a file.
 */
export function agentDir(home: string): string {
  return path.join(home, "agent");
}

/**
 * pi reads its directory from `PI_CODING_AGENT_DIR` wherever it does not take
 * one as a parameter, so it is set once, before any session exists.
 */
export function pointPiAt(dir: string, env: Env = process.env): void {
  env.PI_CODING_AGENT_DIR = dir;
}

/** Where skills Mnemo writes for itself live (pi discovers them from here). */
export function skillsDir(home: string): string {
  return path.join(agentDir(home), "skills");
}
