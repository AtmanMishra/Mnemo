---
name: pi-agent-sdk
description: Use @earendil-works/pi-ai (pi-agent LLM layer) programmatically in a TypeScript/Next.js web app — openai-responses streaming, agent loop, tool registry, MCP bridging, OCI compat. Use when wiring pi-agent into a route handler, building the stream → tools → repeat loop, declaring tools, handling reasoning effort, or debugging pi/OCI payload mismatches.
---

# pi-agent — programmatic usage in Next.js/TypeScript

Sources: this repo's `pi-brain.js`/`agent/route.js` (verified file:line), local `node_modules/@earendil-works/pi-ai` typings + dist source, pi.dev/docs (sdk/rpc/json). Full research: `docs/research/pi-agent-sdk.md`. Version pinned here: **0.74.2** (npm `legacy-node20` tag; latest 0.84.x restructured internals — verify against the pinned version, docs may reference symbols that don't exist in it).

## Two layers, don't confuse them

| Layer | Package | Use in web apps |
|---|---|---|
| LLM/stream layer | `@earendil-works/pi-ai` | **THE one this repo uses.** Multi-provider client: `stream`/`complete`, tool-call streaming, costs. |
| Agent layer | `@earendil-works/pi-coding-agent` (pi.dev/docs/sdk) | Full coding agent (`createAgentSession`, subprocess RPC/JSON modes). In-process `AgentSession` for Node/TS, not the RPC subprocess. |

## Core import & API

```ts
import { streamOpenAIResponses } from '@earendil-works/pi-ai/openai-responses'; // repo's import
// or generic: import { getModel, stream, complete, streamSimple, completeSimple, Type, StringEnum } from '@earendil-works/pi-ai';
```

- `stream(model, context, options?)` → `AssistantMessageEventStream`: async-iterable of normalized events + `result(): Promise<AssistantMessage>`.
- `complete(...)` → `Promise<AssistantMessage>` (non-stream). `streamSimple`/`completeSimple` clamp thinking level + add thinking budget to maxTokens.
- `result()` **never rejects** on HTTP/model errors — check `stopReason === 'error' | 'aborted'` + `errorMessage`. Throws only on client construction (missing API key) etc.
- Key types: `Model {id,name,api,provider,baseUrl,reasoning,contextWindow,maxTokens,cost,...}` · `Context {systemPrompt?, messages, tools}` (JSON-serializable) · `Tool<T> {name,description,parameters}` TypeBox schema · `AssistantMessage {role:'assistant',content:(Text|Thinking|ToolCall)[],stopReason:'stop'|'length'|'toolUse'|'error'|'aborted',usage,cost,...}` · `ToolResultMessage {role:'toolResult',toolCallId,toolName,content,isError}`.

### Stream events (openai-responses provider)

`start` · `text_start/text_delta/text_end` (key on `contentIndex` — blocks interleave!) · `thinking_start/delta/end` (`thinkingSignature` = JSON of upstream reasoning item, replayed on continuation) · `toolcall_start/delta/end` (`toolcall_delta.arguments` = best-effort partial JSON; `toolcall_end.toolCall` fully parsed) · `done` (reason, message w/ usage/cost) · `error`/`aborted`.
Usage accounting: input = input_tokens − cached_tokens; cacheRead = cached_tokens. If any toolCall exists and status maps to stop → stopReason forced `toolUse`.

## Agent loop (stream → tools → repeat) — runAgent in pi-brain.js

There is **no `agentLoop` export** in 0.74.2 (README-only mention). Manual loop (exactly `pi-brain.js:180-275`):

1. `context = { systemPrompt, messages }` (or `[{role:'user',content:userMessage}]`).
2. Per step: `s = stream(model, context, opts)`; forward `thinking_delta`/`text_delta` to UI; `final = await s.result()`.
3. `stopReason==='error'` → emit error + throw. Push `final` to messages.
4. `calls = final.content.filter(b => b.type==='toolCall')`; none → done.
5. For each call: `args = validateToolCall(tools, call)` (throws on schema mismatch; catch → error toolResult so model retries); `output = execTool(call.name, args)` (catch → `ERROR: ...`); push `{role:'toolResult', toolCallId: call.id, toolName, content:[{type:'text',text: output.slice(0, MAX)}], isError}`.
6. Repeat ≤ maxSteps (repo: default 8, route passes 10). Cap exhausted without text → one tool-less wrap-up call (`tools: []`) so user never gets silent empty answer.

Parallel tools: independent (non-gated) calls via `Promise.all`; approval-gated serial.

## Tool registry

```ts
const tool: Tool = { name:'get_weather', description:'...',
  parameters: Type.Object({ location: Type.String(), units: StringEnum(['celsius','fahrenheit']) }) };
```
- No SDK-side executor — declare to model, execute in your code (`execTool(name, args) => Promise<string>` convention).
- Avoid `Type.Enum` (Google compat) — use `StringEnum`.
- Tool results support text + base64 images as content blocks.

## MCP: pi-ai has NO MCP client (0.74.2 or pi-coding-agent) — bridge it app-side

Repo reference (`pi-tools.js:440-487`): one pi `Tool` per discovered MCP tool — `name = sanitizeName(tool.name)` (non-alnum → `_`, ≤60 chars, letter-first else `mcp_` prefix, collisions `_2`), `parameters = sanitizeSchema(tool.inputSchema)` (strip `$schema`, force `type:'object'`/`properties:{}` — MCP schemas can be `$ref`-heavy), executor → `callMcpTool({endpoint, authType, authKey, toolName, args, timeoutMs})` → `mcpResultToModelText`. Approval-gated tools block on HITL gate; denial fed back as `ERROR:` tool result. Server-side: connect servers per session, pass `mcpServers` + tool guidance into system prompt.

## Options (OpenAIResponsesOptions)

`apiKey` (wins) · `signal` (AbortSignal — pass `request.signal`) · `temperature` · `maxTokens` · `timeoutMs` (**default 10 min — set ~60000 for chat**) · `maxRetries` (**default 2 — set 1**) · `cacheRetention` ('none'|'short'|'long', default short) · `sessionId` (prompt-cache key) · `reasoningEffort` ('minimal'|'low'|'medium'|'high'|'xhigh') · `reasoningSummary` · `onPayload(payload, model)` — **THE compat hook** · `onResponse` · `headers`.
Default: pi sends `reasoning:{effort:'none'}` for reasoning models unless you pass effort; `store:false` hardcoded; systemPrompt serialized as `developer` (reasoning) or `system` input item.

## OCI compat (must-have onPayload hook — pi-brain.js ociCompatPayload)

1. `reasoning.effort 'none'` → `'low'` (OCI rejects 'none'; valid: minimal|low|medium|high|xhigh).
2. system/developer input items → top-level `instructions` (OCI gemini/Vertex passthrough rejects both roles as input). Real OpenAI keeps developer item — OCI-only fix.
3. Strip echoed `reasoning*` parts/items on continuation turns (OCI rejects as input; OpenAI needs them).
4. Delete `function_call.id`, keep `call_id` only (OCI 400 "did not match any variant of untagged enum ResponseInput").
5. OCI Conversations: `conversation` + `store:true` (override pi's false); delete `previous_response_id` (can't combine).
6. JSON output: `text_format = {type:'json_schema', name:'response', schema:{type:'object'}}`.

Model object: `{id, name, api:'openai-responses', provider:'oci', baseUrl: 'https://inference.generativeai.<region>.oci.oraclecloud.com/openai/v1', reasoning: modelSupportsReasoning(id), input:['text'], contextWindow:128000, maxTokens:8192}`.
Reasoning-capable families: gpt-oss, grok-4, grok-3-mini, o3, o4, gpt-5, command-a-reasoning. **ALL google.gemini-2.5\* reject reasoning blocks (400)**. Headers: `openai-project` (required for gemini), `opc-compartment-id`.

## Next.js route-handler pattern (repo)

- Return `ReadableStream`; write **newline-delimited JSON** via `send(obj)` closure (not SSE framing): first frame `{thinking:true}`, then thinking/text deltas, tool events, `mcp_approval_request` (client answers via `/api/agent/approve`), final `{done:true}` or `{error, done:true}` (error + done on the SAME frame — client throws otherwise).
- Abort: pass `request.signal` into options; on disconnect result() returns `stopReason:'aborted'` (no throw).
- Tool-result cap `AGENT_TOOL_RESULT_MAX_CHARS` (24k) before model reads.
- OCI Conversations retry: stale conversation id error → retry once with client-side history (no conversation field) (`route.js:325-335`).

## Gotchas (repo-verified)

`agentLoop` doesn't exist (write manual loop) · `result()` never rejects — check stopReason · pi hardcodes `store:false` · OCI needs `instructions` hoist · strip reasoning on OCI replay · delete `function_call.id` for OCI · toolCall ids are compound `call_id|item_id` (split on `|` when round-tripping) · SDK timeout/retry defaults are a latency trap · IPv6 Happy-Eyeballs deadlock on Docker bridge → import `lib/network-compat` (ipv4first) in EVERY outbound module · version drift: 0.84.x restructures internals (verify symbols against pinned 0.74.2) · events interleave — key on `contentIndex`; partial args may be truncated.

## Official reference

pi.dev/docs/latest/sdk (pi-coding-agent layer: `createAgentSession`, `defineTool`, `subscribe`, compaction, RPC/JSON modes) — full map in `docs/research/pi-agent-sdk.md`.
