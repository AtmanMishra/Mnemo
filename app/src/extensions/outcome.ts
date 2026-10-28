/**
 * Records what each run came to (evolve/outcome.ts) and keeps the runs whose
 * result was checked as task cards (evolve/cards.ts). Only the session the
 * user talks to records: a sub-agent's work is part of its parent's run.
 * A run sent back to verify is still one run; it is recorded when it is done.
 * Off with the "Record outcomes" setting.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { projectIdentity, textOf } from "@mnemo/memory";
import { SAFE_GIT, trustedBin } from "../runtime/bin.ts";
import { cardFor, writeCard } from "../evolve/cards.ts";
import { appendOutcome, RunTracker } from "../evolve/outcome.ts";
import { snapshot } from "../evolve/surface.ts";
import type { Host } from "./host.ts";

function gitRun(cwd: string, args: string[], env?: Record<string, string>) {
  const bin = trustedBin("git");
  if (!bin) return undefined;
  const r = spawnSync(bin, [...SAFE_GIT, ...args], { cwd, encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 * 1024, env: env ? { ...process.env, ...env } : undefined });
  return r.status === 0 ? r.stdout : undefined;
}

/**
 * What changed since `head`, new files included (ignored ones not), as file names and a
 * patch. Read through a scratch index, so the user's own index is never touched.
 */
export function gitChanges(root: string, head: string): { files: string[]; patch: string } | undefined {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-index-"));
  try {
    const env = { GIT_INDEX_FILE: path.join(dir, "index") };
    if (gitRun(root, ["read-tree", head], env) === undefined) return undefined;
    if (gitRun(root, ["add", "-A"], env) === undefined) return undefined;
    const names = gitRun(root, ["diff", "--cached", "--name-only", head], env);
    const patch = gitRun(root, ["diff", "--cached", "--binary", head], env);
    if (names === undefined || patch === undefined) return undefined;
    return { files: names.split("\n").filter(Boolean), patch };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** HEAD and whether the tree is clean, or undefined outside git. */
export function gitState(cwd: string): { head: string; clean: boolean } | undefined {
  const head = gitRun(cwd, ["rev-parse", "--verify", "HEAD"]);
  const status = head === undefined ? undefined : gitRun(cwd, ["status", "--porcelain"]);
  return head === undefined || status === undefined ? undefined : { head: head.trim(), clean: status.trim() === "" };
}

export function outcomeExtension(host: Host) {
  return (pi: ExtensionAPI): void => {
    if (host.depth > 0) return;
    let run: RunTracker | undefined;
    let runs = 0;
    let escalationsAtStart = 0;
    let surface: string | undefined;
    const args = new Map<string, Record<string, unknown>>();

    pi.on("before_agent_start", async (event, ctx) => {
      // The verify follow-up of a run already being recorded.
      if (run) return;
      if (!host.settings.get().recordOutcomes) return;
      run = new RunTracker(event.prompt ?? "", gitState(ctx.cwd));
      escalationsAtStart = host.escalations.length;
      try {
        surface = snapshot(host.home, "seen at run start");
      } catch {
        surface = undefined;
      }
    });

    pi.on("tool_execution_start", async (event) => {
      if (run) args.set(event.toolCallId, (event.args ?? {}) as Record<string, unknown>);
    });

    pi.on("tool_execution_end", async (event) => {
      const a = args.get(event.toolCallId);
      args.delete(event.toolCallId);
      if (!run || !a) return;
      // The error, or what a command printed: a check that hides its exit status may still say it.
      const text = event.isError || typeof a.command === "string" ? textOf((event.result as { content?: unknown })?.content) : undefined;
      run.call(event.toolName, a, !event.isError, text);
    });

    pi.on("agent_end", async (event, ctx) => {
      if (!run) return;
      // Memory sent the run back to run a check: the record waits for the end of that.
      if (host.verifying) return void run.held.push(...event.messages);
      const r = run;
      run = undefined;
      const last = [...event.messages].reverse().find((m) => (m as { role: string }).role === "assistant") as { stopReason?: string } | undefined;
      const followUp = runs++ > 0;
      try {
        const project = projectIdentity(ctx.cwd);
        // One spelling of each path (macOS's /var is /private/var), so the folder the run
        // worked in is found inside its project.
        const root = real(project.root);
        const cwd = real(ctx.cwd);
        // From a clean start, git knows every file the run changed, however it changed them.
        const changes = r.git?.clean ? gitChanges(root, r.git.head) : undefined;
        const record = r.finish({
          project: { id: project.id, name: project.name, root },
          cwd,
          session: ctx.sessionManager.getSessionId(),
          model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
          messages: [...r.held, ...event.messages],
          stopReason: last?.stopReason,
          escalated: host.escalations.length > escalationsAtStart,
          changed: changes?.files,
        });
        record.surface = surface;
        const card = cardFor(record, followUp, changes?.patch);
        if (card) {
          writeCard(host.home, card);
          record.card = card.id;
        }
        appendOutcome(host.home, record);
      } catch {
        /* a record is never worth failing a run for */
      }
    });
  };
}
