import { test, beforeEach } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  listSkillsTool,
  loadSkillTool,
  createSkillTool,
  sanitizeSkillName,
  setSkillsHome,
  setProjectRoot,
  globalSkillDir,
} from "../src/tools/skills.ts";
import { discoverSkills } from "../src/skills/discovery.ts";

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sea-skills-"));
  setSkillsHome(tmp);
  setProjectRoot(tmp); // isolate from this repo's own .agents/skills
});

test("sanitizeSkillName enforces [a-z0-9-]", () => {
  assert.equal(sanitizeSkillName("Hello World!"), "hello-world");
  assert.equal(sanitizeSkillName("  My--Skill_2 "), "my-skill-2");
  assert.throws(() => sanitizeSkillName("!!!"));
});

test("create_skill roundtrips through discovery", async () => {
  const res = await createSkillTool.execute("c1", {
    name: "Code Review",
    description: "Reviews code carefully",
    instructions: "1. Read the diff.\n2. Comment on bugs.",
  });
  const file = path.join(globalSkillDir(), "code-review", "SKILL.md");
  assert.equal((res.details as any).path, file);
  const onDisk = await fs.readFile(file, "utf8");
  assert.match(onDisk, /^---\nname: code-review\ndescription: Reviews code carefully\n---\n/);

  const skills = await discoverSkills({ cwd: tmp, home: tmp });
  const found = skills.find((s) => s.name === "code-review");
  assert.ok(found);
  assert.equal(found.scope, "global");
  assert.equal(found.description, "Reviews code carefully");
});

test("load_skill returns full SKILL.md body", async () => {
  await createSkillTool.execute("c2", {
    name: "greeter",
    description: "Says hello",
    instructions: "Always greet warmly.",
  });
  const res = await loadSkillTool.execute("l1", { name: "greeter" });
  assert.match(res.content[0].text, /name: greeter/);
  assert.match(res.content[0].text, /Always greet warmly\./);
});

test("load_skill errors with available names on unknown skill", async () => {
  await createSkillTool.execute("c3", { name: "known", description: "d", instructions: "i" });
  await assert.rejects(() => loadSkillTool.execute("l2", { name: "missing" }), /Available: known/);
});

test("list_skills renders a table", async () => {
  await createSkillTool.execute("c4", { name: "aa", description: "First", instructions: "x" });
  await createSkillTool.execute("c5", { name: "bbb", description: "Second", instructions: "y" });
  const res = await listSkillsTool.execute("t1", {});
  const lines = res.content[0].text.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^aa {3}global {3}First$/);
  assert.match(lines[1], /^bbb +global +Second$/);
});

test("list_skills on empty state", async () => {
  const res = await listSkillsTool.execute("t2", {});
  assert.equal(res.content[0].text, "(no skills found)");
});
