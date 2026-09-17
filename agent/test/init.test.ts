/**
 * #8 — `mnemo init`: the project-memory bootstrap proposes, and a person
 * disposes.
 *
 * Real temp projects and real temp HOMEs, injected consent: nothing here spawns
 * a shell, reads the developer's own `~/.mnemo/`, or leaves a file behind
 * (AGENTS.md, "Test fixtures never spawn a shell"; the same rule that made the
 * schedule and hooks suites pass on Windows).
 */
import { test, after } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BLOCK_END,
  BLOCK_START,
  detectRepoFacts,
  findMemoryTarget,
  runInit,
  unifiedDiff,
  upsertBlock,
} from "../src/init.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-init-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let counter = 0;

/**
 * One project per test, as a real directory tree. `.git` is created because the
 * project root is the nearest ancestor holding one — a fixture without it would
 * quietly exercise a different code path.
 */
function project(files: Record<string, string> = {}): { root: string; home: string } {
  const root = fs.mkdtempSync(path.join(tmp, `project-${counter++}-`));
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  const home = fs.mkdtempSync(path.join(tmp, `home-${counter++}-`));
  write(root, files);
  return { root, home };
}

function write(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  }
}

function read(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function exists(root: string, rel: string): boolean {
  return fs.existsSync(path.join(root, rel));
}

/** A CLI run with scripted answers; returns everything the caller needs to see. */
function cli(root: string, home: string, answers: string[] = []) {
  const log: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  return {
    log,
    err,
    asked,
    run: (argv: string[] = []) => runInit(argv, {
      cwd: root,
      home,
      env: {},
      log: (s) => log.push(s),
      err: (s) => err.push(s),
      // "" is the answer a closed stdin gives: nobody was there to consent.
      ask: async (q: string) => {
        asked.push(q);
        return answers.shift() ?? "";
      },
    }),
  };
}

const SAMPLE = {
  "package.json": JSON.stringify({
    name: "widget",
    description: "a small thing",
    scripts: { test: "node --test", build: "tsc" },
  }, null, 2),
  "README.md": "# widget\n",
  "src/index.ts": "export const x = 1;\n",
  "docs/notes.md": "# notes\n",
};

test("a project with no memory file gets one, built from what is actually in it", async () => {
  const { root, home } = project(SAMPLE);
  const c = cli(root, home);
  assert.equal(await c.run(), 0);
  assert.equal(c.asked.length, 0, "creating a file that does not exist overwrites nothing, so it asks nothing");

  const content = read(root, "AGENTS.md");
  assert.match(content, /widget — a small thing/, "the manifest's own name and description");
  assert.ok(content.includes("`npm run test`"), "the test command comes from package.json scripts");
  assert.ok(content.includes("`npm run build`"));
  assert.ok(content.includes("`src/` — source"), "the layout notes come from the directories present");
  assert.ok(content.includes("`docs/`"), "docs/ is described, not ignored");
  assert.match(content, /package\.json/);
  assert.ok(!content.includes("pnpm"), "nothing in this project mentions pnpm, so the file must not either");
  assert.ok(!content.includes("cargo"), "there is no Cargo.toml, so there is no cargo command");
});

test("a Go module gets go commands and no Node ones", async () => {
  const { root, home } = project({ "go.mod": "module example.com/thing\n\ngo 1.22\n", "cmd/main.go": "package main\n" });
  const c = cli(root, home);
  assert.equal(await c.run(), 0);
  const content = read(root, "AGENTS.md");
  assert.ok(content.includes("`go test ./...`"));
  assert.ok(!content.includes("npm run"), "no package.json, no npm command — a memory file that invents commands is worse than one that says nothing");
});

test("an existing memory file is only proposed to, and a refusal writes nothing", async () => {
  const human = "# Our rules\n\n- always use pnpm\n- never commit to main\n";
  const { root, home } = project({ ...SAMPLE, "AGENTS.md": human });
  const c = cli(root, home, ["n"]);
  assert.equal(await c.run(), 1);
  assert.equal(read(root, "AGENTS.md"), human, "a refusal leaves the file byte-for-byte identical");
  assert.match(c.err.join("\n"), /nothing written/);
  assert.ok(c.log.some((s) => s.includes("--- a/AGENTS.md")), "the diff is shown before the question");
  assert.ok(c.log.join("\n").includes(" - always use pnpm"), "the diff is against the real file, not a blank one");
  assert.ok(c.log.join("\n").includes("+"), "the proposal itself is visible, not just a line count");
  assert.equal(c.asked.length, 1, "asked exactly once");
});

test("consent appends the generated block and leaves every human line in place", async () => {
  const human = "# Our rules\n\n- always use pnpm\n";
  const { root, home } = project({ ...SAMPLE, "AGENTS.md": human });
  const c = cli(root, home, ["y"]);
  assert.equal(await c.run(), 0);
  const content = read(root, "AGENTS.md");
  assert.ok(content.startsWith(human), "the human's text stays exactly where it was");
  for (const line of human.split("\n")) assert.ok(content.includes(line));
  assert.ok(content.includes("# Our rules"), "the generated block adds no second title over a file someone wrote");
  assert.equal(content.split(BLOCK_START).length - 1, 1);
  assert.ok(content.includes(BLOCK_END));
});

test("a second run refreshes the marked block instead of appending a copy", async () => {
  const { root, home } = project({ ...SAMPLE, "AGENTS.md": "# ours\n" });
  assert.equal(await cli(root, home, ["y"]).run(), 0);

  // Unchanged repository: the proposal equals the file, so there is nothing to
  // ask about and nothing to write.
  const again = cli(root, home, ["y"]);
  assert.equal(await again.run(), 0);
  assert.equal(again.asked.length, 0, "an up-to-date block is not a change");
  assert.match(again.log.join("\n"), /already up to date/);

  // The repository moved on: the same block is replaced in place.
  write(root, { "package.json": JSON.stringify({ name: "widget", scripts: { test: "node --test", lint: "eslint ." } }) });
  const third = cli(root, home, ["y"]);
  assert.equal(await third.run(), 0);
  const content = read(root, "AGENTS.md");
  assert.equal(content.split(BLOCK_START).length - 1, 1, "exactly one generated block, forever");
  assert.ok(content.includes("`npm run lint`"), "the refreshed block carries the new fact");
  assert.equal(content.split("# ours").length - 1, 1);
});

test("a deny rule blocks the write even when the answer is yes", async () => {
  const { root, home } = project({
    ...SAMPLE,
    "AGENTS.md": "# ours\n",
    ".mnemo/permissions.json": JSON.stringify({
      version: 1,
      rules: [{ tool: "write_file", pattern: "*AGENTS.md", action: "deny" }],
      default: "ask",
    }),
  });
  const c = cli(root, home, ["y"]);
  assert.equal(await c.run(), 1);
  assert.equal(c.asked.length, 0, "a deny is a decision already made — it is enforced, not asked about");
  assert.match(c.err.join("\n"), /deny rule/);
  assert.equal(read(root, "AGENTS.md"), "# ours\n");
});

test("a deny rule blocks the write on a file that does not exist yet", async () => {
  const { root, home } = project({
    ...SAMPLE,
    ".mnemo/permissions.json": JSON.stringify({
      version: 1,
      rules: [{ tool: "write_file", pattern: "*AGENTS.md", action: "deny" }],
      default: "ask",
    }),
  });
  const c = cli(root, home, ["y"]);
  assert.equal(await c.run(), 1);
  assert.equal(exists(root, "AGENTS.md"), false);
});

test("--dry-run shows the proposal and writes nothing", async () => {
  const { root, home } = project({ ...SAMPLE, "AGENTS.md": "# ours\n" });
  const c = cli(root, home, ["y"]);
  assert.equal(await c.run(["--dry-run"]), 0);
  assert.equal(c.asked.length, 0);
  assert.equal(read(root, "AGENTS.md"), "# ours\n");
  assert.ok(c.log.join("\n").includes("--dry-run"));
  assert.ok(c.log.join("\n").includes(BLOCK_START), "the dry run still shows what it would write");
});

test("a file pi loads by another name is the file that gets updated", async () => {
  // pi loads AGENTS.override.md in preference to AGENTS.md, so writing AGENTS.md
  // here would leave the agent reading the file nobody updated.
  const { root, home } = project({ ...SAMPLE, "AGENTS.override.md": "# override\n" });
  assert.equal(findMemoryTarget(root).relative, "AGENTS.override.md");
  const c = cli(root, home, ["y"]);
  assert.equal(await c.run(), 0);
  assert.ok(read(root, "AGENTS.override.md").includes(BLOCK_START));
  assert.equal(exists(root, "AGENTS.md"), false, "no second memory file appears beside the one pi reads");
});

test("with no answer at all, an existing file is left alone — and --yes is the way to say yes", async () => {
  const human = "# ours\n";
  const { root, home } = project({ ...SAMPLE, "AGENTS.md": human });
  const nonTty = cli(root, home, []); // the ask seam returns "" — a closed stdin
  assert.equal(await nonTty.run(), 1);
  assert.equal(read(root, "AGENTS.md"), human);
  assert.match(nonTty.err.join("\n"), /no consent/);

  const explicit = cli(root, home, []);
  assert.equal(await explicit.run(["--yes"]), 0);
  assert.equal(explicit.asked.length, 0, "--yes states the consent in the command; it does not ask again");
  assert.ok(read(root, "AGENTS.md").includes(BLOCK_START));
});

test("an unknown argument is a usage error, not a silent write", async () => {
  const { root, home } = project(SAMPLE);
  const c = cli(root, home);
  assert.equal(await c.run(["--force"]), 2);
  assert.equal(exists(root, "AGENTS.md"), false);
  assert.match(c.err.join("\n"), /usage: mnemo init/);
});

test("detectRepoFacts reports only files that are there", () => {
  const { root } = project(SAMPLE);
  const facts = detectRepoFacts(root);
  assert.equal(facts.name, "widget");
  assert.deepEqual(facts.manifests, ["package.json"]);
  assert.deepEqual(facts.layout.map((d) => d.name), ["docs", "src"]);
  assert.ok(facts.git);
});

test("upsertBlock replaces in place, appends when absent, and never drops a line", () => {
  const block = `${BLOCK_START} -->\nbody one\n${BLOCK_END}\n`;
  assert.equal(upsertBlock("", block), `\n${block}`);
  assert.equal(upsertBlock("# ours\n", block), `# ours\n\n${block}`);

  const once = upsertBlock("# ours\n", block);
  const twice = upsertBlock(once, `${BLOCK_START} -->\nbody two\n${BLOCK_END}\n`);
  assert.ok(twice.startsWith("# ours\n"), "the human's text survives a refresh");
  assert.ok(twice.includes("body two"), "the block is replaced, not duplicated");
  assert.ok(!twice.includes("body one"));
  assert.equal(twice.split(BLOCK_START).length - 1, 1);
});

test("unifiedDiff shows the change itself, and nothing when there is none", () => {
  assert.equal(unifiedDiff("a\nb\n", "a\nb\n", "AGENTS.md"), "");
  const d = unifiedDiff("a\nb\nc\n", "a\nB\nc\n", "AGENTS.md");
  assert.ok(d.startsWith("--- a/AGENTS.md\n+++ b/AGENTS.md\n"), d);
  assert.match(d, /^@@ -1,3 \+1,3 @@$/m);
  assert.match(d, /^-b$/m);
  assert.match(d, /^\+B$/m);
  assert.match(d, /^ [ac]$/m);
});
