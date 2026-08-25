# sea-agent × pi InteractiveMode TUI Adoption Report

Date: 2026-02-14. Sources: local `@earendil-works/pi-coding-agent/dist/*` (.d.ts/.js actually read),
`agent/src/cli.ts`, `bin/sea.ts`, `extensions/memory-layer.ts`, `research/pi-agent-report.md`,
plus public docs fetched over HTTP (claude-code README + code.claude.com cli-reference/interactive-mode,
openai/codex README+docs+features.md, google-gemini/gemini-cli README, opencode.ai/docs).

---

## 1. Recommendation

**Option A: wrap pi's `main(args, { extensionFactories })` directly.** Evidence:

1. `main` and `MainOptions` are exported from the package root:
   `index.d.ts` → `export { type MainOptions, main } from "./main.ts"`.
2. `main.js` line ~437 merges our factories into the built-ins and threads them into every
   session creation path:
   ```js
   const extensionFactories = [...builtInExtensions, ...(options?.extensionFactories ?? [])];
   ...
   resourceLoaderOptions: { ..., extensionFactories }
   ```
   So inline extensions run identically in interactive, print, JSON, and RPC modes, across
   `/reload`, forks, and session switches.
3. `InlineExtension` (`core/extensions/types.d.ts`) is `(pi: ExtensionAPI) => void | Promise<void>`
   or `{ name, factory, hidden? }`. `ExtensionAPI.registerTool(ToolDefinition)` is exactly how
   extensions inject LLM-callable tools into interactive mode; the TUI renders them via
   `ToolExecutionComponent` automatically.
4. We get the entire TUI for free: streaming markdown (`AssistantMessageComponent`),
   diff rendering (`renderDiff`/`diff.js`), bash execution blocks, thinking blocks +
   `ThinkingSelectorComponent` (Ctrl+T cycle, hideable), compaction summaries, footer with
   context-usage %, model/thinking/session/settings selectors, `/tree` fork navigation,
   `/share`, HTML export, autocomplete, keybindings, external editor, themes.

**Option B (SDK `createAgentSession` + à-la-carte `pi-tui` components) is not recommended now.**
`createAgentSession` gives a headless session; nothing wires `InteractiveMode` for you — it needs
an `AgentSessionRuntime`/`createAgentSessionServices()` composition root, theme init, TUI lifecycle,
and per-component glue (autocomplete, selectors, event→component mapping). That is weeks of work to
rebuild what `main()` already composes. Choose B only if we later need a radically custom UI.

### Blockers / caveats for Option A (none fatal)

| Concern | Detail | Mitigation |
|---|---|---|
| Duplicate tools | pi enables built-in read/write/edit/bash/grep/find/ls by default; our `src/tools/*` duplicates most of them | Pass `--no-builtin-tools` (or `--tools <names>`) from our wrapper; keep only genuinely-sea tools (ipy_run, spawn_subagent, skills trio, harness) plus memory extension |
| Approval gate | pi has **no** built-in permission prompts (trust-model philosophy; `permission-gate` exists only as an example extension) | Port `src/approval.ts` to an inline extension: `pi.on("tool_call", async (ev, ctx) => gated ? { block: !(await ctx.ui.confirm(title, summary)) } : {})`. `ctx.ui.confirm` renders a native TUI dialog; works in interactive mode, auto-fails-open in print/RPC |
| Memory directive hack | `cli.ts` mutates `session.agent.state.systemPrompt` before each call | Replace with `pi.on("before_agent_start")` returning `{ systemPrompt: ev.systemPrompt + MEMORY_DIRECTIVE }` — officially chained per turn |
| `SEA_MEMORY_JOURNAL` / `SEA_MEMSRV_BIN` | Read inside `MemClient` constructor; extension runs in-process | Unaffected. Just don't strip env in the wrapper |
| Provider/key selection | pi uses its own auth.json/models.json/env-key resolution, plus first-time setup & project-trust prompts | Wrapper computes provider/model with existing `pickProvider()`, passes `["--provider", p, "--model", m]`; optionally pre-seed settings to skip first-run UI |
| One-shot + JSONL export | pi print mode covers `sea "<prompt>"` (non-TTY autodetect) and has native `--export` (HTML) | Keep a tiny JSONL-export wrapper only if the old format is load-bearing |

---

## 2. Feature parity table

| Feature | pi provides | Claude Code | Codex CLI | Gemini CLI | OpenCode | How we get it |
|---|---|---|---|---|---|---|
| Streaming markdown output | ✅ AssistantMessageComponent | ✅ | ✅ | ✅ | ✅ | Free via Option A |
| Diff blocks for edits | ✅ renderDiff/DynamicBorder | ✅ | ✅ | ✅ | ✅ | Free |
| Thinking blocks + level control | ✅ ThinkingSelector, cycle off…max, Ctrl+T | ✅ (+`--effort`) | ✅ reasoning effort | ✅ | ✅ | Free |
| Tool execution rendering | ✅ ToolExecutionComponent, expandable output | ✅ | ✅ | ✅ | ✅ | Free |
| Bash execution block | ✅ BashExecutionComponent | ✅ | ✅ | ✅ | ✅ | Free |
| Slash commands | ✅ built-in + `registerCommand` | ✅ rich set | ✅ `/permissions` etc. | ✅ | ✅ commands dir | Free + our own commands |
| Context/compaction indicator | ✅ footer context %, `/compact`, auto-compaction queue | ✅ /context,/compact | ✅ | ✅ /compress | ✅ | Free |
| Session resume/continue | ✅ `--resume --continue --fork --session-id --session-dir`, session selector | ✅ same flags | ✅ `codex resume` | ✅ checkpointing | ✅ | Free |
| Fork/tree navigation | ✅ `/tree` TreeSelectorComponent (branch at any entry, labels, filters) | ⚠️ /rewind | ⚠️ limited | ⚠️ checkpoint restore | ⚠️ | Free (best-in-class here) |
| Session share/export | ✅ `/share`, `--export` HTML, copy-to-clipboard | ✅ | ⚠️ cloud links | ❌ | ✅ opencode.ai/s | Free |
| Tool permission prompts | ❌ (example extension only) | ✅ permission modes/prompt-tool | ✅ sandbox+/permissions | ✅ approval modes | ✅ allow/ask/deny rules | Build: 30-line inline extension (§3) |
| Subagents + navigation | ❌ deliberately omitted (example extension exists) | ✅ agents/Task, `--agents` | ✅ subagents | ⚠️ limited | ✅ @general, build/plan Tab | Later gap (§5) |
| Plan mode | ❌ (extension) | ⚠️ plan mode | ⚠️ | ⚠️ | ✅ built-in Tab switch | Later gap |
| Traces/logs viewer | ⚠️ logs dir written; no viewer | ✅ /traces-ish, verbose | ✅ transcript log | ⚠️ | ⚠️ | Later gap |
| RPC/headless embed | ✅ `--mode rpc`, `RpcClient` typed client, json/print modes | ✅ `--output-format` stream-json | ✅ `codex exec` | ✅ non-interactive | ✅ server/SDK | Free |
| Skills/prompt templates/themes | ✅ native | ✅ skills/plugins | ✅ skills/plugins | ⚠️ GEMINI.md only | ✅ skills/commands | Free |
| MCP support | ⚠️ via packages/extensions | ✅ | ✅ | ✅ | ✅ | Later gap if needed |

## 3. Integration sketch (Option A)

New `bin/sea.ts` (or `src/tui-main.ts`) outline:

```ts
import { main } from "@earendil-works/pi-coding-agent";
import seaToolsExtension    from "../extensions/sea-tools.ts";     // wraps src/tools/*
import memoryLayerExtension from "../extensions/memory-layer.ts";  // unchanged module
import approvalExtension    from "../extensions/approval-gate.ts"; // ported src/approval.ts

// 1. compute provider/model with existing pickProvider()
const sel = pickProvider();
const argv = process.argv.slice(2);
if (sel && !argv.some(a => a.startsWith("--provider") || a.startsWith("--model"))) {
  argv.push("--provider", sel.provider);
  if (sel.modelId) argv.push("--model", sel.modelId);
}
argv.push("--no-builtin-tools");          // dedupe vs pi read/write/edit/bash
// keep legacy sea flags translated: --list-sessions handled before this point;
// one-shot works because non-TTY stdin/stdout drops into pi print mode automatically.

await main(argv, {
  extensionFactories: [
    { name: "sea-tools",   factory: seaToolsExtension },
    { name: "sea-memory",  factory: memoryLayerExtension },
    { name: "sea-approval",factory: approvalExtension },
  ],
});
```

`extensions/sea-tools.ts` pattern:

```ts
import { ipyRunTool, listSkillsTool, loadSkillTool, createSkillTool,
         subagentSpawnTool } from "../src/tools/index.ts";
export default function seaTools(pi) {
  for (const t of [ipyRunTool, listSkillsTool, loadSkillTool, createSkillTool, subagentSpawnTool])
    pi.registerTool(t);            // ToolDefinition shape matches SeaTool closely;
                                  // adapt execute() return to AgentToolResult if needed
}
```

`extensions/approval-gate.ts`:

```ts
const GATED = new Set(["bash_exec", "write_file", "apply_edit"]);  // reuse old gate policy
export default function approval(pi) {
  pi.on("tool_call", async (ev, ctx) => {
    if (!GATED.has(ev.toolName) || !process.stdin.isTTY || process.env.SEA_APPROVAL_MODE !== "interactive")
      return;                                       // fail open like today
    const ok = await ctx.ui.confirm("Approve?", `${ev.toolName}: ${summarize(ev.input)}`);
    return ok ? {} : { block: true, reason: "user denied" };
  });
}
```

Memory directive moves into `memory-layer.ts` (additive):

```ts
pi.on("before_agent_start", async (ev) => ({ systemPrompt: ev.systemPrompt + MEMORY_DIRECTIVE }));
```

**What happens to existing code**

- `src/tools/index.ts` stays the source of truth; only the registration surface changes
  (SeaTool → ToolDefinition adapter, likely near-zero since both use typebox schemas).
- `src/cli.ts` REPL loop, `printAssistantText`, `assertMemoryDirective`, manual ext-host shim → deleted.
- `src/approval.ts` readline gate → superseded by approval-gate extension (keep tests by keeping the
  pure decision function shared).
- `bin/sea.ts` flag parsing shrinks: `--list-sessions` kept locally; `--import/--export` either map to
  pi's native session store (`--session-dir ~/.sea/sessions` makes old sessions visible in the
  selector) or stay as thin pre/post steps.
- `SessionManager.inMemory` disappears — sessions persist as pi JSONL under `--session-dir`,
  enabling `--resume/--continue/--fork` for free.

**Migration steps**

1. Write `extensions/sea-tools.ts` adapter; unit-test that all sea tools register through a fake `pi`.
2. Write `extensions/approval-gate.ts`; port gate policy; keep `SEA_APPROVAL_MODE` semantics.
3. Add `before_agent_start` hook to `memory-layer.ts`; delete directive hack from `cli.ts`.
4. Rewrite `bin/sea.ts` as above; translate legacy flags; decide session-dir layout.
5. E2E: interactive boot, one-shot piped prompt, approval y/n/a flow, memory roundtrip,
   `--resume`, `/compact`, `/tree`, `/share`.
6. Delete `src/cli.ts` REPL path once parity confirmed.

## 4. Gaps: things competitors have that pi lacks (build-later list)

1. **Subagent task tree/navigation UI** — Claude Code (agents + `--forward-subagent-text`), Codex
   (subagents with findings returned to terminal), OpenCode (`@general`). pi's `/tree` navigates the
   *session fork* tree, not subagent runs. We already spawn subagents via `spawn_subagent`; a widget +
   selector showing child status/results would close this (use `ctx.ui.setWidget` + `ctx.ui.custom`).
2. **Permission rule engine** — OpenCode's allow/ask/deny wildcard config and Codex `/permissions`
   sandbox view are richer than a y/n/a gate. Phase 2: per-tool/per-path rules persisted in settings.
3. **Plan mode** — OpenCode's Tab-switchable read-only plan agent. Doable as an extension
   (`registerCommand("plan")` swapping toolsets), like pi's own example.
4. **Trace/log viewer** — Claude Code verbose/transcript views. pi writes logs to `logDirectory`;
   a `/logs` command opening a scrollable component would suffice.
5. **MCP-first extensibility** — Gemini/OpenCode/Codex treat MCP as core config. pi expects TS
   extensions/packages; add an MCP bridge package if users ask.
6. **Cloud/web handoff & share-by-default** — Codex cloud, OpenCode share hub. pi `/share` exists but
   no hosted surface; low priority for us.
