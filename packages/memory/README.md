# @mnemo/memory

Mnemo's memory, detachable. One journal (the Rust `memsrv` sidecar), any
number of coding agents: what one agent learns, every other agent — and Mnemo
itself — recalls.

What it keeps, per project (git remote, so every clone shares it) and per user:

- **profiles** — conventions, commands, decisions, preferences; one current
  value per key, older values kept as history
- **session records** — goal, outcome, what was done, what is left open
- **pitfalls with their fixes** — a failure, counted across sessions, and what
  resolved it
- **skills** — procedures, as `SKILL.md` files in `.agents/skills/`
- **provenance** — which agent and model taught each of these

## Attach it to an agent

| agent | how | what it gets |
|---|---|---|
| Mnemo | built in (`app/src/extensions/memory.ts`) | everything, live |
| Claude Code | hooks + MCP: `mnemo memory setup claude-code` prints both | profiles at session start, recall per prompt, learning after each run (async `Stop` hook), and the three tools |
| Claude Code (past sessions) | `mnemo memory ingest --model <provider/id>` | learns from every saved session in `~/.claude/projects`, once each |
| Codex, Cursor, opencode … | MCP: `mnemo memory setup codex` prints the entry | `memory_recall`, `memory_search`, `memory_remember` |

Learning needs one model call per run (reflection). Any pi model works and a
cheap one is enough: `--model`, else `$MNEMO_MEMORY_MODEL`, else Mnemo's
default model. Everything memory reads is redacted for credential shapes
before it reaches the reflection model or the journal.

## Drive it from code

```ts
import { MemoryService, MemorySession, findMemsrv, journalPath, mnemoHome } from "@mnemo/memory";

const home = mnemoHome();
const memory = new MemoryService(findMemsrv(home)!, journalPath(home));
const session = new MemorySession({
  memory,
  cwd: process.cwd(),
  userSkillsDir: `${home}/agent/skills`,
  source: { agent: "my-agent", model: "some-model" },
  reflect: async (system, user) => callYourModel(system, user), // text out, throw on failure
  notify: (note) => console.log(note),
});

const { system, message } = await session.recall(prompt); // system prompt block + per-message recall
session.toolStart("bash", { command: "pnpm test" });
await session.toolEnd("bash", { command: "pnpm test" }, false, "vitest: not found");
await session.end({ messages }); // credit, then one reflection call
await session.close();
```

`context(prompt)` answers the same question without starting a run, for a
caller that keeps no state between calls (a hook, an MCP request).

## Tests

```bash
cargo build --release --bin memsrv --manifest-path ../../memory-layer/Cargo.toml   # once
bun test ./test && bunx tsc --noEmit
```

The tests drive the real sidecar; without it they skip.
