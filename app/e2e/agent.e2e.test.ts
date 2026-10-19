// The compiled binary, end to end, against the mock provider: the CLI surface, the
// tool loop, the permission gate, key scrubbing, memory across sessions, the Python
// kernel, sub-agents, sessions. Each test is one thing a user does.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import pkg from "../package.json" with { type: "json" };
import { startMockLLM, systemPrompt, textOf, toolResults, type MockLLM, type Script } from "./mock-llm.ts";
import { binary, memsrv, mnemo, world, type World } from "./harness.ts";
import { hasPty, KEY, submit, terminal, type Terminal } from "./pty.ts";

const T = 120_000;
let script: Script = () => ({ text: "done" });
let llm: MockLLM;
const worlds: World[] = [];
const fresh = (opts: Parameters<typeof world>[0] = {}) => {
  const w = world({ llm: llm.url, ...opts });
  worlds.push(w);
  return w;
};
/** Sets what the model does for the next run and forgets earlier requests. */
function play(s: Script) {
  script = s;
  llm.requests.length = 0;
  turns = 0;
}
let turns = 0;
/** Agent turns in order; anything past the list says "done". */
const steps = (...replies: ReturnType<Script>[]): Script => () => replies[turns++] ?? { text: "done" };
const lastToolResult = () => toolResults(llm.agentRequests().at(-1)!).at(-1) ?? "";

beforeAll(() => {
  binary(); // build once, outside any test's timeout
  llm = startMockLLM((req, ctx) => script(req, ctx));
}, 300_000);
afterAll(() => {
  llm.stop();
  for (const w of worlds) w.cleanup();
});

describe("command line", () => {
  test("--version prints the package version", async () => {
    const r = await mnemo(fresh(), ["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(pkg.version);
  }, T);

  test("--help lists the commands", async () => {
    const r = await mnemo(fresh(), ["--help"]);
    expect(r.code).toBe(0);
    for (const word of ["doctor", "update", "uninstall", "memory", "--demo", "--plan", "--yolo"]) expect(r.stdout).toContain(word);
  }, T);

  test("an unknown argument fails with a message, not a crash", async () => {
    const r = await mnemo(fresh(), ["--no-such-flag"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("unknown argument --no-such-flag");
  }, T);

  test("-p with no model configured says how to fix it", async () => {
    const w = world();
    worlds.push(w);
    const r = await mnemo(w, ["-p", "hi"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("/login");
  }, T);

  test("--demo --dump plays the scripted turn with no key", async () => {
    const w = world();
    worlds.push(w);
    const r = await mnemo(w, ["--demo", "--dump"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("retries");
  }, T);
});

describe("doctor", () => {
  test("finds the model, the sidecar and Python; --fix repairs loose permissions", async () => {
    const w = fresh();
    if (process.platform !== "win32") fs.chmodSync(w.mnemoHome, 0o755);
    const r = await mnemo(w, ["doctor"]);
    expect(r.stdout).toContain("✓ model   mock/mock-1");
    if (memsrv()) expect(r.stdout).toMatch(/✓ memory  .* · \d+ nodes · answered in \d+ ms\n  embed   hashing/);
    if (process.platform === "win32") return;
    expect(r.stdout).toContain("readable by others");
    expect(r.code).toBe(1);
    const fix = await mnemo(w, ["doctor", "--fix"]);
    expect(fix.stdout).toContain("fixed");
    expect(fs.statSync(w.mnemoHome).mode & 0o077).toBe(0);
    const again = await mnemo(w, ["doctor"]);
    expect(again.stdout).not.toContain("readable by others");
    expect(again.code).toBe(memsrv() ? 0 : 1);
  }, T);
});

describe("the tool loop", () => {
  test("write creates a file and the answer is printed", async () => {
    const w = fresh();
    play(steps({ tools: [{ name: "write", args: { path: "hello.txt", content: "hi there\n" } }] }, { text: "wrote it" }));
    const r = await mnemo(w, ["-p", "write hello.txt"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("wrote it");
    // What the run took goes to stderr, never into the answer.
    expect(r.stderr).toMatch(/mnemo: \d+ model calls, 1 tool calls, .* tokens, \$\d/);
    expect(r.stdout).not.toContain("model calls");
    expect(fs.readFileSync(path.join(w.project, "hello.txt"), "utf8")).toBe("hi there\n");
  }, T);

  test("read sends the file back to the model", async () => {
    const w = fresh({ files: { "notes.md": "the secret word is pelican\n" } });
    play(steps({ tools: [{ name: "read", args: { path: "notes.md" } }] }, { text: "ok" }));
    await mnemo(w, ["-p", "read notes"]);
    expect(lastToolResult()).toContain("pelican");
  }, T);

  test("edit changes a file in place", async () => {
    const w = fresh({ files: { "a.ts": "export const x = 1;\n" } });
    play(steps({ tools: [{ name: "edit", args: { path: "a.ts", edits: [{ oldText: "x = 1", newText: "x = 2" }] } }] }, { text: "ok" }));
    await mnemo(w, ["-p", "bump x"]);
    expect(fs.readFileSync(path.join(w.project, "a.ts"), "utf8")).toBe("export const x = 2;\n");
  }, T);

  test("bash runs and its output reaches the model", async () => {
    const w = fresh();
    play(steps({ tools: [{ name: "bash", args: { command: "echo from-the-shell" } }] }, { text: "ok" }));
    await mnemo(w, ["-p", "run echo"]);
    expect(lastToolResult()).toContain("from-the-shell");
  }, T);

  test("-c continues the last session: the model sees the earlier turn", async () => {
    const w = fresh();
    play(steps({ text: "first answer about zebras" }));
    await mnemo(w, ["-p", "first question"]);
    play(steps({ text: "second answer" }));
    const r = await mnemo(w, ["-c", "-p", "second question"]);
    expect(r.code).toBe(0);
    const sent = llm.agentRequests()[0]!.messages.map((m) => textOf(m.content)).join("\n");
    expect(sent).toContain("first question");
    expect(sent).toContain("zebras");
  }, T);
});

describe("images", () => {
  // pi decodes images with a WebAssembly module it reads from disk; a binary must carry it.
  test("read returns an image to the model, not 'Image omitted'", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const w = fresh();
    fs.writeFileSync(path.join(w.project, "dot.png"), png);
    play(steps({ tools: [{ name: "read", args: { path: "dot.png" } }] }, { text: "ok" }));
    await mnemo(w, ["-p", "look at dot.png"]);
    const sent = JSON.stringify(llm.agentRequests().at(-1)!.messages);
    expect(sent).not.toContain("Image omitted");
    expect(sent).toMatch(/image\/png|data:image/);
  }, T);
});

describe("permission gate", () => {
  test("--plan refuses a write", async () => {
    const w = fresh();
    play(steps({ tools: [{ name: "write", args: { path: "nope.txt", content: "x" } }] }, { text: "ok" }));
    await mnemo(w, ["--plan", "-p", "write nope.txt"]);
    expect(fs.existsSync(path.join(w.project, "nope.txt"))).toBe(false);
    expect(lastToolResult().toLowerCase()).toMatch(/plan|blocked|denied|refus/);
  }, T);

  test("an MCP server's tool runs from the compiled binary", async () => {
    const w = fresh();
    const server = path.join(import.meta.dir, "..", "test", "fixtures", "mcp-server.ts");
    fs.mkdirSync(path.join(w.mnemoHome, "agent"), { recursive: true });
    fs.writeFileSync(path.join(w.mnemoHome, "agent", "mcp.json"), JSON.stringify({ mcpServers: { shouter: { command: process.execPath, args: [server], exposure: "direct" } } }));
    play(steps({ tools: [{ name: "mcp__shouter__shout", args: { text: "pelican" } }] }, { text: "ok" }));
    const r = await mnemo(w, ["--yolo", "-p", "shout"]);
    expect(r.code).toBe(0);
    expect(lastToolResult()).toContain("PELICAN");
  }, T);

  test("a deny rule holds even in --yolo", async () => {
    const w = fresh();
    fs.writeFileSync(path.join(w.mnemoHome, "permissions.json"), JSON.stringify({ rules: [{ tool: "bash", pattern: "touch*", action: "deny" }] }));
    play(steps({ tools: [{ name: "bash", args: { command: "touch denied.txt" } }] }, { text: "ok" }));
    await mnemo(w, ["--yolo", "-p", "touch"]);
    expect(fs.existsSync(path.join(w.project, "denied.txt"))).toBe(false);
  }, T);

  test("a deny rule sees through a compound command", async () => {
    const w = fresh();
    fs.writeFileSync(path.join(w.mnemoHome, "permissions.json"), JSON.stringify({ rules: [{ tool: "bash", pattern: "touch*", action: "deny" }] }));
    play(steps({ tools: [{ name: "bash", args: { command: "echo hi && touch sneaky.txt" } }] }, { text: "ok" }));
    await mnemo(w, ["--yolo", "-p", "touch"]);
    expect(fs.existsSync(path.join(w.project, "sneaky.txt"))).toBe(false);
  }, T);

  test("a broken permissions.json stops edits instead of dropping the rules", async () => {
    const w = fresh();
    fs.writeFileSync(path.join(w.mnemoHome, "permissions.json"), "{ not json");
    play(steps({ tools: [{ name: "write", args: { path: "x.txt", content: "x" } }] }, { text: "ok" }));
    await mnemo(w, ["--yolo", "-p", "write"]);
    expect(fs.existsSync(path.join(w.project, "x.txt"))).toBe(false);
  }, T);

  test("Mnemo's own credentials file cannot be read by the read tool", async () => {
    const w = fresh();
    fs.writeFileSync(path.join(w.mnemoHome, "agent", "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "sk-ant-should-never-leave" } }));
    play(steps({ tools: [{ name: "read", args: { path: path.join(w.mnemoHome, "agent", "auth.json") } }] }, { text: "ok" }));
    await mnemo(w, ["--yolo", "-p", "read auth"]);
    expect(JSON.stringify(llm.requests)).not.toContain("sk-ant-should-never-leave");
  }, T);
});

describe("secrets", () => {
  const key = "sk-ant-e2e-0123456789abcdef";
  test("commands the agent runs do not see provider keys or forge tokens", async () => {
    const w = fresh({ env: { ANTHROPIC_API_KEY: key, GITHUB_TOKEN: "ghp_e2e-should-not-leak" } });
    play(steps({ tools: [{ name: "bash", args: { command: "env" } }] }, { text: "ok" }));
    await mnemo(w, ["-p", "print env"]);
    expect(lastToolResult()).toContain("HOME=");
    expect(lastToolResult()).not.toContain(key);
    expect(lastToolResult()).not.toContain("ghp_e2e-should-not-leak");
  }, T);

  test("MNEMO_PASS_ENV hands one back", async () => {
    const w = fresh({ env: { ANTHROPIC_API_KEY: key, MNEMO_PASS_ENV: "ANTHROPIC_API_KEY" } });
    play(steps({ tools: [{ name: "bash", args: { command: "env" } }] }, { text: "ok" }));
    await mnemo(w, ["-p", "print env"]);
    expect(lastToolResult()).toContain(key);
  }, T);
});

describe("memory", () => {
  const hasMemsrv = !!memsrv();
  test.if(hasMemsrv)("a fact remembered in one session is in the next session's prompt", async () => {
    const w = fresh();
    play(steps({ tools: [{ name: "memory_remember", args: { scope: "project", key: "deploy target", value: "we deploy with flyctl to region ams" } }] }, { text: "noted" }));
    const first = await mnemo(w, ["-p", "remember how we deploy", "--no-reflect"]);
    expect(first.code).toBe(0);
    play(steps({ text: "you deploy with fly" }));
    await mnemo(w, ["-p", "how do we deploy?", "--no-reflect"]);
    const req = llm.agentRequests()[0]!;
    expect(systemPrompt(req) + JSON.stringify(req.messages)).toContain("flyctl");
  }, T);

  test.if(hasMemsrv)("an OpenRouter key does not send memory to OpenRouter, so memory keeps answering", async () => {
    // Takes the connection and never answers: memsrv embedding through it
    // would stall every memory call until the app gave up on memory.
    let connections = 0;
    const hung = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open: () => void connections++, data: () => {} } });
    try {
      const url = `http://127.0.0.1:${hung.port}/api/v1/embeddings`;
      const w = fresh({ env: { OPENROUTER_API_KEY: "sk-or-e2e-not-a-key", OPENROUTER_EMBED_URL: url } });
      // memsrv also reads $MNEMO_HOME/.env, which the app's own environment does not reach.
      fs.writeFileSync(path.join(w.mnemoHome, ".env"), `OPENROUTER_API_KEY=sk-or-e2e-not-a-key\nOPENROUTER_EMBED_URL=${url}\n`);
      play(steps({ tools: [{ name: "memory_remember", args: { scope: "project", key: "deploy target", value: "we deploy with flyctl to region ams" } }] }, { text: "noted" }));
      expect((await mnemo(w, ["-p", "remember how we deploy", "--no-reflect"])).code).toBe(0);
      play(steps({ tools: [{ name: "memory_search", args: { query: "how do we deploy flyctl" } }] }, { text: "ok" }));
      await mnemo(w, ["-p", "how do we deploy?", "--no-reflect"]);
      const req = llm.agentRequests()[0]!;
      expect(systemPrompt(req) + JSON.stringify(req.messages)).toContain("flyctl");
      expect(lastToolResult()).toContain("flyctl");
      const doctor = await mnemo(w, ["doctor"]);
      expect(doctor.stdout).toContain("  embed   hashing");
      expect(connections).toBe(0);
    } finally {
      hung.stop(true);
    }
  }, T);

  test.if(hasMemsrv)("memory_search finds what was remembered", async () => {
    const w = fresh();
    play(steps({ tools: [{ name: "memory_remember", args: { scope: "project", key: "test runner", value: "tests run with vitest --run" } }] }, { text: "ok" }));
    await mnemo(w, ["-p", "remember", "--no-reflect"]);
    play(steps({ tools: [{ name: "memory_search", args: { query: "how are tests run" } }] }, { text: "ok" }));
    await mnemo(w, ["-p", "search", "--no-reflect"]);
    expect(lastToolResult()).toContain("vitest");
  }, T);

  test.if(hasMemsrv)("mnemo memory status answers", async () => {
    const r = await mnemo(fresh(), ["memory", "status"]);
    expect(r.code).toBe(0);
  }, T);

  test("--no-memory runs without the sidecar", async () => {
    const w = fresh();
    play(steps({ text: "no memory here" }));
    const r = await mnemo(w, ["--no-memory", "-p", "hi"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("no memory here");
  }, T);
});

describe("python kernel", () => {
  const python = Bun.which("python3") ?? Bun.which("python");
  test.if(!!python)("ipy_run executes Python from the compiled binary", async () => {
    const w = fresh({ env: { MNEMO_PYTHON: python! } });
    play(steps({ tools: [{ name: "ipy_run", args: { code: "print(6 * 7)" } }] }, { text: "ok" }));
    await mnemo(w, ["--yolo", "-p", "compute"]);
    expect(lastToolResult()).toContain("42");
  }, T);

  test.if(!!python)("the kernel does not see provider keys either", async () => {
    const key = "sk-ant-kernel-0123456789";
    const w = fresh({ env: { MNEMO_PYTHON: python!, ANTHROPIC_API_KEY: key } });
    play(steps({ tools: [{ name: "ipy_run", args: { code: "import os; print(sorted(os.environ))" } }] }, { text: "ok" }));
    await mnemo(w, ["--yolo", "-p", "env"]);
    expect(lastToolResult()).toContain("HOME");
    expect(lastToolResult()).not.toContain("ANTHROPIC_API_KEY");
  }, T);
});

describe("sub-agents", () => {
  test("spawn_subagent runs a child on the same model and returns its answer", async () => {
    const w = fresh();
    const firstUser = (req: Parameters<Script>[0]) => textOf(req.messages.find((m) => m.role === "user")?.content);
    let spawned = false;
    play((req) => {
      if (firstUser(req).includes("count the files")) return { text: "child says: 1 file" };
      if (!spawned) {
        spawned = true;
        return { tools: [{ name: "spawn_subagent", args: { task: "count the files", access: "read-only" } }] };
      }
      return { text: "parent done" };
    });
    const r = await mnemo(w, ["--yolo", "-p", "please delegate"]);
    expect(r.code).toBe(0);
    expect(llm.agentRequests().some((q) => firstUser(q).includes("count the files"))).toBe(true);
    expect(lastToolResult()).toContain("child says: 1 file");
    expect(r.stdout).toContain("parent done");
  }, T);
});

describe("install layout", () => {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const mnemoName = `mnemo${suffix}`;
  const memsrvName = `memsrv${suffix}`;

  // HOME does not isolate HKCU. Both install and uninstall edit the real user
  // PATH, so restore its raw value, registry type and absence after each test.
  let savedUserPath: string | undefined;
  const powershell = (script: string, env: Record<string, string> = {}) => {
    const encoded = Buffer.from(`$ErrorActionPreference = 'Stop'\n${script}`, "utf16le").toString("base64");
    const r = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`Windows PATH fixture failed (${r.exitCode}): ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  };
  beforeEach(() => {
    if (process.platform !== "win32") return;
    savedUserPath = powershell(`
      $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
      $saved = @{ present = $false }
      try {
        if ($key -and @($key.GetValueNames()) -contains 'Path') {
          $saved = @{ present = $true; value = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); kind = [int]$key.GetValueKind('Path') }
        }
      } finally { if ($key) { $key.Close() } }
      [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($saved | ConvertTo-Json -Compress)))
    `);
  });
  afterEach(() => {
    const saved = savedUserPath;
    savedUserPath = undefined;
    if (saved === undefined) return;
    powershell(`
      $saved = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:MNEMO_E2E_USER_PATH)) | ConvertFrom-Json
      $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
      try {
        if ($saved.present) { $key.SetValue('Path', $saved.value, [Microsoft.Win32.RegistryValueKind]$saved.kind) }
        else { $key.DeleteValue('Path', $false) }
      } finally { $key.Close() }
    `, { MNEMO_E2E_USER_PATH: saved });
  });

  /** The binary and sidecar where the installer puts them, with the PATH link it makes. */
  function installed(w: World) {
    const bin = path.join(w.mnemoHome, "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.copyFileSync(binary(), path.join(bin, mnemoName));
    fs.chmodSync(path.join(bin, mnemoName), 0o755);
    if (memsrv()) fs.copyFileSync(memsrv()!, path.join(bin, memsrvName));
    const linkDir = path.join(w.home, ".local", "bin");
    fs.mkdirSync(linkDir, { recursive: true });
    if (process.platform !== "win32") fs.symlinkSync(path.join(bin, "mnemo"), path.join(linkDir, "mnemo"));
    fs.mkdirSync(path.join(w.mnemoHome, "memory"), { recursive: true });
    fs.writeFileSync(path.join(w.mnemoHome, "memory", "journal.jsonl"), "");
    return { bin, exe: path.join(bin, mnemoName), link: path.join(linkDir, "mnemo"), linkDir };
  }
  const run = async (w: World, exe: string, args: string[], env: Record<string, string> = {}) => {
    const p = Bun.spawn([exe, ...args], { cwd: w.project, env: { ...w.env, ...env }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { stdout, stderr, code };
  };

  test("doctor finds the sidecar next to the installed binary without MNEMO_MEMSRV", async () => {
    if (!memsrv()) return;
    const w = fresh();
    const i = installed(w);
    const env = { ...w.env };
    delete env.MNEMO_MEMSRV;
    const p = Bun.spawn([i.exe, "doctor"], { cwd: w.project, env, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    expect(out).toContain(`✓ memory  ${path.join(i.bin, memsrvName)}`);
  }, T);

  test.if(!!memsrv())("install --yes copies a download into $MNEMO_HOME/bin, where it finds its sidecar", async () => {
    const w = fresh();
    const dl = path.join(w.home, "Downloads", "mnemo");
    fs.mkdirSync(dl, { recursive: true });
    fs.copyFileSync(binary(), path.join(dl, mnemoName));
    fs.chmodSync(path.join(dl, mnemoName), 0o755);
    fs.copyFileSync(memsrv()!, path.join(dl, memsrvName));
    const env = { ...w.env };
    delete env.MNEMO_MEMSRV;
    const bin = path.join(w.mnemoHome, "bin");
    const r = await run({ ...w, env }, path.join(dl, mnemoName), ["install", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`copied ${mnemoName} and ${memsrvName} to ${bin}`);
    // Off Windows nothing edits a shell profile: it says the line instead.
    if (process.platform === "win32") {
      expect(r.stdout).toContain(`added ${bin} to your PATH`);
      expect(r.stdout).toContain("Open a new terminal and type  mnemo");
    } else expect(r.stdout).toContain(`export PATH="${bin}:$PATH"`);
    expect(fs.readdirSync(bin).sort()).toEqual([memsrvName, mnemoName]);
    const doctor = await run({ ...w, env }, path.join(bin, mnemoName), ["doctor"]);
    expect(doctor.stdout).toContain(`✓ memory  ${path.join(bin, memsrvName)}`);
    // The download, run again while the installed copy is first on the PATH, says so.
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
    const again = await run({ ...w, env: { ...env, [pathKey]: `${bin}${path.delimiter}${env[pathKey] ?? ""}` } }, path.join(dl, mnemoName), ["doctor"]);
    expect(again.stdout).toContain(`! path    mnemo in a new terminal is ${path.join(bin, mnemoName)}, not this one (${path.join(dl, mnemoName)})`);
    const installed = await run({ ...w, env }, path.join(bin, mnemoName), ["install", "--yes"]);
    expect(installed.stdout).toContain(`Mnemo is installed in ${bin}`);
  }, T);

  test("uninstall --yes removes the program and keeps what it learned", async () => {
    const w = fresh();
    const i = installed(w);
    const r = await run(w, i.exe, ["uninstall", "--yes"], { MNEMO_LINK_DIR: i.linkDir });
    expect(r.code).toBe(0);
    // Windows schedules deletion of the running executable after it exits.
    for (let n = 0; n < 50 && fs.existsSync(i.exe); n++) await Bun.sleep(100);
    expect(fs.existsSync(i.exe)).toBe(false);
    expect(fs.existsSync(path.join(i.bin, memsrvName))).toBe(false);
    if (process.platform !== "win32") expect(fs.existsSync(i.link)).toBe(false);
    expect(fs.existsSync(path.join(w.mnemoHome, "memory", "journal.jsonl"))).toBe(true);
  }, T);

  test("uninstall without a terminal and without --yes changes nothing", async () => {
    const w = fresh();
    const i = installed(w);
    const r = await run(w, i.exe, ["uninstall"], { MNEMO_LINK_DIR: i.linkDir });
    expect(r.code).toBe(2);
    expect(fs.existsSync(i.exe)).toBe(true);
  }, T);

  test("uninstall --deep --yes deletes a home with literal path characters, even from its bin", async () => {
    const w = fresh();
    const home = path.join(w.home, ".mnemo O'Brien [draft] %TEMP% & 日本");
    fs.renameSync(w.mnemoHome, home);
    w.mnemoHome = home;
    w.env.MNEMO_HOME = home;
    const i = installed(w);
    const r = await run({ ...w, project: i.bin }, i.exe, ["uninstall", "--deep", "--yes"], { MNEMO_LINK_DIR: i.linkDir });
    expect(r.code).toBe(0);
    // Windows deletes after the process exits; give it a moment.
    for (let n = 0; n < 50 && fs.existsSync(w.mnemoHome); n++) await Bun.sleep(100);
    expect(fs.existsSync(w.mnemoHome)).toBe(false);
  }, T);

  test("uninstall --deep refuses a home that holds files Mnemo did not put there", async () => {
    const w = fresh();
    const i = installed(w);
    fs.writeFileSync(path.join(w.mnemoHome, "my-thesis.docx"), "precious");
    const r = await run(w, i.exe, ["uninstall", "--deep", "--yes"], { MNEMO_LINK_DIR: i.linkDir });
    expect(r.stderr).toContain("not deleted");
    expect(fs.readFileSync(path.join(w.mnemoHome, "my-thesis.docx"), "utf8")).toBe("precious");
    // What was asked for did not happen: that is not a success.
    expect(r.code).toBe(1);
    expect(r.stdout).not.toContain("Mnemo is uninstalled");
  }, T);

  test("uninstall --deep deletes a home holding saved approvals and permission rules", async () => {
    const w = fresh();
    const i = installed(w);
    fs.writeFileSync(path.join(w.mnemoHome, "grants.json"), JSON.stringify({ "/x": [{ tool: "bash", pattern: "ls*" }] }));
    fs.writeFileSync(path.join(w.mnemoHome, "permissions.json"), JSON.stringify({ deny: ["bash(rm *)"] }));
    fs.mkdirSync(path.join(w.mnemoHome, "skill-history"));
    const r = await run(w, i.exe, ["uninstall", "--deep", "--yes"], { MNEMO_LINK_DIR: i.linkDir });
    expect(r.code).toBe(0);
    for (let n = 0; n < 50 && fs.existsSync(w.mnemoHome); n++) await Bun.sleep(100);
    expect(fs.existsSync(w.mnemoHome)).toBe(false);
  }, T);
});

describe("memory commands", () => {
  test.if(!!memsrv())("tidy, status and setup run against a real journal", async () => {
    const w = fresh();
    play(steps({ tools: [{ name: "memory_remember", args: { scope: "project", key: "lint", value: "run biome check" } }] }, { text: "ok" }));
    await mnemo(w, ["-p", "remember", "--no-reflect"]);
    for (const args of [["memory", "status"], ["memory", "tidy"], ["memory", "setup", "claude-code"], ["memory", "setup", "codex"], ["memory", "--help"]]) {
      const r = await mnemo(w, args);
      expect({ args, code: r.code, err: r.stderr }).toEqual({ args, code: 0, err: expect.not.stringContaining("Cannot find module") });
    }
  }, T);
});

describe("a failed model call", () => {
  test("-p exits 1 and says why when the provider refuses the request", async () => {
    const w = fresh();
    play(() => ({ status: 401, error: "invalid api key (mock)" }));
    const r = await mnemo(w, ["-p", "hi", "--no-reflect"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("invalid api key (mock)");
    expect(r.stdout.trim()).toBe("");
  }, T);

  test("--best-of counts a candidate whose model call failed as failed", async () => {
    const w = fresh();
    play(() => ({ status: 401, error: "invalid api key (mock)" }));
    const r = await mnemo(w, ["-p", "hi", "--best-of", "2", "--check", "true"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("exit 1");
  }, T);
});

describe("system prompt", () => {
  test("points at no pi documentation the binary does not have", async () => {
    const w = fresh();
    play(() => ({ text: "ok" }));
    const r = await mnemo(w, ["-p", "hi", "--no-reflect"]);
    expect(r.code).toBe(0);
    const prompt = systemPrompt(llm.agentRequests()[0]!);
    // pi names README.md, docs/ and examples/ beside its package; a compiled binary has none of them.
    for (const [, p] of prompt.matchAll(/(?:Main documentation|Additional docs|Examples): (\S+)/g)) expect({ p, exists: fs.existsSync(p!) }).toEqual({ p, exists: true });
    expect(prompt).not.toContain(path.join(path.dirname(binary()), "docs"));
    expect(prompt).toContain("github.com/earendil-works/pi");
  }, T);
});

describe("arguments", () => {
  test("-p followed by an option, or by nothing, is a usage error, not a prompt", async () => {
    const w = fresh();
    play(() => ({ text: "should not be asked" }));
    for (const args of [["-p", "--yolo"], ["-p"], ["-p", ""], ["--cwd"], ["--best-of"]]) {
      const r = await mnemo(w, args);
      expect({ args, code: r.code }).toEqual({ args, code: 2 });
      expect(r.stderr).toContain("mnemo --help");
    }
    expect(llm.agentRequests()).toHaveLength(0);
  }, T);

  test("an unknown argument exits 2, like the other usage errors", async () => {
    const r = await mnemo(fresh(), ["--no-such-flag"]);
    expect(r.code).toBe(2);
  }, T);

  test("--help says what a headless run allows", async () => {
    const r = await mnemo(fresh(), ["--help"]);
    expect(r.stdout).toMatch(/-p "<prompt>"[^\n]*asks nothing/);
  }, T);
});

describe.if(hasPty)("the terminal", () => {
  const START = ["--no-boot", "--no-motion"];
  async function ready(t: Terminal) {
    await t.waitFor(/for commands/);
    await Bun.sleep(1200);
    t.mark();
  }

  test("/clear in the workspace leaves the terminal's own scrollback alone", async () => {
    const t = await terminal(fresh(), START);
    try {
      await ready(t);
      await submit(t, "/clear");
      await Bun.sleep(1500);
      // \x1b[3J erases the scrollback the user had before starting Mnemo; the workspace is on the alternate screen.
      expect(t.raw().includes("\x1b[3J")).toBe(false);
    } finally {
      await t.kill();
    }
  }, T);

  test("an unhandled rejection mid-session is logged and shown, and the session goes on", async () => {
    const w = fresh({
      files: {
        "README.md": "# demo\n",
        ".pi/extensions/flaky.ts": `export default function () { setTimeout(() => { Promise.reject(new Error("boom from an extension")); }, 2500); }\n`,
      },
    });
    play(() => ({ text: "still here" }));
    const t = await terminal(w, [...START, "--trust-project"]);
    try {
      await ready(t);
      await t.waitFor(/boom from an extension/, 15_000);
      expect(await t.exitWithin(500)).toBeUndefined();
      await submit(t, "ping");
      await t.waitFor(/still here/);
      const log = fs.readFileSync(path.join(w.mnemoHome, "logs", "errors.log"), "utf8");
      expect(log).toContain("boom from an extension");
    } finally {
      await t.kill();
    }
  }, T);
});

describe("the gate under -p, after the security review", () => {
  // -p allows what would ask; plan and deny still refuse.
  test("--plan -p refuses a command", async () => {
    const w = fresh();
    play(steps({ tools: [{ name: "bash", args: { command: "touch planned.txt" } }] }, { text: "ok" }));
    await mnemo(w, ["--plan", "-p", "touch"]);
    expect(fs.existsSync(path.join(w.project, "planned.txt"))).toBe(false);
  }, T);

  test("-p in the default mode still honours a deny rule", async () => {
    const w = fresh();
    fs.writeFileSync(path.join(w.mnemoHome, "permissions.json"), JSON.stringify({ rules: [{ tool: "bash", pattern: "touch*", action: "deny" }] }));
    play(steps({ tools: [{ name: "bash", args: { command: "'touch' denied.txt" } }] }, { text: "ok" }));
    await mnemo(w, ["-p", "touch"]);
    expect(fs.existsSync(path.join(w.project, "denied.txt"))).toBe(false);
  }, T);

  test("a grants.json of null does not switch the gate off", async () => {
    const w = fresh();
    fs.writeFileSync(path.join(w.mnemoHome, "grants.json"), "null");
    play(steps({ tools: [{ name: "bash", args: { command: "touch pwned.txt" } }] }, { text: "ok" }));
    await mnemo(w, ["--plan", "-p", "touch"]);
    expect(fs.existsSync(path.join(w.project, "pwned.txt"))).toBe(false);
  }, T);

  test.if(process.platform === "linux")("the read tool does not return the process environment", async () => {
    const key = "sk-ant-e2e-environ-0123456789";
    const w = fresh({ env: { ANTHROPIC_API_KEY: key } });
    play(steps({ tools: [{ name: "read", args: { path: "/proc/self/environ" } }] }, { text: "ok" }));
    await mnemo(w, ["--yolo", "-p", "read environ"]);
    expect(JSON.stringify(llm.requests)).not.toContain(key);
  }, T);
});
