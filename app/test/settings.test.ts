/**
 * The settings: every default is what Mnemo did before there was a menu, a value that
 * does not fit is refused (never quietly bent), a file that is damaged or hand-edited
 * falls back to the defaults, and a change reaches the part of Mnemo it names.
 */
import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LIMITS, Roster } from "../src/runtime/roster.ts";
import {
  caret,
  chordMatches,
  DEFS,
  defaults,
  KEY_DEFAULTS,
  limitsOf,
  loadSettings,
  normalizeChord,
  openSettings,
  parseValue,
  sanitize,
  SETTING_KEYS,
  SettingsStore,
} from "../src/runtime/settings.ts";
import { settingsCommand, settingsMenu, settingsText } from "../src/runtime/settings-menu.ts";
import { Dialogs } from "../src/runtime/dialogs.ts";
import { judge } from "../src/extensions/policy.ts";
import { THEMES, setTheme, themeName } from "../src/ui/theme.ts";
import { mnemoEnv, nextDialog } from "./helpers.ts";

const homes: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-settings-"));
  homes.push(d);
  return d;
};
const envs: Awaited<ReturnType<typeof mnemoEnv>>[] = [];
afterEach(async () => {
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
  for (const e of envs.splice(0)) await e.close();
  setTheme("night");
});

test("every default is what Mnemo did before the menu", () => {
  const d = defaults();
  expect(limitsOf(d)).toEqual({ maxDepth: LIMITS.maxDepth, maxChildren: LIMITS.maxChildren, maxLive: LIMITS.maxLive, hops: LIMITS.hops, wakeSpend: LIMITS.wakeSpend, messageChars: LIMITS.messageChars, sendsPerWindow: LIMITS.sendsPerWindow, inbox: LIMITS.inbox });
  expect(d).toMatchObject({ theme: "night", wheelRows: 3, sidebarWidth: 34, toastSeconds: 4.5, toastMax: 3, kernelTimeout: 120, kernelMaxTimeout: 600, escalateAfter: 2, replyWait: 120, notifyAfter: 20, mode: "default", splitLayout: "auto" });
  expect(d).toMatchObject({ motion: true, bootAnimation: true, mouse: true, sidebar: true, reflect: true, verify: true, notify: true, autoUpdate: false, expandOutput: false, escalateModel: "" });
  expect(d["keys.palette"]).toBe("ctrl+k");
  expect(d["keys.prevAgent"]).toBe("alt+,");
  // Every setting says what it is, and its default passes its own check.
  for (const k of SETTING_KEYS) {
    expect(DEFS[k].help.length).toBeGreaterThan(5);
    expect(parseValue(k, d[k])).toEqual({ ok: true, value: d[k] });
  }
});

test("values are checked, not bent: wrong type, out of range, unknown choice", () => {
  const bad = (k: Parameters<typeof parseValue>[0], v: unknown) => expect(parseValue(k, v).ok).toBe(false);
  bad("hops", "0");
  bad("hops", 101);
  bad("hops", "2.5");
  bad("hops", "lots");
  bad("wakeSpend", -1);
  bad("wakeSpend", "free");
  bad("reflect", "maybe");
  bad("theme", "neon");
  bad("splitLayout", "diagonal");
  bad("mode", "yolo");
  bad("mode", "accept-edits");
  bad("escalateModel", "just-a-name");
  bad("escalateModel", "x".repeat(200));
  expect(parseValue("hops", "5")).toEqual({ ok: true, value: 5 });
  expect(parseValue("wakeSpend", "0")).toEqual({ ok: true, value: 0 });
  expect(parseValue("wakeSpend", "1.25")).toEqual({ ok: true, value: 1.25 });
  expect(parseValue("reflect", "Off")).toEqual({ ok: true, value: false });
  expect(parseValue("theme", "Dracula")).toEqual({ ok: true, value: "dracula" });
  expect(parseValue("escalateModel", " anthropic/claude-x ")).toEqual({ ok: true, value: "anthropic/claude-x" });
  expect(parseValue("escalateModel", "")).toEqual({ ok: true, value: "" });
  // Every theme the interface has is a choice, and nothing else is.
  expect([...DEFS.theme.options!].sort()).toEqual(Object.keys(THEMES).sort());
});

test("a bypass mode can never be a stored default", () => {
  expect(DEFS.mode.options).toEqual(["default", "plan"]);
  expect(sanitize({ mode: "yolo" }).mode).toBe("default");
  expect(sanitize({ mode: "accept-edits" }).mode).toBe("default");
});

test("chords: ctrl or alt plus one key; line editing and signals stay the prompt's", () => {
  expect(normalizeChord("Ctrl+O")).toBe("ctrl+o");
  expect(normalizeChord(" alt + , ")).toBe("alt+,");
  for (const bad of ["ctrl+c", "ctrl+d", "ctrl+a", "ctrl+e", "ctrl+u", "ctrl+w", "ctrl+h", "ctrl+j", "ctrl+m", "ctrl+i", "alt+b", "alt+f", "ctrl+1", "alt+1", "ctrl+,", "shift+x", "ctrl+", "o", "ctrl+oo", ""])
    expect(normalizeChord(bad)).toBeUndefined();
  // ctrl+k kills to the end of the line; only the palette may share it.
  expect(normalizeChord("ctrl+k")).toBeUndefined();
  expect(parseValue("keys.palette", "ctrl+k")).toEqual({ ok: true, value: "ctrl+k" });
  expect(parseValue("keys.expand", "ctrl+k").ok).toBe(false);
  expect(caret("ctrl+g")).toBe("^g");
  expect(caret("alt+l")).toBe("alt+l");
  expect(chordMatches("ctrl+o", "o", { ctrl: true })).toBe(true);
  expect(chordMatches("ctrl+o", "o", { meta: true })).toBe(false);
  expect(chordMatches("alt+,", ",", { meta: true })).toBe(true);
  expect(chordMatches("alt+,", ",", {})).toBe(false);
  expect(chordMatches("ctrl+o", "p", { ctrl: true })).toBe(false);
});

test("two actions on one chord are refused, and a file with such a clash gets every default key back", () => {
  const s = new SettingsStore();
  const clash = s.set("keys.expand", "ctrl+g");
  expect(clash).toEqual({ ok: false, error: expect.stringContaining("Hub") });
  expect(s.get()["keys.expand"]).toBe("ctrl+o");
  // Free the chord first, then take it.
  expect(s.set("keys.hub", "ctrl+j").ok).toBe(false); // reserved
  expect(s.set("keys.hub", "ctrl+q").ok).toBe(true);
  expect(s.set("keys.expand", "ctrl+g").ok).toBe(true);
  // A hand-edited file that binds two actions to one chord.
  const loaded = sanitize({ "keys.expand": "ctrl+g", "keys.hub": "ctrl+g", wheelRows: 7 });
  for (const k of Object.keys(KEY_DEFAULTS) as (keyof typeof KEY_DEFAULTS)[]) expect(loaded[k]).toBe(KEY_DEFAULTS[k]);
  expect(loaded.wheelRows).toBe(7);
});

test("a Python cell may not be given more time than the ceiling allows", () => {
  const s = new SettingsStore();
  expect(s.set("kernelTimeout", 700).ok).toBe(false);
  expect(s.set("kernelMaxTimeout", 60).ok).toBe(false);
  expect(s.set("kernelMaxTimeout", 900).ok).toBe(true);
  expect(s.set("kernelTimeout", 700).ok).toBe(true);
  expect(sanitize({ kernelTimeout: 500, kernelMaxTimeout: 100 }).kernelMaxTimeout).toBe(500);
});

test("a file with junk in it changes nothing it cannot read", () => {
  const home = tmp();
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ hops: 7, wakeSpend: "lots", theme: 3, nonsense: true, wheelRows: 9999, reflect: false }));
  const s = loadSettings(home);
  expect(s.hops).toBe(7);
  expect(s.reflect).toBe(false);
  expect(s.wakeSpend).toBe(0.5);
  expect(s.wheelRows).toBe(3);
  expect(s).not.toHaveProperty("nonsense");
  for (const junk of ["{ not json", "[1,2]", "null", "42", ""]) {
    fs.writeFileSync(path.join(home, "config.json"), junk);
    expect(loadSettings(home)).toEqual(defaults());
  }
  expect(loadSettings(path.join(home, "nowhere"))).toEqual(defaults());
});

test("only choices that differ from the default are written, and an unchanged state.json is left alone", () => {
  const home = tmp();
  const store = openSettings(home);
  expect(fs.existsSync(path.join(home, "config.json"))).toBe(false);
  expect(store.set("hops", 20).ok).toBe(true);
  expect(store.set("reflect", "off").ok).toBe(true);
  expect(JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"))).toEqual({ hops: 20, reflect: false });
  expect(fs.existsSync(path.join(home, "state.json"))).toBe(false);
  if (process.platform !== "win32") expect(fs.statSync(path.join(home, "config.json")).mode & 0o777).toBe(0o600);
  expect(fs.readdirSync(home).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  // Back to the default: the line goes, and with the last one the file.
  store.set("hops", 12);
  expect(JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"))).toEqual({ reflect: false });
  store.reset("reflect");
  expect(fs.existsSync(path.join(home, "config.json"))).toBe(false);
});

test("the theme and the update check stay in state.json, beside what else lives there", () => {
  const home = tmp();
  fs.writeFileSync(path.join(home, "state.json"), JSON.stringify({ onboarded: true, recent: ["/a"], theme: "nord", autoUpdate: true }));
  const store = openSettings(home);
  // What `/theme` and `mnemo update --auto on` already wrote is what the menu shows.
  expect(store.get()).toMatchObject({ theme: "nord", autoUpdate: true });
  store.set("theme", "tokyo");
  store.set("autoUpdate", "off");
  const state = JSON.parse(fs.readFileSync(path.join(home, "state.json"), "utf8"));
  expect(state).toEqual({ onboarded: true, recent: ["/a"], theme: "tokyo", autoUpdate: false });
  expect(fs.existsSync(path.join(home, "config.json"))).toBe(false);
  expect(loadSettings(home)).toMatchObject({ theme: "tokyo", autoUpdate: false });
});

test("a store that cannot save keeps the old value and says why", () => {
  const home = tmp();
  fs.writeFileSync(path.join(home, "config.json"), "{}");
  // A directory where the file belongs: the move over it fails.
  fs.rmSync(path.join(home, "config.json"));
  fs.mkdirSync(path.join(home, "config.json"));
  fs.writeFileSync(path.join(home, "config.json", "keep"), "x");
  const store = openSettings(home);
  const r = store.set("hops", 3);
  expect(r.ok).toBe(false);
  expect(store.get().hops).toBe(12);
});

test("subscribers hear which setting moved", () => {
  const s = new SettingsStore();
  const heard: unknown[] = [];
  const off = s.subscribe((k) => heard.push(k));
  s.set("hops", 3);
  s.set("hops", 0); // refused: not heard
  s.reset("hops");
  s.reset();
  off();
  s.set("hops", 4);
  expect(heard).toEqual(["hops", "hops", undefined]);
});

test("the roster enforces the caps it was given, and a lowered cap stops new work only", () => {
  const r = new Roster(() => 0);
  const a = r.addRoot("a");
  r.setLimits({ maxChildren: 1 });
  r.addSub(a.id, { label: "one", task: "t", access: "read-only" });
  expect(() => r.addSub(a.id, { label: "two", task: "t", access: "read-only" })).toThrow(/limit 1/);
  r.setLimits({ maxChildren: 2, maxDepth: 0 });
  expect(() => r.addSub(a.id, { label: "two", task: "t", access: "read-only" })).toThrow(/at most 0 deep/);
  expect(r.snapshot().limits).toMatchObject({ maxChildren: 2, maxDepth: 0, hops: LIMITS.hops });
  // The shipped numbers are untouched by one roster's tuning.
  expect(LIMITS.maxDepth).toBe(3);
  expect(new Roster().limits.maxChildren).toBe(4);
});

test("the message chain, the message length and the woken-turn budget follow the settings", () => {
  const r = new Roster(() => 0);
  const inbox: string[] = [];
  const mk = (n: string) => {
    const node = r.addRoot(n, { deliver: (m, how) => void inbox.push(`${n}:${how}`), stop: () => {} });
    return node.id;
  };
  const a = mk("a");
  const b = mk("b");
  r.link(a, b);
  r.setLimits({ messageChars: 100, hops: 1 });
  expect(r.send(a, b, "x".repeat(101))).toEqual({ ok: false, reason: expect.stringContaining("over 100 characters") });
  expect(r.send(a, b, "hi")).toEqual({ ok: true, delivery: "woken" });
  expect(r.send(b, a, "hi back")).toEqual({ ok: true, delivery: "held", held: "chain" });
  // A budget of nothing: a message never wakes an idle agent, it waits for its user.
  const c = mk("c");
  const d = mk("d");
  r.link(c, d);
  r.setLimits({ wakeSpend: 0 });
  expect(r.send(c, d, "hello")).toEqual({ ok: true, delivery: "held", held: "spend" });
});

test("/settings words: list, read, set, refuse, reset", () => {
  const s = new SettingsStore();
  const moved: unknown[] = [];
  const say = (...argv: string[]) => settingsCommand(s, argv, (k) => moved.push(k));
  expect(say().text).toContain("wakeSpend");
  expect(settingsText(s)).toMatch(/Agents\n\s+maxDepth\s+3/);
  expect(say("wakeSpend")).toMatchObject({ ok: true, text: expect.stringContaining("Now: $0.50") });
  expect(say("wakeSpend", "1.5")).toMatchObject({ ok: true, text: "Woken-turn budget: $1.50  (default $0.50)" });
  expect(s.get().wakeSpend).toBe(1.5);
  expect(say("HOPS", "x")).toEqual({ ok: false, text: "hops is a whole number" });
  expect(say("set", "keys.hub", "alt", "+", "j")).toMatchObject({ ok: true });
  expect(s.get()["keys.hub"]).toBe("alt+j");
  expect(say("nope", "1").ok).toBe(false);
  expect(say("reset", "wakeSpend").text).toContain("$0.50");
  expect(say("reset").text).toBe("Every setting is back to its default.");
  expect(s.get()).toEqual(defaults());
  expect(moved).toEqual(["wakeSpend", "keys.hub", "wakeSpend", undefined]);
});

/** Answer the menu's dialogs in order; `null` is esc. */
async function drive(dialogs: Dialogs, answers: (string | boolean | null)[]) {
  const seen: string[] = [];
  for (const a of answers) {
    let d = dialogs.current();
    for (let i = 0; !d && i < 200; i++) {
      await new Promise((r) => setTimeout(r, 5));
      d = dialogs.current();
    }
    if (!d) throw new Error(`no dialog for ${String(a)}`);
    seen.push(d.kind === "select" || d.kind === "text" ? d.title : d.kind);
    if (d.kind === "confirm") d.resolve(a === true);
    else if (d.kind === "select" || d.kind === "text") d.resolve(a === null ? undefined : String(a));
  }
  return seen;
}

test("the menu: toggle, choose, type a number; a refused value says why and the list comes back", async () => {
  const s = new SettingsStore();
  const dialogs = new Dialogs();
  const notes: string[] = [];
  const applied: unknown[] = [];
  const menu = settingsMenu({ settings: s, dialogs, notice: (t) => void notes.push(t), applied: (k) => void applied.push(k) });
  const titles = await drive(dialogs, [
    "reflect", // a switch: flips at once
    "splitLayout", "rows", // a choice
    "hops", "30", // a number
    "wakeSpend", "-5", // refused
    "hops", "", // empty number: nothing
    "theme", null, // backed out of a choice
    null, // leave
  ]);
  await menu;
  expect(s.get()).toMatchObject({ reflect: false, splitLayout: "rows", hops: 30, wakeSpend: 0.5, theme: "night" });
  expect(titles.filter((t) => t === "Settings")).toHaveLength(7);
  expect(notes).toEqual(["wakeSpend is between 0 and 100"]);
  expect(applied).toEqual(["reflect", "splitLayout", "hops"]);
});

test("the menu names what waits for the next launch, and reset-everything asks first", async () => {
  const s = new SettingsStore();
  const dialogs = new Dialogs();
  const notes: string[] = [];
  const menu = settingsMenu({ settings: s, dialogs, notice: (t) => void notes.push(t), applied: () => {} });
  await drive(dialogs, ["motion", "hops", "7", "@reset-all", false, null]);
  await menu;
  expect(s.get()).toMatchObject({ motion: false, hops: 7 });
  expect(notes).toEqual(["Saved. Animation takes effect the next time Mnemo starts."]);
  const again = settingsMenu({ settings: s, dialogs, notice: () => {}, applied: () => {} });
  await drive(dialogs, ["@reset-all", true, null]);
  await again;
  expect(s.get()).toEqual(defaults());
});

test("the cursor returns to the setting you just changed", async () => {
  const s = new SettingsStore();
  const dialogs = new Dialogs();
  const menu = settingsMenu({ settings: s, dialogs, notice: () => {}, applied: () => {} });
  await drive(dialogs, ["hops", "9"]);
  const d = dialogs.current();
  expect(d?.kind === "select" && d.initial).toBe("hops");
  d?.resolve(undefined as never);
  await menu;
});

test("/settings in a session: words change the host, the menu opens on a bare /settings", async () => {
  const e = await mnemoEnv();
  envs.push(e);
  const c = e.controller;
  await c.submit("/settings hops 4");
  expect(c.settings.get().hops).toBe(4);
  expect(e.host.roster.limits.hops).toBe(4);
  await c.submit("/settings wakeSpend 2");
  expect(e.host.roster.limits.wakeSpend).toBe(2);
  await c.submit("/settings theme nord");
  expect(themeName()).toBe("nord");
  await c.submit("/settings hops 0");
  expect(e.host.roster.limits.hops).toBe(4);
  await c.submit("/settings reset");
  expect(e.host.roster.limits.hops).toBe(LIMITS.hops);
  expect(themeName()).toBe("night");
  const open = c.submit("/settings");
  const d = await nextDialog(c);
  expect(d.kind === "select" && d.title).toBe("Settings");
  d.resolve(undefined as never);
  await open;
  expect(c.commands().some((x) => x.name === "settings")).toBe(true);
});

test("a host built with settings starts its roster on them", async () => {
  const s = new SettingsStore();
  s.set("maxChildren", 2);
  const e = await mnemoEnv({ settings: s });
  envs.push(e);
  expect(e.host.roster.limits.maxChildren).toBe(2);
  expect(e.host.settings).toBe(s);
  expect(e.controller.settings).toBe(s);
});

test("/help shows the keys as bound now", async () => {
  const s = new SettingsStore();
  s.set("keys.expand", "alt+x");
  const e = await mnemoEnv({ settings: s });
  envs.push(e);
  await e.controller.submit("/help");
  const text = e.controller.transcript.snapshot().committed.map((b) => ("text" in b ? b.text : "")).join("\n");
  expect(text).toContain("alt+x expand output");
  expect(text).toContain("/settings");
});

test("mnemo settings: the same list and changes from the command line, against MNEMO_HOME", () => {
  const home = tmp();
  const run = (...argv: string[]) => {
    const r = Bun.spawnSync([process.execPath, path.join(import.meta.dir, "..", "bin", "mnemo.ts"), "settings", ...argv], { env: { ...process.env, MNEMO_HOME: home }, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  expect(run()).toMatchObject({ code: 0, out: expect.stringContaining("wakeSpend") });
  expect(run("set", "hops", "30")).toMatchObject({ code: 0, out: expect.stringContaining("30 messages") });
  expect(JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"))).toEqual({ hops: 30 });
  expect(run("hops")).toMatchObject({ code: 0, out: expect.stringContaining("Now: 30 messages") });
  expect(run("set", "hops", "0")).toMatchObject({ code: 1, err: expect.stringContaining("between 1 and 100") });
  expect(run("set", "mode", "yolo")).toMatchObject({ code: 1 });
  expect(run("reset")).toMatchObject({ code: 0 });
  expect(fs.existsSync(path.join(home, "config.json"))).toBe(false);
});

test("docs/SETTINGS.md lists every setting by name, and nothing that does not exist", () => {
  const doc = fs.readFileSync(path.join(import.meta.dir, "..", "..", "docs", "SETTINGS.md"), "utf8");
  for (const k of SETTING_KEYS) expect(doc).toContain(`\`${k}\``);
  const named = [...doc.matchAll(/^\| [^|]+ \| `([^`]+)` \|/gm)].map((m) => m[1]);
  expect(named.sort()).toEqual([...SETTING_KEYS].sort());
});

test("the gate still asks before anything edits config.json from outside the settings menu", () => {
  const home = tmp();
  const grants = { project: [], global: [], deny: [] };
  const target = path.join(home, "config.json");
  for (const mode of ["default", "accept-edits"] as const) {
    for (const [tool, input] of [
      ["write", { path: target, content: "{}" }],
      ["edit", { path: target, edits: [] }],
      ["bash", { command: `echo '{"wakeSpend":100}' > ${target}` }],
    ] as const)
      expect(judge({ mode }, [], grants, "/p", tool, input as Record<string, unknown>), `${mode} ${tool}`).toHaveProperty("ask");
  }
  expect(judge({ mode: "plan" }, [], grants, "/p", "write", { path: target, content: "{}" })).toMatchObject({ allow: false });
});

test("no tool the model can call changes a setting", async () => {
  const e = await mnemoEnv();
  envs.push(e);
  const tools = e.controller.session.getAllTools().map((t) => t.name);
  expect(tools.length).toBeGreaterThan(5);
  expect(tools.filter((n) => /setting|config|preference/i.test(n))).toEqual([]);
});
