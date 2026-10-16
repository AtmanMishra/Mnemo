/**
 * The gate against the calls a security review got through it: each test is
 * one way a call used to pass that it should not have.
 */
import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Grants, commandVariants, judge, loadRules, policyExtension } from "../src/extensions/policy.ts";
import { decide, generalise } from "../src/policy/gate.ts";
import { realPath, type PathSystem } from "../src/policy/paths.ts";
import { mnemoEnv } from "./helpers.ts";

const noGrants = { project: [], global: [], deny: [] };
const tmp = (prefix: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const refused = (v: unknown) => typeof v === "object" && v !== null && (v as { allow?: boolean }).allow === false;
const allowed = (v: unknown) => typeof v === "object" && v !== null && (v as { allow?: boolean }).allow === true;

const envs: Awaited<ReturnType<typeof mnemoEnv>>[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
});

// ── 1. a broken grants.json or permissions.json does not turn the gate off ──

test("a grants.json that is not an object is read as no grants", () => {
  for (const text of ["null", "1", '"x"', "[]", '{"projects": 5, "global": "x"}', '{"projects": {"/p": "git*"}}']) {
    const home = tmp("mnemo-grants-");
    fs.writeFileSync(path.join(home, "grants.json"), text);
    const g = new Grants(home);
    expect(g.for("/p"), text).toEqual({ project: [], global: [], deny: [] });
    g.add("/p", "git status*");
    expect(g.for("/p").project, text).toEqual(["git status*"]);
  }
});

test("a permissions.json holding null stops changes", () => {
  const home = tmp("mnemo-perm-");
  for (const text of ["null", "1", '"x"', '{"rules": null}']) {
    fs.writeFileSync(path.join(home, "permissions.json"), text);
    expect(refused(judge({ mode: "yolo" }, loadRules(home), noGrants, "/p", "bash", { command: "ls" })), text).toBe(true);
  }
});

test("if the gate cannot be set up, it refuses every change instead of vanishing", async () => {
  let calls = 0;
  const home = tmp("mnemo-home-");
  const host = {
    // Fails while the extension is set up, works afterwards: reads are still judged.
    get home(): string {
      if (calls++ === 0) throw new Error("boom");
      return home;
    },
    mode: "yolo",
    signals: [],
  };
  let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
  policyExtension(host as never)({ on: (_: string, h: typeof handler) => (handler = h) } as never);
  expect(handler).toBeDefined();
  const ctx = { cwd: "/p" };
  expect(await handler!({ toolName: "bash", input: { command: "ls" } }, ctx)).toMatchObject({ block: true });
  expect(await handler!({ toolName: "write", input: { path: "a" } }, ctx)).toMatchObject({ block: true });
  expect(await handler!({ toolName: "read", input: { path: "a" } }, ctx)).toBeUndefined();
});

test("plan mode with a grants.json of null still runs nothing", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-home-"));
  fs.writeFileSync(path.join(home, "grants.json"), "null");
  const e = await mnemoEnv({ home, mode: "plan" });
  envs.push(e);
  const marker = path.join(e.cwd, "PWNED");
  e.faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: `touch ${marker}` })], { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("done"))]);
  await e.controller.submit("go");
  await e.idle();
  expect(fs.existsSync(marker)).toBe(false);
});

// ── 2. plan beats allow ──

test("plan mode refuses a change even when an allow rule covers it", () => {
  expect(refused(judge({ mode: "plan" }, [{ tool: "bash", pattern: "git *", action: "allow" }], noGrants, "/p", "bash", { command: "git commit -am x" }))).toBe(true);
  expect(refused(judge({ mode: "plan" }, [{ tool: "write", action: "allow" }], noGrants, "/p", "write", { path: "a.txt" }))).toBe(true);
  // An allow rule still opens a credential path for reading, in any mode.
  const ssh = path.join(os.homedir(), ".ssh", "config");
  expect(allowed(judge({ mode: "plan" }, [{ tool: "read", action: "allow" }], noGrants, "/p", "read", { path: ssh }))).toBe(true);
});

test("plan mode refuses the memory tools that write, and still runs the ones that read", () => {
  const call = (tool: string, input: Record<string, unknown>) => judge({ mode: "plan" }, [], noGrants, "/p", tool, input);
  expect(refused(call("memory_remember", { key: "k", value: "v" }))).toBe(true);
  expect(refused(call("memory_steer", { id: "x" }))).toBe(true);
  expect(allowed(call("memory_search", { query: "k" }))).toBe(true);
  // Outside plan mode they are unchanged.
  expect(allowed(judge({ mode: "default" }, [], noGrants, "/p", "memory_remember", { key: "k", value: "v" }))).toBe(true);
});

// ── 3. dangling symlinks ──

test("accept-edits does not write through a dangling symlink into .git or out of the project", () => {
  const proj = tmp("mnemo-proj-");
  fs.mkdirSync(path.join(proj, ".git", "hooks"), { recursive: true });
  fs.mkdirSync(path.join(proj, "src"));
  fs.symlinkSync("../.git/hooks/pre-commit", path.join(proj, "src", "notes.txt"));
  fs.symlinkSync(`../../outside-${path.basename(proj)}.txt`, path.join(proj, "src", "out.txt"));
  fs.symlinkSync("loop", path.join(proj, "src", "loop"));
  const w = (p: string) => judge({ mode: "accept-edits" }, [], noGrants, proj, "write", { path: p });
  for (const p of ["src/notes.txt", "src/out.txt", "src/loop"]) expect("ask" in w(p), p).toBe(true);
  expect(w("src/new.ts")).toEqual({ allow: true });
  expect(realPath(path.join(proj, "src", "notes.txt"))).toBe(path.join(proj, ".git", "hooks", "pre-commit"));
  expect(realPath(path.join(proj, "src", "loop"))).toBeUndefined();
});

// ── 4. /proc environ and Mnemo's own key files ──

test("reads of /proc environ and memory and of Mnemo's key files are refused, in plan too", () => {
  const home = tmp("mnemo-home-");
  const r = (p: string, mode: "plan" | "yolo" = "plan") => judge({ mode, home }, [], noGrants, "/tmp", "read", { path: p });
  if (process.platform === "linux") {
    for (const p of ["/proc/self/environ", `/proc/${process.pid}/environ`, "/proc/thread-self/environ", "/proc/self/mem", `/proc/${process.pid}/task/${process.pid}/environ`, "/proc/self/../self/environ"])
      expect(refused(r(p)), p).toBe(true);
    expect(allowed(r("/proc/self/status"))).toBe(true);
  }
  for (const p of [path.join(home, ".env"), path.join(home, "agent", "models.json"), path.join(home, "agent", "auth.json"), path.join(home, "grants.json")])
    expect(refused(r(p, "yolo")), p).toBe(true);
});

test("a grant never covers a command that reads another process's environment", () => {
  const grants = { project: ["cat*"], global: [], deny: [] };
  expect(judge({ mode: "default" }, [], grants, "/p", "bash", { command: "cat notes.txt" })).toEqual({ allow: true });
  for (const command of ["cat /proc/1/environ", "cat /proc/$PPID/environ", "cat /proc/self/env?ron"])
    expect("ask" in judge({ mode: "default" }, [], grants, "/p", "bash", { command }), command).toBe(true);
});

// ── 5. Windows spellings ──

const win: PathSystem = { path: path.win32, windows: true, fold: true, home: "C:\\Users\\u", real: (p) => p };

test("on Windows, accept-edits reads paths the way the tools and the file system do", () => {
  const w = (p: string) => judge({ mode: "accept-edits" }, [], noGrants, "C:\\proj", "write", { path: p }, win);
  for (const p of ["src\\a.ts", "src/a.ts", "C:\\PROJ\\src\\a.ts", "/c/proj/src/a.ts", "/mnt/c/proj/src/a.ts", "@src\\a.ts", "file:///C:/proj/a.ts"])
    expect(w(p), p).toEqual({ allow: true });
  for (const p of [".git.\\hooks\\pre-commit", ".GIT\\hooks\\x", ".git \\hooks\\x", ".git::$INDEX_ALLOCATION\\hooks\\x", "sub\\.git\\config", "~\\.bashrc", "/c/Windows/x", "/mnt/d/x", "file:///C:/Windows/x", "..\\x"])
    expect("ask" in w(p), p).toBe(true);
  const r = (p: string) => judge({ mode: "yolo", home: "C:\\Users\\u\\.mnemo" }, [], noGrants, "C:\\proj", "read", { path: p }, win);
  for (const p of ["C:\\Users\\U\\.SSH\\id_rsa", "~\\.ssh\\id_rsa", "~/.ssh./id_rsa", "C:\\Users\\u\\.mnemo\\agent\\AUTH.JSON", "/c/Users/u/.aws/credentials"])
    expect(refused(r(p)), p).toBe(true);
});

// ── 6. grep over a folder that holds credentials ──

test("grep over a folder that holds credentials is refused", () => {
  const home = path.join(os.homedir(), ".mnemo-test-" + process.pid);
  const g = (p: string | undefined, cwd = "/tmp") => judge({ mode: "default", home }, [], noGrants, cwd, "grep", { pattern: "KEY", ...(p === undefined ? {} : { path: p }) });
  for (const p of ["~", os.homedir(), home, path.dirname(home)]) expect(refused(g(p)), p).toBe(true);
  expect(refused(g(undefined, os.homedir()))).toBe(true);
  if (process.platform === "linux") for (const p of ["/", "/proc", "/proc/self"]) expect(refused(g(p)), p).toBe(true);
  const proj = tmp("mnemo-proj-");
  expect(g(".", proj)).toEqual({ allow: true });
  expect(g(undefined, proj)).toEqual({ allow: true });
});

// ── 9. deny rules and the ways to spell a command ──

test("a deny rule sees through quotes, wrapper options, eval, timeout, xargs and shell options", () => {
  const rules = [
    { tool: "*", pattern: "rm *", action: "deny" as const },
    { tool: "*", pattern: "curl*", action: "deny" as const },
  ];
  for (const command of ['"rm" -rf /x', "'rm' -rf /x", "\\rm -rf /x", "r''m -rf /x", "sudo -u root rm -rf /x", "sudo -g wheel -E rm -rf /x", "env -u X curl a", "env -C /tmp curl a", "env -S 'curl a'",
    "bash -e -c 'curl a'", "bash -o pipefail -c 'curl a'", "eval curl a", 'eval "curl a"', "timeout 5 curl a", "timeout -s KILL 5 curl a", "nice -n 5 curl a", "nohup curl a", "echo x | xargs rm -rf", "xargs -I{} rm -rf {}", "find . -exec rm -rf {} +", "command -p curl a", "exec -a x curl a"])
    expect(refused(judge({ mode: "yolo" }, rules, noGrants, "/p", "bash", { command })), command).toBe(true);
  for (const command of ["CURL.EXE https://x", "Curl https://x", "C:\\Windows\\System32\\curl.exe x", "& 'curl.exe' x"])
    expect(refused(judge({ mode: "yolo" }, rules, noGrants, "/p", "powershell", { command })), command).toBe(true);
  expect(judge({ mode: "yolo" }, rules, noGrants, "/p", "bash", { command: "ls -la" })).toEqual({ allow: true });
  expect(commandVariants("sudo -u root curl x")).not.toContain("root curl x");
});

// ── 10. grants that carried a command of their own ──

test("a grant does not cover options that run or write something else", () => {
  const grants = { project: ["git grep*", "git log*", "make*", "go run*", "make test*"], global: [], deny: [] };
  for (const command of ["git grep --open-files-in-pager=touch\\ /tmp/pwned foo", "git grep -Ovim foo", "git grep -nO vim foo", "git log --output=/home/u/.bashrc", "make -f /tmp/evil.mk", "make -C /tmp/evil", "make --eval=x", "make test -f /tmp/evil.mk", "git log -c core.pager=x", "go run /tmp/evil.go"])
    expect(decide({ toolName: "bash", input: { command } }, grants).decision, command).toBe("ask");
  expect(decide({ toolName: "bash", input: { command: "git log --oneline" } }, grants).decision).toBe("allow");
  expect(decide({ toolName: "bash", input: { command: "make" } }, grants).decision).toBe("allow");
  for (const command of ["go run main.go", "bun run build", "cargo run", "npm run build", "make -f other.mk", "bun x cowsay", "pnpm dlx cowsay"])
    expect(generalise({ toolName: "bash", input: { command } }), command).toBe(command);
  expect(generalise({ toolName: "bash", input: { command: "git status --short" } })).toBe("git status*");
});

// ── 11. path rules match where the path lands ──

test("a path rule is matched against where the path lands, not how it is spelt", () => {
  const proj = tmp("mnemo-proj-");
  const allowSrc = [{ tool: "write", pattern: "src/*", action: "allow" as const }];
  expect(judge({ mode: "default" }, allowSrc, noGrants, proj, "write", { path: "src/a.ts" })).toEqual({ allow: true });
  expect(judge({ mode: "default" }, allowSrc, noGrants, proj, "write", { path: "./src/a.ts" })).toEqual({ allow: true });
  expect("ask" in judge({ mode: "default" }, allowSrc, noGrants, proj, "write", { path: "src/../../../etc/x" })).toBe(true);
  const denyEnv = [{ tool: "*", pattern: ".env*", action: "deny" as const }];
  for (const p of [".env", "./.env", path.join(proj, ".env"), "@.env", `file://${proj}/.env`, "src/../.env.local"])
    expect(refused(judge({ mode: "yolo" }, denyEnv, noGrants, proj, "read", { path: p })), p).toBe(true);
});

test("an allow rule for a command ends on a word", () => {
  const rules = [{ tool: "bash", pattern: "git status*", action: "allow" as const }];
  expect(judge({ mode: "default" }, rules, noGrants, "/p", "bash", { command: "git status" })).toEqual({ allow: true });
  expect(judge({ mode: "default" }, rules, noGrants, "/p", "bash", { command: "git status --short" })).toEqual({ allow: true });
  expect("ask" in judge({ mode: "default" }, rules, noGrants, "/p", "bash", { command: "git statusx" })).toBe(true);
});

// ── 15. protected folders below the top, and the home folder's dotfiles ──

test("accept-edits asks for nested control folders, editor and hook folders, and home dotfiles", () => {
  const proj = tmp("mnemo-proj-");
  const w = (p: string, cwd = proj) => judge({ mode: "accept-edits" }, [], noGrants, cwd, "write", { path: p });
  for (const p of ["vendor/lib/.git/hooks/post-checkout", "pkg/.husky/pre-commit", ".githooks/pre-commit", ".idea/workspace.xml", ".devcontainer/devcontainer.json", ".vscode/tasks.json", "a/.vscode/settings.json"])
    expect("ask" in w(p), p).toBe(true);
  expect(w("src/gitstuff.ts")).toEqual({ allow: true });
  const home = os.homedir();
  for (const p of [".bashrc", ".profile", ".zshrc", ".ssh/authorized_keys"]) expect("ask" in w(p, home), p).toBe(true);
});

// ── 13. a running sub-agent follows the mode the user picks ──

test("switching to plan mode reaches a sub-agent that is already running", async () => {
  const e = await mnemoEnv({ mode: "yolo" });
  envs.push(e);
  const marker = path.join(e.cwd, "child-ran");
  e.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("spawn_subagent", { task: "touch a file", access: "full" })], { stopReason: "toolUse" }),
    () => {
      // The user presses shift+tab to plan while the child works.
      e.host.mode = "plan";
      return fauxAssistantMessage([fauxToolCall("bash", { command: `touch ${marker}` })], { stopReason: "toolUse" });
    },
    fauxAssistantMessage(fauxText("child done")),
    fauxAssistantMessage(fauxText("parent done")),
  ]);
  await e.controller.submit("delegate");
  await e.idle();
  expect(fs.existsSync(marker)).toBe(false);
});
