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
| `web/` | the project site: Vite + React, prerendered, deployed on Vercel (`docs/WEB.md`) |
| `DESIGN.md` | the interface spec: palette, motion, keys |
| `docs/ROADMAP.md` | what is left, in order |

`site/` (the old GitHub Pages page) and `.github/workflows/pages.yml` are
obsolete leftovers of the site that `web/` replaced. They are kept for now; do
not change them, and do not add to them.

The previous stack (`tui-go/`, `agent/`, `harness-engine/`) lives on the
[`legacy`](https://github.com/AtmanMishra/Mnemo/tree/legacy) branch. It is not
maintained and not accepted for changes; new work goes in `app/` and `packages/`.

## Set up

You need [Bun](https://bun.sh) 1.3+ (`app/package.json` engines; CI runs 1.4.2) and a Rust toolchain (for the
sidecar; CI uses `stable`). Node and npm are needed only for `web/`.

    bun install
    (cd memory-layer && cargo build --release --bin memsrv)
    cd app && bun bin/mnemo.ts --demo        # a scripted session, no API key needed

## Before you open a pull request

Everything below runs with no API key; tests drive real pi sessions against a
scripted model.

    cd app && bunx tsc --noEmit && bun test --timeout 30000 ./test
    cd packages/memory && bunx tsc --noEmit && bun test ./test
    cd memory-layer && cargo test --all-targets

These are the CI jobs (`.github/workflows/ci.yml`). CI also builds `memsrv`
first (the memory tests skip without it), checks the offline retrieval floor
(`cargo test --locked --offline --test memeval_gate`) and, on ubuntu, macos and
windows, compiles the binary with `bun scripts/build.ts` and runs
`./dist/mnemo --demo --dump`.

If you change `web/` (it is not in the Bun workspace and CI does not build it):

    cd web && npm install && npm run build && npm run check

`npm run build` typechecks, builds, prerenders and ends with `scripts/check.mjs`;
`npm run check` alone re-runs those page checks on an existing `dist/`.

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
  update it in the same pull request. A new or renamed command or key also goes
  in `web/src/content/commands.ts`.

## Where the docs live

- `README.md`, `SECURITY.md`, `DESIGN.md`: for users; keep them true to the code.
- `AGENTS.md`: the contract for coding agents working in this repo.
- `docs/ROADMAP.md` (what is left), `docs/MNEMO.md` and `docs/MNEMO-INTERNALS.md`
  (how it works), `docs/RELEASING.md` (cutting a release), `docs/WEB.md` (the site),
  `docs/releases/vX.Y.Z.md` (release notes), `packages/memory/README.md`,
  `app/eval/README.md`.
- The site's own content (changelog, commands, roadmap) is `web/src/content/`.
- Historical, do not update: `STATUS.md`, `plan.md`, `docs/ISSUE-LEDGER.md`,
  `docs/LEGACY.md`, `docs/archive/`, `research/`, and the superseded
  `docs/HANDOFF.md` and `docs/HANDOFF-PROMPT.md`. `docs/REBUILD.md` and
  `docs/PLAN-monorepo.md` are plans; read their banners.
- Generated: `docs/mascots.md` comes from the legacy Go code and is stale;
  `web/dist/` is build output and not committed.

## Licence

Mnemo is Apache-2.0. By contributing you agree your contribution is licensed
under it (section 5 of the licence), and that you have the right to submit it.
