/**
 * `mnemo memory …` — memory for other coding agents.
 *
 *   ingest    learn from Claude Code's saved sessions (once each)
 *   hook      Claude Code's hooks: context at session start and per prompt,
 *             and (async, on Stop) learning from the run that just ended
 *   mcp       memory as an MCP server (stdio) for Codex, Cursor, opencode …
 *   setup     print the configuration that attaches memory to an agent
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
import {
  contextHook,
  findMemsrv,
  ingestClaudeCode,
  journalPath,
  MemoryService,
  redact,
  serveMcp,
  textOf,
  type HookInput,
  type Reflector,
} from "@mnemo/memory";
import { createModelRuntime } from "./runtime/runtime.ts";
import { skillsDir } from "./runtime/paths.ts";

export const MEMORY_USAGE = `mnemo memory — memory for any coding agent

usage
  mnemo memory setup claude-code   print the hooks and MCP entry that attach memory to Claude Code
  mnemo memory setup codex         print the MCP entry for Codex (~/.codex/config.toml)
  mnemo memory ingest [options]    learn from Claude Code's sessions (~/.claude/projects)
  mnemo memory hook                a Claude Code hook (event JSON on stdin); never fails the agent
  mnemo memory mcp [--cwd <dir>]   memory as an MCP server on stdio
  mnemo memory status              what memory holds and what has been ingested

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

/** The command that runs this binary again: the compiled one, or bun on the source. */
function self(): string {
  const exe = process.execPath;
  return /bun(\.exe)?$/.test(path.basename(exe)) ? `${exe} ${path.resolve(import.meta.dir, "..", "bin", "mnemo.ts")}` : exe;
}

export function setupText(agent: string): string | undefined {
  const cmd = self();
  if (agent === "claude-code") {
    const hook = (async = false) => [{ hooks: [{ type: "command", command: `${cmd} memory hook`, timeout: async ? 300 : 15, ...(async ? { async: true } : {}) }] }];
    const settings = { hooks: { SessionStart: hook(), UserPromptSubmit: hook(), Stop: hook(true) } };
    return [
      "# 1. Hooks — add to ~/.claude/settings.json (every project) or .claude/settings.json (this one):",
      JSON.stringify(settings, null, 2),
      "",
      "# 2. Tools (memory_recall, memory_search, memory_remember):",
      `claude mcp add --transport stdio --scope user mnemo -- ${cmd} memory mcp`,
      "",
      "# 3. Learn from the sessions you already have:",
      `${cmd} memory ingest --model <provider/id>`,
      "",
      "# Reflection after each session uses $MNEMO_MEMORY_MODEL, else Mnemo's default model.",
    ].join("\n");
  }
  if (agent === "codex") {
    const [command, ...args] = cmd.split(" ");
    return [
      "# Add to ~/.codex/config.toml:",
      "[mcp_servers.mnemo]",
      `command = ${JSON.stringify(command)}`,
      `args = ${JSON.stringify([...args, "memory", "mcp"])}`,
      "",
      "# Codex has no session hooks: ask it to call memory_recall at the start of a task (AGENTS.md is a good place).",
    ].join("\n");
  }
  return undefined;
}

async function readStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

export async function runMemoryCommand(argv: string[], home: string, agentDir: string, out = process.stdout, err = process.stderr): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "-h" || command === "--help") return out.write(`${MEMORY_USAGE}\n`), 0;
  if (command === "setup") {
    const text = setupText(rest[0] ?? "");
    if (!text) return err.write("mnemo memory setup: claude-code or codex\n"), 1;
    return out.write(`${text}\n`), 0;
  }
  // A hook must never break the agent it serves: whatever happens, exit 0.
  if (command === "hook") return runHook(home, agentDir, out, err);
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
    if (command === "mcp") {
      await serveMcp(
        { memory, userSkillsDir: skillsDir(home), cwd: path.resolve(option(rest, "--cwd") ?? process.cwd()), source: { agent: option(rest, "--agent") ?? "mcp" } },
        process.stdin,
        process.stdout,
      );
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

async function runHook(home: string, agentDir: string, out: NodeJS.WritableStream, err: NodeJS.WritableStream): Promise<number> {
  const memsrv = findMemsrv(home);
  if (!memsrv) return 0;
  const memory = new MemoryService(memsrv, journalPath(home));
  try {
    const input = JSON.parse((await readStdin()) || "{}") as HookInput;
    if (input.hook_event_name === "Stop" || input.hook_event_name === "SessionEnd") {
      if (!input.transcript_path) return 0;
      const modelRuntime = await createModelRuntime(agentDir);
      const model = resolveModel(modelRuntime, agentDir, process.env.MNEMO_MEMORY_MODEL);
      await ingestClaudeCode({ memory, home, userSkillsDir: skillsDir(home), reflect: modelReflector(modelRuntime, model), files: [input.transcript_path] });
      return 0;
    }
    const text = await contextHook(input, { memory, userSkillsDir: skillsDir(home) });
    if (text) out.write(`${text}\n`);
  } catch (error) {
    err.write(`mnemo memory hook: ${redact(error instanceof Error ? error.message : String(error))}\n`);
  } finally {
    memory.stop();
  }
  return 0;
}
