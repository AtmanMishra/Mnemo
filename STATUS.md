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
| 5 | Product polish | DONE v1 | TUI v2 inline REPL; skills; approval gate; loops; export/import |
| 6 | Live LLM validation | DONE (OpenCode) | eval 3/3 vs 0/3 on ox-alpha-free; spawn_subagent live; agent built its own harness live |
| 7 | Harness engine integration | DONE | create_harness tool: model builds tool plugins at runtime; bundles auto-become skills via bridge |
| 8 | Native pi InteractiveMode migration | DONE | sea = pi main() + extensionFactories; REPL deleted; 92/92 tests; live-verified |

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

## LLM task eval FINAL (ox-alpha-free via OpenCode Zen)
| Task | WITH memory | WITHOUT memory |
|------|------------|----------------|
| checkout package manager | pnpm PASS | honest ignorance FAIL |
| billing port | 8081 PASS | FAIL |
| helm rollback cause | --wait flag PASS | FAIL |
| **Score** | **3/3** | **0/3** |
Fixes that produced the jump from 1/3: (1) memsrv search now returns label+state per hit
(scores alone are useless to an LLM), (2) cli.ts asserts a persistent-memory directive into
systemPrompt before every model call.
Also live-verified: spawn_subagent hierarchical delegation (child wrote ops fact to shared
graph node #15; parent confirmed via its own memory search). opencode + opencode-go providers
added (OPENCODE_API_KEY).

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

## Session log (latest)
- Fixed approval.test.ts hang: readline drops unmatched pre-written lines -> scripted answers now
  feed per-prompt from output detection; ask() resolves on stream EOF instead of pending forever.
- All builders delivered & verified. Pushed commits ca93a51, 5170959 to github.com/AtmanMishra/self-evolving-agent.
- Test totals: agent 71, tui 23 (+31 self-checks), memory-layer 19 (+2 integration). All green.
- OpenCode Zen live round: memory loop, subagent delegation, self-built harness
  (word-counter bundle -> .agents/skills -> discoverable). Secrets hygiene: hardcoded key
  purged from history; keys only in gitignored .env.
- TUI decision: Option A adopted per research/tui-adoption-report.md - wrap pi main()
  with extensionFactories (tools + approval + memory directive as inline extensions);
  custom REPL deleted; gains streaming markdown/diffs/thinking/compaction/resume/fork/tree.

## MNEMO ERA (current)
Agent renamed to MNEMO (Mnemosyne). Command: `mnemo`. Env: MNEMO_* (SEA_* fallbacks kept).
Task tracking moved to plan.md (7 areas). This file records outcomes/verification.

| Doc | Purpose |
|-----|---------|
| plan.md | master task tracker, 7 areas, live checkboxes |
| STATUS.md | outcomes, verification evidence, decisions log (this file) |
| research/audit-report.md | competitor gap audit + single-CLI blockers |
| research/brain-areas-design.md | brain-region memory architecture (Area 3) |
| research/mnemo-ui-identity.md | pixel design system, Silkscreen+VT323, animations |
| research/tui-adoption-report.md | why pi InteractiveMode; cockpit integration path |
| research/agent-tui-design.md | cockpit layout + feature parity table |
| research/memory-design-spec.md / memory-layer-notes.md | memory core design + research |
| research/pi-agent-report.md / deepseek-harness-and-scrapling-report.md | upstream studies |
| research/programmatic-tool-calling.md | in-kernel tool dispatch to reduce round-trips (tasks 4.6-4.7) |

### AREA 1 — AUTH & ONBOARDING: COMPLETE (4/5)
- ~/.mnemo/auth.json credential store (chmod 600); env > store precedence
- `mnemo auth` wizard (provider picker, key validation, default model)
- `mnemo auth status|logout`; first-run auto-launch when nothing configured
- LIVE VERIFIED: `mnemo "<prompt>"` with ZERO env vars -> resolved opencode-go/
  ox-alpha-free from store -> memory_search -> correct answer
- Bug caught by tests: wizard wrote credentials to real home instead of injected
  home; polluted ~/.mnemo cleaned and reseeded
- Remaining: 1.5 verify pi in-TUI /login provider list

### Test totals (current)
agent 102 · tui 23 (+31 self-checks) · memory-layer 19 (+2 integration) · harness-engine 19
HEAD ac50ba7, working tree clean, all pushed.

### AREA 3.1 — BRAIN-AREA MEMORY: COMPLETE
- `Area` enum in memory-layer/src/model.rs with 6 regions (Episodic, Semantic, Procedural, Spatial, Salience, Executive) per research/brain-areas-design.md
- `Node.area` is a stored column, defaulted at creation from NodeKind via `Area::for_kind` (TaskEpisode/Outcome→Episodic, Aspect→Semantic, Harness→Procedural, Entity→Spatial). Stored rather than derived because Salience and Executive nodes have no dedicated kind (needed by 3.4).
- Reassignment via new journal op `Op::SetArea{node,area,at}` — chosen over adding a field to `Op::CreateNode` to keep every existing journal line replayable unchanged and give consolidation (3.5) a re-assignment path. Node serde field has `#[serde(default)]` so pre-area snapshots still load.
- memsrv: `create_node` and `episode` accept optional `"area"` param and return the resulting area; new `set_area` method; `dump`, `state` and `search` hits all carry the area (search hits carry it so callers can route on it in 3.2). Unknown area names rejected.
- Verification: `cargo test` in memory-layer/ = 24 passing / 0 failing (was 19). New tests: area_defaults_by_kind, set_area_survives_journal_replay, snapshot_without_area_field_still_loads, area_parse_round_trips, memsrv_persists_and_returns_area. Other suites re-run green: agent 102, tui 23, harness-engine 19.

### AREA 3.2-3.5 — SEARCH ROUTING & CONSOLIDATION: COMPLETE
- **3.2 area filter + query router**: search()/search_ann() now take &SearchOpts (kind + areas + prefer + cross_area) instead of Option<NodeKind>; empty areas = all areas so old behaviour is unchanged. route_query() is a keyword→area heuristic returning at most 2 areas, empty when the query has no distinctive cue. memsrv search accepts areas[] as a hard filter and always reports "routed".
- **3.3 cross-area discount**: routing is soft — SearchOpts.prefer scales out-of-area nodes by CROSS_AREA_DISCOUNT (0.85) rather than excluding them, so a mis-routed query still ranks correctly. memeval unchanged at Hit@1 93% / Hit@3 100% / MRR 0.967 with real OpenRouter embeddings (docs' baseline was 80%) — no regression. Caveat: the memeval corpus is single-area, so the discount is uniform there; mixed-area ranking is covered by unit tests, not memeval.
- **3.4 salience pain markers**: steer() now creates a Salience node (label "pain: ..." + failure fact) before any blame/correction/rewire op. The episode cites it with DerivedFrom, NOT SuppliesContext, so a pain marker is reachable by search expansion but can never become a blame target for the next failure. memsrv steer returns pain_node.
- **3.5 consolidation**: new memory-layer/src/consolidate.rs replays Episodic+Salience nodes and distils recurring themes into Semantic "lesson" nodes. A lesson needs >=2 sources AND >=2 shared theme tokens (so "same project" isn't mistaken for "same lesson"); groups sharing the same tokens collapse into one lesson. Idempotent — a second pass emits zero ops but still reports standing lessons; new evidence supersedes the sources fact. Exposed as memsrv "consolidate" and the `mnemo consolidate` CLI subcommand (no provider/LLM needed).
- **3.6 (Cockpit Memory pane groups by area)** remains open: it depends on the Area 2 cockpit and will land with task 2.4.
- Verification: memory-layer 36 passing / 0 failing (was 19 at the start of Area 3), agent 104 passing / 0 failing, tui 23, harness-engine 19.

### AREA 2 — COCKPIT TUI: COMPLETE
- **2.1 RPC backbone**: tui/src/rpc.rs spawns `mnemo --mode rpc` and reads pi's JSONL event stream (agent_start/settled, streaming text and thinking deltas, message_end as authoritative reply, tool_execution start/end, turn_end token+cost stats). parse_event is a pure function so the protocol layer is tested from lines recorded off a live run, plus one test driving a scripted child process. No API key or network in tests. Unknown pi event types are ignored rather than erroring, so a pi upgrade can't break the cockpit.
- **2.2 Shell**: new `mnemo-cockpit` binary — nav rail (Chat/Memory/Agents/Skills/Logs), main pane, prompt, status bar. Tab/shift-tab cycle and alt+digit jumps work mid-sentence without eating the draft; bare digits navigate only when the body has focus. Navigation state is pure (no terminal, no process), so every key path is a unit test. Shared modules moved behind a lib target.
- **2.3-2.7 Panes** (all behind one `PaneView` trait — adding a pane = a module, a field, a match arm): Chat (streaming, collapsible thinking, tool cards that flip running→ok/failed, coloured diff hunks, turn cost, tail-anchored scrollback); Memory (nodes grouped by brain area — this is 3.6 — area-filtered search via memsrv, node state on demand); Agents (delegation tree from journal episodes, run state from outcome logs, drill-in transcript, orphaned subagents stay visible); Skills (SKILL.md discovery mirroring the agent's own root order, plus harness bundles); Logs (live journal tail with filters, survives a compacted journal).
- **Extras** beyond the plan text: slash-command palette with subsequence matching and tab completion, and a `?` card merging global with pane-local bindings.
- **2.8 PIXEL pass** per research/mnemo-ui-identity.md: double-line chrome, colour as state, no italics, braille spinner, prompt cursor pulse while streaming.
- **2.9**: seatui and memtui now print deprecation notices pointing at mnemo-cockpit; both still run.
- **Bug found**: end-to-end test caught memory-layer search applying its kind/area filter to seeds only, so graph expansion pulled neighbours back in from excluded kinds and areas. Fixed in expand() so it covers both search() and search_ann() and both filters. memeval unchanged at Hit@1 93% / Hit@3 100% / MRR 0.967.
- Verification: tui 112 passing / 0 failing (was 23), memory-layer 37, agent 104, harness-engine 19 — 272 total, all green. End-to-end test tui/tests/cockpit_e2e.rs drives a real memsrv over a real journal, real skill files on disk, real key handling and real ratatui rendering. The binary was also launched for real: it enters and leaves the alternate screen and exits cleanly.

### Next candidates
Area 4 (agent capabilities) | Area 5 (logging and traces) | Area 6 (packaging)
