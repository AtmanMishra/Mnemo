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
- Memory implements BRAIN-AREA specialization (hippocampus/cortex-style regions) — see
  research/brain-areas-design.md. Complete: node area column, routed search with soft
  cross-area discount, salience pain markers, consolidation into semantic lessons.
  Remaining: cockpit Memory pane groups by area (3.6, depends on Area 2 cockpit).
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
                Bins: memcli (REPL), memsrv (JSON-RPC sidecar over stdio — THE
                integration surface for agents), memeval (retrieval benchmark),
                mempolicy (learned steering evaluation). 44 tests (cargo test).
harness-engine/ TypeScript, zero deps. Dynamic tool-plugin system: createHarness()
                writes bundles (manifest.json + .mjs tool files) that agents can
                build for themselves at runtime; scoped registry; fs.watch
                hot-reload; safety gate (import scanning). 19 tests (npm test) —
                ONE test (watcher latency) is flaky/timing-based, passes on rerun.
agent/          TypeScript, runs on Node >=22.18 native TS stripping (no build step).
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
                212 tests (npm test).
tui/            Rust, ratatui. `mnemo-agent` — nav rail (Chat/Sessions/Memory/
                Agents/Skills/Logs) driven by pi's RPC mode: streams text/thinking/
                tool execution, shows delegation tree, memory search grouped by brain
                area, session/project drill-down. 179 tests.
plan.md         MASTER TASK TRACKER. 8 areas, checkboxes. READ THIS FIRST for "what's next".
DESIGN.md       Brand + TUI design system: wordmark, the Bengal mascot, palette,
                gutters, folding, motion, keys.
docs/           ARCHITECTURE / DATAFLOW / KERNEL / PI-INTEGRATION / MEMORY —
                deep docs with mermaid diagrams.
STATUS.md       Outcomes/verification log + doc index. Read for "what happened and why".
research/       Design docs, one file per topic (see STATUS.md's doc index table).
AGENTS.md       Repo-root instructions pi auto-loads into every Mnemo session.
```

## 3. How to run things
```bash
# The full app (TUI with onboarding wizard, auth inside the runtime)
cd tui && cargo run --bin mnemo-agent

# Memory-layer tools (all live CLI tools, no dependencies on the agent)
cd memory-layer
cargo run --bin memcli                          # memory REPL
cargo run --bin memsrv <journal-path>           # JSON-RPC sidecar (see §5 protocol)
cargo run --bin memeval                         # retrieval benchmark
cargo run --bin mempolicy                       # learned steering evaluation

# Agent CLI (mnemo-agent spawns this in --mode rpc; these are the other modes)
cd ../agent && node ./bin/mnemo.ts "<prompt>"   # one-shot; how sub-agents run
node ./bin/mnemo.ts auth status                 # provider/key table
node ./bin/mnemo.ts traces [session]            # span trees, --json for raw
node ./bin/mnemo.ts consolidate                 # replay episodes into semantic lessons
npm test                                         # 212 tests, must NOT hang
npx tsc --noEmit                                # must be clean

# Test suites
cd ../memory-layer && cargo test                # 44 tests
cd ../tui && cargo test                         # 179 tests
cd ../harness-engine && npm test                # 19 tests (1 flaky, rerun if red)
```

## 4. Current state (verified at HEAD 7483d25)
- ALL 4 codebases green: agent 204, memory-layer 44, tui 179, harness-engine 19
  (479 total). Working tree clean, everything pushed.
- All 8 plan areas complete (every plan.md checkbox ticked): auth, cockpit,
  brain-area memory, agent capabilities, tracing, packaging, quality, and the
  one-app rework that made mnemo-agent the only thing you run.
- Live-verified end-to-end on a real LLM (ox-alpha-free / OpenCode): memory
  write+search+recall, hierarchical spawn_subagent delegation (child writes to
  the SAME shared journal), agent building its OWN harness plugin at runtime
  and it becoming a discoverable skill immediately.
- Eval: retrieval Hit@1 82% / Hit@3 95% (real embeddings) vs 68% / 73%
  (hashing fallback), n=22 with brain areas in the corpus. The older 93% was a
  15-case, single-area corpus — not the same measurement.
- The 3/3-with-memory vs 0/3-without task result predates the eval expansion to
  5 pairs and has NOT been re-run. The stored default is now deepseek-v4-flash
  via opencode-go (~/.mnemo/auth.json). Re-run
  `node agent/eval/memory-eval.mjs` to re-measure (uses the stored default
  unless MNEMO_MODEL is set).

## 5. memsrv protocol (the memory integration surface)
Line-delimited JSON over stdio. `{"id":N,"method":"M","params":{...}}` ->
`{"id":N,"ok":true,"result":...}` or `{"ok":false,"error":"..."}`.
Methods: ping · dump · state{node} · search{query,k} (returns label+kind+state per
hit, NOT just scores — this was a real bug once, see §6) · create_node{kind,label,area?} ·
episode{label,area?} · fact{node,key,value} · link{src,dst} · commit_log{node,kind,detail} ·
steer{episode,failure,fix?{node,fact,new_key,new_value}} · set_area{node,area} · good{episode,detail} · consolidate · exit.

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

## 7. What's NOT done
plan.md's 7 areas are complete. Open threads awaiting real-world validation:
- Area 7.2: real retrieval misses left failing rather than tuned away. The
  clearest is "who gets paged when latency spikes", which does not retrieve
  "alert routing" at all. (Separately, two failure-shaped queries now accept
  either the aspect or the salience pain marker, because after 3.4 both answers
  are defensible — those are not counted as misses.)
- Area 7.3: steering policy learned from journal replay — awaiting a journal with
  real failures to train on.

## 8. Rules of engagement
- memory-layer/, harness-engine/, agent/, tui/ can all be edited — this is one
  actively-developed monorepo, not four separate teams' turf.
- Always run the relevant test suite + typecheck before considering a change done.
- Update plan.md checkboxes AND append a short outcome note to STATUS.md for any
  completed task — these are the persistent memory of THIS project, be as
  disciplined about them as Mnemo itself is about its own memory graph.
- Verify claims independently before trusting them (this project has a track record
  of "done" reports needing correction — treat your own work the same way).
