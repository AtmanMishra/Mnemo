/**
 * Skills that improve in use and retire when unused: a skill followed in a
 * run that showed it wrong is patched (with the reason, the old text kept);
 * one that worked is left alone; unused personal skills are archived, project
 * skills only reported.
 */
import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { curateSkills, findMemsrv, MemoryService, MemorySession, renderSkill, writeSkill, type SkillOffer } from "../src/index.ts";

const MEMSRV = findMemsrv("/nonexistent");
const t = MEMSRV ? test : test.skip;

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-skills-"));
  const cwd = path.join(root, "repo");
  const userSkillsDir = path.join(root, "home", "agent", "skills");
  fs.mkdirSync(cwd);
  return { root, cwd, userSkillsDir, memory: new MemoryService(MEMSRV!, path.join(root, "journal.jsonl")) };
}

t("a skill that proved wrong in a run is patched with its reason, the old version kept; one that worked is not", async () => {
  const { cwd, userSkillsDir, memory } = setup();
  const file = path.join(cwd, ".agents", "skills", "release", "SKILL.md");
  writeSkill(file, renderSkill("release", "Cut a release", "1. npm version patch\n2. npm publish"));
  const offers: SkillOffer[] = [];
  const asked: string[] = [];
  const answers = [
    JSON.stringify({ facts: [], fixes: [], skill: { name: "release", description: "Cut a release", instructions: "1. npm run build\n2. npm version patch\n3. npm publish", patch: true, reason: "publish failed without a build" } }),
  ];
  const s = new MemorySession({
    memory,
    cwd,
    userSkillsDir,
    reflect: async (_sys, user) => (asked.push(user), answers.shift() ?? JSON.stringify({ facts: [], fixes: [], skill: null })),
    approveSkill: async (o) => (offers.push(o), true),
  });
  await s.begin("cut a release of the package please");
  s.toolStart("read", { path: file });
  await s.toolEnd("read", { path: file }, true);
  await s.toolEnd("bash", { command: "npm publish" }, false, "error: dist/ missing");
  await s.toolEnd("bash", { command: "npm run build" }, true);
  await s.toolEnd("bash", { command: "npm publish" }, true);
  await s.end({ messages: [{ role: "user", content: "cut a release of the package please" }] });

  expect(asked[0]).toContain("SKILLS FOLLOWED (as they stood):\n--- release");
  expect(offers[0]).toMatchObject({ name: "release", patch: true, reason: "skill release needs a fix: publish failed without a build" });
  expect(fs.readFileSync(file, "utf8")).toContain("1. npm run build");
  const history = path.join(path.dirname(userSkillsDir), "skill-history", "release");
  expect(fs.readFileSync(path.join(history, fs.readdirSync(history)[0]!), "utf8")).toContain("1. npm version patch\n2. npm publish");
  memory.stop();
}, 30_000);

t("a patch is only for a skill the run read", async () => {
  const { cwd, userSkillsDir, memory } = setup();
  const file = path.join(cwd, ".agents", "skills", "deploy", "SKILL.md");
  writeSkill(file, renderSkill("deploy", "Deploy", "1. make deploy"));
  const offers: SkillOffer[] = [];
  const s = new MemorySession({
    memory,
    cwd,
    userSkillsDir,
    reflect: async () => JSON.stringify({ facts: [], fixes: [], skill: { name: "deploy", description: "Deploy", instructions: "rm -rf /", patch: true, reason: "x" } }),
    approveSkill: async (o) => (offers.push(o), true),
  });
  await s.begin("deploy the service to staging now please");
  await s.toolEnd("bash", { command: "make deploy" }, true);
  await s.toolEnd("bash", { command: "make smoke" }, true);
  await s.end({ messages: [{ role: "user", content: "deploy the service to staging now please" }] });
  expect(offers).toEqual([]);
  expect(fs.readFileSync(file, "utf8")).toContain("1. make deploy");
  memory.stop();
}, 30_000);

t("unused personal skills are archived, project skills only reported, used ones stay active", async () => {
  const { cwd, userSkillsDir, memory } = setup();
  const day = 86_400_000;
  const now = Date.parse("2026-10-08T00:00:00Z");
  const old = (f: string, days: number) => fs.utimesSync(f, new Date(now - days * day), new Date(now - days * day));
  const mk = (dir: string, name: string, days: number) => {
    const f = path.join(dir, name, "SKILL.md");
    writeSkill(f, renderSkill(name, name, "steps"));
    old(f, days);
    return f;
  };
  mk(userSkillsDir, "fresh", 3);
  mk(userSkillsDir, "dusty", 40);
  mk(userSkillsDir, "ancient", 200);
  mk(path.join(cwd, ".agents", "skills"), "team-old", 200);
  const used = mk(userSkillsDir, "used-lately", 200);
  const node = await memory.createNode("harness", "skill used-lately", "procedural");
  await memory.fact(node!, "last used", "2026-10-01");
  void used;

  const report = await curateSkills({ memory, projectRoot: cwd, userSkillsDir, now, apply: true });
  const by = Object.fromEntries(report.map((r) => [r.name, r]));
  expect(by.fresh!.state).toBe("active");
  expect(by["used-lately"]!.state).toBe("active");
  expect(by.dusty!.state).toBe("stale");
  expect(by.ancient!.state).toBe("archive");
  expect(by.ancient!.archivedTo).toBe(path.join(path.dirname(userSkillsDir), "skills-archive", "ancient"));
  expect(fs.existsSync(path.join(userSkillsDir, "ancient"))).toBe(false);
  expect(by["team-old"]).toMatchObject({ scope: "project", state: "archive" });
  expect(by["team-old"]!.archivedTo).toBeUndefined();
  expect(fs.existsSync(path.join(cwd, ".agents", "skills", "team-old", "SKILL.md"))).toBe(true);
  memory.stop();
}, 30_000);
