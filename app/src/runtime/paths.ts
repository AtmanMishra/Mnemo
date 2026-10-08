/**
 * Where Mnemo keeps its state, and where it finds its two sidecars. One home,
 * decided here; nothing else resolves `os.homedir()` on its own (the old
 * credentials store did, and read the wrong file while believing it was
 * somewhere else).
 */
import * as fs from "node:fs";
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

/** The sidecar is `memsrv.exe` on Windows; every derived path goes through this. */
export function memsrvName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "memsrv.exe" : "memsrv";
}

/**
 * The memory sidecar, looked for in the order a person would install it:
 * an explicit override, the Mnemo home (where the installer puts it), beside
 * the running binary (a release archive), then a source checkout's build.
 */
export function findMemsrv(home: string, env: Env = process.env, exists: (p: string) => boolean = fs.existsSync): string | undefined {
  const name = memsrvName();
  const candidates = [
    env.MNEMO_MEMSRV?.trim(),
    path.join(home, "bin", name),
    path.join(path.dirname(process.execPath), name),
    ...["release", "debug"].map((p) => path.resolve(import.meta.dir, "..", "..", "..", "memory-layer", "target", p, name)),
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => exists(p));
}

/** The memory journal: the one file that holds everything Mnemo has learned. */
export function journalPath(home: string, env: Env = process.env): string {
  return env.MNEMO_MEMORY_JOURNAL?.trim() || path.join(home, "memory", "journal.jsonl");
}

/** Where skills Mnemo writes for itself live (pi discovers them from here). */
export function skillsDir(home: string): string {
  return path.join(agentDir(home), "skills");
}
