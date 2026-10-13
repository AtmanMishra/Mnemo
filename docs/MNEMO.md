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
   superseded, unreliable context sources lose weight, a recurring failure is
   counted on one marker with its fix beside it, and what you mark wrong is
   recalled less and then not at all — so the same mistake is less likely twice.
3. **Skills self-extend.** The agent writes skills for itself mid-task (a
   `SKILL.md`, saved after you approve); they persist, get indexed into memory,
   and are recallable by purpose later.

## 2. The pieces

One Bun application (`app/`) is the interface *and* the agent; the memory is a
Rust sidecar; code execution is a Python kernel.

| Piece | Language | What it owns |
|---|---|---|
| `app/` | Bun / TypeScript | The program. The Ink interface, the agent loop (pi's SDK, **in this process**), Mnemo's behaviour as nine pi extensions (policy gate, checkpoints, shell, memory, kernel, sub-agents, skills, escalation, trace), sessions, updates. |
| `packages/memory/` | TypeScript | `@mnemo/memory`: the memory loop any agent can drive — profiles, recall, learning from a run, failure steering, skills, past-session search, `tidy`; and its attachments for Claude Code (hooks) and MCP clients. |
| `memory-layer/` | Rust | The brain. An append-only journal, a graph store, retrieval, steering, consolidation — and `memsrv`, the JSON-RPC sidecar. |
| `app/python/ipy_bridge.py` | Python | The kernel behind the `ipy_run` tool: one long-lived interpreter the agent drives. |

The previous stack (the Go interface `tui-go/`, the Node agent `agent/`,
`harness-engine/`) is on the `legacy` branch, unmaintained; `docs/LEGACY.md`
documents it.

The pieces are separate processes where it pays: `memsrv` and the Python kernel
are children of the app, and each speaks **line-delimited JSON over stdio**; so
does the MCP server (`mnemo memory mcp`). No protocol library is a dependency,
every client is testable against recorded lines, and a human debugging a stuck
agent can `cat` the pipe. pi itself is not a process: it runs in the app.

## 3. One turn, end to end

```
you type ─▶ interface ─▶ Controller ─▶ pi session (in process, Mnemo's extensions)
                                         │
                                         ├─ before_agent_start: recall from memory (memsrv search)
                                         │                      + the memory directive and profiles
                                         ├─ model call ─▶ streaming text/thinking/tool deltas ─▶ interface
                                         ├─ tool call: policy gate (rules → mode → grants → approval)
                                         │             · a known fix stops a repeated failing command
                                         │             · edits are checkpointed first
                                         │             ─▶ execute (read/bash/edit/write, ipy_run, subagent, memory…)
                                         ├─ tool_execution_end: one line into the episode's log; a failure steers memory
                                         └─ agent_end: a run that changed code and checked nothing goes back once;
                                            then, in the background, one reflection writes what was learned
```

What makes it *Mnemo* rather than a chat wrapper: the first hook — memory is
injected before the model is asked anything, because relying on a small model to decide
to search costs a round trip and it often just won't. Retrieval is a candidate
list, never presented as fact.

## 4. What the interface does

One surface, not six panes. In a terminal Mnemo is a full-screen workspace; the
transcript is the application and everything else is previewed in place and
dismissed with `esc`. (`--inline` keeps the transcript in the terminal's
scrollback instead.)

**Keys** (the full list is `web/src/content/commands.ts`, kept in step with the app
by hand; `?` on an empty prompt shows the panel):

| key | does |
|---|---|
| `enter` | send — or **queue**, if the agent is mid-turn |
| `alt+enter` | new line (or end a line with `\`) |
| `esc` | interrupt the turn; close a menu; twice clears the draft, or on an empty prompt **rewinds** |
| `shift+tab` / `ctrl+t` | cycle the mode (default → accept edits → plan) / the thinking level |
| `ctrl+o` | expand thinking and tool output, including what is already printed |
| `ctrl+f` | find in the conversation — live; `↑` `↓` step through matches |
| `ctrl+k` | on an empty prompt: one list of commands, agents, sessions and files |
| `ctrl+b` · `tab` | show or hide the sidebar · move focus prompt → sidebar → transcript |
| `1`–`5` (sidebar) | files · memory · sessions · skills · logs |
| `ctrl+g` `ctrl+p` `ctrl+n` `ctrl+s` | the agent hub · switch project · another agent here · split view (up to four) |
| `alt+1`…`alt+9`, `alt+,` `alt+.` | go to agent N · previous / next agent |
| `/` · `@` | the slash menu · mention a file |
| `ctrl+c` | clear the draft, interrupt the turn, or quit (twice) |

**What is on screen**: a header (project, branch, model, memory node count, cost),
the sidebar, the transcript with a one-pixel-per-turn timeline in its title bar
(`[` `]` step through turns), and the composer with a status line under it.
Tool output is captured and rendered natively inside foldable blocks; file
paths in tool calls and links in answers are clickable where the terminal
supports OSC 8 (`MNEMO_LINKS=0` turns it off). In the memory pane `m` draws the
memory map, `e` edits an item, `d` forgets it, `+` / `-` say it helped or was
wrong, and *Recalled this session* lists what came back. Every screen is fitted
to the terminal at any size and across resizes; the mouse wheel scrolls the
conversation (`/mouse` or `MNEMO_MOUSE=0` hands selection back to the terminal).
A turn that ends, or an approval that waits, while the terminal is in another
window sends a desktop notification (OSC 9 and a bell; `MNEMO_NOTIFY=0` turns it
off). The launch sequence, the first-run introduction and the goodbye screen fill
the whole terminal, and Engram — the field of characters Mne settles out of —
also appears in the welcome card and the empty transcript. `/theme` has eleven
themes.

**Commands** come from four places and land in one list: the interface's own
built-ins (`/help`, `/model`, `/login`, `/resume`, `/rewind`, `/stats`, `/memory`,
`/remember`, `/forget`, `/mode`, `/theme`, `/update`, `/bestof`, …), commands
that pi extensions register, pi's prompt templates, and `SKILL.md` skills
(`/skill:name`). A name that is none of these is sent to the agent as an
ordinary message.

**For scripts and screenshots**: `mnemo --demo --dump` runs the scripted demo turn,
renders one frame to stdout and exits. A TUI cannot be screenshotted from a
script, and "it looked right when I ran it" is not a check anybody else can
repeat.

## 5. Running it

```bash
# 1. a release — nothing else needed (no Bun, Node or Rust)
curl -fsSL https://github.com/AtmanMishra/Mnemo/releases/latest/download/install.sh | sh   # macOS / Linux
irm https://github.com/AtmanMishra/Mnemo/releases/latest/download/install.ps1 | iex        # Windows (PowerShell)

# 2. or from a checkout (needs Bun 1.3+ and a Rust toolchain)
git clone https://github.com/AtmanMishra/Mnemo && cd Mnemo
bun install
(cd memory-layer && cargo build --release --bin memsrv)
cd app && bun bin/mnemo.ts --demo     # a scripted session, no key; app/scripts/install.sh installs from here

# 3. run it, in a project
mnemo doctor      # what it found: model, memory, python (--fix repairs what it can)
mnemo
```

The installer downloads one archive holding `mnemo` and `memsrv`, checks its
SHA-256 against the release's `SHA256SUMS`, and puts both in `~/.mnemo/bin`; on a
terminal it draws itself as it goes. Python is needed only for the `ipy_run` tool
(`python3` or `python`, or `MNEMO_PYTHON`); without one the tool is simply not
offered.

**First run**: five short introduction pages, then the transcript says what to do —
`/login` walks through picking a provider and pasting a key (or a subscription
login), `/model` picks the default. Both write into `~/.mnemo/agent/`
(`auth.json`; `mnemo doctor --fix` tightens it to 0600 if it is wider). Mnemo also
uses credentials it finds in the environment (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, …); see `SECURITY.md`.

**Keeping it**: `mnemo update` installs the latest release with the same
checksum-checked installer (`--check` only says whether there is one; `/update`
does it from inside Mnemo; `mnemo update --auto on` adds a daily check at launch
that tells you and never installs — off by default; Homebrew and Scoop installs
are left to `brew upgrade` / `scoop update`). `mnemo uninstall` removes the
program and keeps what it learned; `--deep` also deletes `~/.mnemo` after you type
`delete`, and only if the folder holds nothing but what Mnemo put there. The
install scripts do the same with `sh -s -- --uninstall` / `--deep`
(`MNEMO_UNINSTALL=1` or `deep` on Windows). `mnemo doctor --fix` tightens
permissions on Mnemo's files, sets a broken `state.json` aside, removes best-of
runs older than 30 days, and reinstalls a missing `memsrv`.

**What the agent's commands inherit.** Bash, the Python kernel and best-of checks
start without the model-provider API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
and the rest of the list in `app/src/runtime/env.ts`, plus any variable
`models.json` interpolates). `MNEMO_PASS_ENV=NAME,NAME` hands named ones back. The
Python kernel has a timeout per call (120 s by default, at most 600 s, the
`timeout` parameter), is stopped by `esc`, and is capped at 8 GB of address space
on Linux (`MNEMO_KERNEL_MEMORY_MB`, 0 for none). A cell that times out or is
stopped loses the interpreter and its namespace.

**Rewind.** Before an `edit` or `write`, the file's bytes are kept under the
turn's user message. `esc esc` on an empty prompt (or `/rewind`) lists your
messages and puts back the conversation, the files, or both; your message
returns to the prompt. Changes made by shell commands are not tracked, and the
record lives as long as the process.

**Other commands.** `mnemo -p "<prompt>"` answers once and prints (headless: nobody is there to
ask, so a call that would ask is allowed; `deny` rules and plan mode still hold). `mnemo -p "<task>" --best-of 3
--check "<cmd>"` (and `/bestof`) races n attempts in separate git worktrees and
applies the smallest change that passes the check. `--escalate provider/id`
finishes a run on a stronger model after two failed checks. `mnemo memory …` is
memory for other agents: `setup claude-code|codex` prints the hooks and MCP entry,
`ingest` learns from Claude Code sessions, `tidy [--apply]` retires duplicate facts
and pitfalls, facts about files that are gone, and what you marked wrong twice,
`curate [--apply]` sorts skills by last use (stale after 30 days, archived after
90, personal skills only), `status` says what memory holds.

## 6. Where things live

All of it under `$MNEMO_HOME` (default `~/.mnemo`).

| Path | What it is |
|---|---|
| `bin/` | `mnemo` and `memsrv`, where the installer puts them |
| `agent/auth.json`, `agent/models.json`, `agent/settings.json` | pi's directory: provider credentials, custom providers, the default model |
| `agent/sessions/<project>/…jsonl` | conversations (pi writes these; Mnemo reads them) |
| `agent/skills/` | personal skills (project skills are `.agents/skills/` in the repository) |
| `permissions.json` | ordered allow/ask/deny rules, first match wins (a deny anywhere wins) |
| `grants.json` | "don't ask again" grants, per project and global |
| `state.json` | the theme, recent folders, whether the introduction was seen, the update check |
| `logs/<date>.jsonl` | one line per tool call and turn, redacted before write |
| `memory/journal.jsonl` | **the memory graph** — an append-only op log, the only source of truth |
| `memory/sessions.db` | the past-session search index (SQLite FTS5), derived |
| `memory/embed/embed-cache.json` | cached embeddings from a remote or local embedding server, derived |
| `.env` | settings `memsrv` reads for what the real environment does not set (never from a project folder) |
| `kernel/ipy_bridge.py` | the Python kernel's bridge, written out from the binary on first use |
| `best-of/<stamp>/` | each best-of candidate's diff |
| `skill-history/<name>/` | the previous body of a skill changed with `update_skill` (a patch memory proposes after a run keeps its copy in `agent/skill-history/`) |

The journal and the session store are deliberately different things: a session
is one conversation and is disposable; the journal is cross-session and
cross-project (a project is its git remote, so every clone shares it), and is the
thing that makes a fresh session start smart.

## 7. Checking it

Three suites, all runnable locally and all run by CI:

```bash
cd app             && bun test --timeout 30000 ./test && bunx tsc --noEmit
cd packages/memory && bun test ./test && bunx tsc --noEmit
cd memory-layer    && cargo test
```

The app and memory-package tests drive the real `memsrv`; without a built
sidecar they skip and say so. CI runs the app suite on **ubuntu, macos and
windows** — portability is a property, not a hope — plus a retrieval gate, a check
that the compiled binary renders a demo frame, and a credential-shaped-string
scan over the working tree and the last 200 commits. Everything is verifiable
without an API key: the app tests run real pi sessions against pi-ai's faux
provider, and `mnemo --demo --dump` prints a whole scripted turn.

The memory layer has a retrieval eval, `cargo run --bin memeval [--hash]`,
reporting Hit@1 / Hit@3 / MRR. The `--hash` numbers are deterministic and pinned
(73% / 77% / 0.743 on 22 cases, enforced by `tests/memeval_gate.rs`): any change
to retrieval is measured against them before and after, and a change that
regresses is reverted.

**Does memory make the next session better?** That is measured in `app/eval/`
(see its README): small git projects, a few sessions a person would plausibly
have, and deterministic checks — no model judges a model — each run with memory
and without, so a behaviour that passes either way is not credited to memory.
`bun eval/run.ts` needs a provider key; `--faux` runs the harness alone, and
`app/test/eval.test.ts` proves the checks discriminate. The recall half of "does
a constraint survive being stated once" needs no model and runs on every commit:
`memory-layer/tests/constraint_probe.rs`.

## 8. The state of it, honestly

**Works**: the interface and its overlays; graph memory with areas, routed search,
steering, trust-weighted recall and `tidy`; automatic recall before every turn and
learning after every run; the tool set (pi's file and shell tools, the Python
kernel, sub-agents, skills); permissions and plan mode; rewind; best-of and
escalation; several agents in one window; memory attached to Claude Code and
MCP clients; update and uninstall; a first-run flow a person can follow; binaries
for five platform pairs.

**Rough**: the Windows installer and the Windows builds of the newest features have
had less real-machine testing than macOS and Linux; the kernel is bounded (a
timeout, a memory cap on Linux only) but is an interpreter, not a sandbox, and
neither is the permission gate; hooks, schedules, MCP servers as tools and
harness bundles from the previous stack are not ported; nothing in the app runs
memory consolidation any more (the sidecar still offers it); the background
curator that tidies memory while you are away is not in a release (it lives on
`feature/background-curator`); retrieval has known misses left failing on purpose.

Nothing here is hidden: the open work is
[in the issue tracker](https://github.com/AtmanMishra/Mnemo/issues), and the
reviews that produced it are in `research/` (the capability review, the Hermes
comparison, and the design for a memory runtime that improves the graph while
nobody is watching).

## 9. The docs, sorted

| Document | Read it when |
|---|---|
| **`docs/MNEMO.md`** (this) | you want to understand or run Mnemo |
| **`docs/MNEMO-INTERNALS.md`** | you are changing it: memory internals, kernel, protocols, extension points, failure modes |
| **`docs/ROADMAP.md`** | you want to know what is left before users can have it, and in what order |
| `DESIGN.md` | you are touching how it looks: palette, glyphs, mascot, keys, motion |
| `AGENTS.md` | you are an agent working in this repo (conventions + binding invariants) |
| `SECURITY.md` | you want to know what the permission gate does and does not do, or to report a vulnerability |
| `docs/RELEASING.md` · `docs/releases/` · `web/src/content/changelog.ts` | you are cutting a release / want the release notes / the changelog |
| `docs/LEGACY.md` | you want the documentation of the previous stack (Go interface + Node agent) |
| `plan.md` / `STATUS.md` | history: the work tracker and outcome log of the previous stack |
| `research/` | current design papers (reviews, the memory-runtime design) |
| `docs/archive/` | history: superseded architecture docs, adoption reports, audit record |
