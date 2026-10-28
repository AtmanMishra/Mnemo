/**
 * Opera: the user attaches repositories (a folder, or an https clone) from the command line; the
 * conductor starts threads, each a background sub-agent in a new worktree on its own branch, follows
 * them through LOG.md, steers and stops them, within the Opera's budget. Real git in throwaway
 * repositories; real pi sessions on the scripted model.
 */
import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { addRepo, cloneCommand, createOpera, listOperas, operaDir, readOpera, removeRepo, setBudget, type Runner } from "../src/opera/store.ts";
import { Conductor, repoTrusted } from "../src/opera/conductor.ts";
import { operaCommand } from "../src/opera/cli.ts";
import { judge } from "../src/extensions/policy.ts";
import { Roster } from "../src/runtime/roster.ts";
import { mnemoEnv } from "./helpers.ts";

const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const sh = (cwd: string, ...a: string[]) => {
  const r = Bun.spawnSync(["git", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
};
function repo(name = "repo"): string {
  const dir = path.join(tmp("mnemo-opera-repo-"), name);
  fs.mkdirSync(dir);
  sh(dir, "init", "-q");
  sh(dir, "config", "user.email", "t@t");
  sh(dir, "config", "user.name", "t");
  sh(dir, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}
const homeWithAgent = () => {
  const home = tmp("mnemo-opera-home-");
  fs.mkdirSync(path.join(home, "agent"), { recursive: true });
  return home;
};

// ── the Opera on disk ───────────────────────────────────────────────────────

test("an Opera is a folder of its own, 0700, with opera.json 0600; names are plain", () => {
  const home = homeWithAgent();
  const o = createOpera(home, "shop");
  expect(o).toMatchObject({ name: "shop", budget: 5, repos: [] });
  const dir = operaDir(home, "shop");
  if (process.platform !== "win32") {
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, "opera.json")).mode & 0o777).toBe(0o600);
  }
  expect(() => createOpera(home, "shop")).toThrow(/already an Opera called shop/);
  for (const bad of ["../x", "a/b", "", ".hidden", "x".repeat(41)]) expect(() => createOpera(home, bad)).toThrow(/not a usable name/);
  expect(() => readOpera(home, "nope")).toThrow(/no Opera called nope/);
  expect(setBudget(home, "shop", 0).budget).toBe(0);
  expect(listOperas(home).map((x) => x.name)).toEqual(["shop"]);
});

test("a folder attaches as its repository's top; a folder outside git, or a second of one name, is refused", () => {
  const home = homeWithAgent();
  createOpera(home, "o");
  const r = repo("api");
  fs.mkdirSync(path.join(r, "src"));
  const added = addRepo(home, "o", path.join(r, "src"));
  expect(added).toMatchObject({ name: "src", kind: "local", path: r, trusted: false });
  expect(() => addRepo(home, "o", r, { name: "src" })).toThrow(/already has a repository called src/);
  expect(() => addRepo(home, "o", tmp("mnemo-not-git-"))).toThrow(/not inside a git repository/);
  expect(addRepo(home, "o", r, { trust: true })).toMatchObject({ name: "api", trusted: true });
  expect(readOpera(home, "o").repos.map((x) => x.name)).toEqual(["src", "api"]);
  // Detaching a folder of yours leaves it as it is.
  removeRepo(home, "o", "api");
  expect(fs.existsSync(path.join(r, "README.md"))).toBe(true);
});

test("a clone is https only, without hooks, submodules or the user's git config; any other address is refused", () => {
  const cmd = cloneCommand("git", "https://example.com/a/b.git", "/x/dest");
  expect(cmd).toContain("protocol.allow=never");
  expect(cmd).toContain("protocol.https.allow=always");
  expect(cmd).toContain("--no-recurse-submodules");
  expect(cmd.join(" ")).toMatch(/core\.hooksPath=(\/dev\/null|NUL)/);
  expect(cmd.slice(-3)).toEqual(["--", "https://example.com/a/b.git", "/x/dest"]);
  const home = homeWithAgent();
  createOpera(home, "o");
  for (const bad of ["http://example.com/a.git", "git@github.com:a/b.git", "ssh://example.com/a", "file:///etc", "ext::sh -c touch% /tmp/pwned"])
    expect(() => addRepo(home, "o", bad)).toThrow();
  expect(() => addRepo(home, "o", "https://user:secret@example.com/a.git")).toThrow(/password/);
});

test("a clone lands in the Opera's repos/, is untrusted unless the user says so, and is deleted when detached", () => {
  const home = homeWithAgent();
  createOpera(home, "o");
  const seen: string[][] = [];
  // Stands in for the network: the address is cloned from a local repository.
  const source = repo("web");
  const runner: Runner = (cmd, cwd) => {
    if (cmd.includes("clone")) {
      seen.push(cmd);
      const dest = cmd.at(-1)!;
      fs.cpSync(source, dest, { recursive: true });
      return { code: 0, out: "", err: "" };
    }
    const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode ?? 1, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  const r = addRepo(home, "o", "https://example.com/team/web.git", { runner });
  expect(seen).toHaveLength(1);
  expect(r).toMatchObject({ name: "web", kind: "clone", url: "https://example.com/team/web.git", trusted: false });
  expect(r.path).toBe(fs.realpathSync(path.join(operaDir(home, "o"), "repos", "web")));
  // A clone carrying .agents/ resources is not trusted because it carries them.
  fs.mkdirSync(path.join(r.path, ".agents", "extensions"), { recursive: true });
  expect(repoTrusted(r, path.join(home, "agent"))).toBe(false);
  expect(repoTrusted({ ...r, trusted: true }, path.join(home, "agent"))).toBe(true);
  removeRepo(home, "o", "web");
  expect(fs.existsSync(r.path)).toBe(false);
  expect(fs.existsSync(source)).toBe(true);
});

test("a failed clone leaves nothing behind and says what to do about a private repository", () => {
  const home = homeWithAgent();
  createOpera(home, "o");
  const runner: Runner = (cmd) => {
    fs.mkdirSync(cmd.at(-1)!, { recursive: true });
    return { code: 128, out: "", err: "fatal: could not read Username" };
  };
  expect(() => addRepo(home, "o", "https://example.com/private.git", { runner })).toThrow(/failed: fatal: could not read Username\. A private repository: clone it yourself/);
  expect(fs.readdirSync(path.join(operaDir(home, "o"), "repos"))).toEqual([]);
  expect(readOpera(home, "o").repos).toEqual([]);
});

test("opera.json entries that mnemo opera did not write are dropped, and a clone path outside repos/ is never deleted", () => {
  const home = homeWithAgent();
  createOpera(home, "o");
  const keep = tmp("mnemo-keep-");
  fs.writeFileSync(path.join(keep, "precious"), "x");
  const file = path.join(operaDir(home, "o"), "opera.json");
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  cfg.repos = [{ name: "../evil", kind: "local", path: "/" }, { name: "rel", kind: "local", path: "relative/path" }, { name: "x", kind: "clone", path: keep, trusted: "yes" }];
  fs.writeFileSync(file, JSON.stringify(cfg));
  const read = readOpera(home, "o");
  expect(read.repos.map((r) => r.name)).toEqual(["x"]);
  expect(read.repos[0]!.trusted).toBe(false);
  removeRepo(home, "o", "x");
  expect(fs.existsSync(path.join(keep, "precious"))).toBe(true);
});

// ── the conductor's bookkeeping ─────────────────────────────────────────────

test("a thread's worktree is a new branch from HEAD; the user's checkout and its uncommitted work are not touched", () => {
  const home = homeWithAgent();
  createOpera(home, "o");
  const r = repo("api");
  addRepo(home, "o", r);
  fs.writeFileSync(path.join(r, "wip.txt"), "mine\n");
  const roster = new Roster();
  const root = roster.addRoot("conductor").id;
  const c = new Conductor(home, readOpera(home, "o"), roster, root, { agentDir: path.join(home, "agent") });
  const p = c.prepare("api", "Fix the login!");
  expect(p.branch).toBe("opera/o/api-fix-the-login");
  expect(p.dir).toBe(fs.realpathSync(path.join(operaDir(home, "o"), "worktrees", "api-fix-the-login")));
  expect(fs.existsSync(path.join(p.dir, "README.md"))).toBe(true);
  expect(fs.existsSync(path.join(p.dir, "wip.txt"))).toBe(false);
  expect(sh(r, "branch", "--show-current").trim()).not.toBe(p.branch);
  expect(fs.readFileSync(path.join(r, "wip.txt"), "utf8")).toBe("mine\n");
  // Same name again: its own folder and branch.
  expect(c.prepare("api", "fix the login").branch).toBe("opera/o/api-fix-the-login-2");
  expect(() => c.prepare("nope", "x")).toThrow(/no repository nope in this Opera; there is api/);
  // What it changed, as thread_list shows it.
  const node = roster.addSub(root, { label: "t", task: "x", access: "full" });
  const t = c.adopt(node.id, p);
  fs.writeFileSync(path.join(p.dir, "README.md"), "hello\nworld\n");
  fs.writeFileSync(path.join(p.dir, "new.txt"), "n\n");
  expect(c.changes(t)).toMatch(/1 file changed, 1 insertion\(\+\), 1 untracked/);
  sh(p.dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "work");
  expect(c.changes(t)).toMatch(/1 file changed, 1 insertion\(\+\), 1 commit, 1 untracked/);
});

test("a repository with no commit cannot start a thread", () => {
  const home = homeWithAgent();
  createOpera(home, "o");
  const empty = path.join(tmp("mnemo-empty-"), "e");
  fs.mkdirSync(empty);
  sh(empty, "init", "-q");
  addRepo(home, "o", empty);
  const roster = new Roster();
  const c = new Conductor(home, readOpera(home, "o"), roster, roster.addRoot("c").id, { agentDir: path.join(home, "agent") });
  expect(() => c.prepare("e", "x")).toThrow(/has no commit yet/);
});

test("LOG.md is the program's record: one line per event, 0600, cleaned and redacted", () => {
  const home = homeWithAgent();
  createOpera(home, "o");
  addRepo(home, "o", repo("api"));
  const roster = new Roster();
  const root = roster.addRoot("conductor").id;
  const c = new Conductor(home, readOpera(home, "o"), roster, root, { agentDir: path.join(home, "agent"), now: () => Date.UTC(2026, 9, 28, 14, 32) });
  const p = c.prepare("api", "t");
  const sub = roster.addSub(root, { label: "t", task: "do it", access: "full" });
  c.adopt(sub.id, p);
  c.log(sub.id, "ran bun test — failed");
  c.log(sub.id, "printed \u001b]0;title\u0007 to the terminal");
  // Built here so the repository's credential scan does not take the test for a leak.
  const key = ["sk", "ant", "api03", "A".repeat(40)].join("-");
  c.log(sub.id, `wrote key ${key}`);
  roster.finish(sub.id, "done", "fixed it");
  const file = path.join(c.dir, "LOG.md");
  const log = fs.readFileSync(file, "utf8");
  expect(log).toContain(`2026-10-28 14:32 #${root} [conductor] started #${sub.id} "t": do it`);
  expect(log).toContain(`#${sub.id} [api] ran bun test — failed`);
  expect(log).not.toContain("\u001b");
  expect(log).not.toContain(key);
  expect(log).toContain(`#${sub.id} [api] finished: fixed it`);
  if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(c.tail(10, sub.id).every((l) => l.includes("[api]"))).toBe(true);
});

test("the Opera's budget counts every thread and its sub-agents; crossing it stops them all and no thread starts", () => {
  const home = homeWithAgent();
  createOpera(home, "o", 1);
  addRepo(home, "o", repo("api"));
  const roster = new Roster();
  const root = roster.addRoot("conductor").id;
  const c = new Conductor(home, readOpera(home, "o"), roster, root, { agentDir: path.join(home, "agent") });
  const stopped: number[] = [];
  const a = roster.addSub(root, { label: "a", task: "x", access: "full" });
  const b = roster.addSub(root, { label: "b", task: "y", access: "full" });
  for (const n of [a, b]) roster.attach(n.id, { deliver: () => {}, stop: () => void stopped.push(n.id) });
  c.adopt(a.id, c.prepare("api", "a"));
  c.adopt(b.id, c.prepare("api", "b"));
  const grand = roster.addSub(a.id, { label: "helper", task: "z", access: "read-only" });
  roster.spend(root, 5); // the conductor's own spend is the user's prompt, not the threads'
  roster.spend(a.id, 0.4);
  roster.spend(grand.id, 0.3);
  expect(c.refusal()).toBeUndefined();
  expect(stopped).toEqual([]);
  roster.spend(b.id, 0.3);
  expect(c.spent()).toBeCloseTo(1.0);
  expect(stopped.sort()).toEqual([a.id, b.id].sort());
  expect(roster.get(grand.id)!.status).toBe("stopped");
  expect(c.refusal()).toMatch(/spent its budget of \$1\.00; the user raises it with mnemo opera budget o/);
  expect(fs.readFileSync(path.join(c.dir, "LOG.md"), "utf8")).toContain("the Opera's budget of $1.00 is spent: stopping 2 threads");
});

test("the gate lets the conductor's tools through as it does spawn_subagent, but plan mode refuses to start a thread", () => {
  const NO = { project: [], global: [], deny: [] };
  for (const tool of ["thread_start", "thread_list", "thread_steer", "thread_stop"]) expect(judge({ mode: "default" }, [], NO, "/p", tool, {})).toEqual({ allow: true });
  expect(judge({ mode: "plan" }, [], NO, "/p", "thread_start", { repo: "a", task: "b" })).toMatchObject({ allow: false });
  expect(judge({ mode: "plan" }, [], NO, "/p", "thread_list", {})).toEqual({ allow: true });
  // A deny rule the user wrote holds here too.
  expect(judge({ mode: "yolo" }, [{ tool: "thread_start", action: "deny" }], NO, "/p", "thread_start", {})).toMatchObject({ allow: false });
});

// ── mnemo opera ─────────────────────────────────────────────────────────────

test("mnemo opera sets up an Opera and names the folder its conductor starts in", () => {
  const home = homeWithAgent();
  const out: string[] = [];
  const log = (s: string) => void out.push(s);
  expect(operaCommand([], home, log)).toBe(0);
  expect(out.pop()).toMatch(/no Operas yet/);
  expect(operaCommand(["new", "shop", "--budget", "2.5"], home, log)).toBe(0);
  expect(readOpera(home, "shop").budget).toBe(2.5);
  const r = repo("api");
  expect(operaCommand(["add", "shop", r, "--trust"], home, log)).toBe(0);
  expect(out.pop()).toBe(`attached api: ${r} (trusted: its .agents/ resources load in its threads)`);
  expect(operaCommand(["budget", "shop", "-1"], home, log)).toBe(1);
  expect(operaCommand(["show", "shop"], home, log)).toBe(0);
  expect(out.join("\n")).toContain("api\tlocal, trusted\t");
  expect(operaCommand(["shop", "--plan"], home, log)).toEqual({ name: "shop", dir: operaDir(home, "shop"), rest: ["--plan"] });
  expect(operaCommand(["shop", "--cwd", "/tmp"], home, log)).toBe(1);
  expect(operaCommand(["nope"], home, log)).toBe(1);
  expect(operaCommand(["add", "shop", r, "--wat"], home, log)).toBe(1);
  expect(operaCommand(["remove", "shop", "api"], home, log)).toBe(0);
  expect(readOpera(home, "shop").repos).toEqual([]);
});

// ── a conductor at work: real sessions on the scripted model ───────────────

type Env = Awaited<ReturnType<typeof mnemoEnv>>;
const envs: Env[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
});
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1])], { stopReason: "toolUse" });
const say = (t: string) => fauxAssistantMessage(fauxText(t));
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const toolOutput = (e: Env, name: string) => e.controller.transcript.snapshot().committed.filter((b) => b.kind === "tool" && b.name === name) as unknown as { status: string; output: string }[];

async function conductor(o: { budget?: number; mode?: "yolo" | "default" | "plan" } = {}) {
  const home = homeWithAgent();
  createOpera(home, "o", o.budget);
  const r = repo("api");
  addRepo(home, "o", r);
  const roster = new Roster();
  const e = await mnemoEnv({ home, cwd: operaDir(home, "o"), roster, mode: o.mode ?? "yolo", opera: readOpera(home, "o") });
  envs.push(e);
  return { e, roster, repo: r, home };
}
/** Every model call answered by who asks: the conductor, or a thread (its system prompt says which). */
function route(e: Env, answer: (sent: string, who: "conductor" | "thread", system: string) => ReturnType<FauxResponseFactory>) {
  const f: FauxResponseFactory = (context) => {
    const sent = JSON.stringify(context);
    // The system prompt travels as the transcript's system messages, in sections.
    const system = context.messages
      .filter((m) => (m.role as string) === "system")
      .map((m) => Object.values((m as { sections?: Record<string, string> }).sections ?? {}).join("\n"))
      .join("\n");
    return answer(sent, system.includes("You are thread #") ? "thread" : "conductor", system);
  };
  e.faux.setResponses(Array.from({ length: 40 }, () => f));
}
async function settle(roster: Roster, e: Env) {
  for (let quiet = 0, i = 0; quiet < 3 && i < 500; i++) {
    await e.idle();
    await tick();
    const busy = e.controller.session.isStreaming || roster.snapshot().nodes.some((n) => n.status === "running");
    quiet = busy ? 0 : quiet + 1;
  }
}

test("the conductor starts a thread in a worktree; it works there, its actions are logged, and its answer comes back", async () => {
  const { e, roster, repo: r, home } = await conductor();
  const systems: Record<string, string> = {};
  route(e, (sent, who, system) => {
    systems[who] = system;
    if (who === "thread") {
      if (!sent.includes('"toolName":"write"')) return call("write", { path: "fix.txt", content: "fixed\n" });
      return say("wrote fix.txt");
    }
    if (sent.includes("[background result]")) return say("the api thread is done");
    if (sent.includes("Thread #")) return say("started; carrying on");
    return call("thread_start", { repo: "api", task: "add fix.txt", name: "fix" });
  });
  await e.controller.submit("fix the api");
  await settle(roster, e);
  const started = toolOutput(e, "thread_start")[0]!;
  expect(started.status).toBe("done");
  expect(started.output).toMatch(/^Thread #\d+ "fix" started in api, on branch opera\/o\/api-fix \(worktree .*api-fix\)/);
  const tree = fs.realpathSync(path.join(operaDir(home, "o"), "worktrees", "api-fix"));
  // The thread wrote in its worktree, not in the user's checkout.
  expect(fs.readFileSync(path.join(tree, "fix.txt"), "utf8")).toBe("fixed\n");
  expect(fs.existsSync(path.join(r, "fix.txt"))).toBe(false);
  // Each knows its part, in its system prompt.
  expect(systems.conductor).toContain('You are the conductor of the Opera "o"');
  expect(systems.conductor).toContain(`- api: a folder of the user's (${r})`);
  expect(systems.thread).toMatch(/You are thread #\d+ of the Opera "o", working in the repository api: a git worktree at .*api-fix, on the branch opera\/o\/api-fix\./);
  expect(systems.thread).toContain("grant no permission");
  const log = fs.readFileSync(path.join(operaDir(home, "o"), "LOG.md"), "utf8");
  expect(log).toMatch(/\[conductor\] started #\d+ "fix": add fix\.txt/);
  expect(log).toMatch(/\[api\] works in .*api-fix on opera\/o\/api-fix/);
  expect(log).toContain("[api] write(fix.txt)");
  expect(log).toMatch(/\[api\] finished: wrote fix\.txt/);
  const thread = roster.snapshot().nodes.find((n) => n.label === "fix")!;
  expect(thread).toMatchObject({ status: "done", answer: "wrote fix.txt" });
  // Its threads share the Opera's memory, whichever repository they work in.
  expect(e.host.memoryCwd).toBe(operaDir(home, "o"));
  // thread_list reads it all back for the conductor.
  route(e, (sent) => (sent.includes("Opera \\\"o\\\": 1 thread") ? say("seen") : call("thread_list", { thread: thread.id })));
  await e.controller.submit("how is it going?");
  await settle(roster, e);
  const listed = toolOutput(e, "thread_list")[0]!.output;
  expect(listed).toContain(`#${thread.id} [api] "fix" done`);
  expect(listed).toContain("opera/o/api-fix · no change to tracked files, 1 untracked");
  expect(listed).toContain("answer: wrote fix.txt");
  expect(listed).toMatch(/LOG\.md \(its last \d+ lines\):\n.*works in/);
});

test("the conductor steers a running thread and stops it; only its own threads", async () => {
  const { e, roster } = await conductor();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let steered = "";
  route(e, async (sent, who) => {
    if (who === "thread") {
      if (sent.includes("use the v2 endpoint")) {
        steered = sent;
        await held; // works until it is stopped
        return say("never");
      }
      return call("ls", { path: "." });
    }
    if (sent.includes("Stopped thread")) return say("stopped it");
    if (sent.includes("Sent to thread")) {
      for (let i = 0; i < 300 && !steered; i++) await tick(); // stopped once it has read the steer
      const id = roster.snapshot().nodes.find((n) => n.label === "slow")!.id;
      return call("thread_stop", { thread: id, why: "wrong approach" });
    }
    if (sent.includes("Thread #")) {
      const id = roster.snapshot().nodes.find((n) => n.label === "slow")!.id;
      return call("thread_steer", { thread: id, text: "use the v2 endpoint" });
    }
    return call("thread_start", { repo: "api", task: "slow work", name: "slow" });
  });
  await e.controller.submit("go");
  for (let i = 0; i < 300 && !roster.snapshot().nodes.some((n) => n.label === "slow" && n.status === "stopped"); i++) await tick();
  release();
  await settle(roster, e);
  expect(toolOutput(e, "thread_steer")[0]!.output).toMatch(/^Sent to thread #\d+; it reads it/);
  expect(steered).toContain("[peer message]");
  expect(toolOutput(e, "thread_stop")[0]!.output).toMatch(/^Stopped thread #\d+\. Its work so far is on opera\/o\/api-slow/);
  expect(roster.snapshot().nodes.find((n) => n.label === "slow")!.status).toBe("stopped");
  expect(fs.readFileSync(path.join(e.cwd, "LOG.md"), "utf8")).toMatch(/\[conductor\] stopped thread #\d+: wrong approach/);
  // An agent that is not one of its threads cannot be steered or stopped through these tools.
  route(e, (sent) => (sent.includes("is not one of this Opera's threads") ? say("ok") : call("thread_stop", { thread: e.host.node })));
  await e.controller.submit("stop yourself");
  await settle(roster, e);
  expect(toolOutput(e, "thread_stop")[1]!.status).toBe("error");
});

test("a thread that cannot start leaves no worktree or branch behind", async () => {
  const { e, roster, repo: r } = await conductor();
  route(e, (sent) => (sent.includes("no model nope/x") ? say("could not") : call("thread_start", { repo: "api", task: "x", name: "bad", model: "nope/x" })));
  await e.controller.submit("go");
  await settle(roster, e);
  expect(toolOutput(e, "thread_start")[0]!.status).toBe("error");
  expect(fs.existsSync(path.join(e.cwd, "worktrees", "api-bad"))).toBe(false);
  expect(sh(r, "branch", "--list", "opera/*").trim()).toBe("");
});

test("plan mode refuses to start a thread; the threads of a spent Opera do not start", async () => {
  const plan = await conductor({ mode: "plan" });
  route(plan.e, (sent) => (sent.includes("Plan mode is read-only") ? say("cannot in plan mode") : call("thread_start", { repo: "api", task: "x" })));
  await plan.e.controller.submit("go");
  await settle(plan.roster, plan.e);
  expect(toolOutput(plan.e, "thread_start")[0]!.status).toBe("error");
  expect(fs.existsSync(path.join(plan.e.cwd, "worktrees"))).toBe(false);

  const spent = await conductor({ budget: 0.01 });
  // A thread of an earlier session in this Opera already spent it.
  const n = spent.roster.addSub(spent.e.host.node, { label: "old", task: "x", access: "full" });
  spent.e.host.opera!.adopt(n.id, spent.e.host.opera!.prepare("api", "old"));
  spent.roster.spend(n.id, 0.02);
  route(spent.e, (sent) => (sent.includes("spent its budget") ? say("out of budget") : call("thread_start", { repo: "api", task: "x", name: "new" })));
  await spent.e.controller.submit("go");
  await settle(spent.roster, spent.e);
  expect(toolOutput(spent.e, "thread_start")[0]!.output).toMatch(/spent its budget of \$0\.01/);
  expect(fs.existsSync(path.join(spent.e.cwd, "worktrees", "api-new"))).toBe(false);
});
