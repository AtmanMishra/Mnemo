/**
 * `mnemo memory …` — memory for other coding agents.
 *
 *   ingest    learn from Claude Code's saved sessions (once each)
 *   status    what memory holds, and what has been ingested
 *
 * The memory loop itself is @mnemo/memory's; this file only composes it with
 * pi's model runtime (for reflection) and the terminal.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { findMemsrv, ingestClaudeCode, journalPath, MemoryService, redact, textOf, type Reflector } from "@mnemo/memory";
import { createModelRuntime } from "./runtime/runtime.ts";
import { skillsDir } from "./runtime/paths.ts";

export const MEMORY_USAGE = `mnemo memory — memory for any coding agent

usage
  mnemo memory ingest [options]   learn from Claude Code's sessions (~/.claude/projects)
  mnemo memory status             what memory holds and what has been ingested

ingest options
  --model <provider/id>    the model that reflects on each run (default: $MNEMO_MEMORY_MODEL,
                           then Mnemo's default model); a cheap one is enough
  --under <dir>            only sessions whose folder is inside <dir>
  --from <dir>             read sessions from <dir> instead of ~/.claude/projects
  --skills                 save the skills a session asked to remember (default: candidates only)
  --min-tools <n>          skip runs with fewer tool calls (default 1)`;

/** A reflector over pi's model runtime: one call, text out, errors thrown. */
export function modelReflector(modelRuntime: ModelRuntime, model: Model<any>): Reflector {
  return async (system, user) => {
    const answer = await modelRuntime.completeSimple(
      model,
      { systemPrompt: system, messages: [{ role: "user", content: user, timestamp: Date.now() }] },
      { sessionId: randomUUID() },
    );
    if (answer.stopReason === "error") throw new Error(answer.errorMessage ?? "no answer");
    return textOf(answer.content);
  };
}

/** `provider/id`, or the default model in pi's settings. */
export function resolveModel(modelRuntime: ModelRuntime, agentDir: string, spec?: string): Model<any> {
  let provider: string | undefined;
  let id: string | undefined;
  if (spec) [provider, id] = [spec.split("/")[0], spec.split("/").slice(1).join("/")];
  else {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")) as { defaultProvider?: string; defaultModel?: string };
      [provider, id] = [s.defaultProvider, s.defaultModel];
    } catch {
      /* no settings yet */
    }
  }
  if (!provider || !id) throw new Error("no model for reflection — pass --model provider/id or set MNEMO_MEMORY_MODEL");
  const model = modelRuntime.getModel(provider, id);
  if (!model) throw new Error(`pi does not know the model ${provider}/${id}`);
  if (!modelRuntime.hasConfiguredAuth(provider)) throw new Error(`no credentials for ${provider} — log in with mnemo (/login) or set its API key`);
  return model;
}

function option(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function runMemoryCommand(argv: string[], home: string, agentDir: string, out = process.stdout, err = process.stderr): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "-h" || command === "--help") return out.write(`${MEMORY_USAGE}\n`), 0;
  const memsrv = findMemsrv(home);
  if (!memsrv) return err.write("mnemo memory: memsrv was not found — `mnemo doctor` says where it looks\n"), 1;
  const memory = new MemoryService(memsrv, journalPath(home));
  try {
    if (command === "status") {
      const stats = await memory.stats();
      let ledger: Record<string, number> = {};
      try {
        ledger = JSON.parse(fs.readFileSync(path.join(home, "memory", "ingested.json"), "utf8"));
      } catch {
        /* nothing ingested */
      }
      out.write(`journal   ${journalPath(home)}\n`);
      out.write(`nodes     ${stats?.nodes ?? "?"} (${stats?.episodes ?? "?"} sessions)\n`);
      out.write(`ingested  ${Object.keys(ledger).length} sessions, ${Object.values(ledger).reduce((a, b) => a + b, 0)} runs\n`);
      return 0;
    }
    if (command === "ingest") {
      const modelRuntime = await createModelRuntime(agentDir);
      const model = resolveModel(modelRuntime, agentDir, option(rest, "--model") ?? process.env.MNEMO_MEMORY_MODEL);
      const report = await ingestClaudeCode({
        memory,
        home,
        userSkillsDir: skillsDir(home),
        reflect: modelReflector(modelRuntime, model),
        projectsDir: option(rest, "--from"),
        under: option(rest, "--under"),
        minTools: Number(option(rest, "--min-tools") ?? 1),
        approveSkill: rest.includes("--skills") ? async () => true : undefined,
        progress: (s, runs) => out.write(`· ${redact(s.cwd)}  ${runs} run${runs === 1 ? "" : "s"}  (${s.model ?? "unknown model"})\n`),
        notify: (_id, note) => {
          if (note.kind === "learned") for (const item of note.items) out.write(`    learned  ${redact(item)}\n`);
          else if (note.kind === "skill") out.write(`    ${note.text}\n`);
          else if (note.kind === "failed") err.write(`    ${redact(note.text)}\n`);
        },
      });
      out.write(`\n${report.sessions} session(s), ${report.runs} run(s) learned · ${report.unchanged} unchanged · ${report.active} still in use\n`);
      return 0;
    }
    err.write(`mnemo memory: unknown command ${command}\n${MEMORY_USAGE}\n`);
    return 1;
  } catch (error) {
    err.write(`mnemo memory: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    memory.stop();
  }
}
