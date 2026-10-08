/**
 * The experiments: each one is a small project, a few sessions a person
 * would plausibly have, and deterministic checks on what Mnemo did. A check
 * never asks a model whether it passed — a judge that can be talked into a
 * pass is not a measurement.
 *
 * Checks come in two kinds:
 *   behaviour  did the agent do the right thing in a LATER session — the
 *              thing memory is supposed to make possible
 *   memory     did the memory layer end up holding the right thing
 * Each scenario runs once with memory and once without (the baseline), so a
 * behaviour check that also passes without memory is not credited to memory.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { MemoryService } from "../src/memory/service.ts";
import { projectIdentity } from "../src/memory/project.ts";
import type { SessionResult } from "./harness.ts";

export interface Ctx {
  /** Project directories by name. */
  dirs: Record<string, string>;
  sessions: SessionResult[];
  memory?: MemoryService;
  read(project: string, file: string): string;
}

export interface Check {
  name: string;
  kind: "behaviour" | "memory";
  /** true = pass; a string = fail, with the evidence. */
  run(ctx: Ctx): Promise<true | string> | true | string;
}

export interface SessionPlan {
  project: string;
  prompts: string[];
  /** Change the world between sessions (a clean checkout, a teammate's commit). */
  before?(dirs: Record<string, string>): void;
}

export interface Scenario {
  name: string;
  about: string;
  projects: Record<string, (dir: string) => void>;
  sessions: SessionPlan[];
  checks: Check[];
}

const write = (dir: string, file: string, body: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), body);
};

/** A small TypeScript project; every scenario starts from this. */
export function nodeProject(dir: string, name: string): void {
  write(dir, "package.json", JSON.stringify({ name, version: "0.1.0", private: true, scripts: {} }, null, 2) + "\n");
  write(dir, "src/server.ts", `export function start(port: number) {\n  console.log("listening on", port);\n}\n`);
  write(dir, "README.md", `# ${name}\n\nA small service.\n`);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["remote", "add", "origin", `git@example.com:eval/${name}.git`], { cwd: dir });
  spawnSync("git", ["-c", "user.email=e@x", "-c", "user.name=eval", "add", "-A"], { cwd: dir });
  spawnSync("git", ["-c", "user.email=e@x", "-c", "user.name=eval", "commit", "-qm", "init"], { cwd: dir });
}

const lastSession = (ctx: Ctx) => ctx.sessions.at(-1)!;
const allText = (s: SessionResult) => [...s.answers, ...s.tools.map((t) => JSON.stringify(t.args))].join("\n");
const commands = (s: SessionResult) => s.tools.filter((t) => t.name === "bash").map((t) => String(t.args.command ?? ""));
async function profile(ctx: Ctx, project: string, scope: "project" | "user") {
  if (!ctx.memory) return [];
  return ctx.memory.profile(scope, projectIdentity(ctx.dirs[project]!).id);
}

export const SCENARIOS: Scenario[] = [
  {
    name: "convention-carries",
    about: "A convention stated once (pnpm, port 4111) is followed in a later session without being repeated.",
    projects: { app: (d) => nodeProject(d, "convention-app") },
    sessions: [
      {
        project: "app",
        prompts: [
          "Quick context for this repo: we use pnpm, never npm or yarn, and the dev server always runs on port 4111. " +
            "Please add a short CONTRIBUTING.md that explains how to install dependencies and start the dev server.",
        ],
      },
      {
        project: "app",
        prompts: [
          "Add a \"dev\" script to package.json that starts src/server.ts, and tell me the exact command I should run to install dependencies.",
        ],
      },
    ],
    checks: [
      {
        name: "later session uses pnpm, not npm/yarn",
        kind: "behaviour",
        run: (ctx) => {
          const t = allText(lastSession(ctx)).toLowerCase();
          if (!t.includes("pnpm")) return "pnpm never mentioned in session 2";
          if (/\bnpm install\b|\bnpm i\b|\byarn install\b|\byarn add\b/.test(t)) return "session 2 suggested npm/yarn";
          return true;
        },
      },
      {
        name: "later session puts port 4111 in the dev script",
        kind: "behaviour",
        run: (ctx) => {
          const pkg = ctx.read("app", "package.json");
          const dev = (JSON.parse(pkg) as { scripts?: Record<string, string> }).scripts?.dev;
          return dev && dev.includes("4111") ? true : `dev script: ${dev ?? "(none)"}`;
        },
      },
      {
        name: "memory holds the package manager",
        kind: "memory",
        run: async (ctx) => {
          const facts = await profile(ctx, "app", "project");
          return facts.some((f) => /pnpm/i.test(f.value)) ? true : `project facts: ${JSON.stringify(facts)}`;
        },
      },
    ],
  },
  {
    name: "pitfall-learned",
    about: "A failure resolved in one session is avoided in the next: the fix is applied first instead of rediscovered.",
    projects: {
      app: (d) => {
        nodeProject(d, "pitfall-app");
        write(d, "scripts/setup.sh", `#!/bin/sh\ntouch .setup-done\necho "setup complete"\n`);
        write(
          d,
          "scripts/test.sh",
          `#!/bin/sh\nif [ ! -f .setup-done ]; then\n  echo "error: test fixtures missing — run sh scripts/setup.sh first" >&2\n  exit 1\nfi\necho "12 tests passed"\n`,
        );
        write(d, ".gitignore", ".setup-done\n");
      },
    },
    sessions: [
      { project: "app", prompts: ["Run the test suite with `sh scripts/test.sh` and make it pass. Tell me the result."] },
      {
        project: "app",
        before: (dirs) => fs.rmSync(path.join(dirs.app!, ".setup-done"), { force: true }),
        prompts: ["Fresh checkout here. Run the tests (scripts/test.sh) and tell me the result."],
      },
    ],
    checks: [
      {
        name: "later session runs setup before the first test run",
        kind: "behaviour",
        run: (ctx) => {
          // One shell line can hold both (`setup.sh && test.sh`); `cat test.sh` is reading, not running.
          const cmds = commands(lastSession(ctx));
          const all = cmds.join("\n");
          const ran = (script: string) => all.search(new RegExp(`\\b(sh|bash)\\s+(\\./)?scripts/${script}|\\./scripts/${script}`));
          const setup = ran("setup\\.sh");
          const test = ran("test\\.sh");
          if (test < 0) return `no test run: ${JSON.stringify(cmds)}`;
          return setup >= 0 && setup < test ? true : `commands in order: ${JSON.stringify(cmds)}`;
        },
      },
      {
        // Not "failed tool calls": a model that writes `test.sh; echo $?` never fails a call.
        name: "later session never hits the missing-fixtures error",
        kind: "behaviour",
        run: (ctx) => {
          const hit = ctx.sessions.map((s) => s.tools.filter((t) => t.output.includes("test fixtures missing")).length);
          return hit[1] === 0 ? true : `missing-fixtures errors per session: ${hit.join(", ")}`;
        },
      },
      {
        name: "memory holds the fix (a pitfall or a project fact)",
        kind: "memory",
        run: async (ctx) => {
          if (!ctx.memory) return "no memory";
          const hits = await ctx.memory.search("test fixtures missing setup", 10);
          const pitfall = hits.find((h) => h.area === "Salience" && /fix:/.test(h.state));
          const fact = (await profile(ctx, "app", "project")).find((f) => /setup\.sh/.test(f.value) && /test/.test(f.value));
          return pitfall || fact ? true : `hits: ${hits.map((h) => h.label).join(" | ")}`;
        },
      },
    ],
  },
  {
    name: "correction-sticks",
    about: "A correction the user makes mid-session (doc comments on every export) holds in the next session.",
    projects: { app: (d) => nodeProject(d, "correction-app") },
    sessions: [
      {
        project: "app",
        prompts: [
          "Create src/math.ts exporting a function add(a, b) that adds two numbers.",
          "No — in this project every exported function must have a JSDoc comment that explains why it exists, not what it does. Fix add accordingly, and keep to that rule from now on.",
        ],
      },
      // A new file: no documented neighbour to copy the style from.
      { project: "app", prompts: ["Create src/text.ts exporting a function shout(s) that upper-cases a string."] },
    ],
    checks: [
      {
        name: "later session documents the new export",
        kind: "behaviour",
        run: (ctx) => {
          const file = path.join(ctx.dirs.app!, "src", "text.ts");
          if (!fs.existsSync(file)) return "no src/text.ts";
          const src = fs.readFileSync(file, "utf8");
          return /\/\*\*[\s\S]*?\*\/\s*export\s+(async\s+)?(function\s+shout|const\s+shout)/.test(src) ? true : `src/text.ts:\n${src}`;
        },
      },
      {
        name: "memory holds the comment rule",
        kind: "memory",
        run: async (ctx) => {
          const facts = [...(await profile(ctx, "app", "project")), ...(await profile(ctx, "app", "user"))];
          return facts.some((f) => /jsdoc|doc comment|comment/i.test(`${f.key} ${f.value}`)) ? true : `facts: ${JSON.stringify(facts)}`;
        },
      },
    ],
  },
  {
    name: "picks-up-the-thread",
    about: "Work left open at the end of one session is resumed from a bare 'where were we?'.",
    projects: {
      app: (d) => {
        nodeProject(d, "thread-app");
        write(d, "src/user.ts", `export interface User {\n  email: string;\n}\n\nexport function validate(user: User): string[] {\n  const errors: string[] = [];\n  return errors;\n}\n`);
      },
    },
    sessions: [
      {
        project: "app",
        prompts: [
          "In src/user.ts, implement validation for the email field only (it must contain @). " +
            "Next session we will also reject emails whose domain is example.org or test.com — do not do that now.",
        ],
      },
      { project: "app", prompts: ["Where were we? Please continue with what we left open last time."] },
    ],
    checks: [
      {
        // Nothing in the code points at this item: only memory can carry it.
        name: "later session blocks the two domains",
        kind: "behaviour",
        run: (ctx) => {
          const src = ctx.read("app", "src/user.ts");
          return /example\.org/.test(src) && /test\.com/.test(src) ? true : `src/user.ts:\n${src}`;
        },
      },
      {
        name: "memory recorded the open thread",
        kind: "memory",
        run: async (ctx) => {
          const facts = await profile(ctx, "app", "project");
          const last = facts.find((f) => f.key === "last session")?.value ?? "";
          return /example\.org|test\.com|domain/i.test(last) ? true : `last session: ${last || "(none)"}`;
        },
      },
    ],
  },
  {
    name: "skill-from-procedure",
    about: "A procedure the user asks Mnemo to remember becomes a skill, and the next run follows it.",
    projects: {
      app: (d) => {
        nodeProject(d, "skill-app");
        write(d, "CHANGELOG.md", "# Changelog\n");
      },
    },
    sessions: [
      {
        project: "app",
        prompts: [
          "Do a patch release: bump the patch version in package.json, add a dated entry at the top of CHANGELOG.md describing it, " +
            "and commit both with the message 'release v<version>'. Remember exactly how to do this — I will ask for it again.",
        ],
      },
      { project: "app", prompts: ["Do another patch release please."] },
    ],
    checks: [
      {
        name: "a skill file was saved",
        kind: "memory",
        run: (ctx) => {
          const dir = path.join(ctx.dirs.app!, ".agents", "skills");
          const found = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
          return found.length ? true : "no skill under .agents/skills";
        },
      },
      {
        name: "later release followed the procedure (0.1.2, changelog, commit)",
        kind: "behaviour",
        run: (ctx) => {
          const version = (JSON.parse(ctx.read("app", "package.json")) as { version: string }).version;
          const log = spawnSync("git", ["log", "--format=%s"], { cwd: ctx.dirs.app!, encoding: "utf8" }).stdout;
          const entries = (ctx.read("app", "CHANGELOG.md").match(/0\.1\.\d/g) ?? []).length;
          if (version !== "0.1.2") return `version ${version}`;
          if (!/release v0\.1\.2/.test(log)) return `git log: ${log}`;
          return entries >= 2 ? true : `changelog mentions ${entries} versions`;
        },
      },
    ],
  },
  {
    name: "projects-stay-apart",
    about: "What is remembered in one repository does not leak into another.",
    projects: { a: (d) => nodeProject(d, "isolation-a"), b: (d) => nodeProject(d, "isolation-b") },
    sessions: [
      { project: "a", prompts: ["Remember for this repository: deployments are done with `make ship-alpha`, always."] },
      { project: "b", prompts: ["How do we deploy this repository? If you don't know, say so."] },
    ],
    checks: [
      {
        name: "the other project's command is not suggested",
        kind: "behaviour",
        run: (ctx) => (/ship-alpha/.test(allText(lastSession(ctx))) ? "session in project b mentioned ship-alpha" : true),
      },
      {
        name: "memory holds the command for project a only",
        kind: "memory",
        run: async (ctx) => {
          const a = await profile(ctx, "a", "project");
          const b = await profile(ctx, "b", "project");
          if (!a.some((f) => /ship-alpha/.test(f.value))) return `project a facts: ${JSON.stringify(a)}`;
          return b.some((f) => /ship-alpha/.test(f.value)) ? "leaked into project b" : true;
        },
      },
    ],
  },
];
