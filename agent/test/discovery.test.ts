import { test } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { discoverSkills, parseFrontmatter, projectAncestors } from "../src/skills/discovery.ts";

async function writeSkill(root: string, relDir: string, name: string, description: string, body = "do the thing"): Promise<string> {
  const dir = path.join(root, relDir, name);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  await fs.writeFile(file, `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`, "utf8");
  return file;
}

/**
 * A project fixture that is its own git root, and a home with nothing in it.
 *
 * `projectAncestors` walks up until it finds `.git`, and to the filesystem
 * root when there is none. os.tmpdir() is `/tmp`, one level below `/`, on
 * Linux — but `C:\Users\<user>\AppData\Local\Temp` on Windows, so a fixture
 * without a `.git` marker walks straight up through the developer's home and
 * discovers their own `~/.agents/skills` as PROJECT skills: names nobody wrote
 * in this test appear in the catalogue and the assertion below fails on one
 * machine and passes on another. The `.git` marker ends the walk inside the
 * fixture. The empty home does the same job for the global locations, which
 * would otherwise read `~/.pi/agent/skills` off the machine running the test.
 */
async function freshProject(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(dir, ".git"), { recursive: true });
  return dir;
}

async function freshHome(prefix = "sea-home-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("parseFrontmatter handles flat keys and strips quotes", () => {
  const parsed = parseFrontmatter('---\nname: "my-skill"\ndescription: Does things\n---\nBODY');
  assert.ok(parsed);
  assert.equal(parsed.meta.name, "my-skill");
  assert.equal(parsed.meta.description, "Does things");
  assert.equal(parsed.body, "BODY");
});

test("parseFrontmatter rejects malformed frontmatter", () => {
  assert.equal(parseFrontmatter("no fences here"), null);
  assert.equal(parseFrontmatter("---\nname: x\n"), null); // unterminated
  assert.equal(parseFrontmatter("---\nnested:\n  key: val\n---\nb\n"), null); // non-flat
});

test("discovers project skills in .pi/skills and .agents/skills", async () => {
  const proj = await freshProject("sea-proj-");
  const home = await freshHome();
  await writeSkill(proj, ".pi/skills", "alpha", "Alpha skill");
  await writeSkill(proj, ".agents/skills", "beta", "Beta skill");
  const skills = await discoverSkills({ cwd: proj, home });
  assert.deepEqual(skills.map((s) => s.name).sort(), ["alpha", "beta"]);
  assert.ok(skills.every((s) => s.scope === "project"));
});

test("walks ancestors up to git root only", async () => {
  const outer = await fs.mkdtemp(path.join(os.tmpdir(), "sea-out-"));
  const gitRoot = path.join(outer, "repo");
  const deep = path.join(gitRoot, "a", "b");
  await fs.mkdir(deep, { recursive: true });
  await fs.mkdir(path.join(gitRoot, ".git"));
  await writeSkill(gitRoot, ".pi/skills", "repo-skill", "From git root");
  await writeSkill(outer, ".agents/skills", "outside-skill", "Above git root");
  const skills = await discoverSkills({ cwd: deep, home: await freshHome() });
  assert.deepEqual(skills.map((s) => s.name), ["repo-skill"]);
  // ancestor order: nearest first
  assert.equal(projectAncestors(deep)[0], deep);
  assert.deepEqual(projectAncestors(deep).at(-1), gitRoot);
});

test("project overrides global on name clash", async () => {
  const proj = await freshProject("sea-clash-");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "sea-home-"));
  await writeSkill(proj, ".pi/skills", "dupe", "PROJECT version");
  await writeSkill(home, path.join(".pi", "agent", "skills"), "dupe", "GLOBAL version");
  await writeSkill(home, path.join(".pi", "agent", "skills"), "only-global", "Global only");
  const skills = await discoverSkills({ cwd: proj, home });
  const dupe = skills.find((s) => s.name === "dupe")!;
  assert.equal(dupe.scope, "project");
  assert.equal(dupe.description, "PROJECT version");
  assert.equal(skills.filter((s) => s.name === "dupe").length, 1);
  assert.ok(skills.some((s) => s.name === "only-global" && s.scope === "global"));
});

test("malformed SKILL.md files are skipped gracefully", async () => {
  const proj = await freshProject("sea-bad-");
  await fs.mkdir(path.join(proj, ".pi/skills/broken"), { recursive: true });
  await fs.writeFile(path.join(proj, ".pi/skills/broken/SKILL.md"), "no frontmatter at all", "utf8");
  await fs.mkdir(path.join(proj, ".pi/skills/nofence"), { recursive: true });
  await fs.writeFile(path.join(proj, ".pi/skills/nofence/SKILL.md"), "---\nname: x\n", "utf8");
  await fs.mkdir(path.join(proj, ".pi/skills/empty"), { recursive: true }); // no SKILL.md
  await writeSkill(proj, ".pi/skills", "good", "Fine skill");
  const skills = await discoverSkills({ cwd: proj, home: await freshHome() });
  assert.deepEqual(skills.map((s) => s.name), ["good"]);
});

test("returns empty list when no locations exist", async () => {
  // the project contains nothing but the .git marker, and it is also the home,
  // so there is no global location either
  const proj = await freshProject("sea-none-");
  const skills = await discoverSkills({ cwd: proj, home: proj });
  assert.deepEqual(skills, []);
});
