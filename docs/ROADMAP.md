# Roadmap — from half-built to something a stranger can install

*Written 2026-10-08 against branch `rebuild/bun-app`. This is the task list.
`docs/REBUILD.md` says where the code is going, `docs/PLAN-monorepo.md` says how
it is laid out, `docs/HANDOFF.md` says where the last session stopped. This file
says what is left before Mnemo can be handed to a user, in the order to do it.*

## The direction (settled)

One Bun application is the program. Three runtimes, three jobs:

| Runtime | Job | Lives in |
|---|---|---|
| **Bun / TypeScript** | the interface, the agent loop and its tools, sessions, auth, policy, hooks, schedules, MCP, the harness engine | `app/` (today) → `packages/*` (later) |
| **Rust** | memory: the journal, recall, steering, consolidation, and the background jobs that improve the graph | `memory-layer/` (`memsrv`) |
| **Python** | execution: one long-lived ipy interpreter the agent drives to touch the system | `agent/kernel/ipy_bridge.py` (to move) |

**Legacy, kept only as a reference until parity is proven:** `tui-go/` (Go
interface), `agent/` (Node: tools, extensions, hooks, schedules, MCP, tracing),
`harness-engine/` (Node). They keep working on this branch, nothing is deleted on
the strength of a plan, and each is archived on its own branch once the Bun side
replaces it (see Stage 7).

**The product** is an agentic CLI in the family of Claude Code, Codex CLI and
Hermes whose difference is the memory: it reads each session, updates the graph,
steers it on failure, stores different kinds of facts, and writes and patches its
own skills. The interface is the table stakes; the memory is the reason to exist.
Both have to ship.

## Where things actually stand (updated 2026-10-08, prototype)

| Area | State |
|---|---|
| `app/` | **A working prototype.** Ink interface on pi 1.1's in-process SDK, with Mnemo's behaviour as six pi extensions (policy, memory, kernel, sub-agents, skills, trace). 103 tests pass, none skipped, `tsc` clean — including a cross-session test where what one session learns is in the next session's prompt. |
| Memory loop | profiles (project, user) injected every turn; search recall linked to the episode as feeders; tool/turn failures steer; clean runs reinforce; a reflection call after each run writes durable facts (a changed fact supersedes); consolidation at shutdown. |
| Install | `app/scripts/install.sh` builds `mnemo` + `memsrv` into `~/.mnemo/bin` and runs `mnemo doctor` (verified). No release pipeline for the Bun binary yet. |
| Not verified | a turn against a real provider (everything here ran on pi's faux model); Windows and macOS (CI job added, not run). |
| Legacy | `agent/`, `harness-engine/`, `tui-go/` still in the tree, no longer used by `app/`. |

## Decisions (answered 2026-10-08)

| # | Question | Answer |
|---|---|---|
| D1 | Agent loop | **pi is the loop.** Mnemo is built on pi's packages, in-process: `@earendil-works/pi-coding-agent` (SDK: `createAgentSessionRuntime`, sessions, tools, extensions, skills, prompt templates, compaction, `ModelRuntime` auth/models), which brings `pi-agent-core`, `pi-ai` and `pi-telemetry`. Pinned at **1.1.0** (was 0.84.4 over RPC). Mnemo's behaviour is added as pi inline extensions. |
| D2 | Where tools run | **In the app process**, through the SDK. pi's built-in tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) replace Mnemo's own file/shell tools; the approval gate and permissions become a `tool_call` extension over them. No child process, no RPC. |
| D3 | Distribution | **A compiled binary** (`bun build --compile`, ≈90 MB, verified to start with no Node or Bun on PATH), shipped through a one-line install script and an `npx`/`bunx` package that fetches the right binary; `memsrv` alongside. |
| D4 | Kernel | **No sandbox in v0.1.** A persistent interpreter behind the approval gate, said plainly in the README. |
| D5 | Monorepo | **After the port.** |
| D6 | v0.1 scope | **Simple first.** Hooks, schedules, MCP and the harness engine move to v0.2. |
| D7 | Interface toolkit | **Ink 8 + React 19** (what Claude Code and Gemini CLI use), replacing the hand-rolled terminal kit. Spec: `DESIGN.md`. |

**pi-durable** (1.1.0) is a different harness (crash-resumable conversations on
its own storage) and is marked experimental; `pi-coding-agent` does not use it.
v0.1 does not adopt it. It is the candidate for "resume a turn after a crash"
later, evaluated then against pi's own session files.

## Stages

Each task is one commit that leaves the branch green. `▢` open, `▣` done.
"Verify" is how you know, and none of them needs an API key.

### Stage 0 — Housekeeping (a day)

- ▣ 0.1 `app/` job in `.github/workflows/ci.yml`: bun install, `tsc`, `bun test`,
  compiled-binary frame, on ubuntu, macos, windows. *Still to verify:* its first
  run on a PR (Windows has never run this code).
- ▣ 0.2 Reconcile `plan.md` with this file (AREA 13 points here).
- ▣ 0.3 Record the decisions at the top of this file.
- ▣ 0.4 The `Bun 1.3.14` test and the RPC pi client are gone with the old
  terminal kit (Stage 1.0).

### Stage 1 — The interface (Ink, on pi's session)

Spec: `DESIGN.md`. Everything runs against a real pi `AgentSession`; tests use
pi-ai's faux provider, so none needs a key.

- ▣ 1.0 Replace the hand-rolled terminal kit and the RPC client with an Ink app
  on `createAgentSessionRuntime` (in-process, pi 1.1.0).
- ▣ 1.1 Transcript: user, assistant (markdown + highlighted code), thinking,
  tool calls with live status, edit diffs, bash output, notices; finished blocks
  go to scrollback (`<Static>`).
- ▣ 1.2 Working line: spinner, shimmering memory verbs, elapsed time, tokens,
  `esc to interrupt`; queue shown under it.
- ▣ 1.3 Input: multi-line editor, history, word/line deletion, paste; `enter`
  sends or queues, `esc`/`ctrl+c` interrupt.
- ▣ 1.4 Slash menu (built-ins + pi's extension commands, prompt templates,
  skills) and `@file` suggestions.
- ▣ 1.5 Dialogs (select, confirm, text) shared by Mnemo and pi extensions via
  the extension UI context; `/login` is pi's login flow (API keys + OAuth)
  through them; `/model`, `/logout`, `/thinking`.
- ▣ 1.6 Footer: model, thinking level, context %, cost, git branch.
- ▣ 1.7 Sessions: `/new`, `/resume` (pi's session list), `/compact`.
- ▢ 1.8 `ctrl+o` expand/collapse for thinking and tool output already printed
  (today it applies to blocks printed after the toggle).
- ▣ 1.9 Memory blocks (`◈ Recalled`, `◈ Learned`, `◈ Memory noted the failure`).
- ▣ 1.9a First run with no credentials says `/login` (pi reports a placeholder
  model, so "has a model" means "its provider has auth").
- ▢ 1.10 A visual pass in three real terminals (iTerm2/Ghostty, Windows
  Terminal, a 16-colour fallback) with screenshots in `docs/`.

### Stage 2 — Mnemo's behaviour as pi extensions

`agent/` (Node) is the specification; its tests travel with each module. pi's
built-in tools replace Mnemo's own file and shell tools (D2).

- ▣ 2.1 **Paths and settings**: `$MNEMO_HOME/agent` as pi's agent dir (auth,
  settings, sessions, skills, prompts); memsrv/journal/python discovery.
  ▢ importing keys from the legacy `~/.mnemo/auth.json` is not done.
- ▣ 2.2 **Policy extension**: permissions rules (first-match), plan mode as rules,
  approval through `ctx.ui.confirm`, grants store, bash-token matching, path
  containment *(audit 12.5, 12.6 — port the tests, not just the code)*. Built as
  modes (default / accept-edits / plan / yolo) + `permissions.json` rules +
  per-project grants + an approval dialog with feedback.
- ▣ 2.3 **Memory extension**: memsrv client, `session_start` episode,
  `before_agent_start` recall + directive, `tool_execution_end` log,
  `turn_end`, `session_shutdown` consolidate; the three memory tools.
- ▣ 2.4 **Kernel tool** (`ipy_run`) + in-kernel `tools.*` through the same gate;
  `ipy_bridge.py` embedded in the binary and written out on first use.
- ▣ 2.5 **Tracing**: redacted JSONL records per tool call and turn in
  `~/.mnemo/logs`. ▢ a `pi-telemetry` adapter and `mnemo traces` are not done.
- ▣ 2.6 **Subagents**: `spawn_subagent` as an in-process child session (no
  second process), depth cap, shared journal, model override that fails loudly.
- ▣ 2.7 **Skills**: pi discovers and loads them; `create_skill` and
  `update_skill` (with history, reloaded after the run) are built.
  ▢ evidence-gating and `retire_skill` are not.
- ▣ 2.8 Subcommands: `doctor`, `-p`, `-c`, `--plan`, `--yolo`, `--no-memory`,
  `--demo`, `--dump`. ▢ `consolidate` and `traces` subcommands are not done.
- ▢ 2.9 *(v0.2)* hooks, schedules, MCP (`pi-mcp`), harness engine, `init`, `pr`.

*Verify (stage):* each extension tested against a faux-provider session; the
constraint-compliance eval (`scripts/eval-constraint-compliance.mjs`) passes on
the new stack with a key; the memory eval pins do not move.

### Stage 3 — Make the memory self-evolve (the point of the project)

> **Read first:** `research/self-evolution-audit.md` (2026-10-08) — measured
> defects in the sidecar and the prototype (two are data-integrity bugs) and
> the five loops this stage has to close, in phases A–E. It supersedes the
> ordering below where they disagree.

The memory layer stores and retrieves. What is missing is the loop that makes it
*learn from sessions*. Design is `research/memory-runtime-design.md`; today only
J0 exists. Build in its own phases, report-only first.

- ▣ 3.1 **Session → memory capture** audit: what does a finished session actually
  write today (episode, log lines, outcome)? Write down the gaps, then close them
  — facts extracted from the transcript, preferences, constraints, repo facts
  (Spatial), decisions (Executive), pain (Salience), each routed to its area.
  Built as a reflection call after each run writing key/value facts onto a
  project profile and a user profile.
- ▢ 3.2 **P0 `mnemo memory status`**: empty episodes, open gaps, contradicting
  same-key facts, dead edges, counts by area. No model, no writes.
- ▢ 3.3 **No-model jobs** J2 merge, J5 salience review, J6 edge maintenance, J9
  compaction report, J10 training rows. Safe on a cron with no key.
- ▢ 3.4 **Model jobs behind `--dry-run`**: J1 distil, J3 fill gaps (citation
  required), J8 eval cases. Budget-capped, stored default model.
- ▢ 3.5 **Apply, lease, revert**: `--apply`, run tags, `revert`, trace spans,
  `/memory improve`.
- ▢ 3.6 **Skill loop (J11)**: lessons + pain markers + the skills the session
  actually loaded → a `patch_skill` proposal with evidence ids; applied only
  under the §5.1 rules.
- ▣ 3.7 **Steering from real outcomes**: wire `steer`/`reinforce` to the turn's
  actual result (tool failure, user correction, test red→green), not only to
  explicit calls.
- ▢ 3.8 **Usefulness feedback** from the interface (thumbs on a recalled item)
  into `mark_useful`.
- ▢ 3.9 **Memory panel writes**: edit a fact, supersede, link, forget with
  confirmation; show `history` of a key.
- ▢ 3.10 **Retrieval quality**: decide the default embedder (hash is offline and
  weak; the remote one needs a key), switch `memsrv` to the ANN path when node
  count justifies it, close the known failing eval rows only by measured change.
- ▢ 3.11 **Cadence** (P3): `mnemo memory daemon` on a schedule; each run's report
  stands alone.
- ▢ 3.12 **The claim, re-measured**: the 3/3-vs-0/3 result is three tasks on a free
  model. Grow it to a task set with repeated sessions where the *second* run is
  the measurement, and publish the number with its method.

### Stage 3b — Memory for every agent; frontier accuracy on a cheap model

*Added 2026-10-08.* The target: Mnemo on a low-tier model (DeepSeek v4.1 Flash,
$0.15/M in) reaching frontier-agent accuracy **on familiar work** — the same
repositories, the same person, the same kinds of task — at a fraction of the
cost, with the gap closing over time. Memory cannot make a cheap model out-reason
a frontier one on a task it has never seen; it can make it stop rediscovering
what is already known. And because the memory attaches to *other* agents too, a
frontier model's sessions teach the memory the cheap model uses.

- ▣ 3b.1 **`@mnemo/memory` package** (`packages/memory`): the loop as
  `MemorySession` (begin/recall/context, toolStart/toolEnd, text, end, close),
  model calls and approval injected; Mnemo drives it from a pi extension.
- ▣ 3b.2 **Provenance**: episodes record agent and model; profile logs record
  who taught each fact; fixes record where they came from.
- ▣ 3b.3 **Claude Code, after the fact**: `mnemo memory ingest` replays saved
  sessions (`~/.claude/projects`) through the loop, once each (ledger), with
  redaction before anything reaches the reflection model.
- ▣ 3b.4 **Claude Code, live**: `mnemo memory hook` — SessionStart (profiles,
  last session; survives compaction), UserPromptSubmit (recall), Stop (async
  ingest of the run that ended). `mnemo memory setup claude-code` prints it.
- ▣ 3b.5 **MCP** (`mnemo memory mcp`): memory_recall / memory_search /
  memory_remember for Codex, Cursor, opencode. `mnemo memory setup codex`.
- ▣ 3b.6 **Recall into action**: the pitfall guard (a command that failed before
  is stopped once with its known fix) and verify-before-done (a run that changed
  code and checked nothing goes back once to run the project's check).
- ▣ 3b.7 **Benchmarks, local**: `app/eval/run.ts` (seven two-session scenarios,
  memory vs none) and `app/eval/series.ts` (six tasks in one repo with unwritten
  rules: the learning curve; `--teacher` for teacher→student).
- ▢ 3b.8 **Trust-weighted recall** (audit F8): rank by provenance (a fix a
  frontier model found and a test confirmed outranks a cheap model's guess).
- ▢ 3b.9 **Local embedder** (audit F15): recall precision; the lexical hash
  ranks an episode above the matching pitfall today.
- ▢ 3b.10 **Escalation**: a step the cheap model fails to verify twice goes to a
  stronger model; memory records the resolution. Metric: frontier calls per
  task, falling.
- ▢ 3b.11 **Test-time compute**: best-of-n with the project's verify command as
  the judge — affordable at a tenth of the price.
- ▢ 3b.12 **Public benchmarks**: a SWE-bench Verified / Terminal-Bench subset as
  the absolute anchor (Mnemo + Flash vs Claude Code + Sonnet/Opus — expect to
  lose there), a per-repository chronological split as the learning curve, and
  accuracy per dollar as the headline. Needs a machine with Docker and the
  datasets; the local series is the rehearsal.
- ▢ 3b.13 **Codex and opencode transcripts** for `ingest`, like Claude Code's.

### Stage 4 — Execution

- ▢ 4.1 Per-call timeout on the in-kernel channel (audit #6) and a cell timeout
  surfaced in the UI.
- ▢ 4.2 Resource bounds (audit #11) — at minimum memory and wall clock.
- ▢ 4.3 Record the process tree each call starts; show it in the audit trail.
- ▢ 4.4 Route `bash_exec` through the kernel or document why not.
- ▢ 4.5 Sandbox decision (D4) written into the README either way.

### Stage 5 — Packaging, install, release

- ▢ 5.1 `bun build --compile` per target (linux/darwin/windows × amd64/arm64);
  smoke test spawns the compiled binary and renders a frame.
- ▢ 5.2 `memsrv` built per target in `release.yml` and attached; the app finds it
  by the platform name (`memsrv.exe` on Windows).
- ▣ 5.3 (from source) `app/scripts/install.sh`. ▢ Install paths from releases (D3): `curl -fsSL …/install.sh | sh` and `irm …/install.ps1 | iex`
  download the binary + `memsrv` for the platform into `~/.mnemo/bin` and put it
  on PATH; `npx @mnemo/cli` / `bunx` is a thin package that fetches the same
  binary. Each finishes by running `mnemo doctor`. `uninstall` removes exactly
  what was written. The from-source script stays for contributors.
- ▣ 5.3a Build: `app/scripts/build.ts` → `dist/mnemo` (≈96 MB; verified to run
  the demo with an empty environment). Stubs Ink's optional devtools import,
  which otherwise breaks `--compile`.
- ▢ 5.4 `mnemo doctor` is the support command: runtime, provider, model, sidecar,
  kernel, home, versions.
- ▢ 5.5 Versioning and `--version`; a release checklist; update path.
- ▢ 5.6 First-run on a clean VM per OS — a person follows the README with nothing
  preinstalled and it works.

### Stage 6 — Quality gates for a public alpha

- ▢ 6.1 CI matrix: app (3 OS), memory-layer, harness, secrets scan, eval floor.
- ▢ 6.2 Open audit leftovers: 12.15 (partly done), 12.16 design confirmations,
  written into a `SECURITY.md` ("what the gate is and is not").
- ▢ 6.3 Telemetry policy: none by default; say so.
- ▢ 6.4 Docs for users (not agents): install, first run, commands, config, memory
  model in plain words, skills, hooks, troubleshooting.
- ▢ 6.5 Known-issues list in the tracker; triage before the tag.

### Stage 7 — Retire the old code

- ▢ 7.1 Parity sign-off (1.12 and 2.x verified).
- ▢ 7.2 Archive `tui-go/` on `archive/tui-go`, `agent/` on `archive/agent-node`,
  `harness-engine/` likewise; remove from CI; one commit that deletes them from
  the tree. Same procedure as `archive/tui-rust`.
- ▢ 7.3 Monorepo restructure (`PLAN-monorepo.md`, D5) — only now.
- ▢ 7.4 `AGENTS.md` rewritten for the final layout.

## The definition of "available to users" (v0.1 alpha)

All of: Stage 0, Stage 1, Stage 2 (2.1–2.8), Stage 3 (3.1–3.5 and 3.7), Stage 4
(4.1, 4.5), Stage 5 (5.1–5.4, 5.6), Stage 6 (6.1, 6.4).

v0.2: hooks, schedules, MCP, the harness engine, `init`/`pr` (2.9), the skill
patch loop (3.6), the memory daemon (3.11), the monorepo move (7.3).

## Risks

- **Port-and-regress.** 15k lines of Node carry audit fixes and Windows lessons.
  Porting a module without porting its tests loses them silently.
- **pi moves fast.** 0.84 → 1.1 in weeks, and `pi-durable` is experimental. Pin exact versions, upgrade on purpose, and keep extension code on the documented SDK surface.
- **Feature gravity.** The interface is easy to polish forever. The memory loop
  (Stage 3) is the differentiator and has the least built; schedule it in
  parallel with Stage 2, not after.
- **The headline number is thin.** Three tasks on a free model is a demo, not a
  benchmark (3.12).
- **Bun churn.** The sandbox is on 1.4.2, the docs and tests assume 1.3.x; CI
  should pin one version and the floor should be tested, not asserted.
