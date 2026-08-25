# MNEMO — MASTER PLAN
One command: `mnemo`. An agentic coding + harness assistant whose memory works like a brain.
This file tracks ALL areas of work. Per-task live status lives in STATUS.md.
Legend: [ ] todo · [~] in progress · [x] done · [-] blocked

## AREA 1 — AUTH & ONBOARDING (single-command experience)
- [~] 1.1 Auth store: ~/.sea/auth.json (chmod 600) via pi AuthStorage wrapper; read order: env > auth.json
- [ ] 1.2 `mnemo auth` wizard: provider picker (anthropic/openai/openrouter/opencode/opencode-go) -> paste key OR oauth device flow where supported -> default model pick from live catalog
- [ ] 1.3 First-run detection: no creds anywhere -> auto-launch wizard; rebrand help/header to MNEMO
- [ ] 1.4 `mnemo auth status|logout` commands
- [ ] 1.5 Verify pi /login lists our providers inside interactive TUI

## AREA 2 — COCKPIT TUI (one app, navigation rail)
- [ ] 2.1 RPC backbone: drive agent via pi runRpcMode (JSON-RPC) instead of REPL scraping
- [ ] 2.2 Shell: left nav rail (Chat/Memory/Agents/Skills/Logs) + main pane + input/status bar; Tab+number switching; focus rings
- [ ] 2.3 Chat pane: streaming markdown, thinking blocks, tool cards, diff blocks (reuse pi components / seatui md.rs)
- [ ] 2.4 Memory pane: brain-area grouped node browser, search, steering log, live journal tail
- [ ] 2.5 Agents pane: subagent tree from journal episodes (status/model/spend), drill-in transcript, kill
- [ ] 2.6 Skills pane: discovered skills+harnesses, load/create actions
- [ ] 2.7 Logs pane: journal ops stream w/ filters
- [ ] 2.8 Pixel identity pass per research/mnemo-ui-identity.md (+ANIMATIONS allowed: spinner, pane transitions, meter fills, typing pulse)
- [ ] 2.9 Deprecate seatui + memtui standalone binaries after panes reach parity

## AREA 3 — BRAIN-AREA MEMORY (research/brain-areas-design.md)
- [ ] 3.1 model.rs: add `area` column to Node (default derived from kind); memsrv persists
- [ ] 3.2 memsrv search: `areas` filter + query router heuristic v0 (keyword->area mapping)
- [ ] 3.3 search.rs: cross-area discount weights; tune via memeval (no regression vs 80% hit@1 baseline)
- [ ] 3.4 steer(): write SALIENCE pain markers before Executive correction
- [ ] 3.5 Consolidation job skeleton (`mnemo consolidate`): Episodic replay -> Semantic facts
- [ ] 3.6 Cockpit Memory pane groups by area (pairs with 2.4)

## AREA 4 — AGENT CAPABILITIES
- [ ] 4.1 MCP client bridge (servers as registered tools)
- [ ] 4.2 Web search/fetch tool (Brave/Tavily key optional)
- [ ] 4.3 Permission rule engine: ~/.sea/permissions.json allow/ask/deny patterns (extends approval gate)
- [ ] 4.4 Plan mode: read-only phase + tool allowlist switch
- [ ] 4.5 Image/screenshot input surfacing through tools

## AREA 5 — LOGGING & TRACES
- [ ] 5.1 Structured logger: level-filtered JSONL traces in ~/.mnemo/logs/<date>.jsonl (request_id spans)
- [ ] 5.2 LLM call tracing: provider/model/tokens-in/out/latency/stop-reason per model round-trip
- [ ] 5.3 Tool-call spans: tool name, inputs summary, output size, duration, ok/error (extension hook writes span)
- [ ] 5.4 Subagent correlation: child spans carry parent session/request ids -> full delegation tree reconstructable
- [ ] 5.5 `mnemo traces [session-id]` CLI: pretty-print span tree; --json flag
- [ ] 5.6 Cockpit Logs pane renders the same trace store (pairs with 2.7)
- [ ] 5.7 Log rotation + redaction (never write api keys / .env values into traces)

## AREA 6 — PACKAGING & DISTRIBUTION
- [ ] 6.1 package.json files/engines fields; npm publish (scoped) or npm link quickstart
- [ ] 6.2 node>=22.6 runtime check with friendly error
- [ ] 6.3 README quickstart: install -> `mnemo` -> wizard -> done

## AREA 7 — QUALITY
- [ ] 7.1 CI: test matrix on push (agent/tui/memory-layer)
- [ ] 7.2 Eval suite expansion: >15 retrieval cases + 5 LLM task pairs
- [ ] 7.3 Learned steering policy experiment (log-replay training data)


## DONE (reference)
[x] Memory layer core+steering+sidecar (19+2 tests)
[x] Harness engine (19 tests)
[x] pi InteractiveMode migration (92 agent tests at merge)
[x] OpenCode/OpenRouter providers; eval 3/3 vs 0/3 on ox-alpha-free
[x] spawn_subagent hierarchical delegation (live-verified)
