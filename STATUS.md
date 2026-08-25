# PROJECT STATUS
Updated: this file is maintained on every milestone. Design details live in research/.
GOAL: coding agent reaching frontier-model performance using small/local models,
powered by graph memory (facts/state/log/context), experience accumulation, and
hierarchical subagents sharing knowledge.

## Phase tracker (user-approved order)
| # | Phase | Status | Notes |
|---|-------|--------|-------|
| 1a | Memory sidecar + locking | DONE | memsrv binary, fd-lock on journal, 2 integration tests |
| 1b | pi extension wiring memory tools | DONE + LIVE-VERIFIED | real LLM session wrote fact, searched, recalled (stealth/ox-alpha via OpenRouter) |
| 2 | Automatic memory loop | NOT STARTED | auto episode/log/outcome capture in agent loop |
| 3a | Retrieval eval (memeval) | DONE | see eval results below |
| 3b | LLM task-success eval | FIRST RUN DONE | WITH memory 2/3 vs WITHOUT 0/3 (nemotron-120b:free); T3 flaky from rate limits; re-run after daily reset |
| 4 | Subagent spawning (tree) | v1 DONE | spawn_subagent tool: parent-chosen brief, shared journal, timeout-kill; 5 deterministic tests; live LLM test pending quota reset |
| 4 | Subagent spawning (tree) | DESIGNED | depth 3 / 4 parallel / 2k-token briefs |
| 5 | Product polish (TUI, import/export, loops) | IN PROGRESS | seatui-builder building the pixel-design Rust TUI (tui/ crate) against the live sea-agent REPL |

## Component scoreboard
| Component | Location | Tests | State |
|-----------|----------|-------|-------|
| Memory layer core | memory-layer/src/{model,store,persist}.rs | 10 | stable |
| Vector search + HNSW | memory-layer/src/{vec,search,ann}.rs | 7 | stable; hashing embedder default |
| Steering engine | memory-layer/src/steering.rs | (in suite) | rules v0 |
| OpenRouter embeddings | memory-layer/src/remote.rs | live-verified | liquid/lfm-2.5-embedding-350m:free, 1024-dim, disk cache |
| memcli REPL | memory-layer/src/bin/memcli.rs | manual | persistent journal |
| memtui dashboard | memory-layer/src/bin/memtui.rs | render-once | keybinds complete (? overlay) |
| Sidecar memsrv | memory-layer/src/bin/memsrv.rs | 2 integration | line-JSON-RPC over stdio |
| Harness engine | harness-engine/ | 19 | dynamic bundles, scopes, watcher, safety gate |
| Agent runtime on pi | agent/ | 20/20 pass, tsc clean | RECOVERED by runtime-finisher; kernel bridge solid (persistence+timeout recovery) |
| Research corpus | research/*.md | - | complete |

## RPC protocol (memsrv, line-delimited JSON over stdio)
Request : {"id":N,"method":"M","params":{...}}   Response: {"id":N,"ok":true,"result":...}|{"ok":false,"error":"..."}
Methods : ping dump state{node} search{query,k} create_node{kind,label} episode{label}
          fact{node,key,value} link{src,dst} commit_log{node,kind,detail}
          steer{episode,failure,fix?} good{episode,detail} exit
Phase 1b accepted by pi-runtime-builder (extension in progress).

## Eval results (memeval, 15 queries, 12-node 3-domain graph)
| Embedder | Hit@1 | Hit@3 | MRR |
|----------|-------|-------|-----|
| hashing (offline) | 53% | 60% | 0.567 |
| OpenRouter lfm-2.5-embedding-350m | **80%** | **80%** | **0.800** |
Real embeddings beat vocabulary matching by +27pp Hit@1 on identical graph+queries.
Remaining misses are cross-domain paraphrases ("db schema change" -> "alembic migrations")
-> expected to close with richer facts + episode context, not just bigger models.
Run: cargo run --bin memeval [--hash]

## Key decisions log
- Node = {facts, state(derived), log(append-only), context(vectors from predecessors)}
- Domains are CLUSTERS of fine-grained aspect-nodes; edges created/deleted/SWITCHED by steering
- Push-based context contract; failure blame traces to specific stale facts -> supersede
- "model-visible means logged" invariant
- Cloud-first providers (OpenRouter primary); skills before MCP; ratatui TUI w/ pixel design system
- Journal = source of truth; vectors are derived (reindex on embedder switch)

## Rules of engagement (multi-agent)
- Only the main agent edits memory-layer/src/. Children consume via CLI/binary.
- Children must not delete data/* journals unless user says exactly 'reset the memory'.
- Every claim of 'done' gets independently verified by the main agent.

## MILESTONE (first end-to-end run)
sea-agent CLI booted with stealth/ox-alpha via OpenRouter. In one live session the model:
memory_write_fact(checkout-service: package-manager=pnpm) -> ok
memory_search("checkout package manager") -> found node #2, score 0.61 -> answered "pnpm"
Journal shows full automatic loop already working: episode node auto-created on session start,
every tool call logged, outcome committed at shutdown. Phase-2 groundwork is REAL.
Note: cli.ts loads extensions via a small in-process shim; SEA_CLI_FORCE=1 required for
one-shot runs until direct-invocation detection is fixed; resolver accepts full catalog ids.

## Rate-limit reality (important for planning)
OpenRouter free tier: ~50 req/day globally (+1000/day per model with 10+ credits).
stealth/ox-alpha quota resets tomorrow. Evals/LLM tests should batch carefully or
use paid credits. Deterministic tests never call LLMs - keep it that way.

## In flight / next
- pi-runtime-builder session FAILED (quiescence wait cancelled); runtime-finisher spawned to repair + finish
- Phase 1b (memory extension) DONE + live-verified
- seatui (main agent TUI) being built in tui/ crate: spawns sea.ts REPL child, chat/activity/status panes, PICO-8 pixel theme
- spawn_subagent tool lives in agent/src/tools/subagent.ts; SEA_AGENT_BIN env overrides child CLI for tests; children inherit SEA_MEMORY_JOURNAL -> shared graph is the coordination bus
- cli.ts loads extensions via in-process shim (extTools + fireEvent); SEA_CLI_FORCE no longer needed (bin/sea.ts main-guard fixed)
- NEXT: hand RPC protocol to runtime builder for phase 1b; then automatic loop (phase 2)

## Docs
- docs/system-design.md — full system design (v1.0)
- docs/diagrams/{architecture,memory-loop,subagent-tree}.html + memory-layer.excalidraw — diagrams (diagram-maker skill)
