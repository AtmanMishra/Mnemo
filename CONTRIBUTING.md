# Contributing to Mnemo

Thanks for looking. Mnemo is a terminal coding agent with a memory that
learns, and it is early: bug reports, evals that break it, and small, focused
pull requests are all welcome.

## Where things are

| Path | What |
|---|---|
| `app/` | the program: Ink interface, agent loop on the pi SDK, extensions (`src/extensions/`), evals (`eval/`) |
| `packages/memory/` | `@mnemo/memory`: the memory loop any agent can drive (profiles, recall, learning, MCP, Claude Code hooks) |
| `memory-layer/` | `memsrv`, the Rust memory sidecar |
| `DESIGN.md` | the interface spec: palette, motion, keys |
| `docs/ROADMAP.md` | what is left, in order |

The previous stack (`tui-go/`, `agent/`, `harness-engine/`) lives on the
[`legacy`](https://github.com/AtmanMishra/Mnemo/tree/legacy) branch. It is not
maintained and not accepted for changes; new work goes in `app/` and `packages/`.

## Set up

You need [Bun](https://bun.sh) 1.4+ and a Rust toolchain (for the sidecar).

    bun install
    (cd memory-layer && cargo build --release --bin memsrv)
    cd app && bun bin/mnemo.ts --demo        # a scripted session, no API key needed

## Before you open a pull request

Everything below runs with no API key; tests drive real pi sessions against a
scripted model.

    cd app && bunx tsc --noEmit && bun test ./test
    cd packages/memory && bunx tsc --noEmit && bun test ./test
    cd memory-layer && cargo test

CI also runs a credential scan over the tree. Fake keys in tests are fine in
the existing fixture files; a new fixture file must be added to the exclude
list in `.github/workflows/ci.yml`.

## How we work

- **One change, one reason.** The commit message says *why*; the diff says
  what. Touch only what the change needs.
- **A bug gets a test that fails first.** Evals are the same idea at the
  system level: `app/eval/README.md` explains the arms and what each check means.
- **Claims need numbers.** If a change is meant to make the agent more
  accurate or cheaper, say how you measured it.
- **Interface changes** follow `DESIGN.md`; if the change alters the vocabulary,
  update it in the same pull request.

## Licence

Mnemo is Apache-2.0. By contributing you agree your contribution is licensed
under it (section 5 of the licence), and that you have the right to submit it.
