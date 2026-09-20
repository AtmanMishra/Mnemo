# The monorepo plan

Written after reading oh-my-pi's package table, which is the thing being asked
for here: not its features, but its *shape*. In oh-my-pi every capability is a
published package with a stable name — `pi-ai` (provider client), `pi-agent-core`
(runtime), `pi-tui` (terminal rendering), `pi-catalog` (models and identity),
`pi-natives` (Rust bindings), `pi-mnemopi` (a memory engine), `pi-utils` — plus a
`crates/` tree for `pi-shell`, `pi-ast`, `pi-iso`, `pi-edit`. Someone can build
*around* it because they can depend on one piece without taking the application.

Ours is not that. `app/` is a working interface and a set of modules that only
make sense together, `memory-layer/` is a Rust binary nothing else can link to,
`kernel/ipy_bridge.py` is a script, and `agent/` is a wrapper. That is the gap
this plan closes.

## Target layout

Bun workspaces, one concern per package, no package allowed to print.

    packages/
      tui/       @mnemo/tui       terminal kit — Screen, KeyReader, Composer,
                                  transcript, theme, brand, overlays
      agent/     @mnemo/agent     the turn — pi RPC client, event translation,
                                  session model, block rendering
      harness/   @mnemo/harness   the harness engine — tools, prompts, approval
                                  wiring: what turns pi into *this* agent
      memory/    @mnemo/memory    TS client + panels for the Rust sidecar
      kernel/    @mnemo/kernel    the ipy bridge client and its boundary
      policy/    @mnemo/policy    the gate, the question it raises, dispatch
      catalog/   @mnemo/catalog   providers, model catalogue, auth store, config
      cli/       @mnemo/cli       the `mnemo` binary — the only composition root
                                  and the only package that writes to stdout

    crates/
      memsrv/    the Rust memory layer (today's `memory-layer/`)
      (later)    sandbox, walker — only as the need is proven

    python/
      ipy/       the interpreter bridge (today's `kernel/ipy_bridge.py`)

## The rules that make it buildable-around

1. **One owner per concern.** A fact has one renderer, one store, one writer.
   Two implementations of "where is the home?" is how the credentials store once
   read the wrong file while believing it was somewhere else.
2. **No package prints.** Everything returns strings or events; `cli/` decides
   what reaches a terminal. This is also what makes the whole thing testable
   without a pty — it is why our tests can drive the interface with strings.
3. **A package may not import the CLI.** Dependencies point inward, always:
   `cli → harness → agent → tui`, `cli → memory → (RPC) → memsrv`.
4. **Each package's public surface is its `index.ts`.** Anything not exported
   there is private, and a test for another package may not import it — that is
   what keeps the boundary honest instead of aspirational.
5. **Interface-first for the Rust side.** `@mnemo/memory` talks to the sidecar
   over a documented protocol; the crate can be rebuilt in any language without
   the app noticing. Same for the kernel: the bridge is a protocol, not a file
   path.
6. **Nothing is copied from oh-my-pi's breadth.** No natives, no browser relay,
   no voice, no benchmark harness. Our bet is memory, not surface area.

## Order of work

Each step lands green, on its own commit, with the app still runnable.

    1  workspace skeleton: root package.json with workspaces, tsconfig base,
       packages/*/package.json, and `app/` kept working untouched
    2  move theme + brand + input + transcript into @mnemo/tui, tests travelling
       with their modules
    3  move session/pi-client into @mnemo/agent; the TurnRunner interface moves
       with it
    4  move policy into @mnemo/policy; harness (tools, approval wiring) into
       @mnemo/harness
    5  move commands + store + catalogue into @mnemo/catalog
    6  move memory + kernel clients into their packages; their tests keep
       spawning the real binaries
    7  `app/` becomes `packages/cli`, `agent/` keeps the pi wrapper, and the
       root gains `bun mnemo` as the one command
    8  `crates/memsrv` + a crate-level README, so the memory layer is usable
       without the agent
    9  a top-level README with the package table — the thing that tells a
       stranger what they can build on

Steps 1–3 are mechanical and safe. 4–6 need care at the import boundaries. 7 is
the one that changes how the project is run, so it goes last.

## Why this before more features

The interface is thin, and that is the complaint. But the reason the features are
expensive to add is that everything sits in one folder with no declared
boundaries: a change to the transcript can touch the terminal driver, the session
and the binary. Fixing the shape first makes each feature afterwards a change in
one package with a stable interface — which is exactly what oh-my-pi bought with
its package table, and it is why its contributors can work in parallel without
treading on each other.

Features then land inside the new shape, in this order: line editing (precondition
first: frame-diff repaint), markdown, code blocks and diffs, tool output with
truncation, tokens/cost in the status bar, sessions, and the chord panels.

## The package table, mapped

oh-my-pi's table is a map of *capabilities*, and each row exists because someone
else might want that one thing. Ours, with what each package owns and what it is
built on. The rule for dependencies: a platform built-in first, then a small
focused package, and never a framework for something we already have.

    @mnemo/tui         terminal kit — Screen (differential rendering), KeyReader,
                       Composer/line editor, transcript, theme, brand, overlays
                       built on: nothing. It is ours, it is ~600 lines, and it is
                       the piece most other agents get from a framework.
    @mnemo/agent       the turn — pi RPC client, event translation, block model
                       built on: @earendil-works/pi-coding-agent (RpcClient) —
                       already installed; our adapter is what makes it a Mnemo
    @mnemo/harness     tools, prompts, approval wiring, sub-agent spawning —
                       what turns pi into *this* agent
                       built on: pi's tool surface + nothing else
    @mnemo/memory      TS client and panels for the Rust sidecar
                       built on: the memsrv protocol. Storage is Rust; recall and
                       consolidation live there, not here.
    @mnemo/kernel      the ipy bridge client and its boundary
                       built on: a JSON-line protocol to kernel/ipy_bridge.py
    @mnemo/policy      the gate, its questions, dispatch, grants store
                       built on: node:fs for the store (JSON, 0600)
    @mnemo/catalog     providers, model catalogue, auth store, config
                       built on: the provider HTTP APIs; the model database is a
                       bundled JSON, refreshed rather than hand-maintained
    @mnemo/cli         the `mnemo` binary — composition root, only printer

    crates/memsrv      the memory layer: journal, recall, consolidation
    crates/sandbox     later, and only if the kernel needs isolation that a
                       persistent interpreter cannot give — the open decision
    python/ipy         the interpreter bridge

## Libraries, per remaining feature

    line editor          done — ours, in @mnemo/tui
    markdown             `marked` to tokenize (small, no DOM), rendered by us to
                         ANSI. Not a terminal-markdown framework: we need control
                         over wrapping, because wrapped markdown is where every
                         terminal agent's rendering falls apart.
    syntax highlighting  `cli-highlight` — highlight.js with a terminal theme,
                         lazy-loaded per language so start-up stays fast
    diffs                `diff` (jsdiff) for the algorithm; rendering ours, with
                         the +/- lines coloured and hunks folded
    tool output          ours: capture, truncate to N lines, `… 7 more` with the
                         key that expands it
    tokens · cost        from pi's session stats — it already reports them; we
                         display them in the status bar
    sessions             `bun:sqlite` — built in, so no dependency at all, and it
                         gives FTS for `/search` later
    autocomplete         ours: the command catalogue and a file index built from
                         the walker when it exists, otherwise a directory walk
    key bindings         ctrl+L (clear), ctrl+R (history search), esc (interrupt)
                         — all in @mnemo/tui, where the keys already live
