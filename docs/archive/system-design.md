# Self-Evolving Coding Agent — System Design
Version 1.0 · Status: implemented through Phase 2 groundwork (see STATUS.md for live state)

## 1. Vision & thesis

**Thesis:** frontier-level coding performance does not require a frontier-size model.
A small model wrapped in the right *system* — persistent graph memory, accumulated
experience, dynamic self-built skills, and hierarchical collaboration — can match or
exceed much larger models on real, repeated engineering work, because:

1. **Memory substitutes for parameters.** Facts a big model memorizes at training time
   live instead in a searchable graph this agent writes itself.
2. **Experience compounds.** Failures steer the memory (stale facts get superseded,
   unreliable context sources get down-weighted), so the same mistake is rarely made twice.
3. **Skills self-extend.** The agent builds its own tools/harnesses mid-task; they persist,
   get indexed into memory, and are recallable forever after.

Non-goals: beating benchmarks through raw scale; general chat; cloud-only operation
(cloud-first today, local runtimes supported later).

## 2. Layered architecture

```
┌────────────────────────────────────────────────────────────┐
│ PRESENTATION   memtui (ratatui dashboard)                  │
│                future: pixel-design agent TUI              │
├────────────────────────────────────────────────────────────┤
│ AGENT RUNTIME  sea-agent CLI on pi (TypeScript)            │
│  - pi agent loop, multi-provider models (OpenRouter etc.)  │
│  - core tools: bash, read/write/edit/glob, ipy kernel      │
│  - extensions: memory-layer.ts (+ harness bridge later)    │
├───────────────────────────────┬────────────────────────────┤
│ HARNESS ENGINE (TS)           │ MEMORY LAYER (Rust)        │
│ self-built skill bundles,     │ memsrv sidecar: JSON-RPC   │
│ scope registry, watcher,      │ graph {facts,state,log,ctx}│
│ createHarness() seam          │ HNSW search, steering      │
├───────────────────────────────┴────────────────────────────┤
│ STORAGE  append-only journal (.lock protected) + snapshots │
│          embed cache (text-hash -> vector per model)       │
└────────────────────────────────────────────────────────────┘
EXTERNAL: OpenRouter (chat models + embeddings; cloud-first)
```

Diagrams: `docs/diagrams/architecture.html`, `memory-loop.html`, `subagent-tree.html`.

## 3. The memory layer (the core invention)

### 3.1 Node model
Every memory node carries four things:

| Part | Nature | Mutability | Purpose |
|------|--------|-----------|---------|
| `facts` | structured key→value truths | add / supersede (never erase) | precise, addressable knowledge |
| `state` | working summary | DERIVED from facts + log tail | cheap read for agents |
| `log` | append-only events | append only | "model-visible means logged"; training signal |
| `context` | vectors pushed by predecessors | recomputed on change | push-based retrieval signal |

Node types: **Aspect** (facet of a skill/domain), **TaskEpisode** (one work session),
**Entity**, **Harness** (a generated plugin), **Outcome** (result record).

Domains are CLUSTERS of fine-grained aspect nodes, never one fat node.

### 3.2 Edges
`SuppliesContext` (the push contract: A owes B correct context), `PartOf`,
`DerivedFrom`, `Supersedes`, `ActivatedWith`. Every edge has weight [0..1],
temporal validity (`valid_from`/`invalid_at`), and success/failure tallies.

### 3.3 Steering (learning from failure)
Pure planner → journal ops (exactly replayable):
1. Log the failure on the episode.
2. Attribute blame: lexical overlap between failure text and each feeder's facts.
3. Down-weight blamed edges (-0.10); reinforce success path (+0.05 Hebbian).
4. Supersede an implicated stale FACT when a correction is known.
5. SWITCH: edge below 0.2 threshold with a healthier alternate ⇒ rewire.
6. Nothing implicated ⇒ create a GAP node ("we lacked X") wired as new context source.

### 3.4 Retrieval
Two-stage: ANN/cosine seeds (HNSW index; brute force under ~100k nodes) then
graph-aware expansion — neighbors of seeds score `seed × 0.5 × edge-weight` along
live edges. Measured: Hit@1 80% with real embeddings vs 53% hashing (15-query bench).
Embeddings: pluggable `Embedder` trait — OpenRouter `lfm-2.5-embedding-350m:free`
(1024-dim, disk-cached by text-hash+model) default via env key; offline hashing fallback;
vectors are derived so switching models = one reindex.

### 3.5 Persistence & concurrency
Journal = source of truth (append-only JSONL of typed `Op`s; replay = exact state).
Every writer takes an exclusive advisory lock (`fd-lock`) on `<journal>.lock`.
Snapshots compact periodically; load = snapshot + tail replay. Vectors/log-derived
data are NEVER journaled.

### 3.6 Sidecar protocol (memsrv)
Line-delimited JSON-RPC over stdio (stderr = diagnostics only):

    → {"id":1,"method":"search","params":{"query":"...","k":5}}
    ← {"id":1,"ok":true,"result":{"results":[{"node":2,"score":0.61,"via_graph":false}]}}

Methods: ping, dump, state, search, create_node, episode, fact, link,
commit_log, steer, good, exit. Binary locks the same journal files as the CLIs,
so memcli / memtui / memsrv / N agents coexist safely.

## 4. Agent runtime (sea-agent on pi)
- pi provides: agent loop, streaming, session trees, compaction, provider catalog.
- Providers: OpenRouter primary (cloud-first decision), then direct Anthropic/OpenAI;
  `SEA_MODEL` selects; resolver accepts full catalog ids.
- Core tools: bash_exec, read_file, write_file, apply_edit, glob_list, ipy_run
  (persistent IPython kernel over JSON-lines subprocess; survives across calls,
  timeouts kill-and-respawn transparently).
- Extension host shim inside cli.ts loads pi-style extensions in-process:
  collects `pi.registerTool()` defs, fires `session_start` / `tool_execution_end` /
  `session_shutdown`. Memory logging failures can never break the agent loop.

### 4.1 The automatic memory loop (phase 2 — LIVE)
On session start → `episode{label}` node auto-created.
On every tool call → `commit_log(kind:"tool_call")`.
On shutdown → `commit_log(kind:"outcome")`.
Agent-visible tools: `memory_search`, `memory_write_fact`, `memory_steer`.

## 5. Harness engine (self-extension)
Skill bundles = folder{manifest.json, *.mjs tool modules}. `createHarness(spec)`:
safety-gate source → write bundle → load → register → Disposable. Layered scopes
(global < project < session). Watched skill dirs pick up changes <500ms; broken
rewrites auto-unregister. Loader-tool pattern gives lazy activation (cheap prompts).
Roadmap: bundles written into pi's skill locations (~/.pi/agent/skills/, .agents/skills/,
.pi/skills/, project .agents/skills/) become Harness nodes in memory — searchable
"I built k8s-debug last week" recall. Safety gate = filter, not sandbox; real isolation
needs workers/containers (documented limitation).

## 6. Hierarchical subagents (phase 4, designed)
Tree of pi session branches. Spawn protocol:
1. parent runs memory_search(task) over the shared graph
2. composes ≤2000-token CONTEXT BRIEF (relevant node states + known facts) — never the transcript
3. child starts with brief + tools; everything it sees is logged to its own episode node
4. children may spawn children (max depth 3, max 4 parallel, token budget inherited/split)
5. results return as Outcome nodes + facts in the SHARED graph — decoupled, crash-safe

## 7. Security model
- Secrets: `.env` (gitignored); keys never hardcoded; extension strips API key from
  sidecar env unless SEA_MEMORY_REMOTE=1.
- Journal integrity: lock-file serialization; replay validates every op.
- Honest limits: bash tool unrestricted; harness safety gate blocks obvious dangerous
  imports but generated code runs with process privileges. Planned: approval gates,
  worker-pool isolation.

## 8. Evaluation
- Retrieval: memeval Hit@1/Hit@3/MRR (done; see §3.4 table in STATUS.md).
- Task-success (next): fixed task set, same model, memory ON vs OFF;
  measure success rate + tokens-to-completion.
- Longitudinal: rerun failed tasks after steering; expect improving outcomes.

## 9. Repository map
    research/        prior-art reports, design notes, spec
    memory-layer/    Rust crate: lib + bins memcli/memtui/memsrv/memeval (19 tests)
    harness-engine/  TS package: dynamic bundles/registry/watcher (19 tests)
    agent/           sea-agent runtime + memory extension (28 tests)
    docs/            this document + diagrams/
    STATUS.md        living phase tracker / scoreboard / decisions log
