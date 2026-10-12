/**
 * What `mnemo doctor --fix` can put right on its own. Each finding says what
 * is wrong; `fix` changes it. Nothing here touches a project, a session or a
 * memory: only Mnemo's own files under $MNEMO_HOME.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface Finding {
  problem: string;
  fix: () => string;
}

const DAY = 86_400_000;

/** Files that hold keys or what you did: readable by you alone. */
const PRIVATE_FILES = ["agent/auth.json", "state.json", ".env"];
const PRIVATE_DIRS = ["", "logs", "memory", "agent"];

function mode(p: string): number | undefined {
  return fs.statSync(p, { throwIfNoEntry: false })?.mode;
}

export function findProblems(home: string, now = Date.now()): Finding[] {
  const out: Finding[] = [];
  if (process.platform !== "win32") {
    for (const rel of PRIVATE_DIRS) {
      const p = path.join(home, rel);
      const m = mode(p);
      if (m !== undefined && (m & 0o077) !== 0)
        out.push({ problem: `${p} is readable by others (${(m & 0o777).toString(8)})`, fix: () => (fs.chmodSync(p, 0o700), `${p} → 700`) });
    }
    const logs = path.join(home, "logs");
    const files = [...PRIVATE_FILES.map((f) => path.join(home, f)), ...(fs.existsSync(logs) ? fs.readdirSync(logs).map((f) => path.join(logs, f)) : [])];
    for (const p of files) {
      const m = mode(p);
      if (m !== undefined && (m & 0o077) !== 0)
        out.push({ problem: `${p} is readable by others (${(m & 0o777).toString(8)})`, fix: () => (fs.chmodSync(p, 0o600), `${p} → 600`) });
    }
  }
  const state = path.join(home, "state.json");
  if (fs.existsSync(state)) {
    try {
      JSON.parse(fs.readFileSync(state, "utf8"));
    } catch {
      out.push({
        problem: `${state} is not valid JSON (theme, recent folders and the update setting are lost)`,
        fix: () => {
          const aside = `${state}.broken-${now}`;
          fs.renameSync(state, aside);
          return `moved it to ${aside}; Mnemo starts a fresh one`;
        },
      });
    }
  }
  const races = path.join(home, "best-of");
  if (fs.existsSync(races)) {
    const old = fs
      .readdirSync(races)
      .map((d) => path.join(races, d))
      .filter((d) => (fs.statSync(d, { throwIfNoEntry: false })?.mtimeMs ?? now) < now - 30 * DAY);
    if (old.length)
      out.push({
        problem: `${old.length} best-of run${old.length === 1 ? "" : "s"} older than 30 days kept in ${races}`,
        fix: () => {
          for (const d of old) fs.rmSync(d, { recursive: true, force: true });
          return `removed ${old.length}`;
        },
      });
  }
  return out;
}
