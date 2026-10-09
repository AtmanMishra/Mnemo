# Mnemo: agent contract

Mnemo is one Bun application in `app/`, with its memory in Rust (`memory-layer/`,
`memsrv`) and code execution in a Python kernel. The previous implementation
(`tui-go/`, `agent/`, `harness-engine/`) is on the `legacy` branch and is not
maintained; read it as a specification, never copy its security posture.

**Start with `docs/ROADMAP.md`** (what is left), then `docs/HANDOFF.md` (the state
of the Bun code and its conventions); target layout in `docs/REBUILD.md` and
`docs/PLAN-monorepo.md`.

## Layout

`app/` is an Ink + React interface on pi 1.1's **in-process** SDK
(`createAgentSessionRuntime`): no RPC, no child process.

- `src/ui/`: components and the pure `store.ts` / `editor.ts` / `format.ts`.
- `src/runtime/`: `controller.ts` is the only caller of the pi session.
- `src/extensions/`: Mnemo's behaviour as pi inline extensions (policy, memory,
  kernel, agents, skills, trace, escalate). They share one `Host`
  (`src/extensions/host.ts`), never globals.
- `src/policy/`: the permission gate (a pure decision) and the approval prompt.
- `packages/memory` (`@mnemo/memory`): the memory semantics (profiles, recall,
  learning, steering). `MemorySession` is the loop any agent drives; `service.ts` is the
  semantics over the sidecar. Test it alone: `cd packages/memory && bun test ./test`.
- `memory-layer/`: `memsrv`, the Rust sidecar. `cd memory-layer && cargo test`.

## Working in `app/`

    bun install
    cd app && bun test ./test && bunx tsc --noEmit

Everything must be verifiable without an API key: tests run real pi sessions against
pi-ai's faux provider (`src/runtime/demo.ts`), and `bun bin/mnemo.ts --demo --dump`
prints a whole scripted turn.

## Invariants (keep these true)

Each is a failure that was invisible on the machine it was written on.

- **The memory sidecar is `memsrv.exe` on Windows.** Derive its path through the platform
  name (`memsrvName()` in `src/runtime/paths.ts`), or memory goes quietly offline there.
- **Test fixtures never spawn a shell script.** `#!/bin/sh` is unrunnable on Windows.
- **Compare real paths.** macOS `/var` vs `/private/var` and Windows 8.3 names make two
  spellings of one directory; use `realpath` before comparing.
- **Line endings are LF everywhere** (`.gitattributes`). CI runs the suite on ubuntu,
  macos and windows, so a POSIX-only assumption fails at the pull request.
- **The gate filters; it is not a sandbox.** Do not describe it as one. Read `SECURITY.md`
  before changing `src/policy/` or `src/extensions/policy.ts`, and keep a regression test
  for every bypass you close.
- **Secrets never reach files, logs or tests.** `redact()` (memory) and `scrub()` (evals)
  exist; the CI gate fails on credential-shaped strings outside the redaction tests.
- **No telemetry and no network calls except to the user's model provider.**

## Commits

Say why, not what; the diff says what. Never commit secrets or personal paths.
