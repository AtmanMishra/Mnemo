/**
 * `mnemo evolve`: the measurement the evolve loop stands on.
 *
 *   stats    the scorecard for this project (or --all)
 *   tasks    the task cards made from checked runs, and which are held out
 *   replay   run cards again with the card's own check as the judge
 *   forget   delete a card
 *   history  kept versions of your profiles, skills and model notes, and how runs went on each
 *   diff     what changed between two versions
 *   revert   put them back to a version
 *   lessons  this project's kept lessons with the helped and hurt votes runs gave them
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { BENCH_MARGIN, findMemsrv, journalPath, LESSON_KEY, MemoryService, projectIdentity } from "@mnemo/memory";
import { readCards, removeCard, splitOf, writeCard, type Split, type TaskCard } from "./cards.ts";
import { evolveDir, projectSlug, readAllOutcomes, readOutcomes } from "./outcome.ts";
import { replayCard, type Arm, type AttemptRunner, type ReplayResult } from "./replay.ts";
import { renderScorecard, score } from "./scorecard.ts";
import { diffSurface, findVersion, revertTo, snapshot, versions, type SurfaceDiff } from "./surface.ts";

export const EVOLVE_USAGE = `usage: mnemo evolve <command> [--cwd <dir>]

  stats [--all] [--days <n>] [--json]   how runs in this project went, earlier half against later half
  tasks [--json]                        task cards: checked runs that can be run again
  replay [options]                      run cards again, judged by each card's own check
      --card <id>                       one card (repeatable); default: every card in --split
      --split held-in|held-out|all      which cards (default all)
      --arm memory|no-memory|both       with a copy of your memory, without, or both (default memory)
      --model <provider/id>             the model for the attempts (default: your default)
      --follow-ups                      include cards whose prompt was not the first of its session
      --timeout <minutes>               per attempt (default 15)
      --json                            one result per line
  forget <card id>                      delete a task card
  history [--json]                      versions of your profiles, skills and model notes, with how runs went on each
  diff <version> [<version>]            files changed from one version to another (default: to now)
  revert <version>                      put profiles, skills and model notes back as they were (itself revertible)
  lessons [--json]                      this project's lessons, with how often runs said each helped or hurt

Records, cards and replays stay in $MNEMO_HOME/evolve; nothing leaves this machine.
Recording is the "Record outcomes" setting (mnemo settings set recordOutcomes false turns it off).`;

interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  /** Tests inject the attempt. */
  run?: AttemptRunner;
}

function flags(argv: string[]): { pos: string[]; opt: Map<string, string[]> } {
  const pos: string[] = [];
  const opt = new Map<string, string[]>();
  const valued = new Set(["--cwd", "--days", "--card", "--split", "--arm", "--model", "--timeout"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (valued.has(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      opt.set(a, [...(opt.get(a) ?? []), v]);
    } else if (a.startsWith("--")) opt.set(a, ["true"]);
    else pos.push(a);
  }
  return { pos, opt };
}

const money = (n?: number) => (n === undefined ? "–" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

export async function evolveCommand(argv: string[], home: string, io: Io = { out: console.log, err: console.error }): Promise<number> {
  let parsed: ReturnType<typeof flags>;
  try {
    parsed = flags(argv);
  } catch (e) {
    io.err(`mnemo evolve: ${(e as Error).message}`);
    return 2;
  }
  const { pos, opt } = parsed;
  const one = (k: string) => opt.get(k)?.[0];
  const cmd = pos[0];
  if (!cmd || cmd === "help" || opt.has("--help")) {
    io.out(EVOLVE_USAGE);
    return cmd ? 0 : 2;
  }
  const cwd = path.resolve(one("--cwd") ?? process.cwd());
  const project = projectIdentity(cwd);

  if (cmd === "stats") {
    const days = Number(one("--days") ?? 0);
    if (!Number.isFinite(days) || days < 0) return io.err("mnemo evolve stats: --days takes a number of days"), 2;
    const since = days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString() : "";
    const all = opt.has("--all") ? readAllOutcomes(home) : readOutcomes(home, project.id);
    const records = all.filter((r) => r.at >= since);
    const history = all.filter((r) => r.at < since);
    if (opt.has("--json")) {
      io.out(JSON.stringify(score(records, history)));
      return 0;
    }
    io.out(renderScorecard(records, { title: opt.has("--all") ? "every project" : `${project.name} (${project.root})`, history }));
    return 0;
  }

  if (cmd === "tasks") {
    const cards = readCards(home, project.id);
    const split = splitOf(cards);
    if (opt.has("--json")) {
      for (const c of cards) io.out(JSON.stringify({ id: c.id, at: c.at, split: split.get(c.id), prompt: c.prompt, check: c.check, tests: c.tests.map((t) => t.path), followUp: c.followUp, validity: c.validity }));
      return 0;
    }
    if (cards.length === 0) {
      io.out(`no task cards for ${project.name} yet. A run becomes one when it starts from a clean git tree, changes files and its last check passes.`);
      return 0;
    }
    for (const c of cards) {
      const notes = [split.get(c.id), c.followUp ? "follow-up" : "", c.validity && c.validity !== "ok" ? c.validity : "", c.tests.length ? `${c.tests.length} test file${c.tests.length > 1 ? "s" : ""}` : "no test files"].filter(Boolean).join(", ");
      io.out(`${c.id}  ${c.prompt.replace(/\s+/g, " ").slice(0, 70)}\n    check: ${c.check.slice(0, 70)} · ${notes}`);
    }
    return 0;
  }

  if (cmd === "forget") {
    const id = pos[1];
    if (!id) return io.err("usage: mnemo evolve forget <card id>"), 2;
    if (!removeCard(home, project.id, id)) return io.err(`mnemo evolve: no card ${id} in ${project.name}`), 1;
    io.out(`deleted card ${id}`);
    return 0;
  }

  if (cmd === "history") {
    const now = snapshot(home, "seen by mnemo evolve history");
    const runs = readAllOutcomes(home);
    const rows = versions(home).map((v) => {
      const rs = runs.filter((r) => r.surface === v.id);
      const edits = rs.filter((r) => r.files.length > 0).length;
      return { ...v, current: v.id === now, runs: rs.length, edits, passed: rs.filter((r) => r.verdict === "passed").length };
    });
    if (opt.has("--json")) {
      for (const r of rows) io.out(JSON.stringify(r));
      return 0;
    }
    for (const r of rows) {
      const how = r.runs ? `${r.runs} run${r.runs > 1 ? "s" : ""}, ${r.passed}/${r.edits} edits checked and passed` : "no runs";
      io.out(`${r.current ? "*" : " "} ${r.id}  ${r.at.slice(0, 16).replace("T", " ")}  ${r.files.length} file${r.files.length === 1 ? "" : "s"} · ${how} · ${r.reason}`);
    }
    io.out("\n* in force now. mnemo evolve diff <version> shows what changed since; mnemo evolve revert <version> puts it back.");
    return 0;
  }

  if (cmd === "lessons") {
    const memsrv = findMemsrv(home);
    if (!memsrv) return io.err("mnemo evolve lessons: memsrv was not found (mnemo doctor says where it looks)"), 1;
    const memory = new MemoryService(memsrv, journalPath(home));
    try {
      const facts = (await memory.profile("project", project.id)).filter((f) => LESSON_KEY.test(f.key));
      const votes = await memory.lessonVotes(project.id);
      const rows = facts.map((f) => {
        const v = votes.get(f.key) ?? { helped: 0, hurt: 0 };
        return { key: f.key, lesson: f.value, ...v, benched: v.hurt >= v.helped + BENCH_MARGIN };
      });
      if (opt.has("--json")) {
        for (const r of rows) io.out(JSON.stringify(r));
        return 0;
      }
      if (!rows.length) return io.out(`no lessons kept for ${project.name} yet. A run that shows one offers it, and you decide.`), 0;
      for (const r of rows) io.out(`${r.benched ? "benched " : ""}${r.key}  helped ${r.helped} · hurt ${r.hurt}\n    ${r.lesson}`);
      if (rows.some((r) => r.benched)) io.out(`\nbenched: hurt runs at least ${BENCH_MARGIN} more times than it helped, so it is left out of the prompt (still in memory).`);
      return 0;
    } finally {
      memory.stop();
    }
  }

  if (cmd === "diff" || cmd === "revert") {
    const ids = pos.slice(1);
    if (ids.length < 1 || ids.length > (cmd === "diff" ? 2 : 1)) return io.err(`usage: mnemo evolve ${cmd === "diff" ? "diff <version> [<version>]" : "revert <version>"}`), 2;
    const found = ids.map((id) => findVersion(home, id));
    const missing = ids.filter((_, i) => !found[i]);
    if (missing.length) return io.err(`mnemo evolve: no single version starts with ${missing.join(", ")} (mnemo evolve history lists them)`), 1;
    const show = (d: SurfaceDiff) => {
      for (const f of d.added) io.out(`  + ${f}`);
      for (const f of d.removed) io.out(`  - ${f}`);
      for (const f of d.changed) io.out(`  ~ ${f}`);
      if (!d.added.length && !d.removed.length && !d.changed.length) io.out("  no changes");
    };
    if (cmd === "diff") {
      show(diffSurface(home, found[0]!.id, found[1]?.id));
      return 0;
    }
    const { kept, diff } = revertTo(home, found[0]!.id);
    show(diff);
    io.out(`back to ${found[0]!.id}. To undo: mnemo evolve revert ${kept}`);
    return 0;
  }

  if (cmd === "replay") {
    const splitWanted = one("--split") ?? "all";
    if (!["held-in", "held-out", "all"].includes(splitWanted)) return io.err("mnemo evolve replay: --split is held-in, held-out or all"), 2;
    const armWanted = one("--arm") ?? "memory";
    if (!["memory", "no-memory", "both"].includes(armWanted)) return io.err("mnemo evolve replay: --arm is memory, no-memory or both"), 2;
    const minutes = Number(one("--timeout") ?? 15);
    if (!Number.isFinite(minutes) || minutes <= 0) return io.err("mnemo evolve replay: --timeout takes minutes"), 2;
    const model = one("--model");
    if (model && !/^[\w.-]+\/[\w.:/@+-]+$/.test(model)) return io.err("mnemo evolve replay: --model is provider/id"), 2;
    const cards = readCards(home, project.id);
    const split = splitOf(cards);
    const ids = opt.get("--card");
    let chosen: TaskCard[];
    if (ids) {
      chosen = ids.map((id) => cards.find((c) => c.id === id)).filter((c): c is TaskCard => !!c);
      const missing = ids.filter((id) => !cards.some((c) => c.id === id));
      if (missing.length) return io.err(`mnemo evolve: no card ${missing.join(", ")} in ${project.name}`), 1;
    } else {
      chosen = cards.filter((c) => (splitWanted === "all" || split.get(c.id) === (splitWanted as Split)) && (opt.has("--follow-ups") || !c.followUp));
    }
    if (chosen.length === 0) return io.out(`no cards to replay in ${project.name} (mnemo evolve tasks lists them)`), 0;
    const arms: Arm[] = armWanted === "both" ? ["memory", "no-memory"] : [armWanted as Arm];
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const keepDir = path.join(evolveDir(home), "replays", projectSlug(project.id), stamp);
    const results: ReplayResult[] = [];
    for (const card of chosen) {
      for (const arm of arms) {
        if (!opt.has("--json")) io.out(`${card.id} · ${arm} · ${card.prompt.replace(/\s+/g, " ").slice(0, 60)}`);
        const r = await replayCard(card, { home, arm, model, keepDir, timeoutMs: minutes * 60_000, run: io.run });
        // What the first look at a card found is kept: a trivial or broken card is not run again.
        if (r.validity && card.validity === undefined) {
          card.validity = r.validity;
          writeCard(home, card);
        }
        results.push(r);
        if (opt.has("--json")) io.out(JSON.stringify(r));
        else io.out(`    ${r.passed ? "passed" : r.validity && r.validity !== "ok" ? `skipped (${r.validity} card)` : "failed"}${r.error ? ` (${r.error.slice(0, 160)})` : ""} · ${r.turns ?? "–"} turns · ${money(r.cost)} · ${Math.round(r.ms / 1000)}s`);
      }
    }
    fs.mkdirSync(keepDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(keepDir, "results.jsonl"), results.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
    if (!opt.has("--json")) {
      io.out("");
      for (const arm of arms) {
        const unusable = (r: ReplayResult) => (r.validity ?? cards.find((c) => c.id === r.card)?.validity ?? "ok") !== "ok";
        const rs = results.filter((r) => r.arm === arm && !unusable(r));
        const passed = rs.filter((r) => r.passed).length;
        const cost = rs.reduce((a, r) => a + (r.cost ?? 0), 0);
        io.out(`${arm}: ${passed}/${rs.length} passed · ${money(cost)} total${rs.length ? ` · ${money(cost / rs.length)} per card` : ""}`);
      }
      const skipped = results.filter((r) => r.error && !r.passed && (r.validity ?? cards.find((c) => c.id === r.card)?.validity ?? "ok") !== "ok").length;
      if (skipped) io.out(`${skipped} attempt${skipped > 1 ? "s" : ""} skipped: a trivial card passes with no change, a broken one fails with the original change`);
      io.out(`diffs and check output: ${keepDir}`);
    }
    return results.some((r) => r.error && (r.validity ?? cards.find((c) => c.id === r.card)?.validity ?? "ok") === "ok") ? 1 : 0;
  }

  io.err(`mnemo evolve: unknown command ${cmd}\n${EVOLVE_USAGE}`);
  return 2;
}
