/**
 * What `mnemo doctor --fix` can put right on its own. Each finding says what
 * is wrong; `fix` changes it. Nothing here touches a project, a session or a
 * memory: only Mnemo's own files under $MNEMO_HOME.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { MemoryService } from "@mnemo/memory";

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

/** Key variables that are close to a name Mnemo reads and silently ignored. */
const MISSPELLED = [["OPEN_CODE_API_KEY", "OPENCODE_API_KEY"]] as const;

export function envHints(env: Record<string, string | undefined>): string[] {
  return MISSPELLED.filter(([wrong, right]) => env[wrong] && !env[right]).map(([wrong, right]) => `${wrong} is set but ignored: the variable is named ${right}`);
}

/** How long `mnemo doctor` waits for memsrv to count what it holds. */
export const MEMORY_ANSWER_MS = 5_000;

/**
 * `mnemo doctor`'s memory lines: memsrv started on the real journal and asked
 * for its count, timed. Found is not enough: a memsrv that does not answer is
 * what the footer shows as busy, and its log says why.
 */
export async function checkMemory(memsrv: string, journal: string, home: string, timeoutMs = MEMORY_ANSWER_MS): Promise<{ ok: boolean; lines: string[] }> {
  const log = path.join(home, "logs", "memsrv.log");
  const mem = new MemoryService(memsrv, journal);
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  const stats = await Promise.race([mem.stats(), late]);
  const ms = Math.round(performance.now() - started);
  clearTimeout(timer);
  mem.stop();
  if (!stats) return { ok: false, lines: [`✗ memory  ${memsrv} did not answer within ${timeoutMs / 1000} s — its log: ${log}`] };
  const embed = stats.embedder === undefined ? "not reported (an older memsrv)" : stats.embedder === "hashing" ? "hashing (offline; MNEMO_EMBED_URL opts in to a server)" : `${stats.embedder} · ${stats.embedModel}`;
  return {
    ok: true,
    lines: [`✓ memory  ${memsrv} · ${stats.nodes} nodes · answered in ${ms} ms`, `  embed   ${embed}`, `  journal ${journal}`, `  log     ${log}`],
  };
}
