/**
 * Runs the real, compiled `mnemo` binary the way a user would: its own home, a scratch
 * project, a model provider configured through `models.json` (the mock in mock-llm.ts),
 * and nothing inherited from the developer's machine. Tests here catch what source-run
 * tests cannot: bundling (a module the binary cannot load), embedded files, the
 * sidecar found next to the binary, exit codes, real child processes.
 *
 *   MNEMO_E2E_BIN=/path/to/mnemo   test that binary (CI: the one it just built)
 *   (unset)                        build app/dist/mnemo first, once per run
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const app = path.join(import.meta.dir, "..");
const root = path.join(app, "..");
const exe = process.platform === "win32" ? ".exe" : "";

let built: string | undefined;
/** The binary under test, built once if the environment does not name one. */
export function binary(): string {
  if (process.env.MNEMO_E2E_BIN) return path.resolve(process.env.MNEMO_E2E_BIN);
  if (built) return built;
  const out = path.join(app, "dist", `mnemo${exe}`);
  const r = Bun.spawnSync(["bun", path.join(app, "scripts", "build.ts")], { cwd: app, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`build failed:\n${r.stderr.toString()}`);
  built = out;
  return out;
}

/** The memory sidecar, as CI and contributors build it. */
export function memsrv(): string | undefined {
  const candidates = [process.env.MNEMO_MEMSRV, path.join(root, "memory-layer", "target", "release", `memsrv${exe}`), path.join(root, "memory-layer", "target", "debug", `memsrv${exe}`)];
  // Normalize Git Bash's forward slashes and /../ before Windows filesystem calls.
  return candidates.filter((p): p is string => !!p).map((p) => path.resolve(p)).find((p) => fs.existsSync(p));
}

export interface World {
  /** $HOME for the run (so nothing reads the real one). */
  home: string;
  /** $MNEMO_HOME */
  mnemoHome: string;
  /** The project folder the agent works in (a git repository). */
  project: string;
  env: Record<string, string>;
  cleanup(): void;
}

/** Provider keys, Mnemo settings and Git overrides must not leak into a test. */
const DROP = /(_API_KEY|_TOKEN|_SECRET)$|^AWS_|^MNEMO_|^OPENROUTER|^ANTHROPIC|^OPENAI|^GEMINI|^GOOGLE_|^AZURE_|^GIT_/;

export function world(opts: { llm?: string; files?: Record<string, string>; env?: Record<string, string> } = {}): World {
  // Child processes expand Windows 8.3 temp paths; give every fixture the same spelling.
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-e2e-")));
  const home = path.join(base, "home");
  const mnemoHome = path.join(home, ".mnemo");
  const project = path.join(base, "project");
  fs.mkdirSync(path.join(mnemoHome, "agent"), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  for (const [rel, body] of Object.entries(opts.files ?? { "README.md": "# demo project\n" })) {
    fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
    fs.writeFileSync(path.join(project, rel), body);
  }
  // The first-run introduction covers the prompt; tests that want it pass --intro.
  fs.writeFileSync(path.join(mnemoHome, "state.json"), JSON.stringify({ onboarded: true }));
  if (opts.llm) {
    fs.writeFileSync(
      path.join(mnemoHome, "agent", "models.json"),
      JSON.stringify({ providers: { mock: { baseUrl: opts.llm, api: "openai-completions", apiKey: "mock-key", models: [{ id: "mock-1", input: ["text", "image"], contextWindow: 128000, maxTokens: 4096 }] } } }, null, 2),
    );
    fs.writeFileSync(path.join(mnemoHome, "agent", "settings.json"), JSON.stringify({ defaultProvider: "mock", defaultModel: "mock-1", defaultThinkingLevel: "off" }, null, 2));
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !DROP.test(k)) env[k] = v;
  // Use a regular config file instead of a platform's null-device path, and
  // isolate signing, hooks and identity from the developer's machine.
  const gitConfig = path.join(home, ".gitconfig");
  fs.writeFileSync(gitConfig, "");
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    MNEMO_HOME: mnemoHome,
    NO_COLOR: "1",
    MNEMO_LINKS: "0",
    MNEMO_NOTIFY: "0",
    MNEMO_MOUSE: "0",
    ...(memsrv() ? { MNEMO_MEMSRV: memsrv()! } : {}),
    ...opts.env,
  });
  const git = (command: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", "-c", "user.email=e2e@example.com", "-c", "user.name=e2e", command, ...args], { cwd: project, env, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${command} failed (${r.exitCode}):\n${r.stderr.toString()}${r.stdout.toString()}`);
  };
  try {
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "init");
  } catch (error) {
    fs.rmSync(base, { recursive: true, force: true });
    throw error;
  }
  return { home, mnemoHome, project, env, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the binary to completion. Async, so a mock server in this process keeps answering. */
export async function mnemo(w: World, args: string[], opts: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number } = {}): Promise<Run> {
  const p = Bun.spawn([binary(), ...args], {
    cwd: opts.cwd ?? w.project,
    env: { ...w.env, ...opts.env },
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => p.kill(), opts.timeoutMs ?? 60_000);
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}
