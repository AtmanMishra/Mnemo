# Roadmap — from half-built to something a stranger can install

*Written 2026-10-08, brought up to date 2026-10-16 against release v0.1.3 (`main`). This is the task list.
`docs/REBUILD.md` says where the code is going, `docs/PLAN-monorepo.md` says how
it is laid out, `docs/HANDOFF.md` says where the last session stopped. This file
says what is left, in the order to do it. The public view of the same plan, without task numbers, is
<https://mnemo.atmanmishra.dev/roadmap>; what shipped in each release is in the
[changelog](https://mnemo.atmanmishra.dev/changelog) (`web/src/content/`).*

## The direction (settled)

One Bun application is the program. Three runtimes, three jobs:

| Runtime | Job | Lives in |
|---|---|---|
| **Bun / TypeScript** | the interface, the agent loop and its tools, sessions, auth, policy, hooks, schedules, MCP, the harness engine | `app/` (today) → `packages/*` (later) |
| **Rust** | memory: the journal, recall, steering, consolidation, and the background jobs that improve the graph | `memory-layer/` (`memsrv`) |
| **Python** | execution: one long-lived ipy interpreter the agent drives to touch the system | `app/python/ipy_bridge.py` |

**Legacy:** `tui-go/` (Go interface), `agent/` (Node: tools, extensions, hooks, schedules, MCP,
tracing) and `harness-engine/` (Node) are no longer on `main`. They live on the `legacy` branch,
unmaintained, and serve as a specification only (see `SECURITY.md`). Their documentation is
`docs/LEGACY.md`.

**The product** is an agentic CLI in the family of Claude Code, Codex CLI and
Hermes whose difference is the memory: it reads each session, updates the graph,
steers it on failure, stores different kinds of facts, and writes and patches its
own skills. The interface is the table stakes; the memory is the reason to exist.
Both have to ship.

## Where things actually stand (updated 2026-10-17, v0.1.6)

| Area | State |
|---|---|
| Releases | v0.1.0 (2026-10-09), v0.1.1 (2026-10-12), v0.1.2 (2026-10-13), v0.1.3 (2026-10-16: compiled-binary fixes for `/login`, Bedrock and image reads; Windows install; about sixty review fixes, `docs/REVIEW-2026-10.md`), v0.1.4 (2026-10-17: permission holes from 0.1.3 closed), v0.1.5 (2026-10-17: agent hierarchy, siblings, split layouts, playground), v0.1.6 (2026-10-17: agents wake each other within a hop and spend bound, typing to sub-agents, persisted links, playground conversations). A tag builds, smoke-tests and attests five archives (linux x64/arm64, macOS arm64/x64, Windows x64) and publishes them with `SHA256SUMS`; `docs/RELEASING.md`. |
| `app/` | The program: Ink interface on pi 1.1's in-process SDK, with Mnemo's behaviour as pi extensions (policy, memory, kernel, shell, checkpoints, sub-agents, peers, skills, trace, escalate, update). 362 unit/integration tests (plus 62 in `packages/memory` and 55 binary/terminal e2e) pass on a scripted model, `tsc` clean, on Linux, macOS and Windows CI. |
| Memory loop | profiles injected every turn; trust-weighted recall linked to the episode; failures steer, clean runs reinforce; a reflection call after each run writes durable facts; `mnemo memory tidy`; consolidation at shutdown; shared with Claude Code (hooks) and Codex, Cursor, opencode (MCP). |
| Agents | Sub-agents to depth 3 and sibling links in one roster (`app/src/runtime/roster.ts`); `list_agents` / `message_agent`; a message wakes an idle agent, bounded by 12 hops and a $0.50 allowance for woken turns since the user's last prompt; the user types to a running sub-agent from its split pane; links kept by project in `state.json`; split auto-join; playground with a conversation view. `docs/AGENT-HIERARCHY.md`. |
| Install | `get.sh` / `get.ps1` (animated on a terminal, checksummed), `mnemo update`, `mnemo uninstall [--deep]`, `mnemo doctor [--fix]`; Docker clean-install test in `app/scripts/test-install.sh`. |
| Site | `web/` (Vite + React on Vercel): home, download, docs, shortcuts, changelog, roadmap, security, privacy, terms; `docs/WEB.md`. |
| Not verified | Long real-provider sessions beyond the dogfood and benchmark runs (`research/`); a person following the README on a clean Windows and macOS machine; the background curator against a real model (it is on `feature/background-curator`, not in a release). |

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
- ▣ 1.8 `ctrl+o` expand/collapse for thinking and tool output already printed
  (inline, the transcript is printed again).
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
- ▢ 2.9 *(v0.2)* schedules, harness engine, `init`, `pr`. ▣ hooks (`app/src/extensions/hooks.ts`: PreToolUse,
  PostToolUse, SessionStart, SessionEnd from `$MNEMO_HOME/hooks.json` and the managed policy). ▣ MCP: pi's MCP client
  (`app/src/extensions/mcp.ts`), tools found by `tool_search`, every call through the gate.

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
- ▣ 3.2 **P0 `mnemo memory status`**: empty episodes, open gaps, contradicting
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
- ▣ 3.8 **Usefulness feedback** from the interface (thumbs on a recalled item)
  into `mark_useful`.
- ▣ 3.9 **Memory panel writes** (v0.1.2: edit, forget, vote; ▢ link, `history` of a key): edit a fact, supersede, link, forget with
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
- ▣ 3b.8 **Trust-weighted recall** (audit F8), v0.1.2: rank by the votes you give
  (`trust = 2(up+1)/(up+down+2)`; marked wrong twice and it is no longer recalled).
  ▢ Rank by provenance too (a fix a frontier model found and a test confirmed
  outranks a cheap model's guess).
- ▣ 3b.9 **Local embedder** (audit F15), v0.1.2: `MNEMO_EMBED_URL` + `MNEMO_EMBED_MODEL`
  point search at an Ollama or any OpenAI-compatible server. ▢ The default is still
  the offline hashing embedder, which ranks an episode above the matching pitfall.
- ▣ 3b.10 **Escalation** (`--escalate provider/id`, `MNEMO_ESCALATE_MODEL`;
  `src/extensions/escalate.ts`): after the project's checks fail twice in a run,
  the rest of the run goes to the stronger model and the next run starts cheap
  again; the episode records it, so the fix is attributed and recalled. ▢ Metric
  in the evals: escalations per task, falling.
- ▣ 3b.11 **Best-of-n** (`mnemo -p "<task>" --best-of N --check "<cmd>"`;
  `src/runtime/best-of.ts`): N headless candidates in git worktrees, the check
  as judge (run one at a time, once more before rejecting), the smallest
  passing diff applied, every diff kept under `$MNEMO_HOME/best-of/`. Verified
  on clsx with DeepSeek. ▢ Taking the check from memory when `--check` is
  absent (the remembered "verify command" is prose today, not a command).
- ◐ 3b.12 **Public benchmarks** — Terminal-Bench subset done
  (`research/terminal-bench-2026-10-08.md`, `app/eval/tbench.ts`): 10/10
  oracle-valid easy/medium tasks with and without memory at ≈$0.008/task; it
  found the shared-`/app` identity bug. Still to do: a SWE-bench Verified / Terminal-Bench subset as
  the absolute anchor (Mnemo + Flash vs Claude Code + Sonnet/Opus — expect to
  lose there), a per-repository chronological split as the learning curve, and
  accuracy per dollar as the headline. Needs a machine with Docker and the
  datasets; the local series is the rehearsal.
- ▢ 3b.13 **Codex and opencode transcripts** for `ingest`, like Claude Code's.

### Stage 4 — Execution

- ▣ 4.1 Per-call timeout on the in-kernel channel (audit #6) and a cell timeout
  surfaced in the UI.
- ▣ 4.2 Resource bounds (audit #11) — at minimum memory and wall clock.
- ▢ 4.3 Record the process tree each call starts; show it in the audit trail.
- ▢ 4.4 Route `bash_exec` through the kernel or document why not.
- ▢ 4.5 Sandbox decision (D4) written into the README either way.

### Stage 5 — Packaging, install, release

- ▣ 5.1 `bun build --compile` per target in `release.yml` (linux x64/arm64,
  darwin arm64/x64, windows x64); each archive is smoke-tested (doctor finds
  the sidecar, the demo runs). ▢ Pin upload/download-artifact to SHAs.
- ▣ 5.2 `memsrv` built per target and packaged beside `mnemo`.
- ▣ 5.3 (from source) `app/scripts/install.sh`. ▣ Release installers
  `app/scripts/get.sh` / `get.ps1` (checksummed; published as install.sh/ps1);
  `app/scripts/test-install.sh` verifies a clean install in Docker ubuntu:24.04.
  ▢ Install paths from releases (D3): `curl -fsSL …/install.sh | sh` and `irm …/install.ps1 | iex`
  download the binary + `memsrv` for the platform into `~/.mnemo/bin` and put it
  on PATH; `npx @mnemo/cli` / `bunx` is a thin package that fetches the same
  binary. Each finishes by running `mnemo doctor`. `uninstall` removes exactly
  what was written. The from-source script stays for contributors.
- ▣ 5.3a Build: `app/scripts/build.ts` → `dist/mnemo` (≈96 MB; verified to run
  the demo with an empty environment). Stubs Ink's optional devtools import,
  which otherwise breaks `--compile`.
- ▣ 5.4 `mnemo doctor` is the support command: runtime, provider, model, sidecar,
  kernel, home, versions.
- ▣ 5.5 Versioning and `--version`; a release checklist; update path.
- ▢ 5.6 First-run on a clean VM per OS — a person follows the README with nothing
  preinstalled and it works.

### Stage 6 — Quality gates for a public alpha

- ▣ 6.1 CI matrix: app (3 OS) with the memory package, memory-layer, retrieval floor, secrets scan (`ci.yml`). ▢ The site (`web/`) has no CI job: `npm run build` runs on Vercel.
- ▣ 6.2 `SECURITY.md` ("what the gate is and is not", credentials, memory as
  trusted input). ▢ Open audit leftovers: 12.15 (partly done), 12.16 design
  confirmations.
- ▣ 6.2a **Scrub provider keys from child processes**: commands the agent runs
  inherit the environment, keys included (an eval's `env` call recorded one).
  Pass bash and the kernel an environment without `*_API_KEY`/`*_TOKEN`/`AWS_*`
  unless the user opts in per command.
- ▣ 6.3 Telemetry policy: none, and measured (`SECURITY.md`): only a real prompt
  opens a connection, to the configured provider.
- ▣ 6.4 Docs for users (not agents): install, first run, commands, config, memory
  model in plain words, skills, hooks, troubleshooting.
- ▢ 6.5 Known-issues list in the tracker; triage before the tag.

### Stage 7 — Retire the old code

- ▢ 7.1 Parity sign-off (1.12 and 2.x verified).
- ▣ 7.2 The Go interface, the Node agent and the harness engine moved to the
  `legacy` branch and are gone from `main` and CI (2026-10-09).
- ▢ 7.3 Monorepo restructure (`PLAN-monorepo.md`, D5) — only now.
- ▣ 7.4 `AGENTS.md` rewritten for the final layout.

## The definition of "available to users" (v0.1 alpha): met

v0.1.0 shipped it: Stages 0 to 2, the memory loop (3.1 to 3.5 and 3.7), the release
pipeline and installers (Stage 5), and the quality gates (Stage 6). What is still open
in those stages is listed above as ▢ and is not blocking.

## Release plan, 0.1.4 onward

*Added 2026-10-16. Drafted from the repo, not agreed: the version numbers, the grouping
and the sizes are proposals for Atman to move around. Nothing has a date, matching the
public roadmap. **Size:** S = a day or less, M = a few days, L = a week or more or needs
outside resources (a model, a machine, weeks of real use).*

The shape: 0.1.4 closes what 0.1.3 shipped with a known hole; 0.1.5 makes the headline
claim measurable and gives skills evidence; 0.2.0 is the first feature jump back to
legacy parity (hooks, schedules, MCP); the curator ships when its own bar is met, not
on a version.

### 0.1.4 — close the known issues (quick wins)

*Status 2026-10-16: built on `claude/project-thread-vya8xl` with the release notes and changelog entry (✔ = in this branch). The agents-page shortcut fixes (draft PR #26) ship in it too. Not done, and why, is under the table.*

Everything here is listed under "Known issues" in `docs/releases/v0.1.3.md`,
`docs/REVIEW-2026-10.md` ("Known and left", "Not fixed") or this file as open.

| Item | Size | Where it comes from |
|---|---|---|
| ✔ Gate: `git bisect run`, `git submodule foreach` and `npm install*` grants covered by the option checks; each with a regression test | S | v0.1.3 known issues; review "Known and left" |
| ✔ Gate: `memory_remember` and `spawn_subagent` refused in plan mode | S | review, Security (last bullet) |
| ✔ esc during a running tool says "Interrupted", like esc during streaming | S | review, Interface ("noticed and left") |
| Merge the two Dependabot PRs (#21 actions, #24 crates) once CI is green, and pin `upload/download-artifact` to SHAs | S | open PRs; 5.1 |
| ✔ A `web/` job in `ci.yml` (`npm run build && npm run check`) | S | 6.1 |
| Binary reports pi's version as 0.0.0 to MCP servers | S–M | review runtime 8b; pi has no setter, so this may need an upstream change or a patch. *Inferred:* low value until MCP lands in 0.2, so it can slide. |
| Keys typed in the first second after the prompt draws can be dropped | M | review interface 15; not reproducible, so the first step is a reproduction (raw mode before first draw). *Inferred:* worth a time-boxed attempt only. |
| Import keys from the legacy `~/.mnemo/auth.json` | S | 2.1 |
| `distrusted` as a ratio, not a difference; skill nodes scoped per project, not global by label | M | review memory "Left". *Inferred:* both change recall ranking, so run the memory evals before and after. |
| A write that times out on the client can still be applied later (idempotency key on memsrv writes) | M | review memory "Left" |
| Move embedding out from under the journal lock | M–L | review memory "Left"; the review called it not a contained change |

**Left out of 0.1.4 on purpose:** the Dependabot PRs (#21, #24) are yours to merge once CI is
green; the pi version report, the dropped first-second keys and the `auth.json` import are not
fixed (the first two need an upstream change or a reproduction; the import writes credentials, so it
wants its own review); the memory items (`distrusted` ratio, per-project skill nodes, write
idempotency, embedding outside the lock) change recall or the sidecar protocol and need the
evals, so they move to 0.1.5. The gate also now treats `git filter-branch`, `cargo install` and
`go get` like the other command-running forms.

Bigger risk to flag: **Windows has never been verified by a person** (review, "Not verified
here"). Code signing for `mnemo.exe` (SmartScreen warning) is a known v0.1.3 issue too;
it needs a certificate, so it is an L that depends on spend, not code.

### 0.1.5 — make the claim measurable, give skills evidence

| Item | Size | Where it comes from |
|---|---|---|
| **Memory claim re-measured**: a task set where the second run is the measurement, method published | L | 3.12; first of the website's "Next" items |
| Terminal-Bench / SWE-bench subset as the absolute anchor, accuracy per dollar as the headline | L | 3b.12; needs Docker and the datasets |
| Escalations per task as an eval metric (should fall) | S | 3b.10 |
| Rank recall by provenance (a fix a frontier model found and a test confirmed outranks a cheap guess) | M | 3b.8 |
| Default embedder decision (offline hash ranks an episode above the matching pitfall) | M | 3b.9, 3.10; the answer is a measured change, so it rides on the benchmark above |
| Evidence-gated skills: `patch_skill` cites session ids, `retire_skill` | M | 2.7, 3.6; website "Skills that cite their evidence" |
| Codex and opencode transcripts for `mnemo memory ingest` | M | 3b.13 |
| `--best-of` takes its check from memory when `--check` is absent (needs the verify command stored as a command, not prose) | M | 3b.11 |
| `mnemo traces`, and a `pi-telemetry` adapter | M | 2.5, 2.8 |
| A pass in real terminals (iTerm2/Ghostty, Windows Terminal, 16-colour) with screenshots | M | 1.10; needs hands on the machines |
| A person follows the README on a clean VM per OS | M | 5.6; also closes the "Windows never verified" gap |

### 0.2.0 — legacy parity

The features the legacy stack had that `app/` does not (`agent/src/hooks`, `schedule`,
`mcp.ts`, `init.ts`, `pr.ts`, and `harness-engine/`). Read them as a specification, never
copy their security posture (`AGENTS.md`). Decision D6 already deferred these here.

| Item | Size | Notes |
|---|---|---|
| Hooks around tool calls | M | legacy `hooks-inline.ts`; runs user commands, so it goes through the gate and gets bypass tests from day one |
| ✔ MCP servers as tools (pi's MCP extension) | M–L | `app/src/extensions/mcp.ts`; the 0.0.0 version report is still open |
| Schedules | M | legacy `schedules-inline.ts`; *inferred:* unattended runs raise the approval question, so decide the permission story first |
| `mnemo init` and `mnemo pr` | S–M each | legacy `init.ts`, `pr.ts` |
| Harness engine | L | legacy `harness-engine/`; *inferred:* the least-asked-for of the set, and the site does not mention it. Cut it, or ship it last. |
| Sandbox decision (4.3 to 4.5): a real sandbox for kernel and commands, or a documented reason not | L | decision first, code second; update the README either way |
| Process tree recorded per call; `bash_exec` through the kernel or documented why not | M | 4.3, 4.4 |
| Parity sign-off, then the monorepo restructure | M | 7.1, 7.3 (D5: only now) |

### Not on a version: the background curator

Built on `feature/background-curator`, which is not on the remote I could read, so I could
not review it. Held out until it has run against real models for weeks and its revert path
has been used (3.3 to 3.6, 3.11). *Inferred:* it should ship the release after that bar is
met, and the first release carrying it should be report-only or `--dry-run`. The no-model
jobs (3.3) could ship earlier on their own, since they are safe on a cron with no key.

### What I assumed

- "Roadmap" meant refreshing this file, which already existed at v0.1.2, rather than a new one. The public roadmap in `web/src/content/roadmap.ts` is not changed here; it should follow once the plan is settled.
- The 0.1.x / 0.2.0 split is mine. The repo only says hooks, schedules, MCP and the harness engine are "v0.2".
- There are no open issues, only the two Dependabot PRs, so the list comes from the docs, not the tracker.
- Sizes are rough and were not checked against the code.

## Risks

- **Port-and-regress.** 15k lines of Node carry audit fixes and Windows lessons.
  Porting a module without porting its tests loses them silently.
- **pi moves fast.** 0.84 → 1.1 in weeks, and `pi-durable` is experimental. Pin exact versions, upgrade on purpose, and keep extension code on the documented SDK surface.
- **Feature gravity.** The interface is easy to polish forever. The memory loop
  (Stage 3) is the differentiator and has the least built; schedule it in
  parallel with Stage 2, not after.
- **The headline number is thin.** Three tasks on a free model is a demo, not a
  benchmark (3.12).
- **Bun churn.** `app/package.json` requires Bun 1.3 or newer and CI pins one
  version; the floor should be tested, not asserted.
