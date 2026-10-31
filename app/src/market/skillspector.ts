/**
 * NVIDIA SkillSpector (https://github.com/NVIDIA/SkillSpector), when the user has installed it.
 *
 * Mnemo does not ship or download it: it is a Python program with its own dependencies, installed
 * with `uv tool install git+https://github.com/NVIDIA/skillspector.git`. When `skillspector` is on
 * PATH, a skill scan also runs `skillspector scan <dir> --no-llm --format json` and reads its
 * report. Static analysis only, and offline: the child gets the base environment (no API keys) and
 * a proxy that points at a closed local port, so its live vulnerability lookup (OSV.dev) falls
 * back to its built-in list instead of calling out. That is a filter, not a sandbox: it holds for
 * SkillSpector's own HTTP client, which honours the proxy variables.
 */
import { trustedBin } from "../runtime/bin.ts";
import { baseEnv } from "../runtime/env.ts";
import { shown, type Finding, type Severity } from "./scan.ts";

export type SpectorRunner = (cmd: string[], env: Record<string, string>) => { code: number; out: string; err: string };

const TIMEOUT_MS = 120_000;
/** Nothing listens on the discard port on loopback, so every proxied request fails at once. */
const NOWHERE = "http://127.0.0.1:9";

const run: SpectorRunner = (cmd, env) => {
  const p = Bun.spawnSync(cmd, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: TIMEOUT_MS });
  return { code: p.exitCode ?? 1, out: p.stdout.toString(), err: p.stderr.toString() };
};

/** The child's environment: no credentials, and no way out through its HTTP client. */
export function spectorEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out = baseEnv(env);
  for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"]) out[k] = NOWHERE;
  out.NO_PROXY = out.no_proxy = "";
  out.SKILLSPECTOR_OSV_TIMEOUT = "2";
  return out;
}

export const spectorCommand = (bin: string, dir: string): string[] => [bin, "scan", dir, "--no-llm", "--format", "json"];

const SEVERITIES = new Set<Severity>(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);

/** The `issues` of SkillSpector's JSON report (`Finding.to_dict` in its models.py) as findings. Throws when it is not one. */
export function parseReport(out: string): Finding[] {
  // Progress lines may come first; the report is the object that starts a line.
  const start = out.search(/^\{/m);
  const report = JSON.parse(start < 0 ? out : out.slice(start)) as { issues?: unknown };
  if (!report || !Array.isArray(report.issues)) throw new Error("its output was not a SkillSpector report");
  return report.issues.map((raw) => {
    const i = raw as Record<string, unknown>;
    const at = (i.location ?? {}) as Record<string, unknown>;
    const text = (v: unknown) => (typeof v === "string" ? v : "");
    const severity = text(i.severity).toUpperCase() as Severity;
    return {
      rule: text(i.id) || "?",
      severity: SEVERITIES.has(severity) ? severity : "MEDIUM",
      message: (text(i.pattern) || text(i.explanation)).replace(/\s+/g, " ").trim(),
      file: text(at.file).replace(/\\/g, "/") || "SKILL.md",
      line: typeof at.start_line === "number" ? at.start_line : 1,
      match: shown(text(i.finding)),
      by: "skillspector",
    };
  });
}

/**
 * SkillSpector's findings for the skill in `dir`; undefined when it is not installed, or why it
 * gave none. `bin` undefined looks for it on PATH.
 */
export function runSkillspector(dir: string, o: { bin?: string; runner?: SpectorRunner } = {}): { findings: Finding[] } | { error: string } | undefined {
  const bin = o.bin ?? trustedBin("skillspector");
  if (!bin) return undefined;
  let r: ReturnType<SpectorRunner>;
  try {
    r = (o.runner ?? run)(spectorCommand(bin, dir), spectorEnv());
  } catch (e) {
    return { error: (e as Error).message };
  }
  try {
    return { findings: parseReport(r.out) };
  } catch {
    const why = r.err.trim().split("\n").at(-1) || `exit code ${r.code}`;
    return { error: why.length > 200 ? `${why.slice(0, 197)}…` : why };
  }
}
