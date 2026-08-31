# MNEMO — MASTER PLAN

One command: `mnemo`. An agentic coding + harness assistant whose memory works like a brain.
This file tracks ALL areas of work. Per-task live status lives in STATUS.md.
Legend: [ ] todo · [~] in progress · [x] done · [-] blocked

## AREA 1 — AUTH & ONBOARDING (single-command experience)

- [x] 1.1 Auth store: ~/.sea/auth.json (chmod 600) via pi AuthStorage wrapper; read order: env > auth.json
- [x] 1.2 `mnemo auth` wizard: provider picker (anthropic/openai/openrouter/opencode/opencode-go) -> paste key OR oauth device flow where supported -> default model pick from live catalog
- [x] 1.3 First-run detection: auto-launch wizard; stored creds resolve to env; branding via pi header (partial)
- [x] 1.4 `mnemo auth status|logout` commands
- [x] 1.5 Verify pi /login lists our providers inside interactive TUI

## AREA 2 — COCKPIT TUI (one app, navigation rail)

- [x] 2.1 RPC backbone: drive agent via pi runRpcMode (JSON-RPC) instead of REPL scraping
- [x] 2.2 Shell: left nav rail (Chat/Memory/Agents/Skills/Logs) + main pane + input/status bar; Tab+number switching; focus rings
- [x] 2.3 Chat pane: streaming markdown, thinking blocks, tool cards, diff blocks (reuse pi components / seatui md.rs)
- [x] 2.4 Memory pane: brain-area grouped node browser, search, steering log, live journal tail
- [x] 2.5 Agents pane: subagent tree from journal episodes (status/model/spend), drill-in transcript, kill
- [x] 2.6 Skills pane: discovered skills+harnesses, load/create actions
- [x] 2.7 Logs pane: journal ops stream w/ filters
- [x] 2.8 Pixel identity pass per research/mnemo-ui-identity.md (+ANIMATIONS allowed: spinner, pane transitions, meter fills, typing pulse)
- [x] 2.9 Deprecate seatui + memtui standalone binaries after panes reach parity

## AREA 3 — BRAIN-AREA MEMORY (research/brain-areas-design.md)

- [x] 3.1 model.rs: add `area` column to Node (default derived from kind); memsrv persists
- [x] 3.2 memsrv search: `areas` filter + query router heuristic v0 (keyword->area mapping)
- [x] 3.3 search.rs: cross-area discount weights; tune via memeval (no regression vs 80% hit@1 baseline)
- [x] 3.4 steer(): write SALIENCE pain markers before Executive correction
- [x] 3.5 Consolidation job skeleton (`mnemo consolidate`): Episodic replay -> Semantic facts
- [x] 3.6 Cockpit Memory pane groups by area (pairs with 2.4)

## AREA 4 — AGENT CAPABILITIES

- [x] 4.1 MCP client bridge (servers as registered tools)
- [x] 4.2 Web search/fetch tool (Brave/Tavily key optional)
- [x] 4.3 Permission rule engine: ~/.mnemo/permissions.json allow/ask/deny patterns (extends approval gate)
- [x] 4.4 Plan mode: read-only phase + tool allowlist switch
- [x] 4.5 Image/screenshot input surfacing through tools
- [x] 4.6 Programmatic tool calling (research/programmatic-tool-calling.md): `tools` proxy inside the ipy kernel + `tool_call` op on the existing stdio bridge, so the model writes ONE program instead of N tool_use round trips
- [x] 4.7 Route in-kernel tool calls through the approval gate + permission rules — without this, generated code bypasses the y/n gate on bash_exec/write_file/apply_edit (pairs with 4.3)

## AREA 5 — LOGGING & TRACES

- [x] 5.1 Structured logger: level-filtered JSONL traces in ~/.mnemo/logs/<date>.jsonl (request_id spans)
- [x] 5.2 LLM call tracing: provider/model/tokens-in/out/latency/stop-reason per model round-trip
- [x] 5.3 Tool-call spans: tool name, inputs summary, output size, duration, ok/error (extension hook writes span)
- [x] 5.4 Subagent correlation: child spans carry parent session/request ids -> full delegation tree reconstructable
- [x] 5.5 `mnemo traces [session-id]` CLI: pretty-print span tree; --json flag
- [x] 5.6 Cockpit Logs pane renders the same trace store (pairs with 2.7)
- [x] 5.7 Log rotation + redaction (never write api keys / .env values into traces)

## AREA 6 — PACKAGING & DISTRIBUTION

- [x] 6.1 package.json files/engines fields; npm publish (scoped) or npm link quickstart
- [x] 6.2 node>=22.6 runtime check with friendly error
- [x] 6.3 README quickstart: install -> `mnemo` -> wizard -> done

## AREA 7 — QUALITY

- [x] 7.1 CI: test matrix on push (agent/tui-go/memory-layer/harness-engine)
- [x] 7.2 Eval suite expansion: >15 retrieval cases + 5 LLM task pairs
- [x] 7.3 Learned steering policy experiment (log-replay training data)

## AREA 8 — ONE APP: `mnemo-agent` (everything inside the runtime)

Decision: the cockpit IS the product. Chat runs in the Rust app over pi's RPC;
the `mnemo` CLI survives only for scripting (traces/consolidate/one-shot).

- [x] 8.1 `mnemo-agent` binary + screen routing (Onboarding -> Projects -> Sessions -> Chat) over the existing nav rail
- [x] 8.2 Rust auth store: read/write ~/.mnemo/auth.json (same schema as src/auth/store.ts), model catalog per provider
- [x] 8.3 Pixel onboarding on first run, in-runtime: provider picker -> key entry -> default model -> done
- [x] 8.4 Projects screen: cwd is the current project; others read from pi's ~/.pi/agent/sessions/<encoded-cwd>/
- [x] 8.5 Sessions screen: sessions per project, subagents nested under each (from trace spans + journal episodes), open/resume
- [x] 8.6 In-session `/login`: authenticate without leaving the session; unset model is a clear error, not a crash
- [x] 8.7 Multi-model: spawn_subagent takes an optional model; child inherits the parent's unless told otherwise; only logged-in providers offered
- [x] 8.8 Retire `mnemo auth`, seatui and memtui now that auth and both dashboards live in the one app

## AREA 9 — HOOKS ENGINE (research/all-in-one-agent-design.md Part A)

User-facing pre/post-tool + lifecycle hooks, scoped project→user→global, audited,
self-buildable by the agent (harness synergy). Built on pi's tool_call (block) and
tool_result (modify) interception — NOT a replacement of pi's events.

- [x] 9.1 Hook manifest + matchers: {id, trigger: PreToolUse|PostToolUse|UserPromptSubmit|TurnEnd|SessionStart|SessionShutdown|Notification, matcher{tool,path}, command, timeout, on{block,audit,modify}}; tool regex + path glob; scope resolution project (.mnemo/hooks) → user (~/.mnemo/hooks) → global (~/.config/mnemo/hooks), scoped-then-id order, any block veto wins
- [x] 9.2 Executor: spawn command with JSON on stdin; exit 0 = allow, 2 = block with reason shown to model, other = allow + log error; timeout; PreToolUse arg-rewrite; PostToolUse result-modify
- [x] 9.3 Event wiring: PreToolUse on pi tool_call, PostToolUse on tool_result, lifecycle hooks on turn_end/session_start/session_shutdown, UserPromptSubmit
- [x] 9.4 Audit trail: every invocation (match, command, duration, exit, block reason, delta) through the existing ~/.mnemo/logs tracer with redaction
- [x] 9.5 `/hook list|test|add|disable`; add scaffolds the hook file into the chosen scope (script or harness bundle)
- [x] 9.6 Memory indexing: hooks recorded as Procedural nodes (reuse harness indexing path) so sessions recall which hooks exist and why
- [x] 9.7 Tests: matcher unit, scope precedence, exit-code semantics, arg-rewrite/modify, audit lines, /hook flows; all deterministic, temp dirs, fake pi events (memory_lifecycle.test.ts pattern)

## AREA 10 — SCHEDULES & TRIGGERS (research/all-in-one-agent-design.md Part B; design done, implementation pending)

- [ ] 10.1 Cron/interval parser + ~/.mnemo/schedules.json job store (prompt, model override, scope, enabled, last/next run)
- [ ] 10.2 `mnemo schedule` daemon + in-session ticker; double-fire prevented via memsrv journal fd-lock lease
- [ ] 10.3 Every tick = TaskEpisode in the journal → steering + consolidation + mempolicy apply to scheduled work
- [ ] 10.4 /trigger: on_failure, on_uncommitted, on_push (webhook), on_cost_over; /now fires any job
- [ ] 10.5 Notifications (TUI status chip + opt-in OS notify) + Schedules overlay in tui-go

## AREA 11 — MEMORY-LAYER IMPROVEMENTS (research/memory-layer-improvements.md; curated — do NOT bloat the graph model)

Guardrail: the memory layer's job = store facts with history, retrieve the right
context, reshape via steering/consolidation. Every change serves one of those or is
NOT built. Retrieval changes MUST keep memeval --hash at Hit@1 ≥ 73% / Hit@3 ≥ 77%
/ MRR ≥ 0.743 (n=22) or improve — revert otherwise.

- [ ] 11.1 Caching (the missing piece): (a) in-memory LRU for memsrv search, keyed (query, areas[], k), bounded ~256; (b) memoize state_of per node, invalidate on journal op touching that node. Embeddings already disk-cached — leave them. Pure performance, zero semantic change; measure memeval --hash byte-identical.
- [ ] 11.2 Retrieval usefulness feedback via EXISTING machinery: capture useful/unhelpful signal (agent recall + TUI thumbs) as counters on node/edge, route into existing prefer()/success-failure reweight so useful edges gain weight, noisy ones lose it. When counters accumulate, feed mempolicy (learned weight replaces fixed one) — not a learning-to-rank system now.
- [ ] 11.3 memsrv thin wrappers (no new engine): `recall_brief(query)` = ready-to-inject block (area-routed, top-k with State inlined not bare scores, provenance line); `remember(summary)` = auto-route area + create node/facts/log in one call.
- [ ] 11.4 Tests + eval gate for all of the above: deterministic (real memsrv + temp journal, fake pi, setProjectRoot/setSkillsHome overrides), memeval --hash pinned 73/77/0.743 no-regression per retrieval change, cargo test + agent npm test green.
NON-GOALS (explicitly not in this area — see doc table): learned embedding/router ML pipeline (no journal signal yet), per-kind recency decay (Supersede covers staleness), cluster summaries, proactive ActivatedWith recall, journal GC, parallel memsrv reads, diff/timeline ops.

## DONE (reference)

[x] Memory layer core+steering+sidecar (19+2 tests)
[x] Harness engine (19 tests)
[x] pi InteractiveMode migration (92 agent tests at merge)
[x] OpenCode/OpenRouter providers; eval 3/3 vs 0/3 on ox-alpha-free
[x] spawn_subagent hierarchical delegation (live-verified)
