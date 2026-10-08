# Mnemo — the whole thing, on one page

*A terminal-native coding agent whose memory works like a graph that gets
better at your work the longer you use it. This is the high-level document: what
it is, how the pieces fit, how to run it, where everything lives.*

Two documents, on purpose. **This one** is for understanding and running Mnemo.
**`docs/MNEMO-INTERNALS.md`** is the detailed one: protocols, algorithms, the
memory model, the kernel, extension points, failure modes. Everything else that
used to be scattered across `docs/` and `research/` is archived in
`docs/archive/` — history, not instructions.

---

## 1. The idea

Frontier-level coding performance should not require a frontier-size model. A
small one wrapped in the right system — persistent memory, accumulated
experience, self-built tools, hierarchical collaboration — can go further on
real, repeated engineering work than a bigger model without them.

Three claims make that concrete:

1. **Memory substitutes for parameters.** Facts a large model memorised at
   training time live in a searchable graph this agent writes itself, and that
   graph is consulted *before* every model call.
2. **Experience compounds.** Failures steer the memory — stale facts get
   superseded, unreliable context sources lose weight, recurring pain becomes a
   lesson — so the same mistake is less likely twice.
3. **Skills self-extend.** The agent builds tools for itself mid-task; they
   persist, get indexed into memory, and are recallable by purpose later.

## 2. The pieces

**Where this is going:** one Bun application (`app/`) that is the interface *and*
the agent, the Rust memory sidecar, and a Python kernel for execution. What is
left to get there is `docs/ROADMAP.md`. Until then both stacks exist in the tree:

| Piece | Language | What it owns |
|---|---|---|
| `app/` | Bun / TypeScript | **The target.** Interface, session, policy gate, memory and kernel clients, a pi RPC adapter. Interface partly built; agent not yet ported. |
| `memory-layer/` | Rust | The brain. An append-only journal, a graph store, retrieval, steering, consolidation — and `memsrv`, the JSON-RPC sidecar every other process talks to. Stays. |
| `agent/` | TypeScript (Node >= 22.18, no build step) | *Legacy, ported into `app/` per the roadmap.* The agent process. Wraps the `pi` coding-agent framework, registers Mnemo's tools, hosts the memory client, the Python kernel, hooks and schedules. |
| `tui-go/` | Go (Bubble Tea v2) | *Legacy.* The interface that works today. Sections 4–5 below describe it. |
| `harness-engine/` | TypeScript, zero deps | *Legacy, ported.* Loads and validates tool bundles the agent writes for itself. |

They are separate processes talking **line-delimited JSON over stdio** — the
same shape four times (pi's RPC, `memsrv`, the Python kernel bridge, MCP). No
protocol library is a dependency, every client is testable against recorded
lines, and a human debugging a stuck agent can `cat` the pipe.

## 3. One turn, end to end

```
you type ─▶ TUI ──prompt──▶ agent (pi + Mnemo extensions)
                              │
                              ├─ before_agent_start: recall from memory (memsrv search)
                              │                      + the memory directive
                              ├─ model call ─▶ streaming text/thinking/tool deltas ─▶ TUI
                              ├─ tool call: approval gate → permissions/plan mode → execute
                              │             (bash/fs, ipy kernel, subagent, harness, MCP…)
                              ├─ tool_execution_end: one line into the episode's log
                              └─ turn_end: tokens/cost; session_shutdown: consolidate
```

What makes it *Mnemo* rather than a chat wrapper: step 2 — memory is injected
before the model is asked anything, because relying on a small model to decide
to search costs a round trip and it often just won't. Retrieval is a candidate
list, never presented as fact.

## 4. What the interface does

One surface, not six panes. The transcript is the application; everything else
floats over it and is dismissed with `esc`.

**Keys** (all of them are generated from one table, so `^h` cannot drift):

| key | does |
|---|---|
| `enter` | send — or **queue**, if the agent is mid-turn |
| `alt+enter` | **steer**: interrupt what it is doing with this |
| `^e` / `^r` / `^a` | open every thinking / tool / all block at once |
| `^t` | the folder explorer, on the right, focused in the same press |
| `^s` `^m` `^o` `^l` `^k` | sessions · memory · schedules · logs · palette |
| `^h` | every key **and** every command, including the agent's own |
| `/` | the slash menu: built-ins, skills, plugin skills, harness bundles, and the commands the agent implements |
| `^f` | transcript search — live, case-insensitive, wraps |
| `^c` | clear the draft, interrupt the turn, or quit (twice) |
| `^g` | hand mouse selection back to your terminal |
| `esc` | up one level. Always. That is the whole navigation model |

**What is on screen**: a header band that travels while work is happening, a
labelled region rule that says how many blocks are folded, the transcript with a
two-cell speaker gutter (`▊` you, `│` Mnemo, `·` thinking, `●` a tool), and a
status line with the current mode's useful keys on the left and live counts on
the right. Tool output is captured and rendered natively inside foldable blocks.

**Commands** come from four places and land in one list: the interface's own
built-ins (`/help`, `/sessions`, `/memory`, `/login`, `/model`, `/logout`, …),
`SKILL.md` skills discovered from `.claude`/`.pi`/`.agents` roots walked up to
the git root, plugin skills from the plugin cache, harness bundles from disk —
and, on a live session, **whatever pi answers with** when asked `get_commands`.
A name the interface does not know but the agent does is routed to the agent
rather than refused, which is how `/hook`, `/schedule`, prompt templates and
`/skill:name` work. Offline, the refusal stands.

**For scripts and screenshots**: `mnemo --dump --rows 30 --cols 100` renders one
frame to stdout and exits; `--keys "ctrl+k,e,s"` presses keys first. A TUI
cannot be screenshotted from a script, and "it looked right when I ran it" is
not a check anybody else can repeat.

## 5. Running it

```bash
# 1. the code
git clone https://github.com/AtmanMishra/self-evolving-agent && cd self-evolving-agent

# 2. everything else — checks your toolchain first, then builds
./scripts/install.sh            # macOS / Linux
.\scripts\install.ps1           # Windows (PowerShell)

# 3. run it, pointed at the repository
mnemo --repo "$(pwd)"
```

Node **22.18+** is the one hard requirement (that is the first version that runs
`.ts` with no flag). Rust is needed only for the memory sidecar; Go only if you
would rather build the interface than download it from
[Releases](https://github.com/AtmanMishra/self-evolving-agent/releases).

**First run**: the transcript says what to do — `/login` walks through picking a
provider and pasting a key, `/model` picks the default. Both write
`~/.mnemo/auth.json` (0600, never in the repo).

**A project's instructions, and its pull request.** `mnemo init` looks at the
repository — manifests, the scripts they define, top-level layout, CI workflows,
the docs already there — and proposes the file pi loads at startup for a
project's instructions (pi's own preference order: `AGENTS.override.md`,
`AGENTS.md`, `CLAUDE.md`). Creating a file writes it; changing one shows the
diff and asks, and an unanswered question is a refusal — `--yes` is the same
consent stated in the command, and with no TTY at all there is no other way to
give it. The generated part lives between `mnemo:init` markers, so a second run
refreshes it in place and never reorders a line a person wrote, and a
`write_file` deny rule blocks the whole command like it blocks any other write.

`mnemo pr` opens a pull request for the current branch from the commits
themselves: the branch's first commit titles it, the log and the real
`git diff --stat` are the body, and no model writes a word. It refuses rather
than guesses — on the base branch, with nothing committed ahead of it, without
an authenticated `gh`, with no `origin`, and when the remote has commits the
branch does not have — and it never force-pushes; a branch whose remote moved on
is a refusal that tells you to merge or rebase yourself. `mnemo pr --review`
posts a summary of the diff, behind its own flag: a summary, not a verdict,
because nothing reviewed anything.

## 6. Where things live

| Path | What it is |
|---|---|
| `~/.mnemo/auth.json` | provider credentials and the default model (mode 0600) |
| `~/.mnemo/permissions.json` | ordered allow/ask/deny rules, first match wins |
| `~/.mnemo/mcp.json` | MCP servers, registered as `mcp__<server>__<tool>` |
| `~/.mnemo/schedules.json` | scheduled prompts and triggers |
| `~/.mnemo/hooks/` | user-scope hooks (project `.mnemo/hooks/` wins over them) |
| `~/.mnemo/logs/<date>.jsonl` | trace spans, redacted before write |
| `memory-layer/data/sea-agent-journal.jsonl` | **the memory graph** — an append-only op log, the only source of truth |
| `~/.pi/agent/sessions/<project>/…jsonl` | conversations (pi writes these; Mnemo reads them) |

The journal and the session store are deliberately different things: a session
is one conversation and is disposable; the journal is cross-session and
cross-project, and is the thing that makes a fresh session start smart.

## 7. Checking it

Four suites, all runnable locally and all run by CI:

```bash
cd agent          && npm test && npx tsc --noEmit
cd memory-layer   && cargo test
cd tui-go         && go test ./... && go vet ./...
cd harness-engine && npm test
```

CI runs the TUI suite on **ubuntu, macos and windows** — portability is a
property, not a hope — plus a credential-shaped-string scan over the working
tree and the last 200 commits.

The memory layer has a retrieval eval, `cargo run --bin memeval [--hash]`,
reporting Hit@1 / Hit@3 / MRR. The `--hash` numbers are deterministic and pinned
(73% / 77% / 0.743 on 22 cases): any change to retrieval is measured against
them before and after, and a change that regresses is reverted.

**Does a constraint survive being stated once?** That question has two halves,
and they are measured in different places on purpose. The recall half —
`memory-layer/tests/constraint_probe.rs`, no model, runs on every commit — seeds
constraints (a package manager, a port, a comment style) and asks for them later
in the words a person would use. The behavioural half —
`scripts/eval-constraint-compliance.mjs`, needs a provider key — runs the agent
against a throwaway project and checks it actually *complies*: the command it
proposes uses pnpm, the URL it gives is port 4111, the comment it writes explains
why. Compliance is judged by a deterministic rule over the answer, never by
another model, because a judge that can be talked into a pass is not a
measurement. The `.github/workflows/nightly-evals.yml` job runs both weekly and
skips the second with a notice when no key is configured — a green run that
measured nothing would be worse than a skipped one.

## 8. The state of it, honestly

**Works**: the interface and its overlays; graph memory with areas, routed
search, steering and consolidation; automatic recall before every turn; the tool
set (bash/fs, Python kernel, subagents, harness bundles, MCP, web, images);
hooks; schedules; traces; permissions and plan mode; a first-run flow a person
can follow; binaries for five platform pairs.

**Rough**: the agent's test suite has real Windows failures (hooks run through
`sh -c`); session branching, `/compact` and a theme picker are not wired; mouse
hit-testing is declared and unimplemented; retrieval has known misses left
failing on purpose; the kernel has no per-call timeout and no resource bounds.

Nothing here is hidden: the open work is
[in the issue tracker](https://github.com/AtmanMishra/self-evolving-agent/issues),
and the reviews that produced it are in `research/` (the command surface, the
capability review, and the design for a memory runtime that improves the graph
while nobody is watching).

## 9. The docs, sorted

| Document | Read it when |
|---|---|
| **`docs/MNEMO.md`** (this) | you want to understand or run Mnemo |
| **`docs/MNEMO-INTERNALS.md`** | you are changing it: memory internals, kernel, protocols, extension points, failure modes |
| **`docs/ROADMAP.md`** | you want to know what is left before users can have it, and in what order |
| `DESIGN.md` | you are touching how it looks: palette, glyphs, mascot, keys, motion |
| `AGENTS.md` | you are an agent working in this repo (conventions + binding invariants) |
| `plan.md` / `STATUS.md` | you want the work tracker / the outcome log with evidence |
| `research/` | current design papers (reviews, the memory-runtime design) |
| `docs/archive/` | history: superseded architecture docs, adoption reports, audit record |
