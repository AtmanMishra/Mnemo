# MNEMO — SESSION HANDOFF
Entry point for a new agent (or human) picking up this project cold.
Repo: https://github.com/AtmanMishra/self-evolving-agent (private) · HEAD: 31c3c08 · branch: main

## 1. What this project is
MNEMO (Mnemosyne, Greek goddess of memory) — an agentic coding + harness assistant,
terminal-native, single-command (`mnemo`). Core thesis: SMALL/LOCAL models can reach
frontier-level performance through accumulated memory, experience, and hierarchical
collaboration, instead of raw model scale. Proven live: 3/3 task success WITH memory
vs 0/3 WITHOUT, on a free model (ox-alpha-free via OpenCode).

Design pillars (do not relitigate without reading the research docs):
- Memory = a GRAPH, not a vector DB. Nodes have facts/state/log/context; edges get
  created/deleted/reweighted by a steering engine when things fail.
- Memory is evolving toward BRAIN-AREA specialization (hippocampus/cortex-style
  regions) — see research/brain-areas-design.md. NOT implemented yet (Area 3).
- The agent runtime is NOT hand-rolled — it wraps pi (`@earendil-works/pi-coding-agent`,
  the same framework prime-agent runs on) via `main(args, {extensionFactories})`.
  Our tools/memory/approval inject as inline extensions. Do not rebuild streaming,
  markdown rendering, thinking blocks, compaction, or session management — pi has them.
- UI identity: PIXEL design system (PICO-8 palette, Silkscreen/VT323 fonts, animations
  allowed) — see research/mnemo-ui-identity.md.

## 2. Repo map (4 independent codebases + docs)
```
memory-layer/   Rust. Graph memory engine: nodes{facts,state,log,context}, typed
                edges, steering, HNSW+hashing/OpenRouter embeddings.
                Bins: memcli (REPL), memtui (ratatui dashboard), memsrv (JSON-RPC
                sidecar over stdio — THE integration surface for agents), memeval
                (retrieval benchmark). 19 tests (cargo test).
harness-engine/ TypeScript, zero deps. Dynamic tool-plugin system: createHarness()
                writes bundles (manifest.json + .mjs tool files) that agents can
                build for themselves at runtime; scoped registry; fs.watch
                hot-reload; safety gate (import scanning). 19 tests (npm test) —
                ONE test (watcher latency) is flaky/timing-based, passes on rerun.
agent/          TypeScript, runs on Node >=22.6 native TS stripping (no build step).
                THE Mnemo CLI. bin/mnemo.ts is a thin shim over pi's main().
                src/auth/       credential store + wizard (~/.mnemo/auth.json)
                src/tools/      all Mnemo tools (bash/fs/skills/harness/subagent/
                                memory), structurally = pi ToolDefinition
                extensions/     inline extensions pi loads: sea-tools-inline
                                (registers all tools), memory-layer (episode/log
                                lifecycle + persistent-memory system-prompt
                                directive), approval-gate (y/n on mutating tools)
                src/skills/     SKILL.md discovery at pi's standard locations +
                                harness-bridge (harness bundles -> discoverable skills)
                102 tests (npm test).
tui/            Rust, ratatui. `seatui` — INLINE REPL (like Claude Code/Codex, NOT
                an alt-screen dashboard): scrollback + slim bottom input/status bar.
                Superseded goal: becomes the shell for a unified COCKPIT (nav rail:
                Chat/Memory/Agents/Skills/Logs) — NOT built yet (Area 2). 23 tests.
plan.md         MASTER TASK TRACKER. 7 areas, checkboxes. READ THIS FIRST for "what's next".
STATUS.md       Outcomes/verification log + doc index. Read for "what happened and why".
research/       Design docs, one file per topic (see STATUS.md's doc index table).
AGENTS.md       Repo-root instructions pi auto-loads into every Mnemo session.
```

## 3. How to run things
```bash
# one-time setup (or: mnemo auth  — interactive wizard)
mkdir -p ~/.mnemo && cat > ~/.mnemo/auth.json <<'EOF'
{"version":1,"providers":{"opencode-go":{"kind":"api_key","key":"<KEY>",
 "defaultModel":"ox-alpha-free","updated_at":0}},"defaultProvider":"opencode-go"}
EOF

cd agent && node ./bin/mnemo.ts                 # interactive (pi InteractiveMode)
node ./bin/mnemo.ts "<prompt>"                  # one-shot
node ./bin/mnemo.ts auth status                 # provider/key table
npm test                                         # 102 tests, ~1s, must NOT hang
npx tsc --noEmit                                 # must be clean

cd ../memory-layer
cargo test                                       # 19 tests
cargo run --bin memcli                           # memory REPL
cargo run --bin memtui                           # memory dashboard (? = help)
cargo run --bin memsrv <journal-path>             # JSON-RPC sidecar (see §5 protocol)

cd ../tui && cargo run --bin seatui              # inline chat TUI
cd ../harness-engine && npm test                 # 19 tests (1 flaky, rerun if red)
```

## 4. Current state (verified at HEAD 31c3c08)
- ALL 4 codebases green: agent 102, memory-layer 19, tui 23, harness-engine 19
  (163 total). Working tree clean, everything pushed.
- Area 1 (Auth & Onboarding) COMPLETE: `mnemo "<prompt>"` works with ZERO
  environment variables — credentials resolve from `~/.mnemo/auth.json`.
- Live-verified end-to-end on a real LLM (ox-alpha-free / OpenCode): memory
  write+search+recall, hierarchical spawn_subagent delegation (child writes to
  the SAME shared journal), agent building its OWN harness plugin at runtime
  and it becoming a discoverable skill immediately.
- Eval: retrieval Hit@1 80% (real embeddings) vs 53% (hashing fallback);
  task-level 3/3 WITH memory vs 0/3 WITHOUT (agent/eval/memory-eval.mjs).

## 5. memsrv protocol (the memory integration surface)
Line-delimited JSON over stdio. `{"id":N,"method":"M","params":{...}}` ->
`{"id":N,"ok":true,"result":...}` or `{"ok":false,"error":"..."}`.
Methods: ping · dump · state{node} · search{query,k} (returns label+kind+state per
hit, NOT just scores — this was a real bug once, see §6) · create_node{kind,label} ·
episode{label} · fact{node,key,value} · link{src,dst} · commit_log{node,kind,detail} ·
steer{episode,failure,fix?{node,fact,new_key,new_value}} · good{episode,detail} · exit.

## 6. Hard-won lessons (do not repeat these mistakes)
1. NEVER hardcode API keys in any script/file, even "temporary" ones — one leaked
   into a git commit and required a `git reset --soft` + force-push to purge. Keys
   live ONLY in gitignored `.env` (memory-layer/) or `~/.mnemo/auth.json`.
2. Before ANY push: `git diff --cached | grep -q "sk-"` sanity check. Make it a habit.
3. `npm test` CAN HANG. Root causes seen so far: (a) readline/stdin lifecycle bugs
   in scripted tests — a stream that runs dry leaves `question()` pending forever;
   fix pattern: resolve on stream 'close', or better, use fully deterministic
   array-based fakes instead of real streams in tests. (b) A wizard/store function
   forgetting to pass an injected `home`/`root` param wrote to the REAL machine
   state instead of the test's temp dir — caused cross-test pollution AND leaked
   fake test credentials into the real `~/.mnemo/auth.json` once. ALWAYS thread
   test-provided paths through every function in the call chain; grep for bare
   `os.homedir()`/`process.cwd()` calls inside anything a test also calls.
4. Skill/harness discovery walks ancestor directories up to the git root — tests
   that don't isolate cwd/home WILL pick up this repo's own `.agents/skills/`
   (tui-design, graft, etc.) and fail nondeterministically. Use
   `setProjectRoot()`/`setSkillsHome()` overrides in every skills test.
5. Mixing Python and `%%bash` in one Jupyter cell silently no-ops the bash part
   with a confusing SyntaxError — always split into separate cells.
6. `search()` results MUST include the actual content (label/state), not just
   node ids + scores — an LLM cannot act on a bare similarity score. This was a
   real bug that made eval scores look like model-capability failure when it was
   actually an API contract failure.
7. pi's direct-invocation guard (`import.meta.url === ...`) must be checked in
   the actual ENTRY file, not a file it imports — file-URL comparison only works
   at the true entrypoint.

## 7. What's NOT done (see plan.md for the authoritative live list)
- Area 1.5: verify pi's in-TUI `/login` lists our providers (quick check)
- Area 2 (0/9): the unified COCKPIT TUI — nav rail (Chat/Memory/Agents/Skills/Logs),
  driven via pi's RPC mode instead of REPL scraping. This is the biggest lift (~1-2wk).
- Area 3 (0/6): brain-area memory — add `area` column to nodes, route search by
  region, salience markers, consolidation job. Rust-only, no LLM needed, high value,
  self-contained — GOOD STARTING POINT for a fresh session.
- Area 4 (0/5): MCP bridge, web search tool, permission rule engine, plan mode,
  image input.
- Area 5 (0/7): structured logging/tracing — spans for tool calls and LLM round
  trips, `mnemo traces` CLI, subagent correlation, redaction.
- Area 6 (0/3): packaging — `npm i -g`, node version guard, README quickstart.
- Area 7 (0/3): CI, bigger eval suite, learned steering policy.

## 8. Rules of engagement
- memory-layer/, harness-engine/, agent/, tui/ can all be edited — this is one
  actively-developed monorepo, not four separate teams' turf.
- Always run the relevant test suite + typecheck before considering a change done.
- Update plan.md checkboxes AND append a short outcome note to STATUS.md for any
  completed task — these are the persistent memory of THIS project, be as
  disciplined about them as Mnemo itself is about its own memory graph.
- Verify claims independently before trusting them (this project has a track record
  of "done" reports needing correction — treat your own work the same way).
