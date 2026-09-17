# The issue ledger

Every issue filed against this repository — twenty-five of them, eight open and seventeen
closed — with what was actually wrong, why it mattered, the nuance that makes each one
worth remembering, what changed, and what changed *for the person using the thing*.

This is written against the code and the git history, not against the issue titles.
Where a closing comment claims a fix the code does not contain, the entry says so.

## How it was checked

- `gh issue list --state all` for the set, `gh issue view <n>` for every body and comment
  (including the nine closed on 2026-09-16 with evidence comments).
- Every claim of a fix was traced to the commit named in its closing comment and read in
  the diff: `git log --oneline --all`, `git show <sha> --stat`, `git show <sha> -- <file>`.
- Every claim of "still open" was re-grepped in the tree at the snapshot.
- **Snapshot**: HEAD `b965caf` ("tui-go: the agent's list is the catalogue, three new
  commands, opt-in mouse, and failures that explain themselves", committed 2026-09-17
  01:19 +0530). The working tree was **dirty** — 34 entries — at 2026-09-17 04:32Z, and
  another worker was editing it while this was written. Anything from the working tree is
  labelled *uncommitted* and is not treated as a fix.
  **HEAD moved during writing**: `90d831e` ("consent: yolo, and a dialog that remembers what it
  was told", 2026-09-17 10:09 +0530) landed the consent/`/yolo` work that was uncommitted at the
  snapshot. Every claim here was verified against `b965caf` plus that dirty tree; where a
  follow-up commit lands the in-flight work an entry names (#20, #24), the entry still describes
  the state it was checked against, and says so.
- Test counts quoted are counts of `test(...)` / `func Test…` declarations where the issue
  gives a number, not of assertions.

## Two rules, from this repo's own history

1. **A claim of "fixed" needs a commit sha or a test name.** A few comments in this tracker
   assert a fix without one, or name a commit that does not do what the comment says. Those
   entries mark it; they do not repeat it.
2. **A caveat is part of the entry, not a footnote.** Where a fix is partial, the entry says
   exactly what remains. Where a fix introduced a new wart, the entry names it.

## Traps for the next reader

- **Audit findings have sha-shaped ids.** `a739fbd8`, `ccdbbb2b`, `1c31b0fe` and `e4cc567c`
  are ids in `audit/FINDINGS.jsonl` — the audit ran in rounds (`agent`, `audit-sec-surface-r3`)
  — **not commits**. `git show a739fbd8` fails with `ambiguous argument … unknown revision`.
  Issues #7, #9 and #11 cite them as if they were commits; the entries below say which is which.
- **Three titles lost their code spans at creation**, so they read with a gap. The missing
  tokens are: #2 `sh -c`, #5 `search_ann()` and `route_query()`, #8 `mnemo ci`. Titles are
  reproduced verbatim in the table.
- **Docs cited by older issues have moved.** `docs/EVAL-RESEARCH.md` is now
  `docs/archive/EVAL-RESEARCH.md` (commit `0c90352`, "two documents instead of fifteen");
  the current pair is `docs/MNEMO.md` and `docs/MNEMO-INTERNALS.md`.
- **Work in flight at the snapshot** (uncommitted, no sha — *not* fixes): `tui-go/internal/limits/`
  plus the `cmd/mnemo` flags (the configuration surface #20 says is missing), the
  `memory-layer` supersede-on-write change with the un-ignored `constraint_probe` test (#24),
  and a consent/`/yolo` workstream (`agent/src/grants.ts`, `agent/src/permissions.ts`,
  `agent/extensions/approval-gate.ts`, `tui-go/app/yolo.go`, `tui-go/internal/pi/yolo.go`).
  Where one of these changes what an issue's status means, the entry says so explicitly.

## The whole ledger

| # | Title (verbatim, gaps and all) | State | The one-line cause |
|---|---|---|---|
| 1 | Windows: the agent suite fails on a POSIX-shaped runtime and POSIX-shaped fixtures | OPEN | `agent/` assumed `sh`, `python3`, a slash path and POSIX fixtures; CI only ran Linux. |
| 2 | Hooks execute through , so the hooks engine is Unix-only | CLOSED | The hook engine hardcoded `spawn("sh", ["-c", …])`, which does not exist on Windows. |
| 3 | tui-go parity remainder: session branching, /compact, approval indicator, theme picker, and the smaller pi bindings | CLOSED | Six known gaps lived only in `tui-go/README.md`, where a rewrite would erase the reasoning. |
| 4 | Mouse click and wheel hit-testing are declared but not implemented | CLOSED | `MouseModeNone` was set and `chat.BlockAtRow` was tested with no caller — a dead code path that looked live. |
| 5 | memory-layer:  is unreachable and  only speaks hand-written English | CLOSED | `search_ann` had no production caller, and `route_query` scores areas by literal English cue phrases. |
| 6 | ipy_run's in-kernel tool channel has no per-call timeout; spawn_subagent has no depth cap | CLOSED | Two documented-unbounded resource paths: one hung tool could hang the kernel; a child could nest forever. |
| 7 | Harness bundles run in-process with full privileges — the gate filters loads, it does not sandbox runs | OPEN | The safety gate scans imports at load; a registered bundle then runs with the host process's rights. |
| 8 | Pre-alpha gaps from the research catalogue: /init, , PR automation, cost-budget auto-switch, lesson autowrite | OPEN | Five catalogue features `plan.md` did not carry; `on_cost_over` fired with nothing listening. |
| 9 | harness-engine's watcher latency test is timing-flaky under parallel load | OPEN | The test asserts watcher pickup inside a fixed wall-clock budget; CI hides it with `npm test \|\| npm test`. |
| 10 | Eval work is designed but unbuilt: constraint-persistence probe, nightly LLM-judged evals, pre-release benchmark runs | CLOSED | The eval plan existed on paper and the headline claim rested on a measurement nothing re-ran. |
| 11 | plan.md 12.15 remainder: MCP SIGTERM orphan handling + kernel resource limits | CLOSED | An MCP server that ignores SIGTERM outlived its agent; the Python kernel had no memory or CPU bound. |
| 12 | memory-layer: the ANN-vs-brute test asserts exact top-1 equality and is therefore flaky | CLOSED | The test demanded that approximate search equal exact search — a promise HNSW does not make. |
| 13 | a user pi extension conflict aborts the agent at startup, and the TUI never says why | CLOSED | Two extensions claiming one tool name make pi exit; `pi.Spawn` never set `cmd.Stderr`, so the reason went to the terminal. |
| 14 | command surface: proposals P1-P8 from the Hermes review | OPEN | Three command registries, and the TUI's was a gate: `/hook` was refused while the agent implemented it. |
| 15 | The approval gate never asks in the TUI: pi's extension UI protocol has no implementer | CLOSED | Nothing parsed `extension_ui_request`, so the gate's non-TTY policy failed **open** and auto-approved mutating tools. |
| 16 | Resume and /new do not move the session: the transcript and the model's context diverge | CLOSED | `resume()` replayed a transcript locally; `switch_session`/`new_session` were never sent. |
| 17 | Project trust is never resolved, so project-local pi resources load silently or not at all | CLOSED | pi ignores trust-requiring resources in non-interactive mode, and Mnemo never passed `--approve` either way. |
| 18 | Three skill catalogues disagree, and get_commands is asked once per process | CLOSED | Three roots, three frontmatter rules, one skill yielding two palette rows; the agent was asked once, ever. |
| 19 | There is no configuration channel into pi, and sessionDir is hardcoded | CLOSED | `~/.pi/agent/sessions` was hardcoded and pi's settings were unreachable, so a relocated session dir vanished from `^s`. |
| 20 | Hardcoded and duplicated values: the provider table, a model id in the UI, and a compile-time tuning surface | OPEN | One fact stored in four places across two languages, defaults resolving against the checkout, and a tuning surface you can only change by rebuilding. |
| 21 | Shell tools get none of pi's session environment, and the process markers are never set | CLOSED | `bash_exec` (and the kernel and subagents) spawned with a scrubbed env and injected nothing, so `$PI_MODEL` was undefined. |
| 22 | On Windows the bash tool promises /bin/sh and runs cmd.exe | CLOSED | `shell: true` is `cmd.exe` on Windows while the tool description promised `/bin/sh -c`. |
| 23 | Providers: five API keys and nothing else — subscription logins and local models are unreachable | CLOSED | The shim exited without one of five API keys, so a subscription-only tester could not start Mnemo at all. |
| 24 | A changed fact stays: same-key writes append instead of superseding, so the model is handed two contradictory instructions | OPEN | `memsrv`'s `fact` op appends; supersession existed and the ordinary write path never reached for it. |
| 25 | tui-go: /fork can only fork from the newest message | OPEN | `/fork` takes the newest forkable entry because the picker over the same reply is not built. |

Every closed issue is closed by work that is in `main` (each entry cites the sha) — except #5,
where the entry documents the part of the closing comment the code contradicts. The eight open
ones are not bookkeeping: #1 (a suite that cannot run on the platform it must), #7 (an accepted
risk awaiting a decision), #9 (a real flake with a known deterministic fix) and #24 (a real bug
whose fix is in flight) are substantive; #14 and #8 are proposal and backlog trackers by design;
#20 and #25 are scoped remainders, and #20's happens to be uncommitted in the tree.

---

## #1 — Windows: the agent suite fails on a POSIX-shaped runtime and POSIX-shaped fixtures

**OPEN** · filed 2026-09-14 · last update 2026-09-16 19:50Z · `bug`

**Cause.** The `agent/` suite was written where `sh`, `python3`, `/tmp` and a slash-separated
path all exist. Four independent assumptions, each fatal on Windows:

- the hook engine ran every hook through `sh -c` (its own issue, #2);
- the Python resolver said `python3` on every platform, and Windows has no such name —
  the launcher there is `py`, then `python`, and 22.x ships no `python3` shim either
  (`agent/src/python.ts:44` is the fix that made this per-platform);
- the memory sidecar path was built as `memory-layer/target/debug/memsrv` while cargo
  emits `memsrv.exe` on Windows (`memsrvName()` / `MEMSRV_NAME`);
- `bash_exec` captures stderr differently through `cmd.exe`, and the skills-discovery
  order differs on a case-insensitive filesystem.

**Effect.** `cd agent && npm test` on Windows 11 / Node 22: **`# fail 83`**, against zero on
the Linux runner, with the whole `hooks_*` block failing as "undefined where
`{block: true, …}` was expected". CI ran on `ubuntu-latest` only (`.github/workflows/ci.yml`),
so none of it was visible where it mattered.

**Nuance.** The count *is* the progress report, and the issue's comments are honest updates
of it: 83 → 61 → 40 → 20. Two of the causes were tracked separately (#2 hooks, #22 shell),
which is why this issue is phrased as the container rather than the defect. And one of the
survivors is not a product bug at all: `resolveInWorkspace rejects absolute paths outside the
root` fails only when `%TEMP%` resolves to its 8.3 short form (`ATMANM~1`) — a
test-robustness bug in the test's own path handling.

**Fix.** Partial, and the issue is open precisely because the last step is not done.

- `93522d1` — the sidecar is `memsrv.exe` on Windows, through one resolver rather than three
  hand-kept call sites.
- `cf4bd6b` — a hook that exits without reading stdin no longer takes the invocation down
  with an unhandled `EPIPE`.
- `150bacf` — `agent/src/python.ts` probes `py` → `python` → `python3` (Windows order chosen
  so the launcher picks the newest 3.x), honours `SEA_PYTHON`, and on failure names what it
  tried instead of surfacing an opaque `ENOENT`. That alone took the kernel tests from ~20
  failures to 2.
- `5ef7264` — the hook cluster, 61/61 (#2), and the load-sensitive timeout flake fixed by
  injecting a scheduler rather than loosening the assertion.
- `12e79b9` — MCP/subagent work (#6, #11).

The issue's own definition of done — *"`npm test` green on Windows, or the POSIX-only tests
explicitly skipped with a stated reason, plus a Windows job in `.github/workflows/ci.yml` so
it cannot regress silently"* — is **not met**: the `agent` job is `runs-on: ubuntu-latest`
on every row of `ci.yml`; only the `tui-go` job carries the three-OS matrix (`ci.yml:121`).
The last comment names the next step, and the code still shows it undone: the five real-server
MCP tests hand a literal `python3` to `McpClient` (`agent/test/mcp.test.ts:53,140,142`) instead
of routing through `resolvePythonBin()`.

**After effect.** Down to **20 failures** from 83 at filing: Windows developers can run the
suite and see their own change rather than a wall of platform noise, and the failures that
remain are named. What a Windows user still cannot do is trust `npm test` to be green, and
what nobody can do is notice the next Windows-only regression in CI, because the agent
suite still has no Windows job.

**Measurement caveat, stated rather than papered over.** I tried to re-measure the 20 at the
snapshot and could not compare: `npm test` on this host resolved Node **v22.12.0** and the run
died in **3.3 seconds with 51 of 51 test files failing and 0 passing**, every one at load with
`ERR_UNKNOWN_FILE_EXTENSION` — the exact failure `AGENTS.md` pins `node-version: "22.18"`
against. The same machine's interactive `node` reports **v22.23.2** and `npm exec -- node
--version` reports **26.9.0**; under the 22.23.2 binary the tests load and run
(`node --test test/hooks_engine.test.ts` → 17 pass, 0 fail, 18 s). So: **20 is the last measured
number, under Node 22.23.2, and I did not reproduce it**; the red run is a local
toolchain-resolution problem in how `npm` picks `node`, not a regression in the product. It is
also a live example of the pin in `AGENTS.md` earning its place.

---

## #2 — Hooks execute through , so the hooks engine is Unix-only

**CLOSED** 2026-09-16 by `5ef7264` · `bug`

*(The title lost its code span at creation; the missing token is `sh -c`.)*

**Cause.** `agent/src/hooks/engine.ts` ran every hook command through `spawn("sh", ["-c", …])`
— a deliberate choice, since hooks are plain scripts and should get a shell's conveniences.
On Windows there is no `sh`, so the engine's contract (*exit 0 = allow, 2 = block, anything
else = allow + log*) could never be evaluated at all. The scaffold `/hook add` writes made
it worse in the same direction: it emitted a `chmod +x` stub script, meaningless on Windows.

**Effect.** ~20 hook tests in `agent/test/hooks_*.test.ts` failed on Windows, and they failed
as *a hook that produces no response* rather than as a block or an allow — the single most
confusing possible shape of this bug, because it looks like the hook declined rather than
like the engine never ran it.

**Nuance.** The first fix looked half-done from the outside, and the closing comment explains
why: the resolver landed in `agent/src/hooks/shell.ts` while the engine kept calling
`spawn("sh", …)` *and importing the resolver it was not using*. That is a failure mode worth
naming — a fix that imports its own replacement reads as complete in review. Two further
subtleties came out of the same commit: a command with arguments is a **program line**, so
only the program token may be resolved (resolving the tail turned `node script.js` into a
path lookup for `script.js`); and scope confinement had to be extended to relative path
*arguments*, which escaped through the same door.

**Fix.** `5ef7264`, with the shell resolved per invocation: the manifest's own `shell` field →
`MNEMO_SHELL` → pi's `shellPath` → the platform default (`sh -c` on POSIX, `cmd.exe /d /s /c`
on Windows) — `agent/src/hooks/shell.ts:101-149`, `executor.ts:339-361`. `shellArgv()`
(`executor.ts:263-282`) handles cmd.exe's habit of stripping the first and last quote of the
tail by adding an explicit quote pair. An unresolvable shell is an **audited error** — never a
crash, never a silent allow. The fixtures were rewritten as plain node scripts run as
`node <script>` (the same discipline as tui-go's re-exec stand-ins), and the two POSIX-only
assertions (exec bit, mode 0600) became platform branches rather than deletions. The
load-sensitive timeout flake was fixed at the root: `ExecRequest` gained an injected
scheduler, the discipline the clock already used, so the test fires the deadline itself
instead of racing 120 ms against node startup — four concurrent runs of the file, zero
failures.

Evidence: `agent/test/hooks_*.test.ts` **61/61** (was 37/56); `tsc` clean; the whole
`hooks_` family is 61 `test(...)` declarations, which is the number the comment quotes.

**After effect.** A hook now runs on Windows, and a hook that cannot find a shell says so in
the audit trail rather than failing open. `MNEMO_SHELL` is the documented way to point hooks
at a specific shell.

**The new wart, stated plainly.** On Windows the platform default is now `cmd.exe`, and an
`sh` on `PATH` is *not* consulted for a hook that did not declare a shell
(`shell.ts:113-119`; `findOnPath("sh"|"bash")` is only reached when the hook declares a
POSIX shell name). Before this change, a machine with Git Bash on `PATH` ran hooks through
`sh -c` because the engine hardcoded it. A POSIX-syntax hook on such a machine now gets
cmd.exe unless it declares `shell: "posix"`/`"sh"` or `MNEMO_SHELL` is set. That is the right
default, but it is a behaviour change for existing hooks, and it is not silent only because
the failure is now visible.

**And a grep trap.** `#!/bin/sh` still appears in the tree, in
`agent/test/read_image.test.ts:36,63` — as **data**: a non-image payload that `read_image`
must refuse. Two test headers also quote the string in comments explaining the discipline.
Grepping for `#!/bin/sh` and concluding the POSIX fixtures came back is wrong; the fixtures
are `node <script>`.

---

## #3 — tui-go parity remainder: session branching, /compact, approval indicator, theme picker, and the smaller pi bindings

**CLOSED** 2026-09-16 by `b965caf` · `enhancement`

**Cause.** `tui-go/README.md` carried a "still gaps" list from the rebuild. The list was
accurate; the problem was that its *reasoning* lived only in a README that the next rewrite
would erase.

**Effect.** Six known gaps against pi, each with a different blocker: session branching,
`/compact`, a pending-approval indicator, a theme picker, the smaller pi bindings
(`!command` boxes, external editor, `/export`/`/import`/`/share`, `/name`, `/session` info,
path completion on tab, `/thinking` level), and a startup header census.

**Nuance.** Two entries were blocked on *decisions*, not code, and the issue is worth keeping
for those sentences alone: a client-side `/compact` "would only remove messages the model
still stands on"; and the approval indicator had no events to draw, because RPC mode emitted
none — which is exactly the hole #15 filled, so the indicator's blocker was another issue's
root cause. The theme picker was a deliberate single-theme choice, not an omission.

**Fix.** `b965caf`, three slices landed and one honestly deferred:

- **`/compact [instructions]`** → pi's `compact` with custom instructions. Refuses mid-turn
  ("the agent is working — compact when the turn ends", `app/update.go:1697-1706`) and
  offline ("compacting is the agent's to do — no agent is attached"). The outcome arrives as
  the compaction events the transcript already draws; a *successful* reply adds nothing on
  purpose, which is documented at `pi.ParseEvent` so the silence is not read as a bug.
- **`/theme`** — four presets lifted from the design preview, in
  `tui-go/internal/theme/theme.go:146-151`: the shipping register (PICO-8), `pottery`,
  `bronze`, `winedark`. Applied on enter, the overlay stays open so several can be tried,
  and the choice persists to `~/.mnemo/theme.json`. Unset, corrupt or unknown → the shipping
  palette, never a failure. "Marble and wine" is deliberately excluded: a light ground needs
  a light terminal, and nothing in the renderer paints the ground — a test asserts every
  offered preset has a ground that works (`app/theme_test.go:141`).
- **`/fork`, first slice** — `get_fork_messages` → fork the newest entry → the transcript is
  cut back to that message because the branch does not contain the later turns
  (`app/update.go:446-490`) → the forked message goes into the editor. Cancelled, empty,
  no-agent and mid-turn each say what happened.

Deferred *as its own issue* rather than dropped: **#25** (choosing which message to fork
from, `/clone`, the session tree, branch naming).

**After effect.** `/compact` and `/theme` exist and persist; a fork produces a real branch cut
at the right place instead of a truncated-looking session. Two things did **not** change:
the startup header still shows cwd + model only, with no loaded-skills/extensions census
(`app/view.go:174-181`), and the smaller pi bindings (`!command`, `^g`-as-editor is now mouse
— see #4 — `/export`, `/import`, `/share`, `/name`, path completion, thinking *level*) are
still absent. The pending-approval *indicator* also never got its own row: what exists instead
is the dialog itself (#15). A passive "something is waiting for you" line is still not drawn.

---

## #4 — Mouse click and wheel hit-testing are declared but not implemented

**CLOSED** 2026-09-16 by `b965caf` · `enhancement`

**Cause.** `app/view.go` set `v.MouseMode = tea.MouseModeNone`, and `chat.BlockAtRow` — the
row-to-block mapping that click-to-fold needs — existed and was tested with **no caller**.
The TUI declared mouse reporting and ignored every mouse event.

**Effect.** No click-to-fold, no wheel scrolling. Worse than absent: a reader of the code
found the mapping, the tests and the mode field and reasonably assumed the feature worked.

**Nuance.** The issue is explicit that this was a design decision, not missing code: a TUI in
alt-screen with mouse tracking on *steals drag-select*, the gesture every terminal user
already has. `bubblezone` was rejected on purpose — `tea.View.OnMouse` is native in Bubble Tea
v2, and a dependency for this would be a dependency for nothing.

**Fix.** `b965caf`, and the decision is in the code rather than in a comment:
**opt-in via `MNEMO_MOUSE=1`, off by default** (`app/view.go:29-46`), because turning it on
takes the terminal's own drag-select away and "that gesture belongs to the user, not to us".
When it is on: the wheel scrolls the transcript, a click folds *and* focuses the block under
the pointer (`app/update.go:1359-1376`), nothing moves behind a modal, and `^g` toggles
reporting either way and says so on the status line, which carries a persistent `mouse · ^g`
segment while reporting is live (`app/view.go:450`). The keymap owns both gestures so help and
the palette render them (`internal/keymap/keymap.go:56-63,143-145,234-238`).

Evidence: `app/mouse_test.go`, 7 tests — `TestMouseReportingIsOffUnlessItWasAskedFor`,
`TestNothingHappensToATranscriptWhileTheMouseIsOff`, `TestTheWheelScrollsTheTranscript`,
`TestAClickFoldsTheBlockUnderThePointer`, `TestAClickBelowTheTranscriptIsNotABlock`,
`TestAModalOwnsTheMouseToo`, `TestTheChordHandsSelectionBackToTheTerminal` — plus
`cmd/mnemo/main_test.go:219` pinning the environment variable's spelling.

**After effect.** A reader who wants in-app clicks gets them, with the trade-off stated where
the mode is chosen so the next reader does not have to rediscover it; a reader who wants
their terminal's selection keeps it, and `^g` is the switch either way. The wart: the mode is
per-process environment, not a saved preference (unlike `/theme`), so it is re-decided every
launch — deliberate, per the comment ("a property of this terminal rather than of this
machine's saved preferences"), and worth knowing before filing "the setting does not stick".

---

## #5 — memory-layer:  is unreachable and  only speaks hand-written English

**CLOSED** 2026-09-16 by `27f8979` · `enhancement`

*(The title lost its code spans at creation; the missing tokens are `search_ann()` and
`route_query()`.)*

**Cause, part 1 — the ANN path is dead code.** `search_ann()` existed in
`memory-layer/src/search.rs`, backed by `src/ann.rs`, with a test asserting it agreed with
brute force — while `memsrv`'s `search` handler called the brute-force `search()`. The
sidecar is the only integration surface, so as shipped there was no way to reach the ANN code
without editing Rust.

**Cause, part 2 — query routing is a hand-written English cue table.** `route_query()` scores
areas by literal cue phrases ("fail, error, broke, bug, crash" → Salience, and so on). A query
in another language, or one that happens not to use those words, routes to no preferred area.

**Effect.** Part 1: a tested, benchmarked code path that no caller can reach (brute force is
documented as fine to ~100k nodes, so this was never urgent — but "reachable only by editing
Rust" is not a shipping posture). Part 2: the cross-area discount never helps a non-English
query — the exact case it exists for. It degrades gracefully (unbiased search) rather than
failing, which is why it was filed as an enhancement.

**Nuance.** Both halves are about the same thing: work that exists but cannot be asked for.

**Fix — and this is where the entry has to stop repeating the closing comment.**
`27f8979` added: `ANN_MIN_NODES = 2048` (`search.rs:109`), a `plan_search()` planner that
returns which path should run and *why* in words (`search.rs:95,122,134-151`), the ANN
quality bound replacing exact-equality in the test (#12), `tests/ann_probe.rs`, and
`mempolicy --json`.

**What the code actually contains at the snapshot: `plan_search` has no caller.**
A repo-wide search finds it only in `search.rs` — its definition and its own doc comments —
and in the generated `graft/` index. `MNEMO_SEARCH_ANN` is **never read by any code**; it
appears only inside the `format!` strings of the reasons. `memsrv`'s search handler still
calls `search(...)` directly (`memory-layer/src/bin/memsrv.rs:442`), and nothing reports
which path ran to any caller. `#[allow(dead_code)]` is still on `search()`
(`search.rs:255`). `plan_search` itself has no test. So the closing comment's claim —
*"`plan_search()` routes memsrv's search through it when `MNEMO_SEARCH_ANN=1` and the graph has
at least `ANN_MIN_NODES` live nodes, and it says which path ran and why"* — **is not true of
the committed code**. The commit made the planner exist; it did not make the routing happen.
The ANN path is still unreachable from the shipped sidecar.

**And the issue's part 2 was not addressed at all.** `route_query` is unchanged — the literal
English cue table is at `search.rs:187-204`, pinned by `search_tests.rs:168-175`, and
`rootcause_tests.rs:74-77` asserts the graceful degradation ("no cue word fires, so search ran
unbiased"). The closing comment's "**#5(b)**" is about `mempolicy --json`, which is real work
in the same commit (one JSON object, unrounded numbers, stable key names, including the
"nothing to learn from" case) — but it is the 7.3 experiment report, not the second item of
this issue. A closer's letter mislabelled a different piece of work, and the effect is that
the tracker now records as done something that is not.

**After effect.** `mempolicy --json` is genuinely consumable by a script or CI job, so that
half is real. Everything the issue actually asked for about the ANN path and the cue table is
still open in substance while the issue reads closed: the sidecar does not route to ANN under
any flag, and a query that does not use the cue words still gets no routing bias. The next
person to touch either should treat this entry, not the closing comment, as the state of play.

---
## #6 — ipy_run's in-kernel tool channel has no per-call timeout; spawn_subagent has no depth cap

**CLOSED** 2026-09-16 by `150bacf` (a) and `12e79b9` (b) · `enhancement`

**Cause.** Two unbounded resource paths in a system whose whole point is long autonomous runs.

1. **No per-call host timeout on the in-kernel tool channel.** `ipy_run` bounded the *program*
   (`timeout_ms`, default 120 s) and killed the kernel when it expired, but a single
   `tools.<name>()` call made from inside the kernel had no host-side bound. A tool that never
   returns hangs the kernel. The code said so in a `ponytail:` comment that ended "add one if
   that ever bites" — the issue's own words for it are "the kind of note that ages badly".
2. **`spawn_subagent` had no depth limit.** A child calling `spawn_subagent` nested processes
   and trace spans with nothing capping it. `docs/system-design.md` §6 specifies max depth 3
   and max 4 parallel; the shipped implementation enforced neither. Sub-agents share the
   memory journal by design, so an unbounded tree is also unbounded concurrent writers to one
   file.

**Effect.** A single hung tool could take down a kernel cell that was otherwise healthy, and
`spawn_subagent` could recurse until something else broke. Neither had a number to point at.

**Nuance.** The protocol constrains the fix: the kernel matches replies **positionally**, so a
late second write would be read as the answer to the *next* call. "Exactly one reply per
message" is therefore part of the correctness of the fix, not an implementation detail.

**Fix.**

- **(a) `150bacf`** — `DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000`, overridable at the cell and by
  `MNEMO_KERNEL_TOOL_TIMEOUT_MS` (the legacy `SEA_KERNEL_TOOL_TIMEOUT_MS` still works;
  `ipy_run.ts:54-82`). The failure surfaces *inside* the program as a catchable `ToolError`
  rather than as a dead cell, so generated code can handle it. The batch path bounds each
  element separately so one hung tool cannot hold the other seven past its own timeout
  (`runBatch`, `ipy_run.ts:303-314`), and the waves are capped at
  `MAX_PARALLEL_TOOL_CALLS = 8` with the reason in the comment — "a hundred parallel
  `bash_exec` calls would be a fork bomb wearing a tool name".
- **(b) `12e79b9`** — children are stamped with `MNEMO_SUBAGENT_DEPTH` (parent + 1, set **last**
  so a caller-supplied environment cannot fake it; `subagent.ts:54-69`), and `spawn_subagent`
  refuses at `MNEMO_SUBAGENT_MAX_DEPTH`, default **3** — "because three levels of delegation
  is as deep as a person can follow a trace, and the point is that it is a number"
  (`subagent.ts:282`). The refusal is an ordinary tool error naming the limit and the variable
  that raises it; an unusable value falls back to the default, never to unlimited. Documented
  in `docs/MNEMO-INTERNALS.md` §3.4/§3.6, tested in `agent/test/subagent.test.ts`.

**After effect.** A hung in-kernel tool now fails as a catchable error inside the Python cell
instead of freezing the kernel, and delegation depth is a number a user can raise. What the
issue did **not** fix, and its own body asked for: the **max 4 parallel** half of §6 is still
unenforced — `grep` for a fan-out cap in `agent/src/tools/subagent.ts` finds nothing, so the
wave cap that exists (`MAX_PARALLEL_TOOL_CALLS = 8`) applies to the in-kernel batch, not to
sub-agent fan-out. Depth is bounded; breadth is not.

---

## #7 — Harness bundles run in-process with full privileges — the gate filters loads, it does not sandbox runs

**OPEN** · filed 2026-09-14 · `enhancement` (accepted risk, filed so it is visible)

**Cause.** `harness-engine`'s safety gate is *lexical*. It scans static and dynamic imports and
`require` specifiers (including backtick forms), rejects non-literal specifiers, blocks
`fs`/`child_process`/net-class/host-info modules unless allowlisted, rejects direct `process`
access, confines relative imports to the bundle directory lexically and after `realpath`
(depth 3), and syntax-checks before import. It runs on **every** load path — `loadBundle` is
the single entry point. What it cannot do is constrain what a loaded tool does *at runtime*:
registered bundles execute inside the Node process with that process's privileges.

**Effect.** Escapes the gate cannot see, in `harness-engine/README.md`'s own words:
`fetch()` (a global, no import), prototype pollution, infinite loops, and obfuscation inside
`eval`/`Function` bodies. The audit finding is blunt about the input side too: the bundle
source is model-authored and therefore attacker-influenced through prompt injection, and once
past the gate it "runs arbitrary JS with the host process's full rights — filesystem, network,
and provider API keys in env" (`audit/FINDINGS.jsonl`, id `a739fbd8`).

**Nuance.** `a739fbd8` is a **finding id, not a commit** (see the traps section) — the issue
cites it as if it were one. And the gate's own header has said "NOT a sandbox … full Node.js
privileges inside this process" from the start: the risk was documented, and what the audit
added is that documentation is not enforcement. `create_harness` — the tool by which the agent
writes its own tools, accepting a model-authored spec **by design** — is simultaneously the
loosest entry point in the system.

**Fix.** None. Recorded as an accepted risk during the security audit and carried in
`plan.md` 12.16 as a "design confirmation (not defect)", filed as an issue so it is visible to
anyone evaluating Mnemo for their own machine. The issue's own definition of done is either
real isolation (a `node --permission` worker or a container per bundle) or "a prominent,
documented statement of trust at every entry point that accepts bundles — including
`create_harness`".

**After effect.** Partial, in one direction only: the trust statement exists in
`harness-engine/README.md:195-201` ("It does **NOT** sandbox anything", plus the four escape
classes) and not in the place the model reads. `create_harness`'s tool description
(`agent/src/tools/harness.ts:20-27`) lists what the gate *rejects* and never says that what it
accepts runs with your privileges — so the acceptance test in the issue is unmet, and a model
told only about the gate can reasonably believe it is constrained. Anyone running Mnemo on
their own machine should read this entry as: **a harness bundle is code you are executing**.

---

## #8 — Pre-alpha gaps from the research catalogue: /init, , PR automation, cost-budget auto-switch, lesson autowrite

**OPEN** · filed 2026-09-14 · partially addressed by `16a9840` (2026-09-17) · `enhancement`

*(The title lost its code span at creation; the missing token is `mnemo ci`.)*

**Cause.** Five items named in `research/all-in-one-agent-design.md`'s feature catalogue that
`plan.md` did not carry, verified absent in the code at filing.

**Effect.** No one-command project-memory bootstrap; no way to run the CI matrix locally; the
agent could push nothing; `on_cost_over` was implemented (`agent/src/schedule/daemon.ts` polls
trace spend against `--budget`) with **nothing acting on it**, so a run could blow past its
budget with the trigger firing into the void; no writer that appends consolidated lessons to a
per-project file a human would read.

**Nuance.** Two of the five turned out to be smaller than a catalogue entry implies, and the
issue says so: `mnemo ci` works better as a *script* than a subcommand, "so it works before the
binary is built"; and lessons-autowrite "is the `patch_skill` tool plus the J11 loop, both
shipped — that part can be closed if you agree the tool is the feature".

**Fix.** Two landed in `16a9840`:

- **`mnemo ci`** → `node scripts/ci.mjs`, which runs what CI runs (agent tests + types, cargo,
  `go test` + `go vet`, harness) as **one table**, with `--fast` to skip Rust and
  `--only <suite>` for one; a suite whose toolchain is missing is *skipped* rather than failed
  (`scripts/ci.mjs:1-40`). The secret scan is deliberately excluded: "it reads the last 200
  commits and belongs to the repository, not to a working tree."
- **cost-budget auto-switch** — an `on_cost_over` trigger that names a fallback model now
  switches the job to it **before** the run it triggers, and persists the change:
  `mnemo schedule trigger add --type on_cost_over --budget N --fallback-model M`, with listings
  showing `→ M when over`. Tests: `agent/test/schedule_cost_switch.test.ts`.

**Still open, verified at the snapshot:**

- **`/init`** — no such builtin (`tui-go/internal/command/command.go`, `Builtins()`), so there
  is still no one-command way to seed a project's memory with its conventions.
- **PR / GitHub automation** — no PR-creating path anywhere in `agent/` or `tui-go/`; a search
  for `gh pr create` / `createPullRequest` / "pull request" across both returns nothing. Every
  change is still manual.
- **Lesson autowrite to a project history file** — `patch_skill` exists
  (`agent/src/tools/skills.ts`, `agent/src/skills/skill-edit.ts`, `skill-history.ts`, landed
  `a539aaf`) and so does the J11 job (`d910c53`), but there is no writer appending consolidated
  lessons into a per-project file. The closer's question — "can be closed if you agree the tool
  is the feature" — is unanswered, which is a fair reason to leave it open.

**After effect.** `node scripts/ci.mjs` means "green here" and "green there" mean the same
thing, including the parts that only fail on another platform — which is how the trust-path bug
(#17) was found, Linux agreeing with itself while macOS did not. A job that crosses its budget
now changes model instead of only logging. The wart to know about: the switch **persists**, so
a cost trigger makes a lasting decision about the job's future model, and it acts *before* the
run that tripped it.

---

## #9 — harness-engine's watcher latency test is timing-flaky under parallel load

**OPEN** · filed 2026-09-14 · `bug`

**Cause.** The test asserts that the watcher picks up a filesystem change inside a fixed
wall-clock budget: `waitFor(… , 2000)` at `harness-engine/test/watcher.test.ts:105-108`, where
`waitFor` throws `waitFor: timed out` when the deadline passes (`test/helpers.ts:65-73`). The
watcher it drives debounces at 250 ms, so the budget is ~8× the debounce and still loses under
load.

**Effect.** "an unsafe bundle is skipped with an error and never imported; the watcher survives
(ccdbbb2b)" fails when the suite runs under load — reproduced on Windows while running the full
suite (1 of 31 failed, `helpers.ts:73`), and previously noted in the handoff as
"flaky/timing-based, passes on rerun".

**Nuance.** The smell the issue names is not the test but CI's response to it: the
harness-engine job runs `npm test || npm test`, with the comment *"one watcher test is
timing-based; a single retry keeps CI honest without hiding a real failure, since a genuine
break fails twice"* (`.github/workflows/ci.yml:105-109`). The issue's counter-argument is the
one to keep: "a retry hides a real failure the second time it appears too."
`ccdbbb2b` is an audit finding id, not a commit.

**Fix.** None, and the file has not been touched since it was written:
`git log --oneline -- harness-engine/test/watcher.test.ts` shows only `ca93a51` (the initial
import) and `7cfe6cb` (which added this test **with** its 2000 ms budget) — the budget was never
raised and the watcher was never driven deterministically.

**After effect.** Nothing changed for anyone: the flake is still there, the retry is still
there, and a real watcher regression would be reported once and swallowed the second time.
The deterministic fix is known and cheap in this repo's own idiom — inject the clock/scheduler
as `5ef7264` did for the hook deadline and `ExecRequest` — and it has simply not been done. The
subject matter is fine: nothing here suggests the watcher itself is broken.

---

## #10 — Eval work is designed but unbuilt: constraint-persistence probe, nightly LLM-judged evals, pre-release benchmark runs

**CLOSED** 2026-09-16 by `9f1a1d2` · `enhancement`

**Cause.** `docs/EVAL-RESEARCH.md` (now `docs/archive/EVAL-RESEARCH.md`) laid out a tiered
plan. The "every commit" tier was real — `memeval` with pinned Hit@1/Hit@3/MRR floors enforced
per retrieval change, plus the four suites — and the other two tiers were designed and not
built.

**Effect.** The gap had a cost, and the issue states it: the headline claim in `README.md`
("3/3 task success WITH memory versus 0/3 WITHOUT") rested on a measurement several
model-generations old, and the stored 3/3-vs-0/3 result predated the corpus expansion to five
pairs and had not been re-run.

**Nuance.** The split that makes this buildable is *which half needs a model*. "Does the graph
still recall a constraint stated once" is deterministic and can fail a PR; "does the agent
*behave* according to it" needs a model and cannot. The issue's phrasing of the second is the
design constraint: LongMemEval's knowledge-update and abstention categories were the closest
published analogues, and "nothing in the repo covers the behavioural half".

**Fix.** `9f1a1d2`.

- **Recall half, deterministic, in CI.** `memory-layer/tests/constraint_probe.rs` seeds
  constraints — a package manager, a port, a comment style — and asks for them later **in the
  words a person would use, not the words they were stored in**, with pinned thresholds
  (`a_constraint_stated_once_is_recalled_later`, `hits_at_1 >= 2`), plus a third test asserting
  an unrelated question does not rank a constraint first, over **eight competing nodes** so the
  assertion is about retrieval and not about graph size
  (`an_unrelated_query_ranks_an_unrelated_node_first`). These run in `ci.yml` through
  `cargo test --all-targets` — a regression fails a PR — and again in the nightly recall job.
- **Behavioural half, needs a model.** `scripts/eval-constraint-compliance.mjs` runs the real
  agent against a throwaway project and checks that it *complies*: the proposed command uses
  pnpm, the URL is port 4111, the comment explains why. Judged by a **deterministic rule over
  the answer**, never by another model ("a judge that can be talked into compliance is not a
  judge", `eval-constraint-compliance.mjs:12-14`).
- **The nightly tier** — `.github/workflows/nightly-evals.yml`, cron `0 3 * * 1` (Mondays,
  03:00 UTC) — runs both and **skips** the compliance job with a `::notice::` when no provider
  key is configured, "because a green run that measured nothing is worse than a skipped one".
  The probe exits 3 for "no key" and the step turns that into a notice, never a pass.

**And it earned its keep on the first run**: the probe found that a same-key write appends
instead of superseding, so after a constraint changes the model is handed both versions —
filed as **#24** with the captured state, and the test for it committed `#[ignore]`d with the
evidence in its doc comment.

**After effect.** A retrieval regression on constraints now fails a PR; compliance drift is
caught weekly; a run that could not measure says so instead of glowing green.

**Two honest gaps, one of them created by this issue being closed.**

- The **pre-release tier** (SWE-bench Multilingual, Terminal-Bench, LoCoMo/LongMemEval) is
  named in the workflow as not done and "needs a budget decision rather than code".
- The headline claim the issue opened with was **not** touched. `README.md`'s "3/3 task
  success … versus 0/3" still stands as written, introduced by `0969477` (2026-08-30) and
  unchanged since; `9f1a1d2` edited `docs/MNEMO.md`, not the README. So the sentence the issue
  describes as resting on an old measurement is *still* resting on it, with a weekly job now in
  place to produce a newer one.

---

## #11 — plan.md 12.15 remainder: MCP SIGTERM orphan handling + kernel resource limits

**CLOSED** 2026-09-16 by `12e79b9` (a) and `150bacf` (b) · `bug`

**Cause.** The last two open items of the audit-remediation batch (the rest — RPC-stall
timeouts, scope shadowing, manifest-ref confinement, watcher symlink containment, doc/CI drift
checks — landed 2026-09-01).

- **(a) MCP SIGTERM orphan (`1c31b0fe`, a finding id).** An MCP server that ignores SIGTERM
  outlives the agent that spawned it. The bridge reports a server that fails to start rather
  than failing the run, which is right, but nothing reaped one that refused to die.
- **(b) Kernel resource limits (`e4cc567c`, a finding id).** The Python kernel process had no
  memory or CPU bound: a generated infinite loop was bounded only by the call timeout, and a
  memory-hungry cell by nothing at all.

**Effect.** Orphaned server processes accumulating outside the agent's lifetime; a runaway cell
able to take the machine's memory with it.

**Nuance — the fix required a hazard it then had to cover.** MCP servers now spawn **detached**
on POSIX, which is required for the negative-pid group kill, and a detached server no longer
dies with the agent's process group. That is why teardown also registers a
`process.once("exit")` sweep that force-kills anything still live. The second subtlety is in
the closing comment and is the kind of thing only a test finds: `stop()` must settle in-flight
requests immediately and destroy our pipe ends, "because waiting on a pipe a killed server will
never close is the other half of the bug" — and the new tests caught a real ordering bug where
a target exiting during the graceful signal could still be handed a spurious SIGKILL.

**Fix.**

- **(a) `12e79b9`** — teardown is two-phase over the process **group**: SIGTERM, then SIGKILL
  after `MCP_TERMINATE_GRACE_MS = 2_000` (`agent/src/mcp.ts:92,187-189`); on Windows
  `taskkill /PID <pid> /T` escalating to `/T /F` (`mcp.ts:131-146`). Escalation is reported; a
  quiet death says nothing. Verified on this host with a real launcher, a real grandchild
  inheriting our stdout, and a deliberately stubborn tree: both pids dead after `stop()`,
  escalation on stderr, no stray processes. Tests: `agent/test/mcp_teardown.test.ts` (507 lines
  added in that commit).
- **(b) `150bacf`** — memory and CPU are bounded where the platform can enforce it: POSIX gets
  `RLIMIT_AS` / `RLIMIT_CPU` (`ipy_run.ts:88`), defaulting to
  `DEFAULT_KERNEL_MEMORY_MB = 2048` and `DEFAULT_KERNEL_CPU_SECONDS = 1800`, overridable by
  `MNEMO_KERNEL_MEMORY_MB` / `MNEMO_KERNEL_CPU_SECONDS`. Windows has no such facility, and
  where it cannot be enforced **the tool description says so** rather than implying a promise
  it cannot keep — the same honesty rule the whole ledger runs on.

**After effect.** An MCP server that ignores SIGTERM is killed as a tree and cannot outlive the
agent silently; a Python cell's memory and CPU have numbers. The wart that comes with it: on
Windows the kernel bound is a documented non-promise, so a runaway cell there is still stopped
only by the call timeout.

---

## #12 — memory-layer: the ANN-vs-brute test asserts exact top-1 equality and is therefore flaky

**CLOSED** 2026-09-16 by `27f8979` · `bug`

**Cause.** `search_tests::p1::hnsw_ann_matches_brute_on_seeds` asserted that the HNSW path
returns the *same top-1* as brute force for every query. HNSW is approximate by construction —
"a test that fails on its own subject matter: the failure is a property of the algorithm, not
of a change."

**Effect.** It failed once in CI on `main` and passed on the runs either side:

```
thread 'search_tests::p1::hnsw_ann_matches_brute_on_seeds' panicked at src/search_tests.rs:119:13:
assertion `left == right` failed: query helm rollback wait: ann top1 3 != brute top1 2
  left: 2
  right: 3
```

**Nuance.** The assertion guarded the **only** test of the ANN path — a path that was
unreachable from `memsrv` (#5) — so relaxing it was the kind of change that had to be a
deliberate decision rather than a repair in the moment. That is why it was filed instead of
patched: `search_ann` was also documented as approximate, with the reason spelled out
(`hnsw_rs` seeds layer assignment from OS entropy and inserts in parallel, so a rebuilt index
can reorder near-ties run to run).

**Fix.** `27f8979`. The test now asserts the property that *is* required, with numbers pinned
(`search_tests.rs:120-142`):

- the ANN top hit must be one that exact search would also have surfaced — i.e. in brute
  force's **top-3** — always;
- the ANN top-1 must equal brute force's top-1 on **at least two thirds** of the queries.

A real regression in the graph walk still fails it; a near-tie ordered the other way no longer
does. `tests/ann_probe.rs`, added in the same commit, reports the actual agreement as a number
"so a change in recall is visible before it becomes a failure".

**After effect.** The flake is gone at the root — the assertion now matches the contract the
algorithm actually offers — and a recall change shows up as a number before it shows up as a
red run. Two warts worth knowing, both visible in the same commit:

- **`ann_probe.rs` says it should not exist.** Its own header reads "TEMPORARY probe (deleted
  before finishing)". It is still in the tree, in `tests/`, which means
  `cargo test --all-targets` — the CI invocation — compiles and runs it forever. It contains
  **zero assertions** (the only occurrence of the word is in that header comment), so its four
  `#[test]` functions measure and print without being able to fail. That is presumably why it
  was kept (the two-thirds bound has to be re-derived when the corpus changes), but as shipped
  it is a benchmark wearing a test's clothes, executed on every CI run.
- **The two-thirds bound is a property of the pinned corpus, not of HNSW.** If the corpus
  changes, the constant has to be re-derived, and the probe is the only tool for that — which
  is an argument for keeping it, and an argument for renaming it out of `tests/`.

---
## #13 — a user pi extension conflict aborts the agent at startup, and the TUI never says why

**CLOSED** 2026-09-16 by `b965caf` · `bug`

**Cause.** Two user extensions that register the same tool name make pi exit at startup:

```
Error: Failed to load extension "C:\\Users\\<user>\\.pi\\agent\\extensions\\subagent\\index.ts":
  Tool "subagent" conflicts with "C:\\Users\\<user>\\.pi\\agent\\extensions\\interactive-subagents\\pi-extension\\subagents\\index.ts"
Hint: Start without extensions using "pi -ne".
```

Two separable defects sat behind it:

1. **The user could not see it.** `pi.Spawn` never set `cmd.Stderr`, so the child's stderr was
   *inherited*: under the TUI's alternate screen that text was written straight at the
   terminal, unmanaged, while the interface reported something generic — or nothing. A failure
   entirely legible to pi was unreadable to the person holding the keyboard.
2. **Whether Mnemo should be exposed to this at all had never been decided.** Mnemo's own
   extensions are inline factories and, verified, still load under `-ne` — so hermetic spawning
   was available and was not chosen.

**Effect.** Reproduced with the exact argv Mnemo uses
(`node agent/bin/mnemo.ts --mode rpc --no-builtin-tools`, `tui-go/internal/pi/pi.go` `Spawn`);
the same command with `-ne` ran fine. The agent exits before the first turn and the TUI says
nothing useful. This is also *why* the command-surface probe in
`research/hermes-command-surface-review.md` §6.4 never got an answer: the probe asked a live
agent for `get_commands` and the agent was already dead.

**Nuance.** The suggested order in the issue is the one that shipped and it is the right lesson:
capture stderr first (right regardless of the `-ne` decision), then decide the policy question
on its merits. The trade-off is real in both directions — `-ne` buys immunity from a broken
user extension and gives up user-installed ones, which the review (P7) proposes to court.

**Fix.** `b965caf`. The child's stderr is piped and drained in its own goroutine **as it
arrives** (`pi.go:503,519,535-551`); pi's `Failed to load extension "<path>": <reason>` shape is
recognised after ANSI stripping and the `Error: ` diagnostics prefix (`pi.go:592-601`); it
surfaces as exactly one transcript notice carrying pi's words **verbatim plus the way out** —
for a conflict, "remove or rename one of them, then start again". `read()` now waits for the
stderr drain before composing the exit message, so the real explanation can never be preceded
or suppressed by "the agent process exited"; and when there is no recognised failure the generic
message appends the last stderr line rather than swallowing it.

Evidence: live, against real pi, with two deliberately conflicting project extensions — stderr
`Error: Failed to load extension "…b.ts": Flag "--dupe" conflicts with …a.ts` became exactly one
transcript line carrying the path, the reason and the instruction. Pinned by a fake agent
(re-exec, no shell — the fixture discipline of #2) asserting the notice **and that no second
notice appears** (`tui-go/internal/pi/fakepi_test.go:373` `TestAnExtensionConflictReachesTheTranscript`),
the unrecognised-failure fallback (`fakepi_test.go:412`), a parser matrix in `contract_test.go`,
and an env-gated live-pi check.

**After effect.** A user whose extension set breaks the agent now gets pi's own sentence, the
path, and what to do about it, in the transcript — instead of a mysterious exit and a wall of
text bleeding through the alternate screen.

**The wart, stated plainly: the `-ne` decision is still not made.** Mnemo still loads user
extensions and can still be broken by a conflicting pair. What changed is that the breakage is
explained rather than hidden. The policy question lives in #14's P7.

---

## #14 — command surface: proposals P1-P8 from the Hermes review

**OPEN** · filed 2026-09-14 · status at the snapshot below · `enhancement`

**Cause.** The headline finding of `research/hermes-command-surface-review.md` (pushed in
`a61c1b4`): Mnemo has **three command registries** — the TUI's own list, pi's extension
commands, and the CLI — and the TUI's is a *gate*. `/hook list` was answered with "no command
called /hook", though the agent implements it and pi would execute it.

**Effect.** Reachable pi features looked absent. One command with two plausible spellings
produced two rows or none. Prompt templates (`~/.pi/agent/prompts/*.md`, custom slash commands
with `description` and `argument-hint`, in daily use on this machine) were reachable and
undocumented.

**Nuance.** Hermes' answer to the same problem is one registry; the client-appropriate version
is to *ask the authority instead of keeping a copy*. The review's non-goals are repeated in the
issue so they stay settled: no gateway, no channel integration, no dashboards, no desktop app,
and "never two command lists again".

**Status of each proposal at the snapshot** — this is what the issue does not say, because it
is a checklist nobody has ticked.

- **P1 — the slash handler is a router, not a gate. LANDED** (`b965caf`). `slash()`
  (`app/update.go:1134-1160`) consults the interface's own table first; an unknown name with a
  live agent goes to `route()`, which **sends the line** — queued while a turn is running,
  because pi executes an extension command mid-stream but rejects a prompt template or skill
  command while streaming, and "one path that is right for all three beats a rule that depends
  on which kind you happened to type" (`update.go:1162-1175`). The refusal survives only for
  the offline case, which the comment calls "the only one where refusing is honest".
  Consequence: `/hook`, `/schedule`, `/now` work today.
- **P2 — ask pi for its command list. LANDED** (`b965caf`). `get_commands` is the live
  catalogue and the disk scan is the offline fallback (see #18 for the mechanics, the
  canonicaliser and the provenance line).
- **P3 — surface prompt templates. PARTIAL.** They are *reachable* through P1's router, so
  typing one works; they are not *listed*. `command.go`'s roots are skills and plugin skills
  (`command.go:98-124,215`); nothing scans `~/.pi/agent/prompts`.
- **P4 — complete arguments, not just names. NOT LANDED.** `prompt.Complete()`
  (`internal/prompt/prompt.go:130-140`) writes `"/" + name + " "` and stops — deliberately,
  "leaving the cursor after it so arguments can follow". There is no per-command argument
  source at all, so `/model <tab>` and `/login <tab>` complete nothing.
- **P5 — session/context commands pi already supports. PARTIAL.** `/compact` landed
  (`b965caf`); `/new` maps to `new_session` (`update.go:1147-1152`, and the comment explains
  why it is not a second palette row). `/name` (`set_session_name`), `/status` (`get_state`)
  and pi's **thinking level** control (`set_thinking_level`) are not implemented anywhere —
  `pi.go` writes only `prompt`, `steer`, `abort`, `get_commands`, `switch_session`,
  `new_session`, `get_fork_messages` and `compact`. **Name collision to know about**: the
  builtin called `thinking` (`command.go` `Builtins()`) is the local "open every thinking
  block" fold, *not* pi's reasoning level.
- **P6 — tool exposure policy (`~/.mnemo/tools.json` + `/tools enable|disable`). NOT LANDED.**
  A search for `tools.json` across `tui-go/` and `agent/` returns nothing.
- **P7 — document pi's on-disk extension path. NOT LANDED.** `docs/MNEMO-INTERNALS.md`
  describes Mnemo's own extensions (`:162`, `:185`) and does not present
  `~/.pi/agent/extensions/` and `.pi/extensions/` as the third-party surface — which is the
  thing that would let someone extend Mnemo without a PR to Mnemo.
- **P8 — `mnemo skills list|check`. NOT LANDED.** No such subcommand exists.

**After effect.** The class of lie this issue was filed about is gone: an unknown slash name is
sent to the agent, and the palette says where each row came from. What remains is the smaller
half — argument completion, the session/context verbs, the tool policy, and the documentation
of the extension surface — plus the fact that P3 is a routing win rather than a listing win, so
a user still cannot *see* their prompt templates.

---

## #15 — The approval gate never asks in the TUI: pi's extension UI protocol has no implementer

**CLOSED** 2026-09-14 by `360e985` (client) + `c18ec13` (gate) · `bug` — security-relevant

**Cause.** `agent/extensions/approval-gate.ts:10-11` prompts for a mutating tool call "via
`ctx.ui.confirm()` (native TUI dialog)". In RPC mode that becomes a pi **extension UI request**
on stdout (`docs/rpc.md` §Extension UI Requests: `type: "extension_ui_request"`, methods
`select`/`confirm`/`input`/`editor`, plus `notify`/`setStatus`/`setWidget`/`setTitle`/
`set_editor_text`). **Nothing in `tui-go` mentioned `extension_ui_request`** — `ParseEvent` had
no case for it, so the request was dropped and no response was ever sent. Compounding it: the
gate's policy for a non-TTY stdin is to fail **open** (`approval-gate.ts:14-15`; `isTty()` at
`agent/src/approval.ts:73`), and the interface never set `MNEMO_APPROVAL_MODE` when spawning
the agent.

**Effect.** In the live path the gate auto-approved `bash_exec`, `write_file`, `apply_edit` and
`ipy_run` — gated precisely because a Python cell has full filesystem, network and process
access. The `ask` tier of `~/.mnemo/permissions.json` behaved as `allow`; only explicit `deny`
rules still bit. In the issue's own words: *"the security posture described in the gate's own
header comment is not the posture in force."*

**Nuance.** The measurement that found it is the reason to trust the finding: **45 RPC commands
documented, 4 used**. And this one hole was load-bearing in both directions — it silently
swallowed *every* other extension that wanted to ask a question, which is why #23's "selecting
`/llama` is a silent no-op" is the same bug wearing different clothes: the palette offered a
command whose failure had nowhere to appear.

**Fix.** `360e985` (interface) + `c18ec13` (gate).

- `select`/`confirm`/`input`/`editor` become a dialog on the existing overlay machinery — esc
  cancels, enter picks, a second request queues, drafts survive. The response goes back in the
  shape pi reads per method: `confirm` → `confirmed`; `select`/`input`/`editor` → `value`;
  dismissal → `cancelled`. `notify`/`setStatus` land on the status line;
  `setWidget`/`setTitle`/`set_editor_text` are **deliberately ignored with a comment saying
  why**. The spawn sets `MNEMO_APPROVAL_MODE=interactive`, dropping any stale inherited value
  (`pi.go:464-486`).
- The gate's prompting condition is now "is there a dialog-capable UI"
  (`ctx.hasUI === true || ctx.mode === "rpc"`) instead of `process.stdin.isTTY`. Every safety
  property was kept and pinned by tests: deny rules and plan mode block in **every** mode; a
  delegated child with no UI still fails **CLOSED**; a no-UI automation run still fails
  **OPEN**; `MNEMO_APPROVAL_MODE=off/0/unset` remains the documented force-approve hatch.

Evidence: `tui-go/internal/pi/contract_test.go:409` (`TestTheDocumentedExtensionUIRequests`)
plus the on-the-wire tests in `fakepi_test.go:252,278,297`; the issue's own verification line —
20/20 Go packages, `go vet` clean, goldens byte-identical, `tsc` clean, agent suite with the
same failing-name set as before, CI 8/8 including macOS and Windows.

**After effect.** The `ask` tier asks. A user with `ask` rules now gets a dialog before a
mutating tool runs, and the answer can be a flat no — which is exactly what the gate was
written to do and could not do. Side effect worth noting because issue #23 depends on it:
`/hook`, `/schedule`, `/trigger` and `/now` became **visible** again, because they report
through `ui.notify` and nothing read that before.

**Two warts.** (i) The dialog *is* the indicator — there is still no passive "something is
waiting for you" row in the transcript, so a reader with the modal behind a scrolled overlay
learns about it only when the tool call blocks (#3 listed this as a gap; it is answered only in
the sense that asking now happens). (ii) The gate now depends on a person: a run nobody is
watching can sit on a dialog until it is answered, and the escape hatch
(`MNEMO_APPROVAL_MODE=off`) is documented rather than automatic.

---

## #16 — Resume and /new do not move the session: the transcript and the model's context diverge

**CLOSED** 2026-09-14 by `360e985` · `bug`

**Cause.** `resume()` (`tui-go/app/update.go:1142-1153` at the time) read a session file,
cleared the transcript and replayed its blocks — and **never told the agent to switch**.
`switch_session` was not implemented anywhere in `tui-go`; the only verbs written to pi were
`prompt`, `steer`, `abort` and `get_commands` (`pi.go:300,368-374`). `/new` was the mirror
image: it cleared the view (`update.go:803-806`) while pi's session file kept growing.

**Effect.** After picking a session in `^s`, the next prompt went to **the session the process
was launched with**. The transcript showed conversation A; the model was in conversation B; and
nothing said so. This is the worst possible shape of the bug for a session UI, because every
visible signal agrees with the wrong state.

**Nuance.** "Which conversation am I in" is the one thing a session UI must not be vague about —
and the closing comment adds a correction that is itself part of the record: *pi's field is
`sessionPath`, not `sessionFile`* — checked against the shipped
`dist/modes/rpc/rpc-types.js`, not just the prose in `rpc.md`. That correction is preserved in
the code (`pi.go:729` comments it). The ledger keeps it because the next reader will make the
same assumption from the same document.

**Fix.** `360e985`. `resume()` now sends `switch_session` (`pi.go:739`) and `/new` sends
`new_session` (`pi.go:747`), both folded into transcript notices — **moved / refused / new /
cancelled** — with failures surfacing as errors rather than silence.

Evidence: `app/session_move_test.go` (`TestPickingASessionTellsTheAgentToMove`,
`TestTheSwitchIsAcknowledgedInTheTranscript`, `TestARefusedSwitchIsVisibleNotSilent`,
`TestNewSessionTellsTheAgentToStartOne`, `TestTheClearBuiltinIsTheSameOperation`,
`TestANewSessionTheAgentRefusedIsVisible`) and the on-the-wire tests
`pi/fakepi_test.go:321` (`TestSwitchSessionGoesOverTheWire`) and `:340`
(`TestNewSessionGoesOverTheWire`). The issue shipped with 20/20 Go packages and CI 8/8.

**After effect.** The transcript and the model's context now move together, and a refusal is
visible instead of silent. The wart: a session pi refuses to switch to leaves the transcript
where it was with a notice line as the only explanation — nothing reconciles what pi *actually*
holds, because `get_state` is still unimplemented (#14 P5). "The transcript is what the model
has" is now true of the happy path; it is asserted, not verified, on the failure path.

---

## #17 — Project trust is never resolved, so project-local pi resources load silently or not at all

**CLOSED** 2026-09-14 by `360e985` (spawn) + `59defb2` (the macOS-only bug) · `bug`

**Cause.** pi asks before trusting a project; in non-interactive modes, trust-requiring
resources are **ignored** — `.pi/settings.json`, `.pi/{extensions,skills,prompts,themes}`,
`.pi/SYSTEM.md`, `.pi/APPEND_SYSTEM.md`, and project `.agents/skills`
(`docs/security.md:5-29`, `docs/settings.md:14-22`). Mnemo spawned with
`--mode rpc --no-builtin-tools` and nothing trust-related; `defaultProjectTrust`, `trust.json`
and the `project_trust` event appeared nowhere in `agent/` or `tui-go/`.

**Effect.** Reproduced against the installed pi 0.84.3 with an isolated agent dir: `get_commands`
returned **7 project-scoped commands with `--approve` and 0 without** — no prompt, no diagnostic
either way. Two consequences, and the second is the one that made this worth fixing first:

- a project's own guardrail extension — exactly the thing that lives in `.pi/extensions` — did
  not run;
- `AGENTS.md` still loaded, because it is trust-exempt, so **a partial load looked total**;
- and the palette listed project skills read off disk (`internal/command/command.go:104-107`),
  offering rows pi would not claim.

**Nuance.** "A partial load looks total" is the finding worth keeping. The failure mode was not
a missing feature but a *lying* interface: the user saw their project's configuration apparently
in force, minus the parts that had been silently dropped.

**Fix.** `360e985` + `59defb2`. `~/.mnemo/trust.json` holds the decision, keyed by absolute
project path with closest-ancestor lookup like pi's own store. Both `--approve` **and**
`--no-approve` are passed explicitly — never left to pi's default — the unrecorded answer is the
safe one, a broken file still decides safely and carries the reason into the transcript, and the
transcript states which way it went and what that means.

CI then caught a real bug in the first version, **on macOS only**: `t.TempDir()` returns
`/var/folders/...` while `os.Getwd()` returns the resolved `/private/var/folders/...` (both are
symlinks there), so a decision keyed under one spelling missed a lookup under the other. Both
sides now canonicalise through one helper that follows symlinks and resolves the longest
existing prefix — because a decision can legitimately name a checkout that does not exist yet.
Two portable tests pin it, one of which creates its own symlink
(`tui-go/internal/pi/trust_test.go`: `TestASymlinkedPathStillMatches`,
`TestAPathThatDoesNotExistYetStillResolves`, plus `TestNoRecordedDecisionIsTheSafeAnswer`,
`TestARecordedDecisionIsUsedVerbatim`, `TestADecisionForAParentCoversItsChildren`,
`TestABrokenTrustFileIsTheSafeAnswerNotACrash`, `TestTheDecisionIsMadeForTheAbsolutePath`), and
`app/session_move_test.go:131` (`TestTheTrustDecisionIsOnTheRecord`) pins that the answer reaches
the transcript.

**After effect.** Project `.pi/settings.json`, `.pi/extensions`, `.pi/prompts`, `.pi/SYSTEM.md`
and project `.agents/skills` are no longer silently ignored — the answer is explicit and stated,
every session, in the transcript. The wart: the decision is per-directory and persists until the
file is edited; there is no in-TUI revoke, so changing your mind means editing
`~/.mnemo/trust.json` by hand. And the macOS case is the reason the trust path is now the
canonical example in `scripts/ci.mjs` of why one OS is not enough: Linux agreed with itself.

---

## #18 — Three skill catalogues disagree, and get_commands is asked once per process

**CLOSED** 2026-09-16 by `b965caf` · `bug`

**Cause.** Three different definitions of "the skills", with different roots and different
frontmatter rules:

| who | roots | knows about |
|---|---|---|
| pi's resource loader | `.pi`, packages, `~/.pi/agent` | everything — but only in a trusted project |
| `agent/src/skills/discovery.ts:75-86` | `.pi`, `.agents` | strict flat-YAML frontmatter only |
| the Go palette scan (`tui-go/internal/command/command.go:94-123`) | `.claude`, `.pi`, `.agents` | no packages |

**Effect.** One skill yielded **two palette rows** (`/name` from disk, `/skill:name` from pi);
`.claude` skills existed only for the Go scan and package skills only for pi; and
`get_commands` was asked exactly **once per process** (`pi.go:293-301`), so anything a pi
package installed mid-session was invisible until restart.

**Nuance.** The fix is not "merge three lists". It is the same move as #14's P2: make
`get_commands` the single catalogue for agent-side commands and keep the disk scan as the
*offline fallback only*, because the disk scan cannot know what a package contributed and the
agent cannot answer when there is no agent.

**Fix.** `b965caf`. The app keeps both: `m.disk` from the startup scan (`app/model.go:229`),
`m.live` from pi's answer (`app/update.go:531`), folded by `command.Catalogue(m.live, m.disk)`
(`update.go:551`) into built-ins → agent → disk, **one name per row**. The "second spelling"
rule is enforced by a canonicaliser that folds case, separators and pi's leading `skill:`, so
`skill:review` (pi) and `review`/`code-review` (disk) are one row and **the agent's wins**; a
name pi does not answer for still appears from disk (`command.go:389-403`). Freshness:
`/commands` re-asks on demand and reports the count, and `/new` and `/clear` re-ask as a matter
of course. The palette's purpose line states the provenance — "the agent's list, live" vs "the
list on disk" — on the stated principle that *"a catalogue that silently changes where it came
from is worse than one that is merely stale"*.

Evidence: `app/catalogue_test.go` — `TestTheAgentIsTheCatalogueForTheCommandsItImplements`,
`TestTheCatalogueIsAskedAgainOnANewSessionAndOnDemand`,
`TestAskingOnDemandReportsWhatCameBack`, `TestThePaletteSaysWhetherTheListIsLiveOrOffDisk`,
`TestARefusedCatalogQuestionIsNotAFailure`.

**After effect.** One row per command, the agent's definition wins, and the list says whether it
is live or off disk. The wart: the fold covers case, separators and the `skill:` prefix — not
semantic renames. A skill the agent registers under a name that shares no spelling with its
folder still appears twice (once from each source), which is the residual of keeping a fallback
list at all.

---

## #19 — There is no configuration channel into pi, and sessionDir is hardcoded

**CLOSED** 2026-09-16 by `b965caf` (after `f428e67`) · `bug`

**Cause.** Nothing in either codebase read or wrote `~/.pi/agent/settings.json` or
`.pi/settings.json`, so `compaction.*`, `retry.*`, `shellPath`, `enabledModels`, `sessionDir`,
`defaultTools`, `thinkingBudgets` and `steeringMode` were unreachable from any Mnemo surface.
Related, same theme: the sessions browser hardcoded `~/.pi/agent/sessions`
(`internal/session/session.go:22`), no `--session-dir` was passed and
`PI_CODING_AGENT_SESSION_DIR` was unread — so a user who relocated sessions per pi's documented
precedence **lost the `^s` listing**; and a third notion of "sessions" survived at
`~/.sea/sessions` (`agent/src/skills/store.ts:29-31`).

**Effect.** A configured session directory was invisible to the browser; a project's
`.pi/settings.json` was inert (see #17); and `^s` showed nothing where the agent was writing.

**Nuance — pi's precedence has a trap in it.** Passing pi's *own default* back to it as
`--session-dir` stops pi nesting sessions per project, which then hides the nested ones from
pi's own `/resume`. That is why the fix has an exception for the case where the answer is
"pi's default anyway" instead of a value.

**Fix.** `f428e67` took the first half (defaults resolved against the Mnemo home, which was what
broke installed runs — see #20), and `b965caf` took the rest:

- `session.Root()` resolves pi's documented precedence —
  `PI_CODING_AGENT_SESSION_DIR` → `sessionDir` in pi's **global** `settings.json` (located
  through `PI_CODING_AGENT_DIR`, with `~` expanded against the home passed in) →
  `<agentDir>/sessions` (`session.go:26-56`).
- The browser reads **both layouts pi writes**: per-project subdirectories (the default) and
  flat files (where a configured directory *is* the session directory, projects told apart by
  each header's `cwd`).
- `SpawnDir()` hands the same value to the spawn as `--session-dir`, with one deliberate
  exception: it returns `""` when pi's own default is the answer, for the trap above
  (`session.go:77`).

Evidence: seven new session tests — `TestTheSessionDirectoryComesFromTheEnvironmentFirst`,
`TestTheSessionDirectoryCanComeFromPisSettingsFile`, `TestAgentDirMovesTheDefaultToo`,
`TestPrecedenceIsPisPrecedence`, `TestASessionDirWithATildeIsResolved`,
`TestSpawnDirSpeaksOnlyWhenPisDefaultIsNotTheAnswer` — plus a `spawnPlan` test asserting the
browser and the agent agree about where sessions live.

**After effect.** `^s` lists the sessions the agent actually writes, including a relocated
directory, and `/resume` inside pi still finds the nested layout because the default is not
echoed back.

**What the issue asked for that is still not done, verified at the snapshot.** Nothing in Mnemo
reads or writes pi's `settings.json`, so `compaction.*`, `retry.*`, `enabledModels`,
`defaultTools` and `thinkingBudgets` remain unreachable from Mnemo's surface — `shellPath` is
the one exception and only because the shell resolvers read it (#2, #22). And the third session
store is **not** retired: `~/.sea/sessions` is still the default in
`agent/src/skills/store.ts:30`, used only by `mnemo --list-sessions`. Two of the three
conventions agree now; the legacy one remains.

---
## #20 — Hardcoded and duplicated values: the provider table, a model id in the UI, and a compile-time tuning surface

**OPEN** · filed 2026-09-14 · partially addressed by `f428e67`, `360e985`, `150bacf` · `enhancement`

**Cause.** An audit of values that will need to change and could not. The list is the entry:

- **The provider list existed in four places across two languages** —
  `agent/src/auth/store.ts:19` (`PROVIDERS`), `agent/src/provider.ts:14` (`SUPPORTED`), the two
  copies of the env-var map (`store.ts:29`, `provider.ts:18`), and `tui-go/internal/auth/auth.go:20`
  (`Providers`). Adding one provider meant editing three files in two languages, and **nothing
  tested that they agreed**.
- **The sidecar and journal defaults resolved against the checkout, not the user's home** —
  `agent/src/hooks/memory.ts:23-27` and `agent/extensions/memory-layer.ts:23-29` both computed
  `REPO_ROOT + memory-layer/target/debug/memsrv`, so an installed binary (npm global, or the
  release tarball) pointed at a tree that does not exist; the two copies had to be kept in step
  by hand. `memory-layer/src/bin/mempolicy.rs:17` used a third convention (CWD-relative).
- **One threshold, two numbers, two languages** —
  `agent/extensions/memory-layer.ts:415` `CONSOLIDATE_THRESHOLD = 3` against
  `memory-layer/src/consolidate.rs:13` `MIN_OCCURRENCES = 2`.
- **A model id in the UI** — `tui-go/app/update.go:2029` defaulted an empty model name to
  `deepseek-v4-flash`, but only for provider `opencode-go`; every other provider got an error.
  The comment called it "the canonical default of the build", which the issue rightly calls
  "the tell".
- **The memory layer's whole tuning surface is compile-time** — `DIM`, `SEARCH_CACHE_CAP`,
  `MIN_OCCURRENCES`, `CROSS_AREA_DISCOUNT`, `USEFULNESS_BIAS`,
  `EMBED_TIMEOUT`/`ATTEMPTS`/`BACKOFF`, and the steering weights. No config file, no env, no
  flag.
- **Interface timings** — `ListTimeout` 20 s, memory `Timeout` 10 s, `NoticeFor` 5 s,
  `MenuRows` 8, `MinKeyLen` 8 — collectively the whole configuration surface, none of it
  settable.

**Effect.** A provider added on one side could silently stop being visible on the other. An
installed binary's Memory pane pointed at a directory that was not there. A number that meant
one thing existed as two numbers. A provider-specific default hid inside a UI fallback, so a
`/model` mistake in any other provider produced an error rather than a sensible choice.

**Nuance, and it is the audit's one clean verdict: "no secret is hardcoded anywhere, and CI
enforces it."** That is worth quoting because it is enforced the boring way — a `secrets` job
that greps the working tree *and* the last 200 commits for credential shapes, with an explicit
list of redaction fixtures the gate must not fire on, and the reasoning for both in the comments
(`.github/workflows/ci.yml:161-198`). The lesson attached to it: the one category that was clean
is the one that had a gate.

**Fix — what landed.**

- **`f428e67`** — one provider source per language with drift tests that fail when the other
  side changes, *proven by mutating the counterpart rather than merely passing*:
  `tui-go/internal/auth/providers_test.go` (`TestTheAgentStoreIsTheSameProviderList`,
  `TestTheAgentStoreExportsTheSameEnvVars`) parses `store.ts`, and
  `agent/test/provider_ids.test.ts` pins pi's own provider ids and, at the bottom, the Go file —
  "both fail on any divergence, in either direction". The duplicated constants in
  `memory-layer.ts` are deleted in favour of one resolver (`resolveMemsrvPaths`) that tries env →
  `$MNEMO_HOME` → the checkout *only if it exists*.
- **`f428e67`** — the two thresholds renamed for what they do and made env-overridable, each
  documented next to the other in both files: `CONSOLIDATE_EVERY_N_EPISODES` (TypeScript, "when
  to run", `MNEMO_CONSOLIDATE_THRESHOLD`, default 3, `memory-layer.ts:429-437`) and
  `DEFAULT_MIN_SOURCES_FOR_THEME` (Rust, "what counts as recurring", `MNEMO_MIN_OCCURRENCES`,
  default 2, `consolidate.rs:19-27`). Unusable values fall back to the default: `0`, `""` and
  `"junk"` are all pinned in `consolidate_tests.rs:126-130`.
- **`f428e67`** — the wizard's `deepseek-v4-flash` special case is a table beside the provider
  list: `tui-go/internal/auth/auth.go:43` maps `opencode-go` to it, `DefaultModelFor` reads it,
  and `app/default_model_test.go` iterates every provider to assert the fallback is not a
  special case hidden in a UI path. (The agent side names the same model in its provider labels,
  `agent/src/auth/wizard.ts:20`.)
- **`150bacf`** — from this issue's own list, the interpreter: it had been `python3` on every
  platform and is now resolved per platform (`agent/src/python.ts`, #1).

**What is still open, verified.**

- **The interface timings are being fixed right now, uncommitted.** Both comments in the issue
  say "still compile-time … no `~/.mnemo/config.json`". At the snapshot a worker has an
  untracked `tui-go/internal/limits/` that owns all five keys with a documented file
  `~/.mnemo/limits.json`, one env var per key (`MNEMO_LIST_TIMEOUT`, `MNEMO_MEMORY_TIMEOUT`,
  `MNEMO_NOTICE_FOR`, `MNEMO_MENU_ROWS`, `MNEMO_MIN_KEY_LEN`), flags on `cmd/mnemo`, precedence
  **flag → env → file → built-in default**, and per-key leniency — a missing, truncated,
  wrong-typed or out-of-range value means "that key was not configured", never an error dialog
  (`limits.go:1-15,129-182`). Two caveats visible in that uncommitted code: the file is
  `limits.json`, not the `config.json` this issue proposed; and `limits.go:208-215` says
  `app/**` "is not this change's to edit", so it carries its own `NoticeFor` variable that is
  parsed, validated and tested but **not yet read by the app** — the interface keeps the five
  seconds it shipped with until a one-line change lands in `app/model.go`. It is not a fix yet:
  no commit, no sha.
- **The memory layer's tuning surface is still compile-time**: `DIM = 256` (`vec.rs:6`),
  `SEARCH_CACHE_CAP = 256` (`cache.rs:20`), `CROSS_AREA_DISCOUNT = 0.85` (`search.rs:92`),
  `USEFULNESS_BIAS`, the embed retry/backoff, and the steering weights. There is no
  `~/.mnemo/memory.json`. The nuance worth recording: the list is not uniform — `EMBED_TIMEOUT`
  already reads `OPENROUTER_EMBED_TIMEOUT_MS` (`remote.rs:71`), so "everything is compile-time"
  is one honest exception short of true.
- **`mempolicy`'s third journal-path convention is resolved**: it now goes through
  `$MNEMO_HOME` with an existence probe and `CARGO_MANIFEST_DIR` only as a last resort
  (`mempolicy.rs:125-133`), so two of the three conventions agree; the legacy `~/.sea/sessions`
  store (#19) is the one that does not.

**After effect.** An installed binary no longer points memory at a checkout that is not there; a
provider added on one side fails the other side's test until both agree; the wizard's default
model is a table entry rather than a special case; and a hung provider costs 20 seconds before
`/model` says so — with that number about to become a preference instead of a rebuild.

---

## #21 — Shell tools get none of pi's session environment, and the process markers are never set

**CLOSED** 2026-09-14 by `c18ec13` · `bug`

**Cause.** pi injects `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL` and
`PI_REASONING_LEVEL` into every bash command, resolved per call
(`docs/environment-variables.md:26-45`), and sets the process markers `AI_AGENT=pi` /
`PI_CODING_AGENT=true` from its CLI entry points. Mnemo calls the library `main()`
(`agent/bin/mnemo.ts:25,333`) and ships **its own** `bash_exec`, which spawned with
`env: scrubChildEnv()` and injected nothing (`bash_exec.ts:44-47`); the kernel and subagents did
the same (`ipy_run.ts:173-176`, `subagent.ts:120-127`). Stale `PI_*` values were never stripped
either, so a nested Mnemo launched from a pi bash session leaked the parent's session metadata
to its children.

**Effect.** Scripts written against pi's documented variables misbehaved **quietly** — a tool
reading `$PI_SESSION_ID` got `undefined` rather than an error, and a common convention (logging
which session a command ran in) silently logged nothing. A nested run could tag its children
with the wrong session.

**Nuance.** The fix belongs in one helper, not three call sites — and the tests assert the
environment a **fake** child receives, so no real shell is needed. That is the same fixture
discipline #2 was forced to adopt, applied here from the start.

**Fix.** `c18ec13`. `childShellEnv()` (`agent/src/childenv.ts:138`) scrubs the environment,
**deletes the five documented `PI_*` names** (so a nested Mnemo cannot leak its parent's session
metadata), then sets the live values from pi's context. It is wired into `bash_exec` per call
(`bash_exec.ts:104`), into the Python kernel (spawn env plus in-kernel bash calls,
`ipy_run.ts:374`) and into `spawn_subagent`. The shim sets `AI_AGENT=pi` and
`PI_CODING_AGENT=true`, and `bash_exec`'s description now documents all five variables and both
markers — the description is part of the contract the model writes against.

Evidence: 33 new tests, including ones that assert the environment a fake child receives (no
real shell needed); `tsc` clean; no new failures in the agent suite; CI 8/8.

**After effect.** A script that reads `$PI_MODEL` or `$PI_SESSION_ID` works under Mnemo the way
it does under pi, and a nested Mnemo cannot leak its parent's session id into the children it
spawns. The wart: the variables are in the tool *description* rather than in `docs/`, so someone
reading the docs to learn what the shell provides finds it by running `bash_exec --help`-shaped
introspection instead.

---

## #22 — On Windows the bash tool promises /bin/sh and runs cmd.exe

**CLOSED** 2026-09-14 by `c18ec13` · `bug`

**Cause.** `bash_exec` spawned with `shell: true` (`agent/src/tools/bash_exec.ts:42`) — which is
`cmd.exe` on Windows — while the description **the model reads** promised `/bin/sh -c`
(`bash_exec.ts:9`).

**Effect.** Verified on this host: `spawn(cmd, {shell: true})` expands `%COMSPEC%` to
`C:\WINDOWS\system32\cmd.exe`; `spawn(sh, ['-c', …])` succeeded only because Git for Windows was
on the inherited `PATH`. So the model wrote POSIX (quoting, `&&`, `$VAR`, globbing) and cmd.exe
executed it. pi's Windows story was unavailable in Mnemo too: `--no-builtin-tools` disables
`bash` **and** the optional native `powershell` tool, pi's Git Bash resolution and `shellPath`
setting were bypassed, and Mnemo shipped no PowerShell tool. The hooks engine's own `sh -c`
(`agent/src/hooks/executor.ts:205`) had the same dependency, which is #2.

**Nuance.** This is a *description* bug before it is an execution bug — the model could not know
what it was writing for, and a wrong shell produces wrong output that looks like the model's
mistake. The same class of bug reappeared in the hooks engine, which is why the fix for #2
resolves a shell per invocation rather than per tool.

**Fix.** `c18ec13`. The description is computed per platform and says what is true: `/bin/sh` on
POSIX; on Windows, `cmd.exe` — explicitly "not POSIX sh" — with the way out named (`MNEMO_SHELL`,
or pi's global `shellPath`). A resolved override is named in the description ("Git Bash (path)")
and Node is invoked with `-c` for non-`cmd` overrides so a POSIX shell really behaves like one.
A configured override that cannot be resolved **throws** rather than silently falling back.
Project-scope `shellPath` is deliberately not read: it lives behind project trust (#17).

**After effect.** The model is told the shell it is actually getting, and a Windows user can
point `MNEMO_SHELL` at Git Bash or PowerShell and have the description say so. Warts: there is
still no native PowerShell tool, so Windows users take the "not POSIX sh" branch or configure
one; and the same platform default now applies to hooks (#2), where a POSIX-syntax hook that
used to find `sh` on `PATH` needs its shell declared.

---

## #23 — Providers: five API keys and nothing else — subscription logins and local models are unreachable

**CLOSED** 2026-09-16 by `6b540d8` · `bug`

**Cause.** Mnemo's provider set was five API-key providers hardcoded in three places
(`agent/src/auth/store.ts:19-25`, `agent/src/provider.ts:14-21`,
`tui-go/internal/auth/auth.go:20`); the wizard only ever wrote `kind: "api_key"`
(`agent/src/auth/wizard.ts:61`); and the shim **exited** rather than starting without one of the
five (`agent/bin/mnemo.ts:318-323`) — verified: `pickProvider({DEEPSEEK_API_KEY: …})` returns
null. Meanwhile pi supports subscription logins (Claude Pro/Max, ChatGPT/Codex, GitHub Copilot,
xAI, OpenRouter OAuth) and ~30 API-key providers with `!command`/`$ENV` key resolution, and its
`/login` is implemented in the *interactive* mode only and absent from `get_commands`, so it
could not be reached from the TUI either.

**Effect.** **"A tester whose only credential is a subscription cannot use Mnemo at all."** The
local-model case was worse than missing: llama.cpp is not one of the five, yet `/llama` **was**
offered by the palette (pi answers it over `get_commands`) and selecting it was a **silent
no-op** — silent because of #15's missing reader, which is the same hole wearing different
clothes.

**Nuance.** The finding is about ordering, not about code: "the people most likely to test it
first were the ones locked out." A pre-alpha whose first screen refuses the credentials its
underlying agent accepts has a distribution problem disguised as an auth problem.

**Fix.** `6b540d8` — "Mnemo was refusing credentials pi accepts".

- `MNEMO_PROVIDER` naming anything outside Mnemo's five now **passes straight through** with no
  key demanded (llama.cpp, subscriptions, package providers); an unknown name is pi's error to
  give.
- New `agent/src/auth/pi_store.ts` reads pi's own `auth.json` (api_key **and** oauth, including
  provider-scoped env) and `settings.json`, read-only — a credential **pi** holds is enough to
  start, so a Claude Pro token in pi's store no longer provokes a demand for
  `ANTHROPIC_API_KEY`.
- pi's `defaultModel` is used when Mnemo's is unset and describes the same provider.
- The refusal, when it comes, **names the working options** — the four env vars, pi's `/login`
  route, the local llama.cpp route, the overrides — instead of a dead end. `mnemo auth status`
  reports pi's stored credentials too.

Evidence: 16 tests in `agent/test/pi_credentials.test.ts`, including "a pi credential for one
provider does not vouch for another", "an entry pi itself would reject is not a credential" and
"a corrupt or missing auth.json is no credential, never a crash". Live checks on this host:
`MNEMO_PROVIDER=llama.cpp mnemo --help` exits **0** (was 2, "not supported"); with only pi's
`auth.json` present, `--list-models` lists models (was exit 1); a bogus model in pi's settings
reached pi and came back as pi's own warning, proving the fallback is live.

**After effect.** A subscription-only tester and a local-model user can start Mnemo, and a
refusal names what does work.

**One gap the closer named, and it is still there**: "the TUI's first-run onboarding still offers
only its own key-based login even when pi holds a credential. The run path is unblocked; that
screen is not yet." The Go side cannot read `pi_store.ts` — it has its own `internal/auth` store
under `~/.mnemo/auth.json` — so the first thing a new user sees is still a demand for a key the
agent would not have needed.

---

## #24 — A changed fact stays: same-key writes append instead of superseding, so the model is handed two contradictory instructions

**OPEN** · filed 2026-09-14 · fix in flight, uncommitted · *(filed without a label)*

**Cause.** The write path appends. `memsrv`'s `fact` op adds a fact with the given key and does
**not** look for an existing *active* fact with the same key on that node. Supersession exists
(`Op::SupersedeFact`) and the steering path uses it (`steer.rs`, the correction flow) — but
nothing on the ordinary write path (`memory_write_fact` → `fact` RPC) ever reached for it.

**Effect.** This is the failure the constraint probe of #10 found on its first run. After a
constraint is *changed*, the state the model is handed contains both versions:

```
[Aspect/Semantic] repo conventions #1
facts:
  - package manager: use npm in this repo; pnpm is not installed here
  - package manager: use pnpm in this repo; the registry outage is over
```

Two live instructions, one of them wrong, and nothing marking which is current. Over a
long-lived graph this is worse than noise: the injected block is *presented as fact*, and a model
reading two contradictory instructions has no reason to prefer the later one. That also breaks
the doc's own claim — retrieval is "a candidate list, never presented as fact"
(`docs/MNEMO.md`) — for the one part of the context that is inlined as state.

**Nuance.** The design that makes this interesting is *supersede-never-delete*: history is kept,
so the fix cannot be "overwrite the old value". What was missing is that the **rendered state**
must show one current value and mark the rest, and that the decision to retire a value belongs to
the runtime rather than being taken silently on write — "proposing is the job, deciding belongs to
the runtime" (the M10 design in `research/memory-runtime-design.md`). The issue's ordering
reflects it: record the contradiction first, then cheaply mark staleness even before
contradiction detection exists.

**Fix — none committed.** The evidence is committed and runnable:
`memory-layer/tests/constraint_probe.rs::a_changed_constraint_returns_the_new_value_and_retires_the_old`
is `#[ignore]`d at HEAD with the captured state in its doc comment; `cargo test --test
constraint_probe -- --ignored` reproduces it. The issue says what to do with it: "un-ignore it
when this lands, and the probe becomes a guard rather than a record."

**In flight at the snapshot — not a fix, because there is no commit.** The working tree contains
the change being written now:

- `memory-layer/src/store.rs` — `Op::SupersedeFact` retires **every other active fact under the
  same key** (not just the one named), keeping each id and value with `status: Superseded` and
  `superseded_by` set, logging how many extra were retired; and `state_of` stops rendering
  retired facts as live instructions, appending instead a line that says how many retired values
  are kept as history ("the facts above are the current answer").
- `memory-layer/src/bin/memsrv.rs` — `fact` now **supersedes by default** when an active fact
  with that key exists, with an explicit `append: true` opt-out "only for a genuinely SET-VALUED
  key (a harness's tool list, where one key carries several values and none supersedes another)
  … It is never the default"; a new read-only `history` op returns every fact with its status and
  `superseded_by`; and `nodes` reports a `retired` count per node so a listing can tell "one
  value" from "one value and three retired ones".
- `memory-layer/tests/constraint_probe.rs` — the test is **un-ignored** in that tree, with
  assertions that both versions survive, exactly one answers a live query, the retired one keeps
  its id and text and records what replaced it, and a **journal replay** reproduces the same
  one-current-value graph with the write journaled as a supersede.

**After effect.** Today: a changed fact still returns both versions and a model can act on the
wrong one — the probe exists to catch exactly that, and it currently fails on purpose. When the
in-flight change lands, the user-visible difference is that a constraint they changed is answered
with one value, the retired value is still retrievable through `history` (nothing is deleted),
and the state text says so — with the `append: true` opt-out the thing to know about if a key is
genuinely set-valued.

---

## #25 — tui-go: /fork can only fork from the newest message

**OPEN** · filed 2026-09-16 (by the closing of #3) · `enhancement`

**Cause.** The first slice of `/fork` landed in `b965caf`: it takes the **newest** entry from
pi's `get_fork_messages` reply, cuts the transcript back to it, and puts that message into the
editor. What is missing is the choice.

**Effect.** "Fork from here" means "fork from the last thing that happened", so a user who wanted
to branch from something earlier cannot.

**Nuance.** The data for the picker is **already fetched** — the same `get_fork_messages` reply
carries every forkable message — so this is UI work over data the interface has, not protocol
work. That is also why it is worth stating as a scoped follow-up rather than a research item.

**Fix.** None for the picker. What did land is the mechanics around it, and they are not
trivial: the transcript is cut back to the fork point because the branch does not contain the
later turns (`TruncateAt`), and cancelled, empty, no-agent and mid-turn each say what happened
rather than failing silently.

**After effect.** The gap is explicit rather than hidden — a genuine improvement over the state
before, where the absent feature was invisible. The family it belongs to remains unimplemented
and invisible in the interface: **`/clone`** (duplicate the session without cutting it), the
**session tree** (branch structure is not drawn, so a fork looks like the same session with less
history), and **branch naming** (a fork inherits the parent's name).

---

## What this ledger says when it is read as a whole

- **Precision about provenance is this repo's house style, and it is the thing the fixes actually
  protect.** The commands palette says whether its list is live or off disk (#18); the shell
  description says which shell you got (#22); the trust decision is announced every session (#17);
  a startup failure carries pi's own words and the way out (#13); `mempolicy` and the eval probe
  emit machine-readable numbers rather than prose (#5, #10). Where that discipline was missing,
  the failure was consistently *not* a crash but a lie: a partial project load that looked total
  (#17), a palette row for a command that quietly did nothing (#23), a mouse path that looked
  implemented (#4), a transcript in conversation A while the model was in conversation B (#16),
  and a security posture described in a header comment that was not the posture in force (#15).
- **The failures that took longest to find were the ones nobody could see**: they needed a second
  operating system (#1, #2, #22), a second spelling of a directory (#17), a run under load (#9),
  or a probe that argued with the product (#10 → #24). Two of the four OS bugs were invisible for
  the same reason — CI ran on one runner.
- **One closed issue carries a claim the code does not support** — #5's ANN routing, which is
  still dead code in the shipped binary — and two open issues have internal claims that have gone
  stale: #20 says its timings are compile-time while an uncommitted fix sits in the tree, and #1's
  last comment describes a remaining set it has not finished. Read those three entries before
  trusting the state the tracker shows.
- **Every accepted risk in this repo is written down, and two of them are still accepted**: harness
  bundles run in-process with the host's privileges (#7) and the sub-agent fan-out has no breadth
  cap (#6). They are not oversights; they are decisions with their reasoning attached, which is
  the most this ledger can ask for.

## Keeping this file true

The rule that makes this document checkable is the one the repo already uses: **a claim of
"fixed" needs a commit sha or a test name.** When an issue here is closed, add its entry with
the sha; when a fix turns out to be partial, say what remains in the entry rather than in a
follow-up comment — comments are where the two wrong claims in this file came from. The two
entries most likely to need updating are #20 (the `limits.json` surface is one `app/model.go`
line from being real) and #24 (whose test is already un-ignored in the working tree and fails on
purpose until the supersede path is committed).



