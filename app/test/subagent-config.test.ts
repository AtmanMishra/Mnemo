/**
 * A sub-agent's model, thinking, output, context, turns and budget: the user's settings are the
 * ceiling, the parent may only tighten them, and every choice reaches the model call pi makes.
 * `resolveSpawn` is tested alone; the rest runs real pi sessions on the scripted model.
 */
import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall, type Model } from "@earendil-works/pi-ai";
import { resolveSpawn, type SpawnAsk } from "../src/extensions/agents.ts";
import { defaults, parseValue, SettingsStore, showValue, type Settings } from "../src/runtime/settings.ts";
import { LIMITS, Roster, usage } from "../src/runtime/roster.ts";
import { mnemoEnv } from "./helpers.ts";

// ── resolveSpawn, alone ─────────────────────────────────────────────────────

const model = (id: string, o: Partial<Model<any>> = {}): Model<any> =>
  ({ id, name: id, provider: "p", api: "x", baseUrl: "", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 16_000, ...o }) as Model<any>;
const PARENT = model("big");
const CATALOG = [PARENT, model("small", { contextWindow: 100_000, maxTokens: 8000 }), model("nokey"), model("tiny", { contextWindow: 16_000 })];

function plan(ask: SpawnAsk = {}, s: Partial<Settings> = {}, o: { subMaxTurns?: number; subSpend?: number; managed?: string[]; parentThinking?: string } = {}) {
  return resolveSpawn({
    ask,
    settings: { ...defaults(), ...s },
    limits: { subMaxTurns: o.subMaxTurns ?? LIMITS.subMaxTurns, subSpend: o.subSpend ?? LIMITS.subSpend },
    parent: PARENT,
    parentThinking: o.parentThinking ?? "medium",
    find: (provider, id) => CATALOG.find((m) => m.provider === provider && m.id === id),
    hasAuth: () => true,
    managed: o.managed,
  });
}
const ok = (r: ReturnType<typeof plan>) => {
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r.plan;
};
const refused = (r: ReturnType<typeof plan>) => (r.ok ? "" : r.reason);

test("with nothing asked and nothing set, a sub-agent gets the parent's model, thinking and the model's own limits", () => {
  const p = ok(plan());
  expect(p.model).toMatchObject({ provider: "p", id: "big", maxTokens: 16_000, contextWindow: 200_000 });
  expect(p.thinking).toBe("medium");
  expect(p.caps).toEqual({ turns: LIMITS.subMaxTurns, spend: 0, maxTokens: 16_000, context: 200_000 });
  expect(p.notes).toEqual([]);
  expect(p.model).not.toBe(PARENT); // a copy: the parent's model object is never changed
  expect(PARENT.maxTokens).toBe(16_000);
});

test("the user's subModel is the default, and the parent may pick another model it names", () => {
  expect(ok(plan({}, { subModel: "p/small" })).model.id).toBe("small");
  expect(ok(plan({ model: "p/small" })).model.id).toBe("small");
  expect(ok(plan({ model: "p/big" }, { subModel: "p/small" })).model.id).toBe("big");
  // A blank pick is no pick.
  expect(ok(plan({ model: "  " }, { subModel: "p/small" })).model.id).toBe("small");
});

test("an unknown model, a malformed one, or one without credentials is refused readably", () => {
  expect(refused(plan({ model: "p/nope" }))).toContain("no model p/nope");
  expect(refused(plan({ model: "nope" }))).toContain("give provider/id");
  expect(refused(plan({}, { subModel: "p/gone" }))).toContain("subModel setting");
  const r = resolveSpawn({ ask: { model: "p/nokey" }, settings: defaults(), limits: LIMITS, parent: PARENT, parentThinking: "off", find: (_p, id) => CATALOG.find((m) => m.id === id), hasAuth: () => false });
  expect(r).toEqual({ ok: false, reason: "p/nokey has no credentials" });
});

test("subModels narrows what the parent may pick, but not the user's own subModel", () => {
  const s = { subModels: "p/small, q/*" };
  expect(ok(plan({ model: "p/small" }, s)).model.id).toBe("small");
  expect(refused(plan({ model: "p/nokey" }, s))).toContain("not among the models your user lets you pick");
  expect(ok(plan({}, { ...s, subModel: "p/nokey" })).model.id).toBe("nokey");
});

test("the managed allowlist refuses a model on every path, the parent's own included", () => {
  expect(refused(plan({ model: "p/small" }, {}, { managed: ["p/big"] }))).toContain("managed policy");
  expect(refused(plan({}, { subModel: "p/small" }, { managed: ["p/big"] }))).toContain("managed policy");
  expect(refused(plan({}, {}, { managed: ["other/*"] }))).toContain("p/big is not allowed by the managed policy");
  expect(ok(plan({ model: "p/small" }, {}, { managed: ["p/*"] })).model.id).toBe("small");
});

test("turns and budget: the parent lowers freely, is capped at the user's number, and is free where the user set none", () => {
  expect(ok(plan({ maxTurns: 5 })).caps.turns).toBe(5);
  const over = ok(plan({ maxTurns: 500 }));
  expect(over.caps.turns).toBe(LIMITS.subMaxTurns);
  expect(over.notes.join()).toContain(`maxTurns capped at your user's subMaxTurns of ${LIMITS.subMaxTurns}`);
  expect(ok(plan({ maxTurns: 500 }, {}, { subMaxTurns: 0 })).caps.turns).toBe(500);
  expect(ok(plan({ maxTurns: 2.7 })).caps.turns).toBe(2);

  expect(ok(plan({ budget: 0.25 }, {}, { subSpend: 1 })).caps.spend).toBe(0.25);
  const rich = ok(plan({ budget: 5 }, {}, { subSpend: 1 }));
  expect(rich.caps.spend).toBe(1);
  expect(rich.notes.join()).toContain("budget capped at your user's subSpend of $1.00");
  expect(ok(plan({ budget: 5 })).caps.spend).toBe(5); // subSpend 0: no limit to keep under
});

test("a zero, negative or missing number asks for nothing: it can never lift a limit", () => {
  for (const n of [0, -1, Number.NaN]) {
    const p = ok(plan({ maxTurns: n, budget: n, maxTokens: n, contextTokens: n }, { subMaxTokens: 4000, subContext: 64_000 }, { subSpend: 2 }));
    expect(p.caps).toEqual({ turns: LIMITS.subMaxTurns, spend: 2, maxTokens: 4000, context: 64_000 });
  }
});

test("output tokens and context stop at the setting and at what the model has, and are written into the model pi gets", () => {
  const p = ok(plan({ maxTokens: 4000, contextTokens: 50_000 }));
  expect(p.model).toMatchObject({ maxTokens: 4000, contextWindow: 50_000 });
  expect(p.caps).toMatchObject({ maxTokens: 4000, context: 50_000 });
  // More than the model has is the model's own.
  expect(ok(plan({ maxTokens: 999_999, contextTokens: 9_999_999 })).model).toMatchObject({ maxTokens: 16_000, contextWindow: 200_000 });
  // The user's numbers are the ceiling...
  const capped = ok(plan({ maxTokens: 9000, contextTokens: 90_000 }, { subMaxTokens: 2000, subContext: 40_000 }));
  expect(capped.model).toMatchObject({ maxTokens: 2000, contextWindow: 40_000 });
  expect(capped.notes.join(" | ")).toContain("maxTokens capped at your user's subMaxTokens of 2000");
  expect(capped.notes.join(" | ")).toContain("contextTokens capped at your user's subContext of 40000");
  // ...and the default when the parent asks nothing.
  expect(ok(plan({}, { subMaxTokens: 2000, subContext: 40_000 })).model).toMatchObject({ maxTokens: 2000, contextWindow: 40_000 });
  // A smaller model's own limits win over a bigger setting.
  expect(ok(plan({ model: "p/small" }, { subMaxTokens: 50_000 })).model).toMatchObject({ maxTokens: 8000, contextWindow: 100_000 });
});

test("context below the minimum is raised to it, unless the model itself has less", () => {
  const p = ok(plan({ contextTokens: 5000 }));
  expect(p.caps.context).toBe(32_000);
  expect(p.notes.join()).toContain("raised to the minimum of 32000");
  expect(ok(plan({ model: "p/tiny" })).caps.context).toBe(16_000);
});

test("thinking: inherit makes the parent's level the ceiling; a set level is the default and the ceiling", () => {
  expect(ok(plan({ thinking: "low" })).thinking).toBe("low");
  const up = ok(plan({ thinking: "high" }));
  expect(up.thinking).toBe("medium");
  expect(up.notes.join()).toContain("thinking capped at medium (your own level)");
  expect(ok(plan({}, { subThinking: "low" })).thinking).toBe("low");
  const set = ok(plan({ thinking: "xhigh" }, { subThinking: "low" }));
  expect(set.thinking).toBe("low");
  expect(set.notes.join()).toContain("/settings subThinking");
  expect(ok(plan({ thinking: "off" }, { subThinking: "low" })).thinking).toBe("off");
  expect(refused(plan({ thinking: "galaxy-brain" }))).toContain("thinking is one of off, minimal");
});

// ── settings ────────────────────────────────────────────────────────────────

test("the new sub-agent settings parse, refuse what does not fit, and show their defaults plainly", () => {
  expect(parseValue("subModel", "anthropic/claude-haiku-5-5")).toEqual({ ok: true, value: "anthropic/claude-haiku-5-5" });
  expect(parseValue("subModel", "haiku")).toMatchObject({ ok: false });
  expect(parseValue("subModels", "anthropic/*, openai/gpt-*")).toMatchObject({ ok: true });
  expect(parseValue("subModels", "anthropic/*, oops")).toMatchObject({ ok: false });
  expect(parseValue("subModels", "a/b,".repeat(120))).toMatchObject({ ok: false });
  expect(parseValue("subThinking", "HIGH")).toEqual({ ok: true, value: "high" });
  expect(parseValue("subThinking", "max")).toMatchObject({ ok: false });
  expect(parseValue("subMaxTokens", "4096")).toEqual({ ok: true, value: 4096 });
  expect(parseValue("subMaxTokens", "-1")).toMatchObject({ ok: false });
  expect(parseValue("subContext", "0")).toEqual({ ok: true, value: 0 });
  expect(parseValue("subContext", "32000")).toEqual({ ok: true, value: 32000 });
  expect(parseValue("subContext", "8000")).toMatchObject({ ok: false, error: expect.stringContaining("at least 32000") });
  const d = defaults();
  expect([d.subModel, d.subModels, d.subThinking, d.subMaxTokens, d.subContext]).toEqual(["", "", "inherit", 0, 0]);
  expect(showValue("subModel", "")).toBe("the parent's model");
  expect(showValue("subModels", "")).toBe("any with credentials");
  expect(showValue("subMaxTokens", 0)).toBe("the model's own");
  expect(showValue("subContext", 64000)).toBe("64000 tokens");
});

test("usage reads as model, turns against the cap, and dollars", () => {
  expect(usage({ model: "p/small", turns: 3, spent: 0.031, caps: { turns: 60, spend: 0, maxTokens: 1, context: 1 } })).toBe("small · 3/60 turns · $0.03");
  expect(usage({ model: "p/small", turns: 1, spent: 0, caps: { turns: 0, spend: 0.5, maxTokens: 1, context: 1 } })).toBe("small · 1 turn · $0.00/$0.50");
  expect(usage({ model: undefined, turns: 0, spent: 0 })).toBe("");
});

// ── on real pi sessions ─────────────────────────────────────────────────────

const envs: Awaited<ReturnType<typeof mnemoEnv>>[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
});
async function env(o: Parameters<typeof mnemoEnv>[0] = {}) {
  const e = await mnemoEnv(o);
  envs.push(e);
  return e;
}
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1])], { stopReason: "toolUse" });
const say = (t: string) => fauxAssistantMessage(fauxText(t));
const looking = (n: number) => Array.from({ length: n }, () => call("read", { path: "package.json" }));
const toolOutput = (e: Awaited<ReturnType<typeof env>>, name: string) =>
  e.controller.transcript.snapshot().committed.filter((b) => b.kind === "tool" && b.name === name) as unknown as { status: string; output: string }[];
const sub = (roster: Roster, label: string) => roster.snapshot().nodes.find((n) => n.label === label)!;

test("a sub-agent runs on the model, output and context it was given, and the parent and roster see it", async () => {
  const roster = new Roster();
  const e = await env({ mode: "yolo", roster, strong: true });
  const seen: { id: string; maxTokens: number; contextWindow: number }[] = [];
  e.faux.setResponses([
    call("spawn_subagent", { task: "summarise", name: "cheap", model: "mnemo-demo/demo-strong", maxTokens: 4000, contextTokens: 50_000, thinking: "low" }),
    (_c, _o, _s, m) => {
      seen.push({ id: m.id, maxTokens: m.maxTokens, contextWindow: m.contextWindow });
      return say("summary");
    },
    (_c, _o, _s, m) => {
      seen.push({ id: m.id, maxTokens: m.maxTokens, contextWindow: m.contextWindow });
      return say("done");
    },
  ]);
  await e.controller.submit("delegate");
  await e.idle();
  // The child's call went to the chosen model with the lowered limits; the parent's did not change.
  expect(seen[0]).toEqual({ id: "demo-strong", maxTokens: 4000, contextWindow: 50_000 });
  expect(seen[1]).toMatchObject({ id: "demo-model", contextWindow: 200_000 });
  expect(sub(roster, "cheap")).toMatchObject({ model: "mnemo-demo/demo-strong", thinking: "low", turns: 1, caps: { maxTokens: 4000, context: 50_000 }, status: "done" });
  const out = toolOutput(e, "spawn_subagent")[0]!;
  expect(out.output).toContain("summary");
  expect(out.output).toContain("[ran on mnemo-demo/demo-strong, thinking low]");
});

test("an unknown model is refused before any sub-agent starts, as a tool error the parent can read", async () => {
  const roster = new Roster();
  const e = await env({ mode: "yolo", roster });
  e.faux.setResponses([call("spawn_subagent", { task: "x", name: "ghost", model: "mnemo-demo/no-such-model" }), say("could not")]);
  await e.controller.submit("delegate");
  await e.idle();
  const out = toolOutput(e, "spawn_subagent")[0]!;
  expect(out.status).toBe("error");
  expect(out.output).toContain("no model mnemo-demo/no-such-model");
  expect(roster.snapshot().nodes.filter((n) => n.kind === "sub")).toHaveLength(0);
});

test("a model outside subModels or the managed allowlist is refused; the default follows /settings at once", async () => {
  const settings = new SettingsStore();
  settings.set("subModels", "mnemo-demo/demo-model");
  const roster = new Roster();
  const e = await env({ mode: "yolo", roster, settings, strong: true });
  e.faux.setResponses([call("spawn_subagent", { task: "x", name: "a", model: "mnemo-demo/demo-strong" }), say("refused")]);
  await e.controller.submit("delegate");
  await e.idle();
  expect(toolOutput(e, "spawn_subagent")[0]!.output).toContain("not among the models your user lets you pick");

  // The user changes the default while the conversation is open: the next spawn uses it.
  settings.set("subModel", "mnemo-demo/demo-strong");
  let used = "";
  e.faux.setResponses([
    call("spawn_subagent", { task: "x", name: "b" }),
    (_c, _o, _s, m) => {
      used = m.id;
      return say("ok");
    },
    say("done"),
  ]);
  await e.controller.submit("again");
  await e.idle();
  expect(used).toBe("demo-strong");

  const managed = path.join(e.home, "managed.json");
  fs.writeFileSync(managed, JSON.stringify({ models: ["mnemo-demo/demo-model"] }));
  e.host.managedFile = managed;
  e.faux.setResponses([call("spawn_subagent", { task: "x", name: "c" }), say("refused")]);
  await e.controller.submit("once more");
  await e.idle();
  expect(toolOutput(e, "spawn_subagent").at(-1)!.output).toContain("not allowed by the managed policy");
  expect(sub(roster, "c")).toBeUndefined();
});

test("a parent cannot raise a sub-agent's turns past the user's setting, and can lower them", async () => {
  const settings = new SettingsStore();
  settings.set("subMaxTurns", 2);
  const roster = new Roster();
  const e = await env({ mode: "yolo", roster, settings });
  e.faux.setResponses([call("spawn_subagent", { task: "read", name: "greedy", maxTurns: 50 }), ...looking(6), say("cut off")]);
  await e.controller.submit("delegate");
  await e.idle();
  const greedy = sub(roster, "greedy");
  expect(greedy.caps!.turns).toBe(2);
  expect(greedy.stepCount).toBe(2);
  expect(greedy.answer).toContain("stopped at its limit of 2 turns (/settings subMaxTurns)");
  expect(toolOutput(e, "spawn_subagent")[0]!.output).toContain("maxTurns capped at your user's subMaxTurns of 2");

  settings.set("subMaxTurns", 60);
  e.faux.setResponses([call("spawn_subagent", { task: "read", name: "frugal", maxTurns: 1 }), ...looking(4), say("cut off")]);
  await e.controller.submit("again");
  await e.idle();
  const frugal = sub(roster, "frugal");
  expect(frugal.stepCount).toBe(1);
  expect(frugal.answer).toContain("stopped at its limit of 1 turns (set by its parent)");
});

test("a parent's lower budget stops the sub-agent, and says the parent set it", async () => {
  const roster = new Roster();
  const e = await env({ mode: "yolo", roster });
  const priced = () => {
    roster.spend(sub(roster, "spender").id, 0.2);
    return call("read", { path: "package.json" });
  };
  e.faux.setResponses([call("spawn_subagent", { task: "read", name: "spender", budget: 0.1 }), priced, call("read", { path: "package.json" }), say("cut off")]);
  await e.controller.submit("delegate");
  await e.idle();
  expect(sub(roster, "spender").answer).toContain("stopped at its limit of $0.10 (set by its parent)");
});

test("list_agents shows each sub-agent's model, turns and spend", async () => {
  const roster = new Roster();
  const e = await env({ mode: "yolo", roster });
  e.faux.setResponses([call("spawn_subagent", { task: "look", name: "looker" }), call("ls", { path: "." }), say("seen"), call("list_agents", {}), say("done")]);
  await e.controller.submit("delegate");
  await e.idle();
  expect(sub(roster, "looker").turns).toBe(2);
  expect(toolOutput(e, "list_agents")[0]!.output).toMatch(/#\d+ "looker" \(sub-agent, depth 1, done · demo-model · 2\/60 turns · \$0\.00\)/);
});
