/**
 * patch_skill: the self-improvement path for Mnemo's own skills.
 *
 * Every test drives temp dirs (project root, skills home, Mnemo home — never
 * the real ~/.mnemo) and, except the last one, a recording stub memory client,
 * so what is asserted is exactly the RPCs that would reach memsrv.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPatchableSkillPath,
  createSkillTool,
  globalSkillDir,
  makePatchSkillTool,
  patchableRoots,
  setProjectRoot,
  setSkillsHome,
} from "../src/tools/skills.ts";
import { listHistory, setMnemoHome, sha256Hex, skillHistoryDir } from "../src/skills/skill-history.ts";
import { discoverSkills } from "../src/skills/discovery.ts";
import { textOf } from "../src/tools/types.ts";

let tmp: string;

/** Records every request a fake client receives (the recall.test.ts pattern). */
function recordingMem(overrides: Record<string, (p: any) => any> = {}) {
  const calls: Array<{ method: string; params: any }> = [];
  const client = {
    calls,
    async request(method: string, params: any = {}) {
      calls.push({ method, params });
      if (overrides[method]) return overrides[method](params);
      if (method === "create_node") return { ok: true, result: { node: 7 } };
      if (method === "fact") return { ok: true, result: { fact: 100 } };
      if (method === "state") return { ok: true, result: { state: "facts:\n  - skill: x\n" } };
      if (method === "dump") return { ok: true, result: { nodes: [] } };
      if (method === "link") return { ok: true, result: { edge: 3 } };
      return { ok: true, result: {} };
    },
  };
  return client;
}

/** A skill under the global root; returns the SKILL.md path. */
async function writeSkill(name: string, description: string, body: string, rel = path.join(".pi", "agent", "skills")): Promise<string> {
  const dir = path.join(tmp, rel, name);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  await fs.writeFile(file, `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`, "utf8");
  return file;
}

/** The refusal message from a tool call that must throw. */
async function refusal(tool: { execute: Function }, args: any): Promise<string> {
  try {
    await tool.execute("x", args);
  } catch (err: any) {
    return String(err?.message ?? err);
  }
  throw new assert.AssertionError({ message: `expected a refusal for ${JSON.stringify(args)}` });
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sea-skill-patch-"));
  // The .git marker stops the discovery ancestor walk at tmp: this machine's
  // real ~/.agents/skills must never leak into a fixture.
  await fs.mkdir(path.join(tmp, ".git"), { recursive: true });
  setSkillsHome(tmp);
  setProjectRoot(tmp);
  setMnemoHome(tmp);
});

test("patch replaces a unique anchor, keeps a timestamped undo copy, and records it in memory", async () => {
  const mem = recordingMem();
  await createSkillTool.execute("c1", {
    name: "db-migrations",
    description: "Run database migrations",
    instructions: "1. stop the app\n2. run the migration\n\n## Pitfalls\n\nnone known",
  });
  const file = path.join(globalSkillDir(), "db-migrations", "SKILL.md");
  const before = await fs.readFile(file, "utf8");

  const res = await makePatchSkillTool({ mem }).execute("p1", {
    name: "db-migrations",
    edits: [{ find: "none known", replace: "Never migrate while the app is running." }],
    reason: "the deadlock incident showed migrations need the app stopped",
    evidence: [12, "psql: deadlock detected during ALTER TABLE"],
    expectedHash: sha256Hex(before),
  });

  const details = res.details as any;
  assert.equal(details.path, file);
  assert.equal(details.scope, "global");
  assert.equal(details.hashBefore, sha256Hex(before));
  const after = await fs.readFile(file, "utf8");
  assert.equal(details.hashAfter, sha256Hex(after));
  assert.match(after, /Never migrate while the app is running\./);
  assert.doesNotMatch(after, /none known/);
  assert.match(after, /1\. stop the app/, "lines the edit did not name stay untouched");

  // undo copy: timestamped, under the Mnemo home, holding the OLD body
  assert.ok(details.history.startsWith(skillHistoryDir("db-migrations")), details.history);
  assert.equal(await fs.readFile(details.history, "utf8"), before);
  assert.deepEqual(await listHistory("db-migrations"), [details.history]);

  // discovery roundtrip: still a skill, same name
  const found = (await discoverSkills({ cwd: tmp, home: tmp })).find((s) => s.name === "db-migrations");
  assert.ok(found, "the patched skill is still discovered");
  assert.equal(found.path, file);

  // memory: a procedural skill node, the reason + evidence in a commit_log,
  // a `last patch` fact, and a link to the evidence node
  const create = mem.calls.find((c) => c.method === "create_node");
  assert.deepEqual(create?.params, { kind: "aspect", area: "procedural", label: "db-migrations" });
  const facts = mem.calls.filter((c) => c.method === "fact").map((c) => c.params);
  assert.deepEqual(facts[0], { node: 7, key: "skill", value: "db-migrations" });
  assert.deepEqual(facts[1], { node: 7, key: "location", value: file });
  const lastPatch = facts.find((f) => f.key === "last patch");
  assert.ok(lastPatch, "a `last patch` fact records the edit");
  assert.ok(lastPatch.value.startsWith(`${details.timestamp}: `), lastPatch.value);
  assert.match(lastPatch.value, /deadlock incident/);

  const log = mem.calls.find((c) => c.method === "commit_log")!.params;
  assert.equal(log.node, 7);
  assert.equal(log.kind, "skill_patch");
  assert.match(log.detail, /deadlock incident/, "the reason is recorded");
  assert.match(log.detail, /#12/, "the evidence node id is recorded");
  assert.match(log.detail, /ALTER TABLE/, "the failure signature is recorded");

  assert.deepEqual(mem.calls.find((c) => c.method === "link")!.params, { src: 7, dst: 12 });
  assert.match(textOf(res), /Patched skill "db-migrations"/);
  assert.match(textOf(res), /memory: skill node #7/);
});

test("patch replaces a ## section body up to the next heading, leaving other sections alone", async () => {
  const mem = recordingMem();
  const file = await writeSkill("sect", "Sectioned skill", "## Steps\n\nold step\n\n## Notes\n\nkeep me");
  const res = await makePatchSkillTool({ mem }).execute("p2", {
    name: "sect",
    edits: [{ section: "## Steps", body: "1. new step\n2. done" }], // the ## prefix is accepted
    reason: "the steps were wrong",
    evidence: ["wrong-steps"],
  });
  const after = await fs.readFile(file, "utf8");
  assert.match(after, /## Steps\n1\. new step\n2\. done\n\n## Notes\n\nkeep me\n$/);
  assert.doesNotMatch(after, /old step/);
  assert.equal((res.details as any).edits, 1);
});

test("patch applies several edits in order", async () => {
  const mem = recordingMem();
  const file = await writeSkill("multi", "Two edits", "alpha beta\ngamma");
  await makePatchSkillTool({ mem }).execute("p3", {
    name: "multi",
    edits: [
      { find: "alpha", replace: "ALPHA" },
      { find: "gamma", replace: "GAMMA" },
    ],
    reason: "r",
    evidence: [1],
  });
  assert.equal(await fs.readFile(file, "utf8"), "---\nname: multi\ndescription: Two edits\n---\n\nALPHA beta\nGAMMA\n");
});

test("refuses without evidence — the edit must answer something", async () => {
  await writeSkill("ev", "Needs evidence", "do the thing");
  const tool = makePatchSkillTool({ mem: recordingMem() });
  for (const evidence of [[], undefined, ["   "]]) {
    const message = await refusal(tool, {
      name: "ev",
      edits: [{ find: "do the thing", replace: "do it well" }],
      reason: "because",
      evidence,
    });
    assert.match(message, /evidence is required/);
  }
});

test("refuses a blank reason", async () => {
  await writeSkill("why", "Needs a reason", "body");
  const message = await refusal(makePatchSkillTool({ mem: recordingMem() }), {
    name: "why",
    edits: [{ find: "body", replace: "new body" }],
    reason: "   ",
    evidence: [1],
  });
  assert.match(message, /reason is required/);
});

test("refuses a stale expectedHash and touches nothing", async () => {
  const file = await writeSkill("hashy", "Hash check", "body text");
  const before = await fs.readFile(file, "utf8");
  const message = await refusal(makePatchSkillTool({ mem: recordingMem() }), {
    name: "hashy",
    edits: [{ find: "body text", replace: "new body" }],
    reason: "r",
    evidence: [1],
    expectedHash: sha256Hex("what the model read"),
  });
  assert.match(message, /expectedHash does not match/);
  assert.match(message, /load_skill/, "it tells the model to re-read the file");
  assert.match(message, new RegExp(sha256Hex(before)), "and hands it the current hash");
  assert.equal(await fs.readFile(file, "utf8"), before, "the file is untouched");
  assert.deepEqual(await listHistory("hashy"), [], "no undo copy for a refused edit");
});

test("refuses an anchor that appears twice, and one that is missing", async () => {
  await writeSkill("amb", "Ambiguous anchors", "TODO: fix this\nmiddle\nTODO: fix this");
  const tool = makePatchSkillTool({ mem: recordingMem() });
  const twice = await refusal(tool, {
    name: "amb",
    edits: [{ find: "TODO: fix this", replace: "FIXED" }],
    reason: "r",
    evidence: [1],
  });
  assert.match(twice, /appears more than once/);
  const missing = await refusal(tool, {
    name: "amb",
    edits: [{ find: "not in this file at all", replace: "x" }],
    reason: "r",
    evidence: [1],
  });
  assert.match(missing, /does not appear/);
});

test("refuses edits that would break the frontmatter, the description or the name", async () => {
  const file = await writeSkill("front", "Frontmatter skill", "body");
  const before = await fs.readFile(file, "utf8");
  const tool = makePatchSkillTool({ mem: recordingMem() });

  const broken = await refusal(tool, {
    name: "front",
    edits: [{ find: "---\n\nbody", replace: "body" }],
    reason: "r",
    evidence: [1],
  });
  assert.match(broken, /without valid frontmatter/);

  const undescribed = await refusal(tool, {
    name: "front",
    edits: [{ find: "description: Frontmatter skill\n", replace: "" }],
    reason: "r",
    evidence: [1],
  });
  assert.match(undescribed, /description/);

  const renamed = await refusal(tool, {
    name: "front",
    edits: [{ find: "name: front\n", replace: "name: renamed\n" }],
    reason: "r",
    evidence: [1],
  });
  assert.match(renamed, /would rename/);

  assert.equal(await fs.readFile(file, "utf8"), before, "every refusal left the file alone");
});

test("refuses a no-op edit — byte-identical is a mistake, not a success", async () => {
  const file = await writeSkill("noop", "No-op", "same text");
  const message = await refusal(makePatchSkillTool({ mem: recordingMem() }), {
    name: "noop",
    edits: [{ find: "same text", replace: "same text" }],
    reason: "r",
    evidence: [1],
  });
  assert.match(message, /byte-identical/);
  assert.deepEqual(await listHistory("noop"), []);
});

test("refuses an unknown skill and names what is available", async () => {
  await writeSkill("present", "Is here", "body");
  const message = await refusal(makePatchSkillTool({ mem: recordingMem() }), {
    name: "ghost",
    edits: [{ find: "a", replace: "b" }],
    reason: "r",
    evidence: [1],
  });
  assert.match(message, /no skill named "ghost"/);
  assert.match(message, /Available: present/);
});

test("refuses a discovered skill outside the patchable roots", async () => {
  // .pi/skills under the project is a standard discovery location, but NOT a
  // root this tool may write to
  const file = await writeSkill("outsider", "Somewhere else", "body", path.join(".pi", "skills"));
  const before = await fs.readFile(file, "utf8");
  const found = (await discoverSkills({ cwd: tmp, home: tmp })).find((s) => s.name === "outsider");
  assert.ok(found, "discovery does see it — the refusal is the tool's scope rule");

  const message = await refusal(makePatchSkillTool({ mem: recordingMem() }), {
    name: "outsider",
    edits: [{ find: "body", replace: "patched" }],
    reason: "r",
    evidence: [1],
  });
  assert.match(message, /outside the patchable roots/);
  assert.equal(await fs.readFile(file, "utf8"), before, "the out-of-scope file is untouched");
});

test("the path guard never allows .claude/** or a package directory", async () => {
  const roots = patchableRoots();
  assert.equal(roots.length, 2);

  // .claude belongs to another tool, whatever the path shape
  assert.throws(
    () => assertPatchableSkillPath(path.join(tmp, ".claude", "skills", "x", "SKILL.md")),
    /\.claude/,
  );
  // node_modules under an allowed root is still someone else's file
  assert.throws(
    () => assertPatchableSkillPath(path.join(roots[1], "node_modules", "x", "SKILL.md")),
    /package directory/,
  );
  // a skill directory that is an npm package is not a skill
  const pkg = path.join(tmp, ".agents", "skills", "pkg");
  await fs.mkdir(pkg, { recursive: true });
  await fs.writeFile(path.join(pkg, "package.json"), "{}");
  assert.throws(() => assertPatchableSkillPath(path.join(pkg, "SKILL.md")), /package directory/);

  // ...while the two owned roots pass
  assert.doesNotThrow(() => assertPatchableSkillPath(path.join(globalSkillDir(), "ok", "SKILL.md")));
  assert.doesNotThrow(() => assertPatchableSkillPath(path.join(roots[1], "ok", "SKILL.md")));
});

test("patches a project .agents/skills skill (scope: project)", async () => {
  const mem = recordingMem();
  const file = await writeSkill("proj", "Project skill", "old project text", path.join(".agents", "skills"));
  const res = await makePatchSkillTool({ mem }).execute("p4", {
    name: "proj",
    edits: [{ find: "old project text", replace: "new project text" }],
    reason: "r",
    evidence: ["sig"],
  });
  assert.equal((res.details as any).scope, "project");
  assert.match(await fs.readFile(file, "utf8"), /new project text/);
});

test("a dead memory sidecar never fails the patch", async () => {
  for (const mem of [
    { async request() { throw new Error("memsrv crashed"); } },
    { async request() { return { ok: false, error: "memsrv is not running" }; } },
  ]) {
    const file = await writeSkill("offline", "Still patchable", "old guidance");
    const res = await makePatchSkillTool({ mem: mem as any }).execute("p5", {
      name: "offline",
      edits: [{ find: "old guidance", replace: "new guidance" }],
      reason: "r",
      evidence: [1],
    });
    assert.equal((res.details as any).memory.recorded, false);
    assert.match(textOf(res), /memory: patch not recorded/);
    assert.match(await fs.readFile(file, "utf8"), /new guidance/);
    assert.ok((await listHistory("offline")).length > 0, "the undo copy is still kept");
  }
});

test("refuses a section that is missing, or one that appears twice", async () => {
  await writeSkill("secs", "Sections", "## Notes\n\nfirst\n\n## Notes\n\nsecond");
  const tool = makePatchSkillTool({ mem: recordingMem() });
  const twice = await refusal(tool, {
    name: "secs",
    edits: [{ section: "Notes", body: "new" }],
    reason: "r",
    evidence: [1],
  });
  assert.match(twice, /appears 2 times/);
  const missing = await refusal(tool, {
    name: "secs",
    edits: [{ section: "Nope", body: "new" }],
    reason: "r",
    evidence: [1],
  });
  assert.match(missing, /no "## Nope" section/);
});

test("refuses an edit that mixes both forms in one object", async () => {
  await writeSkill("mixed", "Mixed", "## Steps\n\nbody");
  const message = await refusal(makePatchSkillTool({ mem: recordingMem() }), {
    name: "mixed",
    edits: [{ find: "body", replace: "x", section: "Steps", body: "y" }],
    reason: "r",
    evidence: [1],
  });
  assert.match(message, /ambiguous/);
});

test("a second patch reuses the skill's existing node instead of duplicating it", async () => {
  const mem = recordingMem({
    dump: async () => ({ ok: true, result: { nodes: [{ id: 5, kind: "Aspect", area: "Procedural", label: "reuse" }] } }),
    state: async (p: any) => ({ ok: true, result: { state: p.node === 5 ? "facts:\n  - skill: reuse\n" : "" } }),
  });
  await writeSkill("reuse", "Reused node", "old");
  await makePatchSkillTool({ mem }).execute("p7", {
    name: "reuse",
    edits: [{ find: "old", replace: "new" }],
    reason: "r",
    evidence: ["sig"],
  });
  assert.equal(mem.calls.filter((c) => c.method === "create_node").length, 0, "no duplicate node");
  assert.equal(mem.calls.find((c) => c.method === "commit_log")!.params.node, 5);
});

test("a same-named node WITHOUT the skill marker is not treated as the skill's node", async () => {
  const mem = recordingMem({
    dump: async () => ({ ok: true, result: { nodes: [{ id: 5, kind: "Aspect", area: "Semantic", label: "unmarked" }] } }),
    state: async () => ({ ok: true, result: { state: "facts:\n  - something: else\n" } }),
  });
  await writeSkill("unmarked", "Unmarked", "old");
  await makePatchSkillTool({ mem }).execute("p8", {
    name: "unmarked",
    edits: [{ find: "old", replace: "new" }],
    reason: "r",
    evidence: ["sig"],
  });
  assert.equal(mem.calls.filter((c) => c.method === "create_node").length, 1, "a fresh skill node is created");
});

const MEMSRV_BIN = process.env.MNEMO_MEMSRV_BIN
  ?? path.join(fileURLToPath(new URL("../..", import.meta.url)), "memory-layer", "target", "debug",
    process.platform === "win32" ? "memsrv.exe" : "memsrv");

test("a real memsrv: the patch lands on a procedural skill node, linked to its evidence", async () => {
  const { MemClient } = await import("../extensions/memory-layer.ts");
  const client = new MemClient({ journalPath: path.join(tmp, "journal.jsonl"), binaryPath: MEMSRV_BIN });
  try {
    await writeSkill("live-patch", "Live patching", "old guidance");
    const seed = await client.request("create_node", { kind: "aspect", label: "live-evidence" });
    assert.equal(seed.ok, true);
    const evidenceId = Number(seed.result.node);

    const res = await makePatchSkillTool({ mem: client }).execute("p6", {
      name: "live-patch",
      edits: [{ find: "old guidance", replace: "new guidance" }],
      reason: "the live run proved it",
      evidence: [evidenceId, "splice: fixture blew up"],
    });
    const details = res.details as any;
    assert.equal(details.memory.recorded, true);
    assert.ok(Number.isInteger(details.memory.node), "a skill node exists");
    assert.deepEqual(details.memory.linked, [evidenceId], "the evidence node was linked");

    const state = await client.request("state", { node: details.memory.node });
    assert.match(state.result.state, /- skill: live-patch/);
    assert.match(state.result.state, /- last patch: /);
    assert.match(state.result.state, /the live run proved it/);
    assert.match(state.result.state, new RegExp(`#${evidenceId}`));

    const dump = await client.request("dump");
    const skillNode = dump.result.nodes.find((n: any) => n.label === "live-patch");
    assert.ok(skillNode, "the skill shows up in the graph");
    assert.equal(skillNode.area, "Procedural");
    const evNode = dump.result.nodes.find((n: any) => n.id === evidenceId);
    assert.ok(evNode.feeders >= 1, "the evidence node is fed by the skill node");
  } finally {
    client.stop();
  }
});
