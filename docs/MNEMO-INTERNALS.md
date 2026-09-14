# Mnemo internals — the detailed document

*For changing Mnemo rather than using it: the memory model and its algorithms,
the agent runtime and its protocols, the interface's structure, the rules that
decide design questions, and the failure modes that have already cost someone a
day.*

Companion: `docs/MNEMO.md` (high level). Superseded material is in
`docs/archive/`.

---

## 1. Process topology

```
terminal ─▶ mnemo (Go TUI)
              │  stdin/stdout, JSONL — pi RPC commands + events
              ▼
            node agent/bin/mnemo.ts --mode rpc --no-builtin-tools
              ├── stdin/stdout JSON-RPC ─▶ memsrv (Rust)  ──▶ journal.jsonl (locked)
              ├── stdin/stdout JSONL     ─▶ python3 agent/kernel/ipy_bridge.py
              ├── stdio JSON-RPC 2.0     ─▶ MCP servers
              └── spawn (print mode)     ─▶ child mnemo.ts  (subagent, own memsrv, same journal)
```

Four boundaries, one shape: one JSON object per line, a line-buffered reader on
the far side. The cost is four near-identical request/response correlators; the
payoff is no protocol dependency, recorded-lines testability, and a pipe a human
can read.

**Sessions vs memory.** `~/.pi/agent/sessions/<encoded-cwd>/*.jsonl` are
conversations (pi writes them, keyed by working directory — which is why the TUI
spawns the agent with `cmd.Dir` set to the project). The memory journal is
cross-session and cross-project. Neither is derivable from the other.

---

## 2. The memory layer (`memory-layer/`, Rust)

### 2.1 The model

`src/model.rs` defines everything. A **Node** has a `NodeKind`
(`Aspect`/`TaskEpisode`/`Entity`/`Harness`/`Outcome`), an `Area`, a `label`, a
list of `Fact`s, an append-only `log` of `LogEntry`, and a `context` field that
is explicitly **derived** and never journaled. A **Fact** is a key/value pair
with `Active`/`Superseded` status: superseding flips the status and records
`superseded_by`, so history survives. An **Edge** is typed
(`SuppliesContext`, `PartOf`, `DerivedFrom`, `Supersedes`, `ActivatedWith`),
weighted, directional, with success/failure counters and `valid_from`/
`invalid_at` — `Unlink` is a soft kill, and `Edge::alive_at(t)` is the three
checks anything reading "now" needs.

Eleven `Op` variants are the **only** way state changes: `CreateNode`,
`AddFact`, `SupersedeFact`, `SetArea`, `DeleteNode`, `Link`, `Unlink`,
`Reweight`, `RecordOutcome`, `PushContext`, `CommitLog`. `StoreData::apply` is
the single place they take effect; `persist::replay` folds the journal back into
a store. *Replay(ops) == state* is an invariant stated on the enum, and it is
what makes the journal — not any in-memory structure — the source of truth.
`DeleteNode` is soft by default; nothing in the design can erase knowledge.

Every writer (memsrv, memcli, a subagent's memsrv) takes an advisory `fd_lock`
on the sibling `.lock` file around each append, which is why several processes
share one journal without interleaving partial lines.

### 2.2 Brain areas and routing

Six areas, each mapped to a structure in the source comments: `Episodic`
(hippocampus: episodes, outcomes), `Semantic` (neocortex: aspect facts — the
default), `Procedural` (cerebellum: harnesses, skills), `Spatial` (parietal:
repos, paths, services), `Salience` (amygdala: pain markers), `Executive`
(prefrontal: steering decisions). Area defaults from kind via `Area::for_kind`
and can be overridden at creation or later via `Op::SetArea` — which is how
Salience and Executive nodes exist at all, since neither has a dedicated kind.

`route_query` scores areas by literal cue phrases, keeps the top two non-zero
ones, and returns empty ("search everywhere") if nothing matches. Routing
**biases** rather than filters: `SearchOpts` separates `areas` (a hard filter)
from `prefer` (the routed areas), and out-of-area nodes are scaled by
`CROSS_AREA_DISCOUNT = 0.85` — low enough to reorder near-ties, high enough that
a mis-routed query still finds its node. The router is a keyword heuristic and
will be wrong; the discount is why that is survivable.

### 2.3 Retrieval

`search()` embeds the query, scores every live node by cosine (brute force,
"fine to ~100k nodes"), filters, sorts, takes `k`. Then `expand()` does one hop
of graph-aware rerank: neighbours along live `PartOf`/`SuppliesContext`/
`ActivatedWith`/`DerivedFrom` edges score `seed × 0.5 × max(edge_weight, 0.1)`,
and dead edges propagate nothing. A neighbour that fails the area/kind filter is
dropped even when reached from a passing seed — "a filtered-out node must not
sneak back in as a neighbour". `search_ann` (HNSW) exists with a test proving
agreement with brute force, but `memsrv` calls the brute-force path.

Embeddings are pluggable. `HashingEmbedder` (256-dim, deterministic, offline) is
the default; the OpenRouter embedder (1024-dim, `lfm-2.5-embedding-350m:free`)
activates when a key is present **and** `SEA_MEMORY_REMOTE=1` is set by the
agent-side client. The disk cache is keyed `sha256(model ‖ text)`; vectors are
derived, so switching embedders costs one reindex and nothing else. Measured:
68%/73%/0.697 (hash) vs 82%/95% (real) on the eval corpus.

### 2.4 Steering — how failure becomes structure

`steer()` is a pure planner returning `Vec<Op>` + notes; the caller journals
them, so steered histories replay exactly. In order:

1. **Log** the failure on the episode (always).
2. **Pain marker, unconditionally, before any decision** — a new `Aspect` node
   forced to `Salience` with a `failure` fact, linked `DerivedFrom` and
   deliberately *not* `SuppliesContext`, so a pain marker can never become a
   blame target for the next failure. "Amygdala logic: capture that it hurt,
   cheaply and unconditionally."
3. **Blame** — every live `SuppliesContext` feeder of the episode is checked for
   lexical token overlap with the failure text; an implicated feeder gets
   `RecordOutcome{success:false}` (−0.10 weight).
4. **Correction**, if the caller supplied one (`fix: {node, fact, new_key,
   new_value}`) — a `SupersedeFact`, validated first (the target fact must exist
   and be active).
5. **Switch** — if a blamed edge's projected weight falls below
   `SWITCH_THRESHOLD = 0.2` and another live feeder above it exists, unlink the
   bad edge and link the alternate.
6. **Gap** — if nothing was implicated and there was no correction, create a
   `gap: <tokens>` node wired as a new feeder, so a failure nobody can explain
   still leaves a trace.

`reinforce()` is the mirror: log, then `RecordOutcome{success:true}` (+0.05) on
every live feeder.

### 2.5 Consolidation

`consolidate()` replays `Episodic` + `Salience` nodes, tokenises labels and
active facts (stopwords dropped), and treats a token as a recurring theme at
`DEFAULT_MIN_SOURCES_FOR_THEME = 2` distinct sources (`MNEMO_MIN_OCCURRENCES`
overrides it). Groups survive only if their members
share `MIN_SHARED_TOKENS = 2` tokens — "two sources that share only 'checkout'
are the same project, not the same lesson". Surviving groups become `Semantic`
lesson nodes; re-running emits nothing unless the sources changed (idempotent by
construction). It is pure memory-layer work: no model, no network, exposed as
`memsrv`'s `consolidate` and `mnemo consolidate`.

### 2.6 Wrappers and feedback

`recall_brief(query)` returns a ready-to-inject block (routed areas, top-k hits
with state text *always* inlined — never bare scores — and a provenance line).
`remember(summary)` auto-routes an area and creates node + fact + log in one
call. Usefulness is captured as `useful`/`unhelpful` counters on nodes
(`Op::RecordUsefulness`), applied as a `(useful − unhelpful) × 0.02` score bias
— zero votes, zero bias, so the eval is untouched until real signal exists.
Votes deliberately do **not** enter `node_text`: a heavily-voted node would
otherwise drift away from its own topic, since the embedding includes the last
few log lines.

### 2.7 `memsrv` — the only integration surface

Line-JSON-RPC over stdio: `{"id":N,"method":"M","params":{…}}` →
`{"id":N,"ok":true,"result":…}`. It replays the journal on startup, opens an
embedder, and serves one request per line until `exit`. Methods: `ping`, `dump`,
`state`, `search`, `create_node`, `episode`, `fact`, `link`, `commit_log`,
`steer`, `set_area`, `good`, `consolidate`, `mark_useful`, `stats`, `remember`,
`recall_brief`, plus the audit-era additions (`unlink`, `reweight`,
`record_outcome`). Search results carry label, kind, area and state text — the
project learned once that ids plus scores are useless to a model. Clients:
`agent/extensions/memory-layer.ts` (FIFO-queued, lazily spawned, agent tools),
`agent/src/hooks/memory.ts` (the hooks sync), and `tui-go/internal/memory`
(one reader loop, timeouts that do not leak, fail-fast on a dead sidecar).
`memcli`, `memeval` and `mempolicy` are scripting/eval binaries that work on a
journal directly.

### 2.8 Evals

`memeval` reports Hit@1 / Hit@3 / MRR over a corpus of question → expected-node
cases. `--hash` forces the deterministic embedder: the numbers are the gate
(73% / 77% / 0.743, n=22) and every retrieval change is measured before and
after. Real misses are left failing on purpose rather than tuned away; the one
case that was closed (a paging query → alert routing) was closed by a measured
query-side alias map that moved Hit@1 68→73% with the other 21 rows
byte-identical. `mempolicy` trains a learned steering policy from journal
replay; on the real journal it reports "nothing to learn from" because the
training rows were never emitted — that is finding M13 in
`research/agentic-capability-review.md`.

---

## 3. The agent runtime (`agent/`)

### 3.1 The pi shim and the four extensions

`bin/mnemo.ts` is a shim: a Node-version guard, local subcommands
(`auth status|logout`, `traces`, `consolidate`, `schedule …`, `--list-sessions`,
`--list-models`) that need no provider, then `main(args, {extensionFactories})`
from `@earendil-works/pi-coding-agent`. `--no-builtin-tools` is passed so the
only tools in a session are Mnemo's — which is why Mnemo has its own
`bash_exec`/`read_file`/`write_file`/`apply_edit`: they carry the permission and
approval integration pi's built-ins do not know about.

Four `InlineExtension`s (inline = shipped with the binary, no per-user install,
identical in every mode):

| extension | hooks it uses |
|---|---|
| `sea-tools-inline` | registers every tool; wires the kernel dispatcher |
| `sea-memory` (`memory-layer.ts`) | `session_start` (episode), `before_agent_start` (directive + recall), `tool_execution_end` (episode log), `turn_end`, `session_shutdown` (consolidate) |
| `approval-gate` | `tool_call` — the only hook that can **block**; permission rules, plan mode, and an approval dialog the interface answers over pi's extension-UI protocol |
| `tracing` | `tool_call`/`tool_result`, `turn_start`/`turn_end`, session span |
| (`hooks-inline`, `schedules-inline`) | the hooks engine and the scheduler, including `/hook`, `/schedule`, `/trigger`, `/now` commands |

### 3.2 Tools

`allTools` (16) from `src/tools/index.ts` — `bash_exec`, `read_file`,
`write_file`, `apply_edit`, `glob_list`, `ipy_run`, `list_skills`, `load_skill`,
`create_skill`, `patch_skill`, `retire_skill`, `spawn_subagent`, `create_harness`,
`web_fetch`, `web_search`, `read_image` — plus three memory tools, MCP tools
discovered before `main()` runs, and whatever a harness bundle adds at runtime.
`web_search`/`web_fetch` are registered at `session_start` only if a
globally-installed pi package has not already claimed those names, because two
tools with one name make pi refuse the whole extension and kill the session at
startup.

`patch_skill` is the self-improvement seam and is deliberately hard to use
wrong: it needs a stated reason and at least one piece of memory evidence, edits
by anchored replacement (whole-file rewrites are not offered), refuses a stale
`expectedHash`, refuses a path outside `~/.pi/agent/skills` and project
`.agents/skills` (never `.claude/`, never a package directory), refuses an
anchor that is not unique, refuses a result with broken frontmatter or one that
stops the skill being discoverable — and writes a timestamped copy of the
previous body under `~/.mnemo/skill-history/<name>/` first, so every patch is
reversible without git. `retire_skill` marks a skill retired instead of deleting
it. The loop that decides *when* to patch is J11 in
`research/memory-runtime-design.md`.

### 3.3 The Python kernel — programmatic tool calling

`ipy_run` submits a program to a persistent kernel
(`agent/kernel/ipy_bridge.py`) over line-JSON. From inside, `tools.<name>(…)`
sends an out-of-band `tool_call` line and blocks for the reply;
`tools.parallel([…])` does the same in bounded waves of
`MAX_PARALLEL_TOOL_CALLS = 8`. Each in-kernel call goes through the **same**
`decideApproval` gate as a normal call (`src/tools/kernel_tools.ts`), so deny
rules and plan mode hold inside generated code; an `ask` resolves to allow
because no `ctx.ui` is reachable from the kernel, which is the same behaviour a
non-TTY run gets. The dispatcher includes the memory and MCP tools, so a program
can search memory, spawn subagents and build harnesses.

Mechanics worth knowing: output capture uses `redirect_stdout`, so the protocol
writes on the *raw* file objects captured at startup — otherwise a `print()`
would be swallowed into the result field and a tool call would be captured
instead of delivered. A cell past its `timeout_ms` (120s default) kills the
kernel; the next call transparently respawns an empty namespace. No per-call
timeout exists on the in-kernel channel (issue #6), and the process has no
memory/CPU bounds (issue #11).

### 3.4 Subagents

`spawn_subagent` spawns a complete second `mnemo.ts` in print mode with a
parent-composed brief (never the parent's transcript), a hard timeout, and
`ANSWER:` extraction from stdout. The child inherits the memory journal path and
the trace parent ids through an explicit `childMemoryEnv()`, so it reads and
writes the *same graph* and its spans nest under the call that spawned it. An
optional `model` parameter must resolve against a logged-in provider's catalogue
or the call **fails loudly** — a silent fallback would look like it worked.

### 3.5 Skills, hooks, schedules

**Skills**: `SKILL.md` with frontmatter, discovered from the same roots the TUI
walks (`.claude`/`.pi`/`.agents`, project-first), creatable by the agent
(`create_skill`), and auto-populated by harness bundles through the bridge.

**Hooks** (`agent/src/hooks/`): manifests with `{id, trigger, matcher{tool,
path}, command, timeout, on{block,audit,modify}}`, scoped project → user →
global, at most one per id with the nearest winning, and disabled state in
`~/.mnemo/hook-state.json`. Execution: `sh -c`, JSON event on stdin, exit 0 =
allow (stdout JSON is the response), exit 2 = block with the stderr reason shown
to the model, anything else or a timeout = allow + an audited error — "a stuck
hook never breaks the loop". Every invocation writes a redacted `hook` span into
the same trace file as everything else. Currently Unix-only (issue #2).

**Schedules** (`agent/src/schedule/`): `~/.mnemo/schedules.json`, cron/interval
parsing, a daemon with an `O_EXCL` pid lease so two daemons cannot double-fire,
and triggers `on_failure`, `on_uncommitted`, `on_cost_over` (fires; nothing acts
on it — issue #8) and `on_push` (deferred). Each tick's work becomes an episode,
so scheduled sessions steer and consolidate like interactive ones.

### 3.6 Tracing, permissions, MCP

**Tracing**: one JSONL file per day in `~/.mnemo/logs`; spans carry
id/parent/timing/attrs so tool calls nest in model round-trips and subagent runs
nest in the spawn that started them. Redaction runs before every write — secret
*shaped* values and the process's own live env values — with a test asserting
the file on disk never contains the key.

**Permissions**: `~/.mnemo/permissions.json`, ordered `{tool, pattern, action}`
rules, first match wins; the glob matches the argument that makes a call
dangerous, not a rendered summary. Deny is enforced with or without a TTY; plan
mode is synthesised *as rules* (read-only allows, everything else denied and
prepended so a user's allow cannot punch through).

**MCP**: `~/.mnemo/mcp.json`, spoken directly (initialize → tools/list →
tools/call) rather than through the SDK, because the transport is the same shape
as the other three. A server that fails to start is reported, never fatal.

---

## 4. The interface (`tui-go/`)

One Elm-style loop, one root model, sub-models that own their state. Package
map: `theme` (palette/glyphs/styles — nothing else names a colour), `brand`
(mascot + wordmark as marker strings), `tree` (one hierarchy used by folders,
sessions and memories), `chat` (the transcript: blocks, folding, focus,
wrapping, search), `ui` (rules, bands, chips), `keymap` (every binding; help and
the palette render from it), `overlay` (one modal contract), `session` (pi's
stored sessions), `filetree`, `prompt`, `agent` (the backend boundary),
`pi` (RPC behind it), `markdown` (glamour + cache keyed by content width and
line count).

Two structural rules. **One owner for layout math**: `app/view.go`'s `rows()`
computes every region boundary in one place — two functions computing it
separately disagreed by one row once, and click hit-testing plus the cursor both
broke. **`Next()` re-arms the backend**: the agent is driven by being asked for
its next message, and every branch that handles an agent message re-arms it, in
one place — forgetting once stops the stream with no error anywhere.

The command surface is one list (`internal/command`): built-ins with their
chords, skills/plugins/harness bundles discovered on disk, and — on a live
session — whatever pi answers to `get_commands`, merged rather than substituted.
An unknown name with a live backend is routed to pi verbatim (that is what
executes an extension command and expands a prompt template); with no backend,
the refusal stands. `--dump` renders a frame to stdout for tests and
screenshots, and `app/testdata/golden/*.txt` pins four scenarios byte-for-byte
(text only — colour is not part of the contract, and the frames are LF
everywhere via `.gitattributes`).

---

## 5. The harness engine (`harness-engine/`)

A bundle is a directory: `manifest.json` plus `tools/*.mjs`, each module
default-exporting `{name, description, schema, execute}`. `loadBundle` is the
single gated entry point every caller goes through (create, watcher, CLI), so a
bundle that appears on disk is gated as hard as one created through the API. The
gate scans static/dynamic imports and `require`, rejects non-literal specifiers,
blocks `fs`/`child_process`/net-class/host-info modules, rejects direct
`process` access, confines relative imports to the bundle directory (lexically
and after realpath, depth 3), and syntax-checks before import — fail-closed
everywhere. It does **not** sandbox: registered tools run in-process with full
privileges (issue #7). The registry layers session/project/global scopes with
the nearest winning, shadows loudly via `ShadowEvent`, and the watcher re-gates
on rewrite.

---

## 6. Invariants

These decide design questions before they are asked:

1. **The journal is the source of truth.** Anything derived (vectors, state
   text, embeddings) can be recomputed; nothing derived may be the only copy.
2. **Supersede, never delete.** Facts, edges and nodes are retired, not erased.
3. **The model never chooses ops.** Planners compute `Op`s; models fill content.
4. **Memory never breaks the loop.** Every memory call is try/caught; a missing
   sidecar degrades to "no memory" and says so.
5. **Config is a parameter, never a lookup.** `home`, `cwd`, journal and sidecar
   paths are fields on `Config`/options, because a function that finds its own
   home finds the developer's in a test.
6. **Prompt caching is a resource.** The tool list and system prompt are the
   cached prefix; changing them mid-session is a bug, not a feature.
7. **One list.** Commands, bindings, colours and layout each have exactly one
   owner. A second copy is how documentation starts lying.
8. **The gate is not a sandbox.** Say what is filtered and what is merely
   trusted, in the file that does it.

---

## 7. Testing

| Suite | Command | Notes |
|---|---|---|
| agent | `cd agent && npm test` (~389) + `npx tsc --noEmit` | fake pi event streams, injected temp homes, real memsrv over temp journals |
| memory-layer | `cd memory-layer && cargo test` (75 lib + integration) | concurrency, replay exactness, eval pins |
| tui-go | `cd tui-go && go test ./...` (20 packages) + `go vet` | golden frames, width sweeps, scripted backends |
| harness-engine | `cd harness-engine && npm test` | bundle lifecycle, gate rejections, watcher |

CI (`.github/workflows/ci.yml`) runs all four, the TUI suite on ubuntu + macos +
windows, and a credential-shaped-string scan of the working tree and the last
200 commits with an explicit exclusion list for redaction fixtures. Fixtures
follow two rules learned the hard way: **no shell scripts** (the stand-in
sidecars are the test binary re-executed with a JSON spec) and **no reliance on
POSIX permissions** (the unreadable-directory test uses a path that is not a
directory on Windows).

---

## 8. Extension points

| To add… | Touch |
|---|---|
| a tool | `agent/src/tools/<name>.ts`, export it in `index.ts`, register in `sea-tools-inline.ts` |
| a slash command (interface) | `tui-go/internal/command` built-ins + a case in `app/update.go`'s `runSlash` |
| a slash command (agent) | `pi.registerCommand` in an extension — it appears in the palette automatically once surfaced by `get_commands` |
| a memory area | `Area` in `memory-layer/src/model.rs` + `route_query` cues + `Area::for_kind` |
| a memory heuristic | a pure planner in `memory-layer/src/` returning `Vec<Op>`, exposed as an `memsrv` method |
| a UI overlay | `internal/overlay` + a case in `chooseOverlay`; render from `keymap` so help cannot drift |
| a hook | a manifest in `.mnemo/hooks/`, or `/hook add` |
| a scheduled job | `mnemo schedule add …` or `~/.mnemo/schedules.json` |
| a background memory job | `research/memory-runtime-design.md` (designed, not built) |

---

## 9. Failure modes already paid for

- **A model that never reads the pipe.** `search` returning bare scores taught
  this: results must carry the content, or the failure looks like model
  incompetence.
- **A fixture that spawns a shell.** It works on the author's machine and takes
  a whole package down on Windows.
- **CRLF in a byte-compared file.** `git status` cannot show it, because git
  normalises before comparing; the golden frame test can.
- **The sidecar's Windows name.** `memsrv` vs `memsrv.exe` is the difference
  between a working memory pane and one that silently reports nothing.
- **A pinned Node that cannot strip types.** 22.6 shipped the feature behind a
  flag; 22.18 is the floor, and CI pinned the wrong one for weeks.
- **An unhandled EPIPE on a hook that never reads stdin** — the exit code *is*
  the answer, and it was being thrown away with the write.
- **A test that asserts exact equality on an approximate algorithm.** The ANN
  comparison is flaky by construction (issue #12).
- **A gate that fails on its own fixtures.** A red security check is one people
  learn to skim; the exclusion list is part of the gate, not an embarrassment.
- **A requirement checked by memory instead of by tool.** "Enforce the
  platform's version floor" was true in prose and false in CI until it was run.
