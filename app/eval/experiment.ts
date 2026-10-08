/**
 * One scenario, run once: build its projects in a scratch directory, run its
 * sessions in order over one Mnemo home, then evaluate its checks.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MemoryService } from "@mnemo/memory";
import { findMemsrv, journalPath } from "../src/runtime/paths.ts";
import { runSession, type EvalModel, type SessionResult } from "./harness.ts";
import type { Ctx, Scenario } from "./scenarios.ts";

export interface CheckResult {
  name: string;
  kind: string;
  pass: boolean;
  detail?: string;
}

export interface RunResult {
  scenario: string;
  memory: boolean;
  /** "mnemo" (memory on), "baseline" (none) or "hermes" (a Hermes-Agent-style memory, eval/hermes.ts). */
  arm: Arm;
  repeat: number;
  checks: CheckResult[];
  sessions: SessionResult[];
  cost: number;
  ms: number;
}

/** This repository: the scenarios, and so the answers, live in it. */
const REPO = path.resolve(import.meta.dir, "../..");

/**
 * The agent has the whole filesystem (no sandbox), and a baseline session
 * once answered by reading eval/scenarios.ts. A run that looked at this
 * repository or at another run's directory does not count as evidence.
 */
export function contamination(root: string, sessions: SessionResult[]): string | undefined {
  for (const s of sessions)
    for (const t of s.tools) {
      const args = JSON.stringify(t.args);
      // Compare with forward slashes: JSON doubles a Windows path's backslashes.
      const flat = args.replace(/\\\\/g, "/");
      if (flat.includes(REPO.replace(/\\/g, "/")) || /eval[\\/]scenarios/.test(t.output)) return `${t.name} ${args.slice(0, 200)}`;
      const other = /\/mnemo-eval-[\w-]+/.exec(flat)?.[0];
      if (other && !root.includes(other)) return `${t.name} ${args.slice(0, 200)}`;
    }
  return undefined;
}

export type Arm = "mnemo" | "baseline" | "hermes";

export async function runScenario(s: Scenario, withMemory: boolean, repeat: number, makeModel: (agentDir: string) => Promise<EvalModel>, hermes = false): Promise<RunResult> {
  const arm: Arm = withMemory ? "mnemo" : hermes ? "hermes" : "baseline";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mnemo-eval-${s.name}-`));
  const home = path.join(root, "home");
  const dirs: Record<string, string> = {};
  for (const [name, setup] of Object.entries(s.projects)) {
    dirs[name] = path.join(root, name);
    fs.mkdirSync(dirs[name]!, { recursive: true });
    setup(dirs[name]!);
  }
  const model = await makeModel(path.join(home, "agent"));
  const sessions: SessionResult[] = [];
  const started = Date.now();
  for (const plan of s.sessions) {
    plan.before?.(dirs);
    process.stdout.write(`  ${s.name} ${arm.padEnd(8)} session ${sessions.length + 1}/${s.sessions.length}…`);
    const r = await runSession({ home, cwd: dirs[plan.project]!, model, memory: withMemory, hermes }, plan.prompts);
    sessions.push(r);
    process.stdout.write(` ${(r.ms / 1000).toFixed(0)}s, ${r.tools.length} tools, $${r.cost.toFixed(4)}${r.errors.length ? `, ${r.errors.length} errors` : ""}\n`);
  }
  const memsrv = withMemory ? findMemsrv(home) : undefined;
  const memory = memsrv ? new MemoryService(memsrv, journalPath(home)) : undefined;
  const ctx: Ctx = {
    dirs,
    sessions,
    memory,
    home,
    read: (project, file) => {
      try {
        return fs.readFileSync(path.join(dirs[project]!, file), "utf8");
      } catch {
        return "";
      }
    },
  };
  const leak = contamination(root, sessions);
  const checks: CheckResult[] = [{ name: "the agent stayed out of the experiment's source and other runs", kind: "integrity", pass: !leak, detail: leak }];
  for (const c of s.checks) {
    if (c.kind === "memory" && !withMemory) continue;
    let outcome: true | string;
    try {
      outcome = await c.run(ctx);
    } catch (error) {
      outcome = `check threw: ${error instanceof Error ? error.message : String(error)}`;
    }
    checks.push({ name: c.name, kind: c.kind, pass: outcome === true, detail: outcome === true ? undefined : outcome.slice(0, 600) });
  }
  memory?.stop();
  // Everything worth keeping is in the result; a leftover directory is one more thing a later run can read.
  fs.rmSync(root, { recursive: true, force: true });
  return { scenario: s.name, memory: withMemory, arm, repeat, checks, sessions, cost: sessions.reduce((n, r) => n + r.cost, 0), ms: Date.now() - started };
}

