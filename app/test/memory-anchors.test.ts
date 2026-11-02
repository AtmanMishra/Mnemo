/**
 * Memories pinned to definitions: a fact about a function carries a tag naming it and a hash of
 * its text; once that code changes or goes, the fact reads as possibly stale instead of as true.
 * The tag in words, then the loop on the real sidecar with a scripted model.
 */
import { test, expect, afterEach, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { anchorKey, anchorsIn, anchorTag, profileBlock, projectIdentity, showValue, splitAnchor } from "@mnemo/memory";
import { defaults, SettingsStore } from "../src/runtime/settings.ts";
import { MEMSRV, mnemoEnv, texts } from "./helpers.ts";

const envs: Awaited<ReturnType<typeof mnemoEnv>>[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
});
setDefaultTimeout(30_000);
const mt = MEMSRV ? test : test.skip;

const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1])], { stopReason: "toolUse" });
const say = (t: string) => fauxAssistantMessage(fauxText(t));
/** Answers, and keeps the system prompt the model was given: pi sends it in sections, and a section that changed later in a new system message. */
const capture = (into: string[], answer: string): FauxResponseStep => (context) => {
  const sections: Record<string, string> = {};
  for (const m of (context as unknown as { messages: { role: string; sections?: Record<string, string> }[] }).messages) if (m.role === "system") Object.assign(sections, m.sections);
  into.push(Object.values(sections).join("\n"));
  return say(answer);
};

// ── the tag ──────────────────────────────────────────────────────────────────

test("a pinned value carries its definition and hash, and reads as what it is about", () => {
  const a = { path: "src/cache.ts", qname: "Cache.get", hash: "3k9xq" };
  const value = `must stay O(1) ${anchorTag(a)}`;
  expect(value).toBe("must stay O(1) [code: src/cache.ts#Cache.get@3k9xq]");
  expect(splitAnchor(value)).toEqual({ text: "must stay O(1)", anchor: a });
  expect(splitAnchor("plain fact")).toEqual({ text: "plain fact" });
  expect(showValue(value)).toBe("must stay O(1) (about Cache.get in src/cache.ts)");
  expect(showValue(value, "fresh")).toBe("must stay O(1) (about Cache.get in src/cache.ts)");
  expect(showValue(value, "changed")).toContain("which has changed since this was written: check it still holds");
  expect(showValue(value, "gone")).toContain("which no longer exists there");
  expect(showValue("plain fact", "changed")).toBe("plain fact");
  // Only a tag at the end counts: one quoted in the middle of a value is text.
  expect(splitAnchor(`see [code: a.ts#f@1] for why`).anchor).toBeUndefined();
  expect(anchorsIn([value, value, "plain"])).toEqual([a]);
});

test("the profile block says which pinned facts may be stale", () => {
  const fresh = { path: "a.ts", qname: "f", hash: "1" };
  const moved = { path: "b.ts", qname: "g", hash: "2" };
  const facts = [
    { key: "f rule", value: `f is pure ${anchorTag(fresh)}` },
    { key: "g rule", value: `g retries twice ${anchorTag(moved)}` },
    { key: "style", value: "tabs" },
  ];
  const block = profileBlock(facts, [], "demo", new Map([[anchorKey(fresh), "fresh"], [anchorKey(moved), "changed"]]));
  expect(block).toContain("- f rule: f is pure (about f in a.ts)\n");
  expect(block).toContain("- g rule: g retries twice (about g in b.ts, which has changed since this was written: check it still holds)");
  expect(block).toContain("- style: tabs");
  expect(block).not.toContain("[code:");
});

// ── on a session ─────────────────────────────────────────────────────────────

const CACHE = "export class Cache {\n  get(k: string) {\n    return this.m.get(k);\n  }\n  put(k: string) {}\n}\n";

function project(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-anchor-")));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src/cache.ts"), CACHE);
  fs.writeFileSync(path.join(dir, "src/other.ts"), "export class Other {\n  put(k: string) {}\n}\n");
  return dir;
}

async function env(o: { settings?: SettingsStore } = {}) {
  const e = await mnemoEnv({ memory: true, reflect: false, mode: "yolo", cwd: project(), settings: o.settings });
  envs.push(e);
  const facts = async () => e.memory!.profile("project", projectIdentity(e.cwd).id);
  return { e, facts };
}

mt("a fact pinned to a method reads as stale once the method changes, as gone once it is removed, and fresh when written again", async () => {
  const { e, facts } = await env();
  const prompts: string[] = [];
  e.faux.setResponses([call("memory_remember", { scope: "project", key: "cache get", value: "must stay O(1): the hot path calls it per request", code: "Cache.get" }), say("noted")]);
  await e.controller.submit("remember that Cache.get must stay O(1)");
  await e.idle();
  const [fact] = await facts();
  expect(fact!.value).toMatch(/^must stay O\(1\): the hot path calls it per request \[code: src\/cache\.ts#Cache\.get@[a-z0-9]+\]$/);
  expect(texts(e.controller).join("\n")).toContain("cache get: must stay O(1): the hot path calls it per request (about Cache.get in src/cache.ts)");

  e.faux.setResponses([capture(prompts, "ok")]);
  await e.controller.submit("hello");
  await e.idle();
  expect(prompts.at(-1)).toContain("- cache get: must stay O(1): the hot path calls it per request (about Cache.get in src/cache.ts)\n");

  // An edit to put leaves get as it was; an edit to get's body makes the fact suspect.
  fs.writeFileSync(path.join(e.cwd, "src/cache.ts"), CACHE.replace("put(k: string) {}", "put(k: string) { return k; }"));
  e.faux.setResponses([capture(prompts, "ok")]);
  await e.controller.submit("and now");
  await e.idle();
  expect(prompts.at(-1)).not.toContain("has changed since");
  fs.writeFileSync(path.join(e.cwd, "src/cache.ts"), CACHE.replace("return this.m.get(k);", "for (const x of this.all) if (x.k === k) return x;"));
  e.faux.setResponses([capture(prompts, "ok")]);
  await e.controller.submit("and now?");
  await e.idle();
  expect(prompts.at(-1)).toContain("(about Cache.get in src/cache.ts, which has changed since this was written: check it still holds)");

  fs.writeFileSync(path.join(e.cwd, "src/cache.ts"), "export class Cache {\n  put(k: string) {}\n}\n");
  e.faux.setResponses([capture(prompts, "ok")]);
  await e.controller.submit("and now??");
  await e.idle();
  expect(prompts.at(-1)).toContain("(about Cache.get in src/cache.ts, which no longer exists there)");

  // Back, rewritten: still not the code the fact was about, until the fact is written again.
  const rewritten = CACHE.replace("return this.m.get(k);", "return this.index.get(k);");
  fs.writeFileSync(path.join(e.cwd, "src/cache.ts"), rewritten);
  e.faux.setResponses([call("memory_remember", { scope: "project", key: "cache get", value: "must stay O(1)", code: "src/cache.ts#Cache.get" }), say("noted")]);
  await e.controller.submit("it is back; note it again");
  await e.idle();
  e.faux.setResponses([capture(prompts, "ok")]);
  await e.controller.submit("and now");
  await e.idle();
  expect(prompts.at(-1)).toContain("- cache get: must stay O(1) (about Cache.get in src/cache.ts)\n");
});

mt("a name the index does not know, or one that means two definitions, is refused with what to do", async () => {
  const { e, facts } = await env();
  e.faux.setResponses([
    call("memory_remember", { scope: "project", key: "a", value: "x", code: "Nowhere.at" }),
    call("memory_remember", { scope: "project", key: "b", value: "y", code: "put" }),
    say("ok"),
  ]);
  await e.controller.submit("remember these");
  await e.idle();
  const out = texts(e.controller).join("\n");
  expect(out).toContain("No definition named Nowhere.at in the code index");
  expect(out).toContain("put names 2 definitions: src/cache.ts#Cache.put, src/other.ts#Other.put. Give one as path#name.");
  expect(await facts()).toEqual([]);
});

mt("with the code index off, a fact cannot be pinned, and an earlier pinned fact reads without a verdict", async () => {
  const { e, facts } = await env({ settings: new SettingsStore({ ...defaults(), codeIndex: false }) });
  const prompts: string[] = [];
  await e.memory!.learn("project", projectIdentity(e.cwd).id, "cache get", `must stay O(1) ${anchorTag({ path: "src/cache.ts", qname: "Cache.get", hash: "old" })}`);
  e.faux.setResponses([call("memory_remember", { scope: "project", key: "a", value: "x", code: "Cache.get" }), capture(prompts, "ok")]);
  await e.controller.submit("remember it");
  await e.idle();
  expect(texts(e.controller).join("\n")).toContain("The code index is off (/settings codeIndex), so a fact cannot be pinned to code");
  expect((await facts()).map((f) => f.key)).toEqual(["cache get"]);
  expect(prompts.at(-1)).toContain("- cache get: must stay O(1) (about Cache.get in src/cache.ts)\n");
});
