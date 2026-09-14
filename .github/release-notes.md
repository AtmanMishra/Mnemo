# Mnemo — pre-alpha

A terminal-native coding agent whose memory works like a brain: a graph of facts
with history, six brain areas, failure steering and consolidation, consulted
automatically before every model call. The bet is that a small or free model
plus accumulated memory goes further than raw model scale — and that a coding
agent should be one command, not six panes.

**This is a pre-alpha.** It is meant to be installed and used by people who are
willing to report what breaks. Expect rough edges; the list of known ones is at
the bottom of this file, and new ones belong in
[the issue tracker](https://github.com/AtmanMishra/self-evolving-agent/issues).

## What is in this release

`mnemo` for linux/amd64, linux/arm64, darwin/amd64, darwin/arm64 and
windows/amd64 — one static binary each, plus `SHA256SUMS`. This is the
interface. The agent runtime (Node/TypeScript) and the memory sidecar
(Rust) build from the source at this tag; the source archives GitHub attaches
to this release are exactly that.

The binary tells you what it is:

    mnemo --version

## Install

You need **git** and **Node 22.18 or newer** (the first Node that runs `.ts`
files with no flag — the agent runtime has no build step from there on).
**Rust** is optional and only needed for the memory sidecar.

**macOS / Linux**

```bash
# 1. the code (the tag you downloaded the binary from)
git clone https://github.com/AtmanMishra/self-evolving-agent
cd self-evolving-agent && git checkout <tag>

# 2. the agent runtime
cd agent && npm install && cd ..

# 3. the memory sidecar (optional; skip it and memory stays offline)
cd memory-layer && cargo build --bin memsrv && cd ..

# 4. the interface — or drop the binary from this release into ./tui-go/
cd tui-go && go build -o mnemo ./cmd/mnemo && cd ..
```

**Windows (PowerShell)** — the same four steps; the release binary is
`mnemo-<tag>-windows-amd64.exe` and belongs at `tui-go\mnemo.exe`.

## First run

```bash
cd tui-go
./mnemo --repo /path/to/self-evolving-agent
```

The first screen says what to do: `/login` walks you through picking a provider
and pasting an API key, `/model` picks the default model, and both write to
`~/.mnemo/auth.json` (mode 0600, never in the repo). Then type.

Useful on day one:

| key | what it does |
|---|---|
| `enter` | send — or queue, if the agent is mid-turn |
| `alt+enter` | steer: interrupt what it is doing with this |
| `^e` / `^r` / `^a` | open every thinking / tool / all block at once |
| `^t` `^s` `^m` `^k` `^l` | explorer · sessions · memory · palette · logs |
| `esc` | up one level, always. That is the whole navigation model |
| `^g` | hand mouse selection back to your terminal |

`mnemo --dump --rows 30 --cols 100` renders one frame to stdout and exits — the
fastest way to see whether it draws correctly in your terminal, and the format
bug reports should quote.

## What works today

- **The transcript is the interface**: streaming text, thinking blocks, tool
  blocks with captured output, folding, focus, search, copy.
- **Memory**: a JSONL journal as the only source of truth, six brain areas,
  routed search with a cross-area discount, failure steering that leaves pain
  markers and rewires stale context, consolidation into lessons, and an
  automatic recall block injected before every model call.
- **Agent**: pi's runtime with Mnemo's tools — bash/fs, a persistent Python
  kernel where the model can call tools as functions, hierarchical
  sub-agents on a shared journal, MCP servers as tools, web search/fetch,
  permission rules, plan mode, hooks, schedules, and JSONL trace spans.
- **Self-extension**: the agent can write a tool bundle for itself, index it as
  procedural memory, and recall it by purpose in a later session.

## Known gaps

These are tracked as issues rather than hidden here. The short version:

- Session branching (`/tree`, `/fork`, `/clone`), `/compact`, an
  approval-indicator, and a theme picker are not wired.
- Mouse click/wheel hit-testing is declared but not implemented; `^g` gives
  the terminal its selection back.
- Hooks run through `sh -c`, so they are Unix-only for now.
- Harness bundles execute in-process: the safety gate filters what gets
  *loaded*, it does not sandbox what runs.
- `spawn_subagent` has no depth limit; the Python kernel has no per-call
  timeout on the tool channel.
- The retrieval eval has known misses left failing on purpose (`memeval`);
  the learned steering policy has no real failure history to learn from yet.

## Reporting

Bugs and rough edges: <https://github.com/AtmanMishra/self-evolving-agent/issues>.
`mnemo --version`, your OS, and the output of `--dump` cover most of what is
needed to reproduce a rendering problem.
