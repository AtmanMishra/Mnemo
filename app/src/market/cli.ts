/** `mnemo skills …`: skills from marketplaces, installed the way Claude Code installs plugins. */
import { frontmatter } from "./marketplace.ts";
import { addMarketplace, install, marketplacePlugins, parseKey, readInstalled, readMarkets, removeMarketplace, uninstall, verifyAll, type InstalledRecord } from "./store.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { skillDir } from "./store.ts";
import { blocking, formatFindings, scanSkill, skillFolders, type ScanOptions, type ScanResult } from "./scan.ts";
import { skillsDir } from "../runtime/paths.ts";

export const SKILLS_USAGE = `mnemo skills — skills from marketplaces, installed like Claude Code plugins

usage
  mnemo skills marketplace add <owner/repo | https-url | folder>   add a marketplace (a git repository with .claude-plugin/marketplace.json)
  mnemo skills marketplace list | update [name] | remove <name>
  mnemo skills browse [marketplace]                                what the marketplaces offer
  mnemo skills install <plugin>@<marketplace> [--force]            install a plugin's skills, once they pass the scan
  mnemo skills list                                                what is installed, and whether it is intact
  mnemo skills update [plugin@marketplace] [--force]               take the marketplace's current version
  mnemo skills remove <plugin@marketplace>
  mnemo skills verify                                              check every installed skill against what was installed
  mnemo skills scan [plugin@marketplace | folder]                  look for what a skill should not do (default: every skill Mnemo loads)

Adding a marketplace clones it (git, https only) and nothing else: no code from it runs, now or
later. Installing copies a plugin's skills as plain files into ~/.mnemo/market/skills/. A skill is
instructions the model follows, so read what you install: \`mnemo skills show <plugin>@<marketplace>\`.
A skill loads only while every file under it is what was installed. Only the skills of a plugin are
used; its commands, agents, hooks and servers are not.

Every skill is scanned before it is installed: prompt injection, hidden text, sending data or
credentials out, remote code piped into a shell, obfuscated code, reverse shells (rules from NVIDIA
SkillSpector). A HIGH or CRITICAL finding stops the install until you read it and pass --force.
When the skillspector program is installed (uv tool install git+https://github.com/NVIDIA/skillspector.git)
its static analysis runs too, offline and without an LLM.`;

const when = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Print a scan of each named skill; returns whether any finding blocks. */
function report(scans: Record<string, ScanResult>): boolean {
  let bad = false;
  for (const [name, s] of Object.entries(scans)) {
    const block = blocking(s.findings).length > 0;
    bad ||= block;
    const head = `${name}: ${s.findings.length ? `${s.findings.length} finding${s.findings.length === 1 ? "" : "s"}${block ? ", NOT SAFE TO LOAD UNREAD" : ""}` : "nothing found"} (${s.by.join(" + ")})`;
    (block ? console.error : console.log)(head);
    for (const l of formatFindings(s.findings)) (block ? console.error : console.log)(l);
    if (s.note) console.error(`  ${s.note}`);
  }
  return bad;
}

/** The skills `mnemo skills scan` reads: a plugin (installed, or not yet), a folder, or all of them. */
function scanTargets(home: string, target: string | undefined, cwd: string): Record<string, string> {
  const out: Record<string, string> = {};
  const installed = (rec: InstalledRecord) => {
    for (const n of Object.keys(rec.skills)) out[`${n} (${rec.plugin}@${rec.marketplace})`] = skillDir(home, rec.marketplace, rec.plugin, n);
  };
  if (target === undefined) {
    for (const rec of Object.values(readInstalled(home))) installed(rec);
    for (const d of skillFolders(skillsDir(home))) out[`${path.basename(d)} (yours)`] = d;
    for (const d of skillFolders(path.join(cwd, ".agents", "skills"))) out[`${path.basename(d)} (this folder)`] = d;
    return out;
  }
  if (/^[^@\s/\\]+@[^@\s/\\]+$/.test(target) && !fs.existsSync(target)) {
    const rec = readInstalled(home)[target];
    if (rec) return installed(rec), out;
    // Not installed: read it where the marketplace has it, so it can be judged before installing.
    const { plugin, marketplace } = parseKey(target);
    const p = marketplacePlugins(home, marketplace).find((x) => x.name === plugin);
    if (!p) throw new Error(`${marketplace} lists no ${plugin}`);
    for (const s of p.skills) out[s.name] = s.dir;
    return out;
  }
  const dir = path.resolve(cwd, target);
  if (!fs.existsSync(dir)) throw new Error(`${target} is not a folder, a file or plugin@marketplace`);
  const found = fs.statSync(dir).isDirectory() ? skillFolders(dir) : [];
  for (const d of found.length ? found : [dir]) {
    const rel = path.relative(cwd, d);
    out[rel === "" ? "." : rel.startsWith("..") || path.isAbsolute(rel) ? d : rel] = d;
  }
  return out;
}

export async function skillsCommand(argv: string[], home: string, o: { cwd?: string; scan?: ScanOptions } = {}): Promise<number> {
  const force = argv.includes("--force");
  const [sub, ...rest] = argv.filter((a) => a !== "--force");
  const fail = (msg: string) => (console.error(`mnemo skills: ${msg}`), 1);
  try {
    if (sub === undefined || sub === "--help" || sub === "help") return console.log(SKILLS_USAGE), 0;
    if (sub === "marketplace") {
      const [what, arg] = rest;
      if (what === "add") {
        if (!arg) return fail("marketplace add needs owner/repo, an https address or a folder");
        const a = addMarketplace(home, arg);
        console.log(`added ${a.name}${a.commit ? ` at ${a.commit.slice(0, 12)}` : ""}: ${a.plugins.length} plugin${a.plugins.length === 1 ? "" : "s"}. mnemo skills browse ${a.name}`);
        return 0;
      }
      if (what === "list") {
        const markets = readMarkets(home);
        if (!Object.keys(markets).length) return console.log("no marketplaces (mnemo skills marketplace add <owner/repo>)"), 0;
        for (const [n, m] of Object.entries(markets)) console.log(`${n}\t${m.commit?.slice(0, 12) ?? "-"}\t${when(m.added)}\t${m.source}`);
        return 0;
      }
      if (what === "update") {
        const markets = readMarkets(home);
        const names = arg ? [arg] : Object.keys(markets);
        for (const n of names) {
          if (!markets[n]) return fail(`no marketplace called ${n}`);
          const a = addMarketplace(home, markets[n]!.source, { replace: n });
          console.log(`${n}: ${a.commit && a.commit === markets[n]!.commit ? "already current" : `now at ${a.commit?.slice(0, 12) ?? "the folder's files"}`}. Installed skills are unchanged until mnemo skills update.`);
        }
        return 0;
      }
      if (what === "remove") {
        if (!arg) return fail("marketplace remove needs a name");
        const gone = removeMarketplace(home, arg);
        console.log(`removed ${arg}${gone.length ? ` and what was installed from it: ${gone.join(", ")}` : ""}`);
        return 0;
      }
      return fail("marketplace add | list | update | remove");
    }
    if (sub === "browse") {
      const markets = rest[0] ? [rest[0]] : Object.keys(readMarkets(home));
      if (!markets.length) return console.log("no marketplaces (mnemo skills marketplace add <owner/repo>)"), 0;
      const installed = readInstalled(home);
      for (const m of markets)
        for (const p of marketplacePlugins(home, m)) {
          const mark = installed[`${p.name}@${m}`] ? "installed" : p.skipped ? `unavailable: ${p.skipped}` : `${p.skills.length} skill${p.skills.length === 1 ? "" : "s"}`;
          console.log(`${p.name}@${m}\t${mark}\t${p.description ?? ""}`);
        }
      return 0;
    }
    if (sub === "show") {
      const { plugin, marketplace } = parseKey(rest[0] ?? "");
      const p = marketplacePlugins(home, marketplace).find((x) => x.name === plugin);
      if (!p) return fail(`${marketplace} lists no ${plugin}`);
      for (const s of p.skills) console.log(`${s.name}\t${s.description ?? ""}`);
      return 0;
    }
    if (sub === "install") {
      if (!rest[0]) return fail("install needs plugin@marketplace (mnemo skills browse)");
      const rec = install(home, rest[0], { force, scan: o.scan });
      report(rec.scans);
      const names = Object.keys(rec.skills);
      console.log(`installed ${rest[0]}: ${names.join(", ")}`);
      for (const n of names) {
        const text = fs.readFileSync(path.join(skillDir(home, rec.marketplace, rec.plugin, n), "SKILL.md"), "utf8");
        const d = frontmatter(text).description ?? "(no description)";
        console.log(`  ${n}: ${d.length > 160 ? `${d.slice(0, 160)}…` : d}`);
      }
      console.log("They are loaded in your next session.");
      return 0;
    }
    if (sub === "list") {
      const all = readInstalled(home);
      if (!Object.keys(all).length) return console.log("nothing installed (mnemo skills browse)"), 0;
      const { bad } = verifyAll(home);
      for (const [k, r] of Object.entries(all)) {
        const problems = bad.filter((b) => b.skill.endsWith(`(${k})`));
        console.log(`${k}\t${Object.keys(r.skills).join(",")}\t${r.commit?.slice(0, 12) ?? "-"}\t${problems.length ? `NOT LOADED: ${problems.map((p) => p.reason).join("; ")}` : "intact"}`);
      }
      return 0;
    }
    if (sub === "update") {
      const keys = rest[0] ? [rest[0]] : Object.keys(readInstalled(home));
      for (const k of keys) {
        const before = readInstalled(home)[k];
        if (!before) return fail(`${k} is not installed`);
        const rec = install(home, k, { force, scan: o.scan });
        report(rec.scans);
        console.log(`${k}: ${rec.commit && rec.commit === before.commit ? "already current" : `now at ${rec.commit?.slice(0, 12) ?? "the marketplace's files"}`}`);
      }
      return 0;
    }
    if (sub === "remove") {
      if (!rest[0]) return fail("remove needs plugin@marketplace");
      uninstall(home, rest[0]);
      console.log(`removed ${rest[0]}`);
      return 0;
    }
    if (sub === "verify") {
      const { ok, bad } = verifyAll(home);
      for (const n of ok) console.log(`${n}: intact`);
      for (const b of bad) console.error(`${b.skill}: NOT LOADED, ${b.reason}`);
      return bad.length ? 1 : 0;
    }
    if (sub === "scan") {
      const targets = scanTargets(home, rest[0], o.cwd ?? process.cwd());
      if (!Object.keys(targets).length) return console.log("no skills to scan"), 0;
      const scans: Record<string, ScanResult> = {};
      for (const [name, dir] of Object.entries(targets)) scans[name] = scanSkill(dir, o.scan);
      return report(scans) ? 1 : 0;
    }
    return fail(`unknown command "${sub}"\n${SKILLS_USAGE}`);
  } catch (e) {
    return fail((e as Error).message);
  }
}
