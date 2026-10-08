/**
 * Terminal-Bench tasks, run with Mnemo inside each task's container.
 *
 *   bun eval/tbench.ts --tasks <terminal-bench>/original-tasks --bin <dir with mnemo + memsrv> \
 *     --home <settings dir> --out <dir> [--arm memory|none]… [--only a,b,c]
 *
 * Per task: build the task's image, start it, put the compiled `mnemo` and
 * `memsrv` in it, run `mnemo -p "<instruction>" --yolo` in the task's working
 * directory with the task's own time limit, then copy in the task's tests and
 * run its `run-tests.sh`. A task is resolved when the pytest summary has at
 * least one PASSED and no FAILED or ERROR — Terminal-Bench's own rule.
 *
 * Arms differ only in memory: `none` passes --no-memory; `memory` shares one
 * memory across all tasks in order, so later tasks can use what earlier ones
 * taught. Each arm gets a copy of --home (model settings) of its own.
 *
 * Network: builds and containers share the host's network and its HTTPS
 * proxy, whose CA bundle is added to every image (see withHostCa), so the
 * agent and the tests can install what they need (Terminal-Bench gives its
 * agents the internet too).
 * OPENCODE_API_KEY (or whichever key the model needs) comes from the
 * environment and is never written anywhere.
 */
import { writeScrubbed, scrub } from "./scrub.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Arm = "memory" | "none" | "oracle";

interface Args {
  tasks: string;
  bin: string;
  home: string;
  out: string;
  arms: Arm[];
  only?: string[];
  parallel: number;
}

function parse(argv: string[]): Args {
  const a: Partial<Args> & { arms: Args["arms"] } = { arms: [], parallel: 2 };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    const next = () => argv[++i]!;
    if (v === "--tasks") a.tasks = next();
    else if (v === "--bin") a.bin = next();
    else if (v === "--home") a.home = next();
    else if (v === "--out") a.out = next();
    else if (v === "--arm") a.arms.push(next() as Arm);
    else if (v === "--only") a.only = next().split(",");
    else if (v === "--parallel") a.parallel = Number(next());
    else throw new Error(`unknown argument ${v}`);
  }
  if (!a.tasks || !a.bin || !a.home || !a.out) throw new Error("--tasks, --bin, --home and --out are required");
  if (a.arms.length === 0) a.arms = ["none", "memory"];
  return a as Args;
}

/**
 * The host's outbound proxy inspects TLS. Every image gets its CA bundle (the
 * public roots plus the proxy's) and the variables that point tools at it,
 * right after each FROM, and apt is pointed at https mirrors; nothing else in
 * a task's Dockerfile changes.
 */
const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? "";
const PROXY = proxy ? ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"] : [];
const CA_HOST = process.env.SSL_CERT_FILE ?? "/root/.ccr/ca-bundle.crt";
/** A folder holding the `uv` and `uvx` binaries (MNEMO_TB_UV). */
const UV_DIR = process.env.MNEMO_TB_UV;
const CA_VARS = ["SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "NODE_EXTRA_CA_CERTS", "PIP_CERT", "GIT_SSL_CAINFO"];

export function withHostCa(dockerfile: string): string {
  // The proxy only tunnels HTTPS, so apt's http mirrors become https ones.
  const apt =
    `RUN for f in /etc/apt/sources.list /etc/apt/sources.list.d/*; do [ -f "$f" ] && sed -i 's#http://#https://#g' "$f"; done; ` +
    `[ -d /etc/apt ] && echo 'Acquire::https::CAInfo "/etc/host-ca.crt";' > /etc/apt/apt.conf.d/99host-ca; true`;
  // Every run-tests.sh fetches uv from astral.sh, which the proxy refuses;
  // `curl … | sh` then exits 0, so uv is put where that installer puts it.
  const uv = `COPY uv/ /root/.local/bin/\nRUN printf 'export PATH="$HOME/.local/bin:$PATH"\\n' > /root/.local/bin/env`;
  const inject = `COPY host-ca.crt /etc/host-ca.crt\nENV ${CA_VARS.map((v) => `${v}=/etc/host-ca.crt`).join(" ")}\n${apt}\n${uv}`;
  return dockerfile.replace(/^(FROM\s.*)$/gm, `$1\n${inject}`);
}

/** Terminal-Bench's own base images, which its registry no longer serves here. */
const BASES: Record<string, string> = {
  "ghcr.io/laude-institute/t-bench/python-3-13": "FROM python:3.13-slim-bookworm\nRUN apt-get update && apt-get install -y tmux asciinema && rm -rf /var/lib/apt/lists/*\nWORKDIR /app\n",
  "ghcr.io/laude-institute/t-bench/ubuntu-24-04": "FROM ubuntu:24.04\nRUN apt-get update && apt-get install -y tmux asciinema && rm -rf /var/lib/apt/lists/*\nWORKDIR /app\n",
};

async function dockerBuild(context: string, dockerfile: string, image: string) {
  const ctx = fs.mkdtempSync(path.join(os.tmpdir(), "tb-build-"));
  try {
    if (context) fs.cpSync(context, ctx, { recursive: true });
    if (fs.existsSync(CA_HOST)) fs.copyFileSync(CA_HOST, path.join(ctx, "host-ca.crt"));
    else fs.writeFileSync(path.join(ctx, "host-ca.crt"), "");
    fs.mkdirSync(path.join(ctx, "uv"), { recursive: true });
    if (UV_DIR) for (const f of ["uv", "uvx"]) fs.copyFileSync(path.join(UV_DIR, f), path.join(ctx, "uv", f));
    fs.writeFileSync(path.join(ctx, "Dockerfile"), withHostCa(dockerfile));
    const args = PROXY.flatMap((k) => ["--build-arg", `${k}=${proxy}`]);
    return await run(["docker", "build", "-q", "--network", "host", ...args, "-t", image, ctx], { timeoutMs: 1_800_000 });
  } finally {
    fs.rmSync(ctx, { recursive: true, force: true });
  }
}

async function build(dir: string, image: string) {
  const dockerfile = fs.readFileSync(path.join(dir, "Dockerfile"), "utf8");
  for (const [, ref] of dockerfile.matchAll(/^FROM\s+(?:--platform=\S+\s+)?(\S+)/gm)) {
    const [repo] = ref!.split(":");
    if (!BASES[repo!]) continue;
    const have = await run(["docker", "image", "inspect", ref!]);
    if (have.code === 0) continue;
    const base = await dockerBuild("", BASES[repo!]!, ref!);
    if (base.code !== 0) return base;
  }
  return dockerBuild(dir, dockerfile, image);
}

const PASS_ENV = ["OPENCODE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY"];

async function run(cmd: string[], o: { timeoutMs?: number; input?: string } = {}): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: o.input === undefined ? "ignore" : Buffer.from(o.input) });
  let timedOut = false;
  const timer = o.timeoutMs ? setTimeout(() => ((timedOut = true), p.kill()), o.timeoutMs) : undefined;
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (timer) clearTimeout(timer);
  return { code: timedOut ? 124 : code, out: out + err };
}

/** Terminal-Bench's pytest rule: something passed and nothing failed. */
export function resolved(output: string): { resolved: boolean; passed: number; failed: number } {
  const passed = (output.match(/^PASSED /gm) ?? []).length;
  const failed = (output.match(/^(FAILED|ERROR) /gm) ?? []).length;
  return { resolved: passed > 0 && failed === 0, passed, failed };
}

/** Model spend so far in a home: every assistant message's cost in pi's session files. */
function spend(home: string): number {
  let total = 0;
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl"))
        for (const m of fs.readFileSync(p, "utf8").matchAll(/"cost":\{[^}]*?"total":([\d.e-]+)/g)) total += Number(m[1]);
    }
  };
  walk(path.join(home, "agent", "sessions"));
  return total;
}

interface Result {
  task: string;
  arm: string;
  resolved: boolean;
  passed: number;
  failed: number;
  agentExit: number;
  agentSeconds: number;
  cost: number;
}

async function runTask(a: Args, task: string, arm: Arm, home: string): Promise<Result> {
  const dir = path.join(a.tasks, task);
  const yaml = fs.readFileSync(path.join(dir, "task.yaml"), "utf8");
  const instruction = (/^instruction:\s*\|[-+]?\n((?:  .*\n|\s*\n)+)/m.exec(yaml)?.[1] ?? "").replace(/^  /gm, "").trim();
  const limit = Number(/max_agent_timeout_sec:\s*([\d.]+)/.exec(yaml)?.[1] ?? 900) * 1000;
  const testLimit = Number(/max_test_timeout_sec:\s*([\d.]+)/.exec(yaml)?.[1] ?? 180) * 1000;
  const image = `tb-${task}`;
  const name = `tb-${task}-${arm}`;
  const logDir = path.join(a.out, arm, task);
  fs.mkdirSync(logDir, { recursive: true });

  const built = await build(dir, image);
  if (built.code !== 0) {
    writeScrubbed(path.join(logDir, "build.txt"), built.out);
    return { task, arm, resolved: false, passed: 0, failed: 0, agentExit: -1, agentSeconds: 0, cost: 0 };
  }
  await run(["docker", "rm", "-f", name]);
  const env = [...PROXY.flatMap((k) => ["-e", `${k}=${proxy}`]), "-e", "TEST_DIR=/tests"];
  const started = await run([
    "docker", "run", "-d", "--name", name, "--network", "host", ...env,
    "-v", `${path.resolve(a.bin)}:/opt/mnemo:ro`,
    "-v", `${path.resolve(home)}:/mnemo-home`,
    "--entrypoint", "sh", image, "-c", "sleep infinity",
  ]);
  if (started.code !== 0) throw new Error(`docker run ${task}: ${started.out}`);

  try {
    const before = spend(home);
    const keys = PASS_ENV.filter((k) => process.env[k]).flatMap((k) => ["-e", k]);
    const t0 = Date.now();
    // The oracle runs the task's reference solution: what it cannot solve is
    // broken by this machine's network, not by any agent.
    if (arm === "oracle") {
      const sh = path.join(dir, "solution.sh");
      // solution.yaml is keystrokes for a terminal: its one-line commands, in order.
      const script = fs.existsSync(sh)
        ? fs.readFileSync(sh, "utf8")
        : [...fs.readFileSync(path.join(dir, "solution.yaml"), "utf8").matchAll(/^- command:\s*(.+)$/gm)].map((m) => m[1]).join("\n");
      await run(["docker", "exec", "-i", name, "sh", "-c", "cat > /tmp/solution.sh"], { input: script });
    }
    const agent = await run(
      arm === "oracle"
        ? ["docker", "exec", name, "bash", "/tmp/solution.sh"]
        : ["docker", "exec", ...keys, "-e", "MNEMO_HOME=/mnemo-home", name, "/opt/mnemo/mnemo", "-p", instruction, "--yolo", ...(arm === "none" ? ["--no-memory"] : [])],
      { timeoutMs: limit },
    );
    const agentSeconds = Math.round((Date.now() - t0) / 1000);
    writeScrubbed(path.join(logDir, "agent.txt"), agent.out);
    const cost = spend(home) - before;

    await run(["docker", "exec", name, "mkdir", "-p", "/tests"]);
    await run(["docker", "cp", `${path.join(dir, "tests")}/.`, `${name}:/tests`]);
    await run(["docker", "cp", path.join(dir, "run-tests.sh"), `${name}:/tests/run-tests.sh`]);
    const tests = await run(["docker", "exec", name, "bash", "/tests/run-tests.sh"], { timeoutMs: testLimit + 300_000 });
    writeScrubbed(path.join(logDir, "tests.txt"), tests.out);
    return { task, arm, ...resolved(tests.out), agentExit: agent.code, agentSeconds, cost };
  } finally {
    await run(["docker", "rm", "-f", name]);
  }
}

async function main() {
  const a = parse(process.argv.slice(2));
  const tasks = (a.only ?? fs.readdirSync(a.tasks)).filter((t) => fs.existsSync(path.join(a.tasks, t, "task.yaml")));
  fs.mkdirSync(a.out, { recursive: true });
  const homes = Object.fromEntries(
    a.arms.map((arm) => {
      const h = path.join(a.out, `home-${arm}`);
      if (!fs.existsSync(h)) fs.cpSync(a.home, h, { recursive: true });
      return [arm, h];
    }),
  );
  const resultsFile = path.join(a.out, "results.jsonl");
  const done = new Set(
    fs.existsSync(resultsFile)
      ? fs.readFileSync(resultsFile, "utf8").trim().split("\n").filter(Boolean).map((l) => {
          const r = JSON.parse(l) as Result;
          return `${r.arm}/${r.task}`;
        })
      : [],
  );
  // Each arm walks the tasks in order (memory accumulates in that order); the arms run side by side.
  await Promise.all(
    a.arms.map(async (arm) => {
      for (const task of tasks) {
        if (done.has(`${arm}/${task}`)) continue;
        const r = await runTask(a, task, arm, homes[arm]!).catch(
          (e): Result => (console.error(`${arm} ${task}: ${e}`), { task, arm, resolved: false, passed: 0, failed: 0, agentExit: -2, agentSeconds: 0, cost: 0 }),
        );
        fs.appendFileSync(resultsFile, scrub(`${JSON.stringify(r)}\n`));
        console.log(`${arm.padEnd(6)} ${task.padEnd(32)} ${r.resolved ? "✓" : "✗"}  ${r.passed}/${r.passed + r.failed} tests  ${r.agentSeconds}s  $${r.cost.toFixed(4)}`);
      }
    }),
  );
}

if (import.meta.main) await main();
