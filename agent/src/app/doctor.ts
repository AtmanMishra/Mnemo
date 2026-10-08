/**
 * doctor — is this installation able to work?
 *
 * The same question the Go interface answered with `mnemo --doctor`, asked by
 * the application that replaced it. Two rules carry over unchanged, because
 * they were learned from a real failed install:
 *
 *  1. **A check that fails must print the line that fixes it.** A diagnosis
 *     without a remedy is a slower way of saying "something is wrong", and the
 *     person reading it is already frustrated.
 *  2. **Required and optional are different sentences.** A missing memory
 *     sidecar turns a feature off; a missing provider means nothing works. An
 *     exit code that conflates them sends people after the wrong thing.
 *
 * Nothing here calls a model or touches the network: doctor is the one command
 * that has to work when everything else is broken. Every fact arrives through
 * `Probes`, so the failure paths are tested rather than imagined — a diagnostic
 * that is wrong about a broken machine is worse than no diagnostic.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { mnemoHome } from "../home.ts";
import { resolveMemsrvPaths, MEMSRV_NAME } from "../hooks/memory.ts";
import { resolvePythonBin } from "../python.ts";
import { MIN_BUN } from "../runtime_check.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export interface DoctorLine {
  name: string;
  ok: boolean;
  /** A missing required piece breaks the installation; an optional one is a feature that is off. */
  required: boolean;
  detail: string;
  /** Empty when ok, and never empty when not: the rule this file exists for. */
  fix?: string;
  /** The rendered row, so every consumer shows the same thing. */
  text: string;
}

export interface DoctorProbes {
  runtime: string;
  home: string;
  homeWritable: boolean;
  providers: string[];
  model: string;
  memsrv: { path: string; exists: boolean };
  /** The Python the ipy kernel will spawn, and whether it was found. */
  kernel: { path: string; exists: boolean };
  /** The interface the app drives, and whether it is installed. */
  agent: { script: string; exists: boolean };
}

function line(name: string, ok: boolean, required: boolean, detail: string, fix?: string): DoctorLine {
  const mark = ok ? "ok  " : required ? "FAIL" : "warn";
  const rows = [`  ${mark}  ${name.padEnd(18)} ${detail}`];
  if (!ok && fix) rows.push(`        fix: ${fix}`);
  return { name, ok, required, detail, fix, text: rows.join("\n") };
}

/** Renders the whole diagnosis. Deterministic: same probes in, same lines out. */
export function doctorLines(p: DoctorProbes): DoctorLine[] {
  const out: DoctorLine[] = [];

  out.push(line("runtime", true, true, p.runtime));

  out.push(
    p.homeWritable
      ? line("home directory", true, true, p.home)
      : line("home directory", false, true, `${p.home} is not writable`,
          `create it and make it writable, or point MNEMO_HOME at a directory that exists`),
  );

  out.push(
    p.providers.length > 0
      ? line("provider", true, true, p.providers.join(", "))
      : line("provider", false, true, "no provider is configured",
          "run mnemo and type /login (or /login <provider> <key> if you know the name)"),
  );

  // Optional either way: a provider with no default model still runs, it just
  // asks which model every time — annoying, not broken.
  out.push(
    p.model
      ? line("default model", true, false, p.model)
      : line("default model", false, false, "none chosen",
          "run /model in Mnemo to pick one from what your key can run"),
  );

  out.push(
    p.agent.exists
      ? line("interface", true, true, p.agent.script)
      : line("interface", false, true, "the coding-agent package is not installed",
          `cd ${path.dirname(path.dirname(p.agent.script))} && bun install`),
  );

  out.push(
    p.memsrv.exists
      ? line("memory sidecar", true, false, p.memsrv.path)
      : line("memory sidecar", false, false, "not found",
          `build it (cd memory-layer && cargo build --bin memsrv) or point MNEMO_MEMSRV_BIN at one — the Memory pane stays off without it`),
  );

  out.push(
    p.kernel.exists
      ? line("ipy kernel", true, false, p.kernel.path)
      : line("ipy kernel", false, false, "no Python interpreter found",
          "install Python 3 (the kernel is how code actually runs), or set SEA_PYTHON to an interpreter"),
  );

  return out;
}

/** Non-zero only when something required is missing — the number a script reads. */
export function doctorExitCode(lines: DoctorLine[]): number {
  return lines.some((l) => l.required && !l.ok) ? 1 : 0;
}

export interface ProbeInput {
  env?: NodeJS.ProcessEnv;
  home?: string;
  repoRoot?: string;
  runtime?: string;
  exists?: (p: string) => boolean;
  writable?: (p: string) => boolean;
  providers?: () => string[];
  model?: () => string;
}

/** Whether a directory can actually be written to — the failure that happens, not the one that is easy to check. */
function writableDir(dir: string): boolean {
  const probe = path.join(dir, ".mnemo-doctor-probe");
  try {
    fs.writeFileSync(probe, "probe");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/** Reads the machine. Everything injected has a real default; nothing is guessed. */
export function probesOf(input: ProbeInput = {}): DoctorProbes {
  const env = input.env ?? process.env;
  const exists = input.exists ?? fs.existsSync;
  const home = input.home ?? mnemoHome(env);
  const repoRoot = input.repoRoot ?? REPO_ROOT;

  const memsrvPaths = resolveMemsrvPaths({ env, home, repoRoot, exists });
  const python = resolvePythonBin(env);
  const agentDir = path.join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent");

  const bunVersion = (globalThis as { Bun?: { version: string } }).Bun?.version;
  return {
    runtime: bunVersion ? `Bun ${bunVersion}` : `Node ${process.version} (Bun ${MIN_BUN.major}.${MIN_BUN.minor}+ is the runtime the app targets)`,
    home,
    homeWritable: exists(home) && (input.writable ? input.writable(home) : writableDir(home)),
    providers: input.providers ? input.providers() : [],
    model: input.model ? input.model() : "",
    memsrv: { path: memsrvPaths.binary, exists: exists(memsrvPaths.binary) },
    kernel: { path: python, exists: python !== "" && exists(python) },
    agent: { script: agentDir, exists: exists(agentDir) },
  };
}

export { MEMSRV_NAME };
