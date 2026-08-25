# Pi Agent — Technical Research Report

Repo: https://github.com/earendil-works/pi · Site: https://pi.dev · Docs: https://pi.dev/docs/latest
License MIT. Monorepo of TypeScript packages (npm scope `@earendil-works/*`), standalone binaries built with Bun.

---

## 1. What pi is

Pi ("Pi Agent Harness") is a minimal, extensible terminal coding agent and the agent runtime it is
built on. Its stated philosophy: "Adapt pi to your workflows... without having to fork and modify pi
internals." It ships powerful defaults (read/write/edit/bash tools) but deliberately omits features
like subagents and plan mode — instead you add them as TypeScript **extensions**, **skills**, **prompt
templates**, **themes**, or shareable **pi packages** (npm/git). The README headline calls it "our self
extensible coding agent" — the agent can build new extensions for itself at runtime (`> pi can create
extensions. Ask it to build one for your use case.` opens the Extensions doc).

Pi runs in four modes: interactive TUI, print/JSON (one-shot), RPC (JSONL over stdio for process
integration), and an SDK for embedding in your own apps.

### Packages (monorepo layout)

| Path | Package | Purpose |
|---|---|---|
| `packages/ai` | `@earendil-works/pi-ai` | Unified multi-provider LLM API (OpenAI, Anthropic, Google, Bedrock, Mistral, Groq, xAI, OpenRouter, llama.cpp, OAuth subscriptions, …). Model catalog, streaming, message types (`UserMessage`, `AssistantMessage`, `ToolResultMessage`, `Tool`, `Model`, `Usage`). |
| `packages/agent` | `@earendil-works/pi-agent-core` | Stateful agent runtime: `Agent` class, `agentLoop()`, tool execution, event streams, `AgentMessage` union. Also contains `src/harness/` (AgentHarness implementation + spec doc) and reference tools (read/write/edit/bash). |
| `packages/coding-agent` | `@earendil-works/pi-coding-agent` | The `pi` CLI: TUI, sessions, compaction, extensions loader/runner, skills, prompt templates, settings, RPC mode, SDK (`src/core/sdk.ts`). |
| `packages/tui` | `@earendil-works/pi-tui` | Terminal UI library with differential rendering (used by extensions for custom UI). |
| `packages/telemetry` | `@earendil-works/pi-telemetry` | Vendor-neutral telemetry contracts + typed schemas. |
| others | `client`, `server`, `protocol`, `session-backends` (e.g. SQLite backend in `@earendil-works/pi-session-backend-sqlite-node`), `evals` | Remote/client protocol, evals, alternate session stores. |

Related: `earendil-works/pi-chat` (Slack/chat automation).

Key source dirs:
- `packages/agent/src/`: `agent.ts` (Agent class), `agent-loop.ts` (low-level loop), `types.ts` (AgentTool, events), `stream-fn.ts`, `proxy.ts`
- `packages/agent/src/harness/`: `agent-harness.ts`, `session/` (jsonl/memory/sqlite storage, tree), `tools/` (bash/read/write/edit), `compaction/`, `skills.ts`, `system-prompt.ts`, `events.ts`
- `packages/coding-agent/src/core/`: `sdk.ts`, `agent-session.ts`, `agent-session-runtime.ts`, `extensions/{loader,runner,types,wrapper}.ts`, `session-manager.ts`, `skills.ts`, `prompt-templates.ts`, `package-manager.ts`, `model-runtime.ts`, `tools/` (built-in coding tools incl. grep/find/ls)
- `packages/coding-agent/examples/extensions/`: ~80 working examples (`dynamic-tools.ts`, `subagent/`, `plan-mode/`, `git-checkpoint.ts`, `permission-gate.ts`, `custom-compaction.ts`, `doom-overlay/`, …)

---

## 2. Core abstractions (pi-agent-core)

### 2.1 Agent

```typescript
const agent = new Agent({
  initialState: {
    systemPrompt: "You are a helpful assistant.",
    model,                       // Model<any> from pi-ai
    thinkingLevel: "medium",     // "off|minimal|low|medium|high|xhigh|max"
    tools: [readFileTool],       // AgentTool[]
    messages: [],                // AgentMessage[]
  },
  streamFn: models.streamSimple.bind(models),   // required StreamFn
  convertToLlm: (messages) => messages.filter(...), // AgentMessage[] -> LLM Message[]
  transformContext: async (messages, signal) => pruneOldMessages(messages),
  toolExecution: "parallel",                   // or "sequential"
  beforeToolCall: async ({ toolCall, args, context }) => {
    if (toolCall.name === "bash") return { block: true, reason: "disabled", terminate: true };
  },
  afterToolCall: async ({ toolCall, result, isError, context }) => { /* override result fields */ },
  shouldStopAfterTurn: async ({ context }, signal) => false,
});
```

Agent state (`agent.state`, mutable):
```typescript
interface AgentState {
  systemPrompt: string;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool<any>[];      // can be reassigned at any time -> runtime tool swap
  messages: AgentMessage[];
  readonly isStreaming: boolean;
  readonly streamingMessage?: AgentMessage;
  readonly pendingToolCalls: ReadonlySet<string>;
}
```

Methods: `await agent.prompt(text | AgentMessage, images?)`, `await agent.continue()`,
`agent.steer(msg)` / `agent.followUp(msg)` (queue mid-run / post-run user messages,
`steeringMode`/`followUpMode`: `"one-at-a-time"` | `"all"`), `agent.abort()`,
`await agent.waitForIdle()`, `agent.subscribe(async (event, signal) => {...})` (returns unsubscribe),
`agent.reset()`.

### 2.2 Event model

`prompt()` emits: `agent_start → turn_start → message_start/update/end (user, then streamed
assistant) → [tool_execution_start → tool_execution_update* → tool_execution_end] → turn_end →
… → agent_end`. Events are plain discriminated unions defined in `types.ts`:

```typescript
export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
```

### 2.3 Tool

Exact interface from `packages/agent/src/types.ts`:

```typescript
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any>
    extends Tool<TParameters> {          // Tool from pi-ai: name, description, parameters (TypeBox)
  label: string;                          // human-readable UI label
  prepareArguments?: (args: unknown) => Static<TParameters>;   // legacy-arg shim before validation
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,   // stream partial results
  ) => Promise<AgentToolResult<TDetails>>;
  executionMode?: ToolExecutionMode;      // per-tool override of global parallel/sequential
}

export interface AgentToolResult<T> {
  content: (TextContent | ImageContent)[];
  details: T;
  usage?: Usage;
  addedToolNames?: string[];              // tools introduced by this result (deferred loading)
  terminate?: boolean;                    // hint to stop after this batch
}

export type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;
```

Tools **throw** on failure; the loop converts throws into `isError: true` tool results for the LLM.
Parameters are TypeBox schemas (`Type.Object({...})`).

### 2.4 Messages

`AgentMessage` union (extensible via declaration merging):

```typescript
type AgentMessage =
  | UserMessage            // { role:"user", content: string|(Text|Image)[], timestamp }
  | AssistantMessage       // { role:"assistant", content:(Text|Thinking|ToolCall)[], api, provider,
                           //   model, usage, stopReason:"stop|length|toolUse|error|aborted", timestamp }
  | ToolResultMessage      // { role:"toolResult", toolCallId, toolName, content, details?, usage?, isError, timestamp }
  | BashExecutionMessage   // coding-agent: { role:"bashExecution", command, output, exitCode, ... }
  | CustomMessage          // { role:"custom", customType, content, display, details? }  <- extension channel
  | BranchSummaryMessage
  | CompactionSummaryMessage;

declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages { notification: { role:"notification"; text:string; timestamp:number } }
}
```

Flow: `AgentMessage[] → transformContext() → convertToLlm() → LLM Message[]`. Only
user/assistant/toolResult go to the LLM; custom types are filtered/mapped in `convertToLlm`.

### 2.5 Low-level loop

```typescript
import { agentLoop, agentLoopContinue } from "@earendil-works/pi-agent-core";
for await (const event of agentLoop([userMessage], context /*AgentContext*/, config /*AgentLoopConfig*/, undefined, streamFn)) { ... }
for await (const event of agentLoopContinue(context, config, undefined, streamFn)) { ... }
// AgentContext = { systemPrompt, messages, tools? }
```

### 2.6 Sessions

Sessions are **JSONL files forming a tree**: `~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl`.
First line is a `SessionHeader` (`{"type":"session","version":3,"id":uuid,"cwd":...}`); each entry has
`SessionEntryBase { type, id (8-hex), parentId|null, timestamp }`. Entry types include `message`,
`model_change`, `thinking_level_change`, `compaction` (with `retainedTail`), `branch_summary`,
custom entries, etc. Because entries link by `id/parentId`, branching (`/tree`, `/fork`, `/clone`)
happens in-place inside one file; versions auto-migrate on load. Compaction summarizes old context;
steering/follow-up queues are persisted parts of the run model.

### 2.7 AgentHarness (next-gen runtime, `packages/agent/docs/harness.md` + `src/harness/`)

A 228 KB implementation spec for a crash-safe, multi-lane harness on top of the same primitives:

- Three stores: immutable **write-once entry log** (memory/JSONL/SQLite backends), **registers**
  (mutable named pointers into the log), and derived indexes.
- Conversation is a tree with **lanes** (named conversation threads, `"main"` default).
- An **operation state machine** (run / compaction / navigation) with a program counter, so a crash
  mid-tool resumes exactly ("suspended operations", recovery policy, controlled-crash `close()`).
- Public surface (Part 5): `AgentHarness.create(options)` → `{ harness, suspended }`;
  `lane(name)`, `createLane(name, at)`, `lanes()`;
  `getTools()/setTools(t)` (registry is harness-global; active names live per lane);
  `getResources()/setResources()` (skills, prompt templates); retry/compaction/stream options;
  `watchSession()` snapshot+events; `hooks`; `close()`.
- Options include `tools`, `toolContext` (per-lane typed context), `entryProjectors`
  (`(entry: CustomEntry) => AgentMessage[]` — turns persisted custom entries back into context on restore),
  `toProviderMessages`, `drive: "automatic"|"manual"`.

This is where pi is heading: durable, resumable, multi-lane agent state with pluggable tools/resources.

---

## 3. Building a coding agent ON TOP of pi

### 3.1 SDK embedding (`packages/coding-agent/docs/sdk.md`)

```typescript
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create();
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  modelRuntime,
  tools: ["read", "bash"],          // subset of built-ins
});

session.subscribe((event) => { /* AgentSessionEvent stream */ });
await session.prompt("What files are in the current directory?");
```

`AgentSession` surface: `prompt(text, options?)`, `steer(text)`, `followUp(text)`, `subscribe(listener)`,
`sessionFile/sessionId`, `setModel/setThinkingLevel/cycleModel`, `agent` (the core Agent),
`messages`, `navigateTree(targetId, options?)`, `compact(customInstructions?)`, `abort()`, `dispose()`.
For session replacement there is `createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager })`
→ `runtime.newSession()/switchSession()/fork()/importFromJsonl()`, plus lower-level
`createAgentSessionServices({cwd})` / `createAgentSessionFromServices(...)`.

13 graded examples live in `examples/sdk/01-minimal.ts` … `12-full-control.ts`, `13-session-runtime.ts`.

### 3.2 Built-in coding tools

Default four: `read`, `write`, `edit`, `bash` (Windows adds `powershell`; more in
`packages/coding-agent/src/core/tools/`: `grep`, `find`, `ls`). Tools are just `AgentTool`s, so an
embedding app can pass its own list via `createAgentSession({ tools })` or swap `agent.state.tools`.

### 3.3 Extension/plugin system (`docs/extensions.md`) — the main plugin point

An extension is a TypeScript module (loaded via **jiti**, no compile step) exporting a default factory
receiving `ExtensionAPI` (`pi`):

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
      const ok = await ctx.ui.confirm("Dangerous!", "Allow rm -rf?");
      if (!ok) return { block: true, reason: "Blocked by user" };
    }
  });

  pi.registerTool({
    name: "greet",
    label: "Greet",
    description: "Greet someone by name",
    parameters: Type.Object({ name: Type.String() }),
    promptSnippet: "...",                    // optional line in system prompt "Available tools"
    promptGuidelines: ["Use greet when..."], // optional bullets appended to Guidelines
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return { content: [{ type: "text", text: `Hello, ${params.name}!` }], details: {} };
    },
    // optional renderCall/renderResult for TUI rendering
  });

  pi.registerCommand("hello", { description: "Say hello",
    handler: async (args, ctx) => ctx.ui.notify(`Hello ${args || "world"}!`, "info") });
}
```

Discovery: `~/.pi/agent/extensions/*.ts` (global) or `.pi/extensions/*.ts` (project-local, gated by
project trust), directory form `<dir>/index.ts`, or declared via `settings.json`
(`"packages": ["npm:@foo/bar@1.0.0", "git:github.com/user/repo@v1"], "extensions": [...]`) or CLI
`pi -e ./path.ts`. `/reload` hot-reloads them. npm/git-distributed plugins are "pi packages"
(`pi install`, manifest key `"pi": { "extensions": [...] }`).

**ExtensionAPI methods** (from docs): `pi.on(event, handler)`, `pi.registerTool(def)`,
`pi.registerCommand(name, {description, getArgumentCompletions?, handler})`,
`pi.registerShortcut(key, opts)`, `pi.registerFlag(name, opts)` (+`pi.getFlag`),
`pi.registerProvider(name, providerDef)` (async factory can fetch a model catalog at startup),
`pi.sendMessage(message, {deliverAs: "steer"|"followUp"|"nextTurn", triggerTurn})`,
`pi.sendUserMessage(content, options?)`, `pi.appendEntry(customType, data?)` (persisted, not LLM-visible)
with `pi.registerEntryRenderer(...)`, `pi.registerMessageRenderer(customType, renderer)`,
`pi.registerMarkdownTransformer(fn)`, `pi.exec(cmd, args, opts?)`,
`pi.getActiveTools()/getAllTools()/setActiveTools(names)`, `pi.getCommands()`,
`pi.setSessionName/getSessionName`, `pi.setLabel(entryId, label)`.

**Events** (interceptable, many support return values that block/transform):
startup: `project_trust`, `session_start`, `resources_discover`, `session_shutdown`,
`session_before_switch/fork/tree/compact`; per-prompt: `input`, `before_agent_start` (modify system
prompt/inject message); per-turn: `context` (modify messages), `before_provider_headers`,
`before_provider_request` (replace payload), `after_provider_response`; per-tool:
`tool_call` (can block), `tool_result` (can modify), plus `turn_start/end`, `agent_end`, `agent_settled`,
`model_select`, `thinking_level_select`, `session_info_changed`, `session_compact(_failed)`.

**ExtensionContext** gives handlers `ctx.ui` (select/confirm/input/editor/notify/setStatus/setWidget/
custom components), `ctx.sessionManager` (entries, labels), cwd, hasUI, etc.

---

## 4. Where a "dynamic harness/plugin system" plugs in

Pi is explicitly designed so agents can extend themselves at runtime. Concrete mechanisms found:

1. **`pi.registerTool()` works after startup.** Docs: "You can call it inside `session_start`, command
   handlers, or other event handlers. New tools are refreshed immediately in the same session… callable
   by the LLM without `/reload`." So an extension (or an LLM-invoked tool implemented by an extension)
   can mint brand-new tools mid-session. `pi.setActiveTools(names)` enables/disables any registered
   tool at runtime, including freshly added ones.

2. **Dynamic Tool Loading** (`docs/extensions.md` §Dynamic Tool Loading, example
   `examples/extensions/dynamic-tools.ts`): register many tools but keep few active; a *loader tool*
   (e.g. `search_tools`) executes keyword/BM25/embedding search over `pi.getAllTools()` and calls
   `pi.setActiveTools([...active, ...matches])` from inside its `execute()`. Pi detects purely additive
   changes, records `addedToolNames` on the tool result, and exposes new definitions before the next
   model request — using native deferred loading when available (Anthropic `defer_loading` +
   `tool_reference` for Sonnet/Opus/Fable ≥4.5; OpenAI `tool_search_call/tool_search_output` for
   gpt‑5.4+; opt-in flags `compat.supportsToolReferences` / `compat.supportsToolSearch`) and a plain
   full-tool-list fallback otherwise. This is effectively a built-in pattern for "the agent creates /
   loads tools on demand."

3. **The agent writes its own extensions.** Both README and docs say: ask pi to build an extension for
   your use case; drop the generated `.ts` file in `.pi/extensions/` or `~/.pi/agent/extensions/` and
   `/reload` (or let `file watchers`/`reload-runtime.ts` style examples handle it). Combined with
   jiti no-compile loading, this makes runtime self-extension a first-class workflow.

4. **Other runtime mutation hooks**: `pi.registerProvider()` (add providers/models at runtime,
   including from async factories), `pi.on("context")` / `transformContext` / `shouldStopAfterTurn`
   (rewrite context every turn), custom compaction via `session_before_compact`, `before_provider_request`
   payload replacement, `pi.appendEntry` + `entryProjectors` for durable state that rehydrates into
   future contexts, and the harness-level `setTools()` registry swap.

5. **Composed agents**: `examples/extensions/subagent/` builds a planner/scout/worker/reviewer multi-agent
   system out of extension-registered tools spawning nested pi runs — proof that higher harnesses
   (like our own dynamic-harness ideas) sit cleanly on the extension layer.

Practical answer to "can an agent create new tools at runtime?": **yes** — either (a) an extension
calls `pi.registerTool()` in response to any event/tool call, (b) a loader tool activates pre-registered
tools lazily via `pi.setActiveTools()` (cache-friendly deferred loading), or (c) the agent authors a new
extension source file and triggers `/reload`.

---

## 5. Links visited

- https://github.com/earendil-works/pi (README, fetched raw at raw.githubusercontent.com/.../main/README.md)
- GitHub git-tree API listing of all 1,566 paths (full repo layout)
- Raw files: `packages/agent/README.md`, `packages/agent/src/types.ts`, `packages/agent/src/agent.ts`,
  `packages/agent/src/agent-loop.ts`, `packages/agent/docs/harness.md`,
  `packages/coding-agent/README.md`, `packages/coding-agent/docs/{index,extensions,sdk,session-format}.md`
- https://pi.dev/docs/latest (browsed via cmux browser; docs nav mirrors repo docs:
  Quickstart, Providers, Security, Settings, Sessions, Compaction, Extensions, Skills,
  Prompt Templates, Themes, Pi Packages, Custom Models/Providers, Session Format, …)
- Referenced from docs (not separately crawled): `examples/extensions/*.ts`,
  `examples/sdk/01..13`, `docs/packages.md`, `docs/skills.md`, `docs/custom-provider.md`

---

## 6. Takeaways for building our own dynamic harness

- Minimal kernel: `StreamFn` + `agentLoop(prompts, context, config, streamFn)` — the whole loop is
  ~one generator; everything else (Agent, sessions, UI) layers on top.
- Tools are data (`AgentTool` objects with TypeBox schemas), so tool registries are trivially
  serializable/filterable — the enabler of lazy/dynamic tool loading.
- Two-layer extensibility works well: a low-level runtime (pi-agent-core) with pure functions, and a
  host process (pi CLI) exposing a rich `ExtensionAPI` with events, blocking hooks, and registration.
- Deferred tool loading with `addedToolNames` recorded in the transcript keeps provider prompt caches
  warm while still letting the model pull in capabilities mid-task — directly relevant to a
  self-evolving agent design.
