/**
 * Where Mnemo keeps its state. One home, decided here; nothing else resolves
 * `os.homedir()` on its own (the old credentials store did, and read the wrong
 * file while believing it was somewhere else).
 */
import * as os from "node:os";
import * as path from "node:path";

type Env = Record<string, string | undefined>;

/** `MNEMO_HOME` when set and not blank, else `~/.mnemo`. */
export function mnemoHome(env: Env = process.env): string {
  const override = env.MNEMO_HOME?.trim();
  return override || path.join(os.homedir(), ".mnemo");
}

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
