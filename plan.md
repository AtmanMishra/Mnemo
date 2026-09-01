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

- [x] 10.1 Cron/interval parser + ~/.mnemo/schedules.json job store (prompt, model override, scope, enabled, last/next run)
- [x] 10.2 `mnemo schedule` daemon + in-session ticker; double-fire prevented via an agent-side lockfile lease (O_EXCL + pid + stale detection) — memsrv left untouched per the parallel-agent guard
- [x] 10.3 Every tick = TaskEpisode in the journal → steering + consolidation + mempolicy apply to scheduled work (verified: pi emits session_start/shutdown in one-shot print mode; probe-spawn test proves the shared MNEMO_MEMORY_JOURNAL reaches the child)
- [x] 10.4 /trigger: on_failure (turn_end), on_uncommitted (git dirty poll), on_cost_over (trace-cost budget); /now fires any job (on_push deferred — webhook listener needs a real HTTP surface, noted)
- [x] 10.5 Notifications (TUI status chip + opt-in OS notify) + Schedules overlay in tui-go — DONE 2026-09-01: one-press-from-every-mode schedules overlay floats the shared store (^o); enter pauses/resumes in place, n fires /now <id>, finished jobs chip once on the status line; corrupt stores say so; palette/help list it (6ec29a5).

## AREA 11 — MEMORY-LAYER IMPROVEMENTS (research/memory-layer-improvements.md; curated — do NOT bloat the graph model)

Guardrail: the memory layer's job = store facts with history, retrieve the right
context, reshape via steering/consolidation. Every change serves one of those or is
NOT built. Retrieval changes MUST keep memeval --hash at Hit@1 ≥ 73% / Hit@3 ≥ 77%
/ MRR ≥ 0.743 (n=22) or improve — revert otherwise.

- [x] 11.1 Caching (the missing piece): (a) in-memory LRU for memsrv search, keyed (query, areas[], k), bounded ~256; (b) memoize state_of per node, invalidate on journal op touching that node. Embeddings already disk-cached — leave them. Pure performance, zero semantic change; measure memeval --hash byte-identical.
- [x] 11.2 Retrieval usefulness feedback via EXISTING machinery: capture useful/unhelpful signal (agent recall + TUI thumbs) as counters on node/edge, route into existing prefer()/success-failure reweight so useful edges gain weight, noisy ones lose it. When counters accumulate, feed mempolicy (learned weight replaces fixed one) — not a learning-to-rank system now.
- [x] 11.3 memsrv thin wrappers (no new engine): `recall_brief(query)` = ready-to-inject block (area-routed, top-k with State inlined not bare scores, provenance line); `remember(summary)` = auto-route area + create node/facts/log in one call.
- [x] 11.4 Tests + eval gate for all of the above: deterministic (real memsrv + temp journal, fake pi, setProjectRoot/setSkillsHome overrides), memeval --hash pinned 73/77/0.743 no-regression per retrieval change, cargo test + agent npm test green.
NON-GOALS (explicitly not in this area — see doc table): learned embedding/router ML pipeline (no journal signal yet), per-kind recency decay (Supersede covers staleness), cluster summaries, proactive ActivatedWith recall, journal GC, parallel memsrv reads, diff/timeline ops.

## AREA 12 — AUDIT REMEDIATION (audit/SUMMARY.md — 53 findings from the security & testing audit)

Ordered queue; every item references the finding id(s) in audit/FINDINGS.jsonl.

- [x] 12.1 CRITICAL-EQUIVALENT — approval-gate chain: ipy_run into GATED_TOOLS (0384ee03); subagent children approval-capable or fail CLOSED non-TTY (b6afa93e). (agent)
- [x] 12.2 harness safety gate on EVERY load (not just create): watcher/disk-loaded bundles (ccdbbb2b+51b81dda), relative/abs import bypass (747c8c3b), computed/backtick specifiers (56b733fa, f685ee0a, a0dfa43b) — gate that can't be regex-bypassed. (harness-engine + agent) — DONE 2026-09-01: loadBundle is the single gated entry (create/watcher/CLI all pass through it), relative imports resolved+confined+rescanned (depth 3), non-literal import()/require() rejected, net-class+process blocked by default; execute() still in-process (a739fbd8 documented).
- [ ] 12.3 memsrv journal resilience: tolerant load + quarantine + atomic writes (ab99acb1 — would-elevate-high, empirical 0-ops proof), non-UTF8 kill (e8e7d9e2), lock-less read_all (dbfee81a), frame/size bounds (f7c2c763). (memory-layer)
- [x] 12.4 web_fetch SSRF filter (localhost/private/metadata + redirects) (3927a1ac). (agent)
- [x] 12.5 bash allow-glob approves whole command string — match tokens, not raw string (3c265f44). (agent)
- [x] 12.6 file tools path containment (no absolute paths straight through; symlink canonicalization) (e00cd116). (agent)
- [x] 12.7 API key not inherited by children via process.env (68846059). (agent)
- [ ] 12.8 trace redaction gaps (URL tokens, sk-or-/tvly- shapes, 120-char verbatim args) (2fefd9ce). (agent)
- [x] 12.9 CI secrets gate actually green + regex coverage + history scan; GITHUB_TOKEN perms; npm ci; pinned tags (5e28efcf, f5efc6ba, 3f198bdf, 144c276d, 23e58063, 89697e08). (CI-repo) — DONE 2026-09-01: gate was red on its own fixture (hooks_executor.test.ts excluded as trace.test.ts); exclusion list fixed after verifying the exact git grep red BEFORE and green AFTER; regex extended to sk-or-v1-/github_pat_/generic api_key assignment; bounded history sweep (last 200 commits, early-exit; full-history scan deferred & documented); permissions: contents: read; npm ci for agent + harness-engine; actions pinned to SHAs with resolved-tag comments (rust-toolchain tracks stable by design).
- [ ] 12.10 hook executor default timeout + scope confinement (41ab8d40); block-reason not persisted raw to traces (fa244d3f). (agent)
- [ ] 12.11 auth.json write: O_NOFOLLOW / realpath before writing key (dd3118fb). (agent)
- [ ] 12.12 search cache invalidation on Unlink/Reweight/RecordOutcome (cddd21c0). (memory-layer)
- [x] 12.13 tui-go memory client: timeout must not leak reader goroutine (4745e2a2); cmd/mnemo os.Exit must run deferred Close (7bbead71). (tui-go) — DONE 2026-09-01: single readLoop dispatches by id, drops late replies, fails fast on dead sidecar; run()/main split so defers fire before exit (b36368f).
- [x] 12.14 test coverage: internal/agent 0% (572d7d4d), internal/pi contract vs real protocol + pin policy (af582760), markdown 0%/prompt 25%/bin/mnemo.ts no tests (0ada275f, edfe2f6a, b7b6c912); drop --test-force-exit masking (01c4ef84). (tui-go + agent) — DONE 2026-09-01: agent/markdown/prompt suites added (agent real message-order turn, markdown cache/render/re-wrap, prompt history/menu/queue basics); pi contract pinned to pi 0.84.4 docs/rpc.md verbatim fixtures incl. deliberate non-events; caret pin kept & drift risk documented as the tripwire (af582760); --test-force-exit dropped after the suite verified to exit cleanly on its own (373 pass, exit 0) (5275fa8).
- [ ] 12.15 low batch: MCP SIGTERM orphan (1c31b0fe), kernel limits (e4cc567c), embed retries stall RPC (6f96adc6), scope shadowing (b02291c2) **DONE 2026-09-01** — registry records ShadowEvent + warns on broader-scope shadowing, manifest refs escape bundle dir (dcd8c081) **DONE 2026-09-01** — refs enforced relative/no-'..'/realpath-confined, watcher symlink (593e9a39) **DONE 2026-09-01** — realpath'd roots, escaping symlinks ignored+logged, doc go version (2bf9a1a9), CI drift checks (2f298097)
- [ ] 12.16 design confirmations (not defects): in-process unsandboxed harness (a739fbd8), in-kernel tools.* skip prompting (48236eda), embeddings egress (509e8ec5), kernel pipe attrs (467cb8ad)
NB: 4b24b4b0 (working-tree red) = AREA 10.5 schedules overlay in-flight/uncommitted — resolved by completing AREA 10.5 (6ec29a5), not as an audit fix.

## DONE (reference)

[x] Memory layer core+steering+sidecar (19+2 tests)
[x] Harness engine (19 tests)
[x] pi InteractiveMode migration (92 agent tests at merge)
[x] OpenCode/OpenRouter providers; eval 3/3 vs 0/3 on ox-alpha-free
[x] spawn_subagent hierarchical delegation (live-verified)
