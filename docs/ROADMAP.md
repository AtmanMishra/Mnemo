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

## Where things actually stand (measured 2026-10-08)

| Area | State |
|---|---|
| `app/` interface | 4.7k lines, 25 test files. 201 of 202 tests pass; the one failure is `test/app.test.ts` "facts come from the injected sources", which hardcodes `Bun 1.3.14` while the sandbox has 1.4.2 — `collectFacts` reads the real runtime instead of an injected one. `tsc --noEmit` is clean. |
| What a user can do in `app/` | first-run screen, `/login`, `/model`, `/memory`, a real streamed turn through pi, the approval question, tool-call lines, a line editor with history, frame-diff repaint. |
| What the Bun app does *not* have | markdown, code/diff rendering, tool output capture, tokens/cost, sessions, slash autocomplete, `@file`, search, overlays other than the memory panel, mouse. |
| The agent | **not ported.** `app/` spawns pi from `agent/node_modules` and relies on `agent/` (Node) for every tool, the approval gate, memory recall, hooks, schedules, MCP, tracing and subagents (≈15k lines). |
| Memory layer | solid and self-contained: journal, areas, routed search, steering, consolidation, `recall_brief`/`remember`, eval gate (73/77/0.743). The *self-improvement runtime* (`research/memory-runtime-design.md`, jobs J0–J11) is designed, with only J0 consolidation built. |
| Kernel | works; no per-call timeout, no resource bounds, not a sandbox. |
| Install | `scripts/install.sh|ps1` and `release.yml` target the Go binary + Node agent. Nothing installs or packages the Bun app. |
| CI | no job runs `app/`. |

## Decisions needed before the big stages

These change the work, so they come first. Recommendation in bold.

- **D1 — Does Bun own the agent loop, or keep wrapping pi?**
  *Keep pi as the loop for v0.1* (it already streams, retries, compacts and
  handles providers, and `app/` already drives it over RPC). Port Mnemo's tools
  and extensions into Bun and load them into pi from `app/`, so `agent/` can go
  away without us writing a provider layer. Revisit owning the loop only if pi's
  extension API blocks something the memory design needs.
- **D2 — Are tools in-process or in pi's child?** Today they live in the pi child
  (Node). Porting means the child becomes a Bun process running the same pi
  entry with our extensions, **so the tool code is shared by the interactive app,
  one-shot mode and subagents**. The alternative (tools in the app, pi as a pure
  model client) is a rewrite of the loop and conflicts with D1.
- **D3 — How is it distributed?** **`bun build --compile` into one binary per
  platform plus a separately downloaded `memsrv`**; the Python kernel needs a
  system `python3`, and `doctor` says so. The alternative is "install Bun, then
  `bun install -g`", which is simpler to build and worse for non-JS users.
- **D4 — Is the kernel a sandbox?** **Not for v0.1.** Ship it as a persistent
  interpreter behind the approval gate, say so in the README, and add real
  isolation as its own project.
- **D5 — Monorepo restructure now or later?** `PLAN-monorepo.md` does it first;
  `HANDOFF.md` says last. **Later — after the interface and agent are ported.**
  Moving 4.7k lines under moving features doubles every merge.

## Stages

Each task is one commit that leaves the branch green. `▢` open, `▣` done.
"Verify" is how you know, and none of them needs an API key.

### Stage 0 — Housekeeping (a day)

- ▢ 0.1 Fix `app.test.ts`: `collectFacts` takes the runtime string from its
  injected sources, as its own doc comment claims. *Verify:* `bun test` 202/202.
- ▢ 0.2 Delete the stale "pi is not a dependency yet" comment in
  `src/session/pi-client.ts` (it is now in `app/package.json`) and make
  `PI_ENTRY` resolve from the app's own `node_modules`, not `../../../agent/`.
  *Verify:* the app starts with `agent/node_modules` absent.
- ▢ 0.3 `app/` job in `.github/workflows/ci.yml`: bun install, `tsc`, `bun test`,
  on ubuntu, macos, windows. *Verify:* a PR runs it red on purpose, then green.
- ▢ 0.4 Reconcile `plan.md` (areas 1–12 describe the Rust/Go/Node products) with
  this file: mark areas superseded, add an AREA 13 that points here.
- ▢ 0.5 Record the D1–D5 answers at the top of this file.

### Stage 1 — The interface a person would tolerate (replaces `tui-go` for chat)

Order is from `HANDOFF.md`; libraries from `PLAN-monorepo.md`.

- ▢ 1.1 **Markdown** (`marked` tokenizes, we render; code never reflowed; render
  only when the block is complete). Four existing tests change by design.
- ▢ 1.2 **Code blocks and diffs** (`cli-highlight`, `diff`).
- ▢ 1.3 **Tool output**: capture, truncate to N lines, `… 7 more` and the key that
  expands it; foldable thinking and tool blocks (`^e`/`^r`/`^a` as in Go).
- ▢ 1.4 **Status bar**: tokens, cost, context % from pi's session stats; mode keys
  on the left.
- ▢ 1.5 **Prompt queue and steer**: `enter` queues mid-turn, `alt+enter`
  interrupts, `esc` aborts, `^c` clears/interrupts/quits.
- ▢ 1.6 **Slash menu and `@file` mentions**; commands merged from built-ins,
  skills, plugin skills and pi's `get_commands`; unknown name routed to pi.
- ▢ 1.7 **Sessions**: list, resume, rename; read pi's session store (decide
  `bun:sqlite` index vs reading JSONL — read first, index when search needs it).
- ▢ 1.8 **Overlays** over a dimmed transcript, one contract, dismissed by `esc`:
  palette `^k`, sessions `^s`, memory `^m` (exists), logs `^l`, schedules `^o`,
  explorer `^t`, help `^h`. Help renders from the keymap.
- ▢ 1.9 **Transcript search** `^f`, `^L` clear, `^R` history search.
- ▢ 1.10 **Onboarding scenes**: provider → key (masked) → model, versioned and
  gated (no TTY, resuming, env set → ask nothing). `/login`, `/model`, `/logout`.
- ▢ 1.11 Mouse: decide wheel-scroll only vs click targets (Go never shipped it).
- ▢ 1.12 **Parity checklist** against `tui-go/DESIGN.md` — every row either
  ported, consciously dropped (with a line saying why), or filed as an issue.

*Verify (stage):* `bun bin/mnemo.ts --dump` golden frames for first-run,
configured, mid-turn, each overlay; a pty test drives a scripted pi stream end to
end (the harness exists: `test/pty.test.ts`).

### Stage 2 — Port the agent into Bun (the large one)

Source of truth for behavior is `agent/`; its tests travel with each module.
Order puts safety before capability.

- ▢ 2.1 **Pi entry in Bun**: `bin/mnemo.ts --mode rpc` running pi's `main()` with
  inline extensions; `--no-builtin-tools`. Node guard replaced by a Bun floor.
- ▢ 2.2 **Policy**: permissions rules (first-match), plan mode as rules, approval
  gate, grants store, bash-token matching, path containment. *(audit items 12.5,
  12.6 carry over — port the tests, not just the code.)*
- ▢ 2.3 **Tools**: `bash_exec`, `read_file`, `write_file`, `apply_edit`,
  `glob_list`, `read_image`, `web_fetch` (SSRF filter), `web_search`;
  `tools.json` exposure policy.
- ▢ 2.4 **Memory extension**: sidecar client (FIFO, lazy spawn), `session_start`
  episode, `before_agent_start` recall + directive, `tool_execution_end` log,
  `turn_end`, `session_shutdown` consolidate; the three memory tools.
- ▢ 2.5 **Tracing**: JSONL spans, nesting, redaction before write, `mnemo traces`.
- ▢ 2.6 **Kernel tool** (`ipy_run`) + in-kernel `tools.*` through the same gate;
  move `ipy_bridge.py` to `python/ipy/`.
- ▢ 2.7 **Subagents**: `spawn_subagent`, depth cap, shared journal, trace parenting,
  model override that fails loudly; interface shows the delegation tree.
- ▢ 2.8 **Skills**: discovery, `load_skill`, `create_skill`, `patch_skill`
  (evidence-gated, with history), `retire_skill`.
- ▢ 2.9 **Hooks** and **schedules** (cron parser, daemon lease, triggers) — with
  the Windows `sh -c` failures fixed rather than ported.
- ▢ 2.10 **MCP**: server tree teardown, `mcp__server__tool` registration.
- ▢ 2.11 **Harness engine** moved into Bun: gate, child-process execution
  boundary, registry, watcher. Same honesty rule — it filters, it does not sandbox.
- ▢ 2.12 Local subcommands: `auth`, `init`, `pr`, `consolidate`, `traces`,
  `--list-models`, `--list-sessions`, one-shot `mnemo "<prompt>"`.

*Verify (stage):* the agent's existing 389 tests are ported or consciously
dropped; a recorded-event run through the full gate; the constraint-compliance
eval (`scripts/eval-constraint-compliance.mjs`) passes on the new stack with a
key, and the memory eval pins do not move.

### Stage 3 — Make the memory self-evolve (the point of the project)

The memory layer stores and retrieves. What is missing is the loop that makes it
*learn from sessions*. Design is `research/memory-runtime-design.md`; today only
J0 exists. Build in its own phases, report-only first.

- ▢ 3.1 **Session → memory capture** audit: what does a finished session actually
  write today (episode, log lines, outcome)? Write down the gaps, then close them
  — facts extracted from the transcript, preferences, constraints, repo facts
  (Spatial), decisions (Executive), pain (Salience), each routed to its area.
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
- ▢ 3.7 **Steering from real outcomes**: wire `steer`/`reinforce` to the turn's
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
- ▢ 5.3 Rewrite `scripts/install.sh|ps1`: Bun floor, memsrv, python check, finish
  by rendering a frame; `uninstall` removes exactly what was written.
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

All of: Stage 0, Stage 1 (1.1–1.10), Stage 2 (2.1–2.8, 2.12), Stage 3 (3.1–3.5
and 3.7), Stage 4 (4.1, 4.5), Stage 5 (5.1–5.4, 5.6), Stage 6 (6.1, 6.4).

Deferred past v0.1 without shame: hooks/schedules (2.9), MCP (2.10), harness
engine port (2.11), skill-patch loop (3.6), cadence daemon (3.11), mouse (1.11),
the monorepo move (7.3). Those exist in the Node agent today, so v0.1 can state
plainly that they return in v0.2 — or v0.1 can wait for them. That is a product
call, not a technical one.

## Risks

- **Port-and-regress.** 15k lines of Node carry audit fixes and Windows lessons.
  Porting a module without porting its tests loses them silently.
- **Two homes for pi.** Until 0.2, `app/` runs pi out of `agent/node_modules`.
- **Feature gravity.** The interface is easy to polish forever. The memory loop
  (Stage 3) is the differentiator and has the least built; schedule it in
  parallel with Stage 2, not after.
- **The headline number is thin.** Three tasks on a free model is a demo, not a
  benchmark (3.12).
- **Bun churn.** The sandbox is on 1.4.2, the docs and tests assume 1.3.x; CI
  should pin one version and the floor should be tested, not asserted.
