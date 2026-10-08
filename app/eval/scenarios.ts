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
import { MemoryService, projectIdentity } from "@mnemo/memory";
import type { SessionResult } from "./harness.ts";

export interface Ctx {
  /** Project directories by name. */
  dirs: Record<string, string>;
  sessions: SessionResult[];
  memory?: MemoryService;
  /** The Mnemo home every session ran with (skills, a Hermes-style memory's files). */
  home: string;
  read(project: string, file: string): string;
}

export interface Check {
  name: string;
  /** behaviour: what the agent did; memory: Mnemo's memory (Mnemo arm only); knowledge: what any arm stored (skills, memory files). */
  kind: "behaviour" | "memory" | "knowledge";
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


/** Every SKILL.md the agent could load afterwards: the repositories' and the personal ones. */
function skillTexts(ctx: Ctx): string[] {
  const dirs = [...Object.values(ctx.dirs).map((d) => path.join(d, ".agents", "skills")), path.join(ctx.home, "agent", "skills")];
  return dirs.flatMap((dir) =>
    fs.existsSync(dir) ? fs.readdirSync(dir).flatMap((n) => (fs.existsSync(path.join(dir, n, "SKILL.md")) ? [fs.readFileSync(path.join(dir, n, "SKILL.md"), "utf8")] : [])) : [],
  );
}

/**
 * Everything an arm stored for later, as later recall can surface it: skills,
 * a Hermes-style memory's files, and Mnemo's profile facts and pitfall fixes
 * — not its raw logs, which record what happened, not what was learned.
 */
async function knowledge(ctx: Ctx): Promise<string[]> {
  const hermes = ["MEMORY.md", "USER.md"].map((f) => path.join(ctx.home, "hermes", "memories", f)).filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, "utf8"));
  const mnemo: string[] = [];
  if (ctx.memory)
    for (const dir of Object.values(ctx.dirs)) {
      const id = projectIdentity(dir).id;
      mnemo.push(...(await ctx.memory.profile("project", id)).map((f) => `${f.key}: ${f.value}`));
      mnemo.push(...(await ctx.memory.search("release publish sign build", 10)).filter((h) => h.area === "Salience" && /fix:/.test(h.state)).map((h) => h.state));
    }
  return [...skillTexts(ctx), ...hermes, ...mnemo];
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
          // "do not use npm install" is the convention kept, not broken: only an unnegated mention counts.
          const suggested = t.split("\n").filter((l) => /\bnpm install\b|\bnpm i\b|\byarn install\b|\byarn add\b/.test(l) && !/\b(not|never|don'?t|instead of|avoid|rather than)\b/.test(l));
          if (suggested.length) return `session 2 suggested npm/yarn: ${suggested[0]!.trim().slice(0, 120)}`;
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
        // A real (if small) suite: a stub that only echoes "passed" makes a model audit it instead of running it.
        write(d, "scripts/setup.sh", `#!/bin/sh\nmkdir -p test/fixtures\nprintf '[{"id":1,"email":"a@b.dev"},{"id":2,"email":"c@d.dev"}]' > test/fixtures/users.json\necho "setup complete"\n`);
        write(
          d,
          "scripts/test.sh",
          `#!/bin/sh\nif [ ! -f test/fixtures/users.json ]; then\n  echo "error: test fixtures missing — run sh scripts/setup.sh first" >&2\n  exit 1\nfi\nnode --test\n`,
        );
        write(
          d,
          "test/users.test.mjs",
          `import { test } from "node:test";\nimport assert from "node:assert";\nimport { readFileSync } from "node:fs";\n\n` +
            `const users = JSON.parse(readFileSync(new URL("./fixtures/users.json", import.meta.url), "utf8"));\n\n` +
            `test("every fixture user has an email", () => {\n  for (const u of users) assert.match(u.email, /@/);\n});\n\n` +
            `test("ids are unique", () => {\n  assert.equal(new Set(users.map((u) => u.id)).size, users.length);\n});\n`,
        );
        write(d, ".gitignore", "test/fixtures/\n");
      },
    },
    sessions: [
      { project: "app", prompts: ["Run the test suite with `sh scripts/test.sh` and make it pass. Tell me the result."] },
      {
        project: "app",
        before: (dirs) => fs.rmSync(path.join(dirs.app!, "test", "fixtures"), { recursive: true, force: true }),
        prompts: ["Run the tests (scripts/test.sh) and tell me the result."],
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
          // The error as a run prints it, at a line start — not a script or a skill quoting it.
          const hit = ctx.sessions.map((s) => s.tools.filter((t) => /^error: test fixtures missing/m.test(t.output)).length);
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
    name: "checks-its-work",
    about: "A change in a project with tests is checked before it is called done, and the suite passes at the end.",
    projects: {
      app: (d) => {
        nodeProject(d, "slug-app");
        const pkg = JSON.parse(fs.readFileSync(path.join(d, "package.json"), "utf8"));
        pkg.scripts = { test: "node --test" };
        write(d, "package.json", JSON.stringify(pkg, null, 2) + "\n");
        write(
          d,
          "src/slug.mjs",
          `/** URL slugs for article titles. */\nexport function slugify(title) {\n  return title\n    .toLowerCase()\n    .normalize("NFKD")\n    .replace(/[\\u0300-\\u036f]/g, "")\n    .replace(/[^a-z0-9]+/g, "-");\n}\n`,
        );
        write(
          d,
          "test/slug.test.mjs",
          `import { test } from "node:test";\nimport assert from "node:assert";\nimport { slugify } from "../src/slug.mjs";\n\n` +
            `test("lower-cases and joins words", () => assert.equal(slugify("Hello World"), "hello-world"));\n` +
            `test("drops accents", () => assert.equal(slugify("Crème Brûlée"), "creme-brulee"));\n` +
            `test("collapses runs of separators", () => assert.equal(slugify("a -- b"), "a-b"));\n` +
            `test("keeps digits", () => assert.equal(slugify("Top 10 Tips"), "top-10-tips"));\n`,
        );
      },
    },
    sessions: [
      {
        project: "app",
        prompts: ["slugify should never start or end with a dash (\"  Hello!  \" should become \"hello\"), and should cut slugs to at most 40 characters without leaving a dash at the end. Please change it."],
      },
    ],
    checks: [
      {
        name: "ran the tests after its last change",
        kind: "behaviour",
        run: (ctx) => {
          const tools = lastSession(ctx).tools;
          const lastEdit = tools.map((t) => t.name).lastIndexOf("edit") > tools.map((t) => t.name).lastIndexOf("write") ? tools.map((t) => t.name).lastIndexOf("edit") : tools.map((t) => t.name).lastIndexOf("write");
          if (lastEdit < 0) return "no edit";
          const after = tools.slice(lastEdit + 1).filter((t) => t.name === "bash").map((t) => String(t.args.command ?? ""));
          return after.some((c) => /node --test|npm (run )?test|pnpm test|bun test/.test(c)) ? true : `commands after the last edit: ${JSON.stringify(after)}`;
        },
      },
      {
        name: "the suite passes, old behaviour and new",
        kind: "behaviour",
        run: async (ctx) => {
          const dir = ctx.dirs.app!;
          const extra =
            `import { test } from "node:test";\nimport assert from "node:assert";\nimport { slugify } from "../src/slug.mjs";\n` +
            `test("no edge dashes", () => assert.equal(slugify("  Hello!  "), "hello"));\n` +
            `test("at most 40, no trailing dash", () => { const s = slugify("a".repeat(39) + " bcd"); assert.ok(s.length <= 40 && !s.endsWith("-"), s); });\n`;
          fs.writeFileSync(path.join(dir, "test", "zz-hidden.test.mjs"), extra);
          const r = spawnSync("node", ["--test"], { cwd: dir, encoding: "utf8" });
          return r.status === 0 ? true : `node --test:\n${(r.stdout + r.stderr).split("\n").filter((l) => /^not ok|# (pass|fail)/.test(l)).join("\n")}`;
        },
      },
    ],
  },
  {
    name: "procedure-evolves",
    about: "A procedure learned in one session is corrected when the world changes, and the corrected version is followed afterwards.",
    projects: {
      app: (d) => {
        nodeProject(d, "relay");
        const pkg = JSON.parse(fs.readFileSync(path.join(d, "package.json"), "utf8"));
        pkg.scripts = { build: "node scripts/build.mjs", publish: "node scripts/publish.mjs" };
        write(d, "package.json", JSON.stringify(pkg, null, 2) + "\n");
        write(d, "src/relay.mjs", `export const relay = (msg) => \`relay:\${msg}\`;\n`);
        write(
          d,
          "scripts/build.mjs",
          `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";\nconst { version } = JSON.parse(readFileSync("package.json", "utf8"));\nmkdirSync("dist", { recursive: true });\n` +
            `writeFileSync("dist/relay.js", "// relay " + version + "\\n" + readFileSync("src/relay.mjs", "utf8"));\nconsole.log("built relay " + version);\n`,
        );
        write(
          d,
          "scripts/publish.mjs",
          `import { cpSync, existsSync, readFileSync } from "node:fs";\nconst { version } = JSON.parse(readFileSync("package.json", "utf8"));\n` +
            `if (!existsSync("dist/relay.js") || !readFileSync("dist/relay.js", "utf8").includes(version)) { console.error("error: dist is stale — run npm run build first"); process.exit(1); }\n` +
            `if (existsSync(".release-policy") && readFileSync(".release-policy", "utf8").includes("signed") && !existsSync("dist/SIGNATURE")) { console.error("error: unsigned build — run npm run sign before npm run publish"); process.exit(1); }\n` +
            `cpSync("dist", "registry/" + version, { recursive: true });\nconsole.log("published relay " + version);\n`,
        );
        write(d, ".gitignore", "dist/\n");
      },
    },
    sessions: [
      {
        project: "app",
        prompts: [
          "Release a new version of relay: bump the patch version in package.json, run npm run build, then npm run publish, and commit. Remember how to do releases — I will ask again.",
        ],
      },
      {
        project: "app",
        // The team changed the process between releases: builds must be signed now.
        before: (dirs) => {
          const d = dirs.app!;
          write(d, ".release-policy", "signed\n");
          write(d, "scripts/sign.mjs", `import { readFileSync, writeFileSync } from "node:fs";\nimport { createHash } from "node:crypto";\nwriteFileSync("dist/SIGNATURE", createHash("sha256").update(readFileSync("dist/relay.js")).digest("hex"));\nconsole.log("signed dist/relay.js");\n`);
          const pkg = JSON.parse(fs.readFileSync(path.join(d, "package.json"), "utf8"));
          pkg.scripts.sign = "node scripts/sign.mjs";
          write(d, "package.json", JSON.stringify(pkg, null, 2) + "\n");
          spawnSync("git", ["add", "-A"], { cwd: d });
          spawnSync("git", ["-c", "user.email=e@x", "-c", "user.name=eval", "commit", "-qm", "require signed releases"], { cwd: d });
          fs.rmSync(path.join(d, "dist"), { recursive: true, force: true });
        },
        prompts: ["Do another release please."],
      },
      { project: "app", before: (dirs) => fs.rmSync(path.join(dirs.app!, "dist"), { recursive: true, force: true }), prompts: ["Release again, please."] },
    ],
    checks: [
      {
        name: "the second release went out despite the new rule",
        kind: "behaviour",
        run: (ctx) => (fs.existsSync(path.join(ctx.dirs.app!, "registry", "0.1.2", "SIGNATURE")) ? true : `registry: ${fs.existsSync(path.join(ctx.dirs.app!, "registry")) ? fs.readdirSync(path.join(ctx.dirs.app!, "registry")).join(", ") : "(none)"}`),
      },
      {
        name: "the third release follows the corrected procedure (signed, never refused)",
        kind: "behaviour",
        run: (ctx) => {
          const refused = lastSession(ctx).tools.filter((t) => /^error: unsigned build/m.test(t.output)).length;
          if (!fs.existsSync(path.join(ctx.dirs.app!, "registry", "0.1.3", "SIGNATURE"))) return "0.1.3 not published signed";
          return refused === 0 ? true : `refused ${refused} time(s) for an unsigned build`;
        },
      },
      {
        name: "what was learned includes the signing step",
        kind: "knowledge",
        run: async (ctx) => {
          const stored = await knowledge(ctx);
          const found = stored.filter((t) => /npm run sign|\bsign(ed|ing)?\b/i.test(t));
          return found.length ? true : `nothing stored mentions signing (stored: ${stored.length} items)`;
        },
      },
      {
        name: "the release procedure is a skill",
        kind: "knowledge",
        run: (ctx) => (skillTexts(ctx).some((t) => /publish/.test(t)) ? true : `skills: ${skillTexts(ctx).length}`),
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
