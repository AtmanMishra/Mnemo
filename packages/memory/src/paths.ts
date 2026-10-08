/**
 * Where memory lives and where its sidecar is found. Shared by every agent the
 * memory is attached to — Mnemo, a Claude Code hook, the MCP server — so they
 * all read and write one journal.
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
