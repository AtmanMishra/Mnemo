/** `mnemo opera …`: set up an Opera's repositories and budget, and start its conductor. */
import * as fs from "node:fs";
import * as path from "node:path";
import { addRepo, createOpera, listOperas, operaDir, readOpera, removeRepo, setBudget, DEFAULT_BUDGET } from "./store.ts";

export const OPERA_USAGE = `mnemo opera — one conductor, several repositories, threads that each work in their own worktree

usage
  mnemo opera                                    list your Operas
  mnemo opera new <name> [--budget <dollars>]    make one ($${DEFAULT_BUDGET} for all its threads together unless you say; 0 is no limit)
  mnemo opera add <name> <folder | https-url | owner/repo> [--name <repo>] [--trust]
                                                 attach a repository: a folder of yours, or a clone of an https address
  mnemo opera remove <name> <repo>               detach one (a clone's folder is deleted; your folder and the worktrees are kept)
  mnemo opera budget <name> <dollars>            change the budget
  mnemo opera show <name>                        its repositories, worktrees and the end of its log
  mnemo opera <name> [options]                   start its conductor (the options of mnemo, e.g. --plan, --model)

The conductor plans and starts threads; each thread is a sub-agent in a new git worktree of one
repository, on a branch opera/<name>/<thread>, so your own checkout is never touched. You approve
each thread's edits and commands in the conductor's terminal, as for any sub-agent.

Adding an https address clones it (git, https only, no hooks or submodules, without your git config):
the only time Opera uses the network. A clone's own .agents/ resources do not load in its threads
unless you add it with --trust. Everything is in ~/.mnemo/opera/<name>/: opera.json, repos/,
worktrees/ and LOG.md (one line per thing a thread did).`;

const SUBCOMMANDS = new Set(["new", "add", "remove", "budget", "show", "list", "help", "--help", "-h"]);

/** What to start, when the command starts a conductor: its folder and the rest of the command line. */
export interface OperaLaunch {
  name: string;
  dir: string;
  rest: string[];
}

function take(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("-")) throw new Error(`${flag} needs a value`);
  argv.splice(i, 2);
  return v;
}

function dollars(text: string | undefined): number {
  const n = Number(text);
  if (text === undefined || !Number.isFinite(n) || n < 0) throw new Error("the budget is a number of dollars, 0 for no limit");
  return n;
}

export function operaCommand(argv: string[], home: string, log: (s: string) => void = console.log): number | OperaLaunch {
  const fail = (msg: string) => (console.error(`mnemo opera: ${msg}`), 1);
  const [sub, ...rest] = argv;
  try {
    if (sub === undefined || sub === "list") {
      const all = listOperas(home);
      if (!all.length) return log("no Operas yet (mnemo opera new <name>)"), 0;
      for (const o of all) log(`${o.name}\t${o.repos.length} repositor${o.repos.length === 1 ? "y" : "ies"}\t${o.budget > 0 ? `$${o.budget.toFixed(2)}` : "no budget"}\t${o.repos.map((r) => r.name).join(", ")}`);
      return 0;
    }
    if (sub === "help" || sub === "--help" || sub === "-h") return log(OPERA_USAGE), 0;
    if (sub === "new") {
      const args = [...rest];
      const budget = take(args, "--budget");
      if (args.length !== 1) return fail("new needs a name: mnemo opera new <name> [--budget <dollars>]");
      const o = createOpera(home, args[0]!, budget === undefined ? undefined : dollars(budget));
      log(`made the Opera ${o.name} (${o.budget > 0 ? `$${o.budget.toFixed(2)} for all its threads` : "no budget"}). Attach repositories: mnemo opera add ${o.name} <folder | https-url>`);
      return 0;
    }
    if (sub === "add") {
      const args = [...rest];
      const name = take(args, "--name");
      const trust = args.includes("--trust");
      const plain = args.filter((a) => a !== "--trust");
      if (plain.length !== 2) return fail("add needs an Opera and a repository: mnemo opera add <name> <folder | https-url | owner/repo> [--name <repo>] [--trust]");
      const unknown = plain.find((a) => a.startsWith("--"));
      if (unknown) return fail(`unknown option ${unknown}`);
      const r = addRepo(home, plain[0]!, plain[1]!, { name, trust });
      log(`attached ${r.name}: ${r.kind === "clone" ? `cloned ${r.url} into ${r.path}` : r.path}${r.trusted ? " (trusted: its .agents/ resources load in its threads)" : ""}`);
      return 0;
    }
    if (sub === "remove") {
      if (rest.length !== 2) return fail("remove needs an Opera and a repository: mnemo opera remove <name> <repo>");
      const r = removeRepo(home, rest[0]!, rest[1]!);
      log(`detached ${r.name}${r.kind === "clone" ? " and deleted its clone" : ""}`);
      return 0;
    }
    if (sub === "budget") {
      if (rest.length !== 2) return fail("budget needs an Opera and dollars: mnemo opera budget <name> <dollars>");
      const o = setBudget(home, rest[0]!, dollars(rest[1]));
      log(`${o.name}: ${o.budget > 0 ? `$${o.budget.toFixed(2)} for all its threads` : "no budget"}`);
      return 0;
    }
    if (sub === "show") {
      if (rest.length !== 1) return fail("show needs an Opera: mnemo opera show <name>");
      const o = readOpera(home, rest[0]!);
      const dir = operaDir(home, o.name);
      log(`${o.name}  ${o.budget > 0 ? `budget $${o.budget.toFixed(2)}` : "no budget"}  ${dir}`);
      for (const r of o.repos) log(`  ${r.name}\t${r.kind}${r.trusted ? ", trusted" : ""}\t${r.url ?? r.path}`);
      if (!o.repos.length) log(`  (no repositories: mnemo opera add ${o.name} <folder | https-url>)`);
      const trees = fs.existsSync(path.join(dir, "worktrees")) ? fs.readdirSync(path.join(dir, "worktrees")) : [];
      if (trees.length) log(`worktrees (${path.join(dir, "worktrees")}):\n${trees.map((t) => `  ${t}`).join("\n")}`);
      const logFile = path.join(dir, "LOG.md");
      if (fs.existsSync(logFile)) log(`LOG.md (last lines):\n${fs.readFileSync(logFile, "utf8").trimEnd().split("\n").slice(-15).join("\n")}`);
      return 0;
    }
    if (SUBCOMMANDS.has(sub)) return fail(`${sub}: mnemo opera --help`);
    // Anything else names an Opera to conduct; what follows are mnemo's own options.
    if (sub.startsWith("-")) return fail(`unknown option ${sub}: mnemo opera --help`);
    const o = readOpera(home, sub);
    if (rest.includes("--cwd")) return fail("the conductor works in the Opera's folder; --cwd does not apply");
    return { name: o.name, dir: operaDir(home, o.name), rest };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}
