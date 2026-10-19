# Testing Mnemo

Mnemo has five layers of tests. Each layer catches a kind of bug the others cannot.
The layer that matters most for users is the one that was missing until v0.1.3: in every
release up to v0.1.2, subscription `/login` and image reads were broken **only in the
compiled binary**. Every other test passed, because they all ran from source.

| Layer | Where | What it runs | What only it catches | Run it |
|---|---|---|---|---|
| Unit and integration | `app/test/`, `packages/memory/test/` | Source code under Bun, with a scripted model (pi's faux provider) and the real `memsrv` | Logic: the gate's decisions, the memory loop, the controller, the rendered frames | `cd app && bun test --timeout 30000 ./test` · `cd packages/memory && bun test ./test` |
| Sidecar | `memory-layer/src` (unit), `memory-layer/tests/` (RPC) | `memsrv` itself, over its real protocol | Journal integrity, locking across processes, recall quality floor (`memeval_gate`) | `cd memory-layer && cargo test --all-targets` |
| Bundle guard | `app/test/bundle-guard.test.ts` | Bundles `bin/mnemo.ts` exactly as the release build does, then reads the output | A dependency that loads a file the binary will not contain: a computed `import()`, a baked-in build-machine `__dirname` | part of the unit run |
| Binary end to end | `app/e2e/agent.e2e.test.ts` | The **compiled** `mnemo`, as a user runs it: its own `$HOME`, a scratch git project, a mock model (`e2e/mock-llm.ts`) configured through an ordinary `models.json` | Bundling, embedded files, exit codes, real child processes, the sidecar found beside the binary, install layout | `cd app && bun scripts/build.ts && MNEMO_E2E_BIN=$PWD/dist/mnemo sh scripts/without-node-modules.sh bun test --timeout 120000 ./e2e` |
| Terminal end to end | `app/e2e/interactive.e2e.test.ts` | The compiled binary in a real pseudo-terminal (`e2e/pty.ts`); the test types keys and reads the screen | Dialogs, keys and flows only a person at a keyboard would reach: `/login`, the palette, quitting | same command (Linux and macOS; skipped on Windows, which has no pty) |

CI runs all five on Linux, macOS and Windows. The two end-to-end layers run with
`node_modules` **moved away** (`app/scripts/without-node-modules.sh`), because a user's
machine has none: anything the binary still reads from the build tree fails there instead
of in a release. The release workflow runs the same suite again against each archive's own
`mnemo` and `memsrv` before the draft release is published.

The terminal suite also starts both layouts with `CI=true`: a real terminal must
still render and accept input there. Mnemo passes its TTY decision explicitly to
Ink, whose default would otherwise suppress interactive rendering on CI runners.

## Rules

1. **A feature is not done until the binary test exercises it.** If it is reached
   through a dialog or a key, the terminal test covers it too. Unit tests prove the logic.
   Only the binary proves the user gets it.
2. **A bug fix comes with a test that failed before the fix.** Run the test against the
   unfixed code once and watch it fail. A test that has never failed has not been proven
   to test anything.
3. **Prove the e2e test catches the break.** For a binary-only fix, build once without
   the fix and run the test against that binary (`MNEMO_E2E_BIN=/path/to/broken`).
   That is how the login and image tests were checked.
4. **Dependency upgrades run the bundle guard first.** When it fails, read the new
   `import()` and decide whether `src/runtime/bun-setup.ts` must register something.
5. **Never skip, quarantine or loosen a failing test to get green.** A flaky test is a
   bug in the test or the code. Fix the bug.

## Writing an end-to-end test

```ts
const w = fresh();                                   // a home, a git project, the mock model
play(steps(
  { tools: [{ name: "write", args: { path: "a.txt", content: "hi" } }] },  // turn 1: a tool call
  { text: "done" },                                                        // turn 2: the answer
));
const r = await mnemo(w, ["-p", "write a.txt"]);     // the real binary
expect(r.code).toBe(0);
expect(fs.readFileSync(path.join(w.project, "a.txt"), "utf8")).toBe("hi");
expect(lastToolResult()).toContain("…");             // what the binary sent back to the model
```

- `llm.requests` holds every request the binary made. Check what reached the model:
  recalled memory in the system prompt, a tool's output, a secret that must not be there.
- Requests that offer tools are the agent loop. Requests without tools are side calls,
  such as reflection; the mock answers those with `[]`.
- For the terminal, `await ready(t)` waits until the prompt listens, not just until it is
  drawn. Use `await submit(t, text)` for single-line composer input: it waits for the
  complete draft to appear before sending Enter, because a busy runner can buffer
  the final characters and Enter together as a paste. Use `t.type()` for dialog keys.
  Async mock scripts can keep a turn
  pending until the test releases it, so interruption tests do not race a fixed sleep.
- In rendered UI tests, wait for the expected frame or source result before sending
  the next key. A pane heading can appear before its rows load or its viewport is measured.
- Windows uninstall tests must wait for actual removal: the running executable is
  locked until it exits. `windows-uninstall.test.ts` runs the deferred cleanup through
  PowerShell (or `MNEMO_TEST_PWSH`), including literal path characters, parent exit,
  and a directory link whose target must remain. The binary suite also uninstalls
  from inside its own installation directory.

## Feature coverage

✓ tested · ◐ partly (logic only, or one path) · ✗ not yet (listed so nobody assumes it is)

| Feature | Unit / sidecar | Binary e2e | Terminal e2e |
|---|---|---|---|
| `--version`, `--help`, bad arguments (exit 2) | | ✓ | |
| `doctor`, `doctor --fix` | ◐ `doctor.test` (memsrv timed, embedder named, no answer fails) | ✓ finds model, sidecar, Python; names the embedder; fixes permissions | |
| `--demo --dump` | | ✓ | |
| `-p` answer, tool loop (`read`, `write`, `edit`, `bash`) | ✓ `extensions.test` | ✓ | |
| `-p` exit code on a model error | | ✓ exit 1 with the reason; best-of counts it failed | |
| `-c` continue | | ✓ | |
| Modes: plan, deny rules, compound commands, broken `permissions.json` / `grants.json` | ✓ `gate.test`, `policy.test`, `extensions.test` | ✓ | ✗ approval dialog |
| Credential files refused, `/proc/*/environ` | ✓ `policy.test` | ✓ `auth.json`, `/proc/self/environ` | |
| Bash and the kernel get an allowlisted environment (no provider keys, no `GITHUB_TOKEN`); `passEnv`, `MNEMO_PASS_ENV` | ✓ `env.test`, `scrub.test` | ✓ | |
| Python kernel (`ipy_run`) | ✓ `kernel.test`, `kernel-cells.test` | ✓ runs from the binary | |
| Sub-agents | ✓ | ✓ | |
| Memory across sessions, `memory_search` | ✓ `memory-loop.test`, `packages/memory` | ✓ | |
| Embedder opt-in: `OPENROUTER_API_KEY` alone keeps memory local; footer `◈ busy`, not `off`, when memsrv does not answer | ✓ `embedder_rpc`, `controller.test`, `ui.test`, `memory-pane.test` | ✓ key in env and `.env`, hung server never reached | |
| `mnemo memory status / tidy / setup / --help` | ✓ `tidy.test`, `memory-cli.test` | ✓ runs against a real journal | |
| Images in `read` | | ✓ (v0.1.3) | |
| `mnemo install`, a download installing itself, doctor's PATH check | ✓ `self-install.test` (Windows paths with stubs; the PATH through pwsh when present) | ✓ `install --yes` from a download, doctor from both copies | ✓ the question: no is remembered, yes installs |
| Uninstall, `--deep`, the refusal to delete foreign files | ✓ `uninstall.test` | ✓ installer layout, saved grants, refusal exits 1 | |
| Update, `--check`, auto check | ✓ `update.test` | ✗ needs a mock GitHub | |
| Installers `get.sh` / `get.ps1` | ✓ `installers.test` (dash; pwsh when present), release workflow | ◐ `scripts/test-install.sh` (Docker) | |
| Workspace prompt → answer; esc with a queued message; `/clear` keeps scrollback; an extension's unhandled rejection | ✓ `workspace.test`, `controller.test` | | ✓ |
| `/login`: API key, subscription (Anthropic, Codex, Copilot), the sign-in link, esc cancels | ✓ `controller.test`, `link.test` | | ✓ |
| `ctrl+k` palette, `/theme`, quitting, the introduction | ✓ | | ✓ |
| Rewind (`esc esc`, `/rewind`) | ✓ `rewind.test` | | ✗ |
| `ctrl+f` find, `ctrl+o` expand, memory pane keys, hub and split view | ✓ `workspace.test`, `keys.test`, `multi.test` | | ✗ |
| Best-of-n, escalation | ✓ `best-of.test`, `escalate.test` | ◐ a failed candidate | |
| Claude Code hooks, MCP server, ingest | ✓ `packages/memory` | ✗ | |
| Release workflow: tag gate, draft then publish, e2e on the archive | ✓ `workflows.test`, `release.test` | | |

The ✗ rows are the next tests to write. The deep review of 2026-10-14
(`docs/REVIEW-2026-10.md`) lists each finding with the test that now guards it.
