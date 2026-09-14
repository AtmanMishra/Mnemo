# All-in-One Agent: Feature Catalog & Design Ideas

*Status: design proposal (not yet planned). Companion to plan.md and STATUS.md.
Goal: make Mnemo the one terminal agent that does everything a SOTA agentic
coding agent does, without diluting its differentiators (memory layer, harness
engine, ipy kernel).*

## 0. Design rule (read first)

Before proposing any feature, answer: **does pi already provide it?** pi-native
wins by default (streaming, sessions, compaction, provider catalogue, skill
discovery, extension scopes, `tool_call`/`tool_result` interception). Write
custom code only where the product thesis demands it (memory, harness,
permissions on custom tools) or where the user contract (scopes, auditing,
self-building) is richer than pi's raw events. Every custom feature must be
deterministic-testable with temp dirs and injected IO, per HANDOFF.md §6.

---

## PART A — The Hooks System (the ask)

### A.1 What pi already gives us (verified in docs/extensions.md)

| Pi event | Interception | Used by Mnemo today? |
| --- | --- | --- |
| `tool_call` | **can block** (pre-tool) | yes — approval-gate.ts |
| `tool_result` | **can modify** (post-tool) | **no** — unused |
| `tool_execution_update` / `tool_execution_end` | observation | end → memory commit_log |
| `before_agent_start`, `turn_end`, `session_start/shutdown`, `message_end` | observation | memory directive + recall, auto-steer, episode/outcome |
| extension scopes: `~/.pi/agent/extensions/` (global), `.pi/extensions/` (project) | — | no (extensions are code, not user hooks) |

So pre/post-tool interception exists at pi level but is (a) only usable by
writing TypeScript extensions, (b) lacking a user-facing contract, (c) lacking
an audit trail, (d) not self-buildable by the agent.

### A.2 The Mnemo hook contract (new: agent/src/hooks/)

A hook = one small rule file, matching a middleware event, runnable as a script
(any language) with JSON on stdin — the Claude Code hooks model, but wired to
pi's events instead of a proprietary runtime.

```jsonc
// .mnemo/hooks/audit.store-writes.json
{
  "id": "audit.store-writes",
  "trigger": "PreToolUse",            // PreToolUse | PostToolUse | UserPromptSubmit | TurnEnd | SessionStart | SessionShutdown | Notification
  "matcher": { "tool": "write_file|apply_edit", "path": "src/**" },
  "command": ".mnemo/hooks/bin/audit-write.sh",
  "timeout": 10,
  "on": { "block": false, "audit": true }   // PostToolUse can also "modify" the result payload
}
```

Precedence + scope resolution: `project` (repo `.mnemo/hooks/`, committed,
overrides) → `user` (`~/.mnemo/hooks/`) → `global` (shared location, e.g.
`~/.config/mnemo/hooks/`, for org/machine-wide policy). All matching hooks
run; ordering is scoped-then-id; any `block` veto wins. This mirrors pi's
extension-scope idea but with a declarative, scriptable contract — the same
three scopes the user asked for.

Semantics per trigger (borrowed map from Claude Code, adapted):

- **PreToolUse**: stdin = tool name + args; exit 0 = allow, 2 = block (reason
  shown to the model), 1/other = allow + log error. Can also *rewrite* args
  (exit 0 + JSON response) — e.g. force a sandbox wrapper on bash_exec.
- **PostToolUse**: stdin = tool + args + result; can annotate/modify the
  result before it reaches the model (pi's `tool_result` event already allows
  this — we just surface it).
- **UserPromptSubmit**: pre-process prompts (policy filters, redaction, route).
- **TurnEnd / SessionStart / SessionShutdown**: lifecycle hooks (the memory
  extension already uses these; hooks make them user-extensible).
- **Notification**: fired by schedules/triggers (Part B).

Audit trail: every hook invocation (match, command, duration, exit code,
block reason, result delta) appended to `~/.mnemo/logs/<date>.jsonl` through
the existing tracer (redaction included). Nothing a hook does is invisible.

### A.3 "User tells the agent to build a hook"

Synergy with the harness engine: a hook command can be (a) a plain script the
user writes, or (b) a **harness bundle** — the agent builds it with
`create_harness`, and the harness-bridge registers the hook manifest
automatically. `/hook add "block write_file outside src/ — project scope"`
drives the standard flow: ask → plan → scaffold the hook file in the chosen
scope → register → test with a dry-run invocation → record in memory as a
Procedural node (same path as harness indexing, P3 from the backend run).
Hooks become recallable memory, so a new session knows which hooks exist and
why. `/hook list`, `/hook test <id>`, `/hook disable <id>`.

### A.4 Security

Hooks are arbitrary code — same trust model as skills/extensions. Rendered as
"code runs from these locations" in the project-trust prompt; hooks from
non-trusted projects never run outside confirmation; `timeout` and no
network-by-default unless the hook declares `"network": true`.

---

## PART B — Time & Event Triggers (/schedule, /trigger)

### B.1 What exists

`agent/bin/sea-loop.ts` — a tested interval scheduler seed (`--every 30m`,
injected runner, signal abort) that spawns one-shot `mnemo` children. It is CLI
only, interval not cron, non-persistent, no UI.

### B.2 Design: persistent scheduler (new: agent/src/schedule/ + memsrv lease)

- Store: `~/.mnemo/schedules.json` — jobs with cron/interval expressions,
  prompt, model override (multi-model!), scope, enabled flag, last/next run.
- Daemon: `mnemo schedule` (background); **in-session**: the TUI shows a
  Schedules overlay (new overlay kind, `^j`?) with add/pause/fire-now; the
  spawned pi session itself hosts a lightweight ticker that fires one-shot
  children when the daemon isn't running (tick lease via memsrv's journal
  fd-lock so two host processes can't double-fire — the memory layer already
  has the locking primitive).
- Every tick is a **TaskEpisode** in the journal (own + subagent), so
  scheduled work feeds steering + consolidation + mempolicy exactly like
  interactive work — the "improves with use" loop applies to cron runs too.
- `/trigger`: named triggers — `on_failure` (a failed turn/tool fires a job),
  `on_uncommitted` (watcher on dirty git state), `on_push` (GitHub webhook →
  `mnemo webhook` listener or polling bridge), `on_cost_over` (budget
  threshold). Triggers share the same job store; firing is just
  `runJob(id)`.
- `/now`: fire any job immediately — also the universal test button.
- Notifications: hook trigger `Notification` on job end (success/failure +
  cost), surfacing as a TUI status chip and (opt-in) OS notification.

---

## PART C — SOTA Catalog mapped to Mnemo (feature → who owns it → status)

Legend: **pi** = pi-native (mostly free when surfaced) · **MX** = Mnemo custom
(agent/ backend) · **TUI** = tui-go work · **ML** = memory-layer.

| Feature | Reference (who has it) | Mnemo today | Owner/work |
| --- | --- | --- | --- |
| Pre/Post tool hooks, scoped, audited | Claude Code hooks | pi events only, no contract | **MX** Part A |
| /schedule, /trigger, /now | Codex-style schedulers, cron agents | sea-loop.ts seed | **MX** Part B |
| Background tasks | Codex, Gemini CLI | none | **MX** Part B (jobs ARE background tasks) |
| Plan mode / read-only | all | ✅ custom (4.4) | done |
| Permissions allow/ask/deny | Claude Code / pi | ✅ custom (4.3) | done — consider scoped rules per project |
| MCP | all | custom minimal (4.1) | evaluate switching to pi's built-in MCP config for servers pi already knows |
| Subagents (tree, multi-model) | Claude Code / pi | ✅ custom (+ pi's own) | done; TUI tree exists |
| Compaction / resume / fork | pi | pi-native | TUI needs /fork + /compact pass-through (W5) |
| /undo /rewind | Codex, Claude Code | pi has /undo in CLI | TUI pass-through (W5) |
| /init project memory | Claude Code | none | **MX** small: project PROMPT.md-ish file from session lessons |
| Memory (brain areas, steering) | — (unique) | ✅ custom | the differentiator |
| Harness engine (self-built tools) | — (unique) | ✅ custom | the differentiator; extends to hooks (A.3) |
| ipy kernel (programmatic tools) | — (unique) | ✅ custom | the differentiator; hook commands can be python via kernel |
| Web search / fetch | all | ✅ custom (4.2) | done |
| Image input | all | ✅ custom (4.5) | done |
| Eval harness | — | memeval + memory-eval | **ML** extend to hook/schedule regression evals |
| Cost budgets + model routing | Codex, Gemini CLI | traces have cost; no budgets | **MX** budgets per session/day → auto-switch provider (multi-model infra exists) |
| CI / headless runs | all | works non-TTY (gates fail-open) | **MX** polish: `mnemo ci` wrapper + GH Action |
| PR / GitHub automation | Claude Code /pr, Codex | none | **MX** GH webhook bridge + /pr_comment |
| Notifications | Codex | none | **MX/TUI** Part B.4 |
| Sandboxing | Codex, pi docs containerization | none | **MX** optional container wrapper per approval mode |
| Themes / templates | pi | TUI theme exists | **TUI** W5 theme picker; pi templates free |
| Observability (traces, redaction) | — | ✅ custom (5.x) | done; hooks/schedules append to it |
| Wiki / JOURNEY project history | Claude Code memory file | consolidation lessons exist | **ML/MX** auto-append lessons to project history file |
| Terminal setup / health | pi | pi-native CLI | surface in TUI |

---

## PART D — Where the differentiators feed back (the moat)

The catalog above is generic; the *combinations* are not:

1. **Hooks + memory**: a PostToolUse audit hook runs always; its output lands
   in the journal → steering blames/supersedes on hook-flagged failures →
   mempolicy learns which matchers actually prevent repeat mistakes. Hook
   quality becomes measurable.
2. **Schedules + memory**: cron ticks accumulate episodes; after N ticks the
   same job generates consolidation lessons ("CI routinely breaks on X before
   Y") and the scheduler can *self-adjust* (mempolicy-informed retry/backoff).
3. **Harness + hooks**: the agent builds its own hooks mid-task exactly like
   it builds tools today — self-extending policy, not code the user writes.
4. **ipy kernel + hooks**: hook commands authored in Python run in the
   persistent kernel with in-kernel tool access (tools.read_file inside a
   hook) — a hook is just a short program.
5. **Eval + everything**: each new surface (hooks, schedules) gets a
   deterministic regression eval in the memeval/memory-eval style so the
   "improves with use" claim keeps being measured, not asserted.

## PART E — Suggested roadmap (order of attack)

1. **Part A — hooks engine** (highest value, directly requested): contract +
   matcher + scopes + audit; wire to tool_call/tool_result; /hook command;
   harness-generated hooks; memory indexing; deterministic tests (fake pi
   events + temp hook dirs).
2. **Part B — schedules**: cron parser + store + daemon + TUI overlay +
   trigger types (start with on_failure, on_uncommitted); journal integration;
   tests via injected clock.
3. **Part C quick wins**: TUI pass-through of pi-native commands (fork,
   compact, undo), notifications, cost budgets, project memory file.
4. **CI/PR + sandboxing** when the loop above is stable.
5. Periodically: re-baseline against pi's CHANGELOG — pi moves fast; anything
   pi adopts natively, we adopt and delete our version.

Each part becomes a plan.md area with checkboxes and a STATUS.md outcome note,
per repo discipline.
