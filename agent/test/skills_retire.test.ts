/**
 * retire_skill: supersede a skill without deleting it.
 *
 * Same temp-dir + stub-client discipline as skills_patch.test.ts: the real
 * home, the real skill roots and a real memsrv are all out of the picture
 * except in the one integration test at the bottom.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  createSkillTool,
  globalSkillDir,
  makeRetireSkillTool,
  setProjectRoot,
  setSkillsHome,
} from "../src/tools/skills.ts";
import { listHistory, setMnemoHome, sha256Hex } from "../src/skills/skill-history.ts";
import { discoverSkills } from "../src/skills/discovery.ts";
import { textOf } from "../src/tools/types.ts";

let tmp: string;

function recordingMem(overrides: Record<string, (p: any) => any> = {}) {
  const calls: Array<{ method: string; params: any }> = [];
  const client = {
    calls,
    async request(method: string, params: any = {}) {
      calls.push({ method, params });
      if (overrides[method]) return overrides[method](params);
      if (method === "create_node") return { ok: true, result: { node: 9 } };
      if (method === "fact") return { ok: true, result: { fact: 100 } };
      if (method === "state") return { ok: true, result: { state: "facts:\n  - skill: x\n" } };
      if (method === "dump") return { ok: true, result: { nodes: [] } };
      if (method === "link") return { ok: true, result: { edge: 3 } };
      return { ok: true, result: {} };
    },
  };
  return client;
}

async function writeSkill(name: string, description: string, body: string, rel = path.join(".pi", "agent", "skills")): Promise<string> {
  const dir = path.join(tmp, rel, name);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  await fs.writeFile(file, `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`, "utf8");
  return file;
}

async function refusal(tool: { execute: Function }, args: any): Promise<string> {
  try {
    await tool.execute("x", args);
  } catch (err: any) {
    return String(err?.message ?? err);
  }
  throw new assert.AssertionError({ message: `expected a refusal for ${JSON.stringify(args)}` });
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sea-skill-retire-"));
  await fs.mkdir(path.join(tmp, ".git"), { recursive: true }); // stop the ancestor walk at tmp
  setSkillsHome(tmp);
  setProjectRoot(tmp);
  setMnemoHome(tmp);
});

test("retire supersedes: the file stays, discovery drops it, memory records it", async () => {
  const mem = recordingMem();
  await createSkillTool.execute("c1", {
    name: "old-deploy",
    description: "Deploy the old way",
    instructions: "1. rsync\n2. restart",
  });
  const file = path.join(globalSkillDir(), "old-deploy", "SKILL.md");
  const before = await fs.readFile(file, "utf8");

  const res = await makeRetireSkillTool({ mem }).execute("r1", {
    name: "old-deploy",
    reason: "superseded by the migrator service",
    evidence: [4, "rsync lost the exec bit again"],
    expectedHash: sha256Hex(before),
  });

  const details = res.details as any;
  assert.equal(details.path, file);
  assert.equal(details.discovered, false);
  const after = await fs.readFile(file, "utf8");
  // supersede, not delete: the instructions and identity are all still there,
  // the retirement is one frontmatter line
  assert.equal(
    after,
    "---\nname: old-deploy\ndescription: Deploy the old way\nretired: \"superseded by the migrator service\"\n---\n\n1. rsync\n2. restart\n",
  );

  assert.equal(await fs.readFile(details.history, "utf8"), before, "undo copy holds the pre-retirement body");
  assert.deepEqual(await listHistory("old-deploy"), [details.history]);

  // discovery no longer offers it — the roundtrip check ran inside the tool
  const skills = await discoverSkills({ cwd: tmp, home: tmp });
  assert.ok(!skills.some((s) => s.name === "old-deploy"), "a retired skill is not discovered");

  // memory: commit_log + `retired` fact + link, on the skill's procedural node
  const log = mem.calls.find((c) => c.method === "commit_log")!.params;
  assert.equal(log.kind, "skill_retire");
  assert.match(log.detail, /superseded by the migrator service/);
  assert.match(log.detail, /#4/);
  const retiredFact = mem.calls.filter((c) => c.method === "fact").map((c) => c.params).find((f) => f.key === "retired");
  assert.ok(retiredFact, "a `retired` fact records it");
  assert.ok(retiredFact.value.startsWith(`${details.timestamp}: `));
  assert.deepEqual(mem.calls.find((c) => c.method === "link")!.params, { src: 9, dst: 4 });

  assert.match(textOf(res), /Retired skill "old-deploy"/);
  assert.match(textOf(res), /remove the retired line to bring the skill back/);
});

test("retirement is reversible: removing the line brings the skill back", async () => {
  const file = await writeSkill("comeback", "Comes back", "body");
  await makeRetireSkillTool({ mem: recordingMem() }).execute("r2", {
    name: "comeback",
    reason: "temporarily superseded",
    evidence: ["sig"],
  });
  assert.ok(!(await discoverSkills({ cwd: tmp, home: tmp })).some((s) => s.name === "comeback"));

  const retired = await fs.readFile(file, "utf8");
  await fs.writeFile(file, retired.replace(/^retired: .*\n/m, ""), "utf8");
  const found = (await discoverSkills({ cwd: tmp, home: tmp })).find((s) => s.name === "comeback");
  assert.ok(found, "un-retiring is just deleting the line");
  assert.equal(found.path, file);
});

test("retire refuses without evidence and without a reason", async () => {
  await writeSkill("ev", "Needs evidence", "body");
  const tool = makeRetireSkillTool({ mem: recordingMem() });
  assert.match(await refusal(tool, { name: "ev", reason: "r", evidence: [] }), /evidence is required/);
  assert.match(await refusal(tool, { name: "ev", reason: " ", evidence: [1] }), /reason is required/);
});

test("retire refuses an unknown skill", async () => {
  const message = await refusal(makeRetireSkillTool({ mem: recordingMem() }), {
    name: "ghost",
    reason: "r",
    evidence: [1],
  });
  assert.match(message, /no skill named "ghost"/);
});

test("retire refuses a skill outside the patchable roots", async () => {
  const file = await writeSkill("outsider", "Somewhere else", "body", path.join(".pi", "skills"));
  const before = await fs.readFile(file, "utf8");
  const message = await refusal(makeRetireSkillTool({ mem: recordingMem() }), {
    name: "outsider",
    reason: "r",
    evidence: [1],
  });
  assert.match(message, /outside the patchable roots/);
  assert.equal(await fs.readFile(file, "utf8"), before);
});

test("retire refuses a stale expectedHash", async () => {
  const file = await writeSkill("hashy", "Hash check", "body");
  const before = await fs.readFile(file, "utf8");
  const message = await refusal(makeRetireSkillTool({ mem: recordingMem() }), {
    name: "hashy",
    reason: "r",
    evidence: [1],
    expectedHash: sha256Hex("stale"),
  });
  assert.match(message, /expectedHash does not match/);
  assert.equal(await fs.readFile(file, "utf8"), before);
});

test("when another skill of the same name would survive, the retirement is undone", async () => {
  // the project skill wins discovery; retiring it reveals the global one
  const project = await writeSkill("dup", "Project copy", "project body", path.join(".agents", "skills"));
  await writeSkill("dup", "Global copy", "global body");
  const before = await fs.readFile(project, "utf8");

  const message = await refusal(makeRetireSkillTool({ mem: recordingMem() }), {
    name: "dup",
    reason: "r",
    evidence: [1],
  });
  assert.match(message, /discovery still finds "dup"/);
  assert.match(message, /write was undone/);
  assert.equal(await fs.readFile(project, "utf8"), before, "the half-applied retirement was rolled back");
  assert.ok((await discoverSkills({ cwd: tmp, home: tmp })).some((s) => s.name === "dup"));
});

test("a dead memory sidecar never fails the retirement", async () => {
  const file = await writeSkill("offline", "Still retirable", "body");
  const res = await makeRetireSkillTool({ mem: { async request() { throw new Error("memsrv crashed"); } } as any })
    .execute("r3", { name: "offline", reason: "r", evidence: [1] });
  assert.equal((res.details as any).memory.recorded, false);
  assert.match(textOf(res), /memory: retirement not recorded/);
  assert.match(await fs.readFile(file, "utf8"), /retired: "r"/);
});
