# The rebuild: one Bun application, memory in Rust, execution in the ipy kernel

Branch: `rebuild/bun-app`. This document is the target and the order of work.
The old surfaces (`agent/` on Node, `tui-go/`, `harness-engine/`) stay on `main`
and keep working until each piece has been replaced and accepted — nothing is
deleted on the strength of a plan.

## The shape

    app/                     the application. Bun. This is the program.
      src/transcript/        block lifecycle + the stable-row contract   [built]
      src/frame/             one frame, renderable with no model or key  [next]
      src/setup/             onboarding as versioned, gated scenes
      src/status/            the status line as a segment catalogue
      src/session/           list · resume · fork · compact
      src/memory/            memsrv client (RPC over stdio) — the Rust side
      src/kernel/            the ipy kernel: the execution path
      src/tools/             the tools, migrated from agent/src/tools
      src/auth/              provider store and login, migrated
      bin/mnemo.ts           the entry (today: agent/bin/mnemo-bun.ts)
    memory-layer/            Rust, unchanged: journal, facts, episodes,
                             consolidation, the ANN path
    kernel/ipy_bridge.py     unchanged: the interpreter half of the kernel
    harness-engine/          unchanged: dynamic tool bundles

Three runtimes, three jobs, and the point of the rebuild is that the seams
between them are explicit rather than incidental:

    Bun       the application: interface, sessions, tools, onboarding, policy
    Rust      memory: the journal, recall, consolidation
    Python    execution: one long-lived interpreter the agent drives

## Rules that hold everywhere

1. **Every stage is verifiable without an API key.** A check that needs a model
   cannot run in CI, and what cannot run in CI rots. `--dump`, `doctor`, the
   transcript contract and the kernel round-trip are all provable offline.
2. **One home.** `src/home.ts` decides where state lives; nothing resolves
   `os.homedir()` on its own. (The credentials store did — see the finding in
   `research/rebuild-direction-bun.md` §8.)
3. **The interface owns no state the app needs.** Blocks render; the app decides.
   Same split as the setup scenes: presentation in one place, effects in another.
4. **Tests run where they belong.** `bun test` for `app/`; `node --test` for the
   packages that have not moved, until they do.
5. **Nothing lands unverified.** Suite green, the frame rendered, the round-trip
   exercised — and the numbers quoted come from a run, not from memory.

## Phases

**Phase 0 — the transcript contract. (built, this branch)**
The block lifecycle (`active | settled | committed`), the modes
(`mutable | appendOnly`), the stable-row contract, freezing on violation instead
of throwing, and width-keyed caches. This is first because it is the question
the old interface answered by accident: which rows may be rewritten? Everything
else in the interface stands on the answer.

**Phase 1 — the session spine.**
The entry, the frame, and the transcript wired to pi's loop: a run that starts,
paints its first frame with no key, streams an answer through an append-only
block, and retires it into scrollback. Verification: a `--dump`-style frame plus
a scripted fake model that streams three chunks, asserting the head leaves the
viewport exactly once.

**Phase 2 — memory on screen.**
The Rust sidecar behind a client of our own (`src/memory/`), with a panel that
shows what it knows: areas, facts, episodes, and the `history` of a key. Read
first, then the write path (facts, episodes, forget) through the tools.
Verification: a journal written by the test, read back through the app, plus the
existing `memsrv` RPC tests still green.

**Phase 3 — execution through the kernel.**
`bash_exec` and a Python cell both route through the kernel; the approval gate
decides what may reach it, and each call records the process tree it started.
Verification: a cell that persists state across calls, a denied call that never
reaches the interpreter, and the audit trail showing the child processes.
Honest boundary: the kernel is a persistent interpreter, **not an isolation
boundary** — real sandboxing is a separate decision to be made explicitly.

**Phase 4 — the interface.**
Onboarding as scenes with `minVersion` and gates; the status line as a segment
catalogue; symbol presets over the glyphs; the boot frame's facts feeding both.
Verification: frames for first-run, configured and mid-session states, plus the
gate tests (no TTY, resuming, env, version current → ask nothing).

**Phase 5 — installation.**
A Bun installer that installs Bun, builds `memsrv` with Cargo, puts the entry on
PATH and finishes by rendering a frame; an `uninstall` that removes exactly what
it wrote. Verification: install into a temp prefix, run the installed artifact,
uninstall, assert the tree is as it was.

**Phase 6 — retirement.**
When phases 1–5 pass acceptance, the Go interface and the Node entry are
archived the way the Rust TUI was: a branch, a note, and no ambiguity about
which program is the program.
