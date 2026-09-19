# The rebuild: Bun app, Rust memory, ipy sandbox — researched against oh-my-pi

The decision this document serves: **the agent runtime, the harness engine and the
memory layer stay; the interface and everything around it moves to Bun; the Rust
sidecar remains the memory; the ipy kernel becomes the execution sandbox.** The
reference for the parts we do not have yet — installation, onboarding, motion,
and the feel of the thing — is `oh-my-pi`, read as a source of ideas rather than
of code.

Everything below was read in the two checkouts, not recalled. Line references
are to `C:\Users\AtmanMishra\oh-my-pi` (MIT, Stencil Labs) and to this repo.

---

## 1. What each project actually is

| | oh-my-pi (`omp`) | self-evolving-agent (`mnemo`) |
| --- | --- | --- |
| language | TypeScript on Bun, one Rust crate for hot paths | TypeScript on Node + a Go interface (`tui-go`) + a Rust memory server |
| packages | `ai`, `catalog`, `agent`, `coding-agent`, `tui`, `natives`, `stats`, `omptype`, `utils` | `agent/`, `harness-engine/`, `memory-layer/`, `tui-go/` |
| entry | `packages/coding-agent/src/cli.ts` | `agent/bin/mnemo.ts` (node), `tui-go/cmd/mnemo` (Go) |
| runtime floor | `engines.bun: >=1.3.14`, enforced at startup | `engines.node: >=22.18`, enforced at startup |
| interface | its own TUI (`packages/tui`, differential rendering) | pi's TUI, driven from the Go side |
| memory | `@oh-my-pi/pi-mnemopi` (in-repo) | `memory-layer/` — memsrv, journal, HNSW, consolidation |
| test discipline | `bun scripts/ci-test-ts.ts <group>` with named groups | `node --test test/*.ts`, plus `scripts/ci.mjs --only <group>` |

The two are not the same kind of project: `omp` is one monorepo with one runtime
and one ideology; `mnemo` grew three runtimes because each piece was added where
it was easiest. **That is the actual defect this rebuild addresses** — not any
one component, but the seams between them.

---

## 2. Installation: what oh-my-pi does that we do not

Read in `scripts/install.ps1` (352 lines) and `scripts/install.sh`.

1. **Runtime first, then everything else.** The installer checks Bun against a
   hard floor (`$MinimumBunVersion = "1.3.14"`, line 50) *before* it decides how
   to install, and offers to install Bun itself when it is missing or old
   (lines ~211–219: `irm bun.sh/install.ps1 | iex`). It is not asked of the user
   as a preference; it is a prerequisite that the installer satisfies.
2. **Three install modes, one default.** `-Source`, `-Binary`, or a package
   install; the default is chosen from what the machine has. We have the same
   axis (our `get.sh`/`get.ps1` release-binary route vs `install.sh` source
   route) and it is parked.
3. **Version pinning by ref.** `-Ref v3.20.1` installs a specific version, so a
   bug report can name one.
4. **Old PowerShell is refused with instructions**, not a crash (`< 5.1` →
   "install PowerShell 7 from …"). The same shape as our Node floor message.
5. **The install is proved by running the artifact in CI**, not just locally:
   `scripts/install-tests/run-ci.sh` exercises binary, source-link and tarball
   installs, and `omp --smoke-test` spawns the workers and serves the dashboard
   to catch the packaged-artifact failures that only appear post-install.

What this means for us: our installer must install Bun, build `memsrv` (it is a
Cargo artifact, and nobody installing a coding agent should have to discover
that), and finish by rendering a frame. Anything less and the first bug report
is "it didn't work".

---

## 3. Onboarding: the best idea in the reference

`packages/tui/src/setup/wizard.ts` in one screen:

- **The wizard is a list of scenes** — `providers`, `model`, `glyph`,
  `composer`, `theme` (`ALL_SCENES`, lines 17–23) — and each scene carries its
  own `minVersion` (`wizard.ts:57`). A new question added in v12 is asked of
  someone on v11 and never asked again.
- **Selection is a gate, not a default** (`selectSetupScenes`, lines 41–65):
  no TTY → nothing runs; `resuming` → nothing; `OMP_SKIP_SETUP` set → nothing;
  the setting disabled → nothing; stored version already current → nothing.
- **A "cold-launch gate"** keeps it cheap: the wizard module (and its TUI,
  OAuth, search and theme dependencies) is `await import()`ed *only* when setup
  is stale or forced (`main.ts:614-632`), so the common launch pays nothing.
- **Completion is recorded once, at the end** (`markSetupWizardComplete`,
  `setup.ts:95-98`) — not per scene, so an interrupted wizard is asked again
  rather than half-remembered.
- **A separate provider wizard exists for later** (`runProviderSetupWizard`,
  `setup.ts:119-122`) so `/login`-style flows do not replay the introduction.

Our current state: the interface has `/login`, `/model`, and a first-run hint,
and the Go build learned to put the instructions in the transcript instead of a
status line. What we do **not** have is any of the above: no versioning, no
resume/gate discipline, no separation of "introduce the tool" from "configure a
provider". Every launch either says nothing or says everything.

---

## 4. Motion, and where it belongs

`packages/tui/src/components/loader.ts` is 205 lines and most of it is restraint:

- `SPINNER_ADVANCE_MS = 80`, `RENDER_INTERVAL_MS = 1000/30`, and the spinner
  advances by `floor(elapsed / 80)` steps rather than one per tick — so a slow
  frame does not slow the animation down, and a resumed terminal catches up
  instead of drifting (lines 154–184).
- **Backpressure**: the next tick idles for nine times the last frame's cost
  (`RENDER_BACKPRESSURE_MULTIPLIER = 9`, line 176), explicitly to keep animation
  at or below 10% of a core. Animation yields to work.
- `dispose()` stops the timer and is idempotent (lines 134–137); the component
  is constructed with the frames it will use so a frame swap never re-wraps.
- Nothing animates when nothing changes: the whole file is driven by
  `#requestPaint()`, and painting is a no-op without a UI.

`packages/tui/src/status-line/` (18 files) is the other half: context usage,
git branch, token counts, loop state, and a schema for ordering segments. This
is the "what is happening" that our interface currently answers only if you open
the logs pane.

Our own animation work (Go side) had the right instinct — one question, "does
any spring need a frame?" — and the wrong home: it lives in a runtime we are
leaving. **Motion is a property of the interface, so it moves with the
interface.**

---

## 5. Agent runtime and extensibility

- `packages/agent` is the runtime; `packages/coding-agent/src/extensibility/`
  has a **loader per extension kind**: `plugins/loader.ts`, `hooks/loader.ts`,
  `extensions/loader.ts`, `custom-commands/loader.ts`, `custom-tools/loader.ts`,
  plus `mcp/loader.ts` and `session/session-loader.ts`. One loader per kind, each
  with its own discovery root and diagnostics, rather than one loader with four
  modes.
- **Prompts are files, never code**: `AGENTS.md` §Code Quality — "never build
  prompts in code (no inline strings, template literals, or concatenation).
  Prompts live in static `.md` files; use Handlebars; import via
  `import content from "./prompt.md" with { type: "text" }`". Our memory
  directive, approval wording and system-prompt additions are inline strings.
- **Model quirks are data, not branches**: all model/provider conditionals live
  in a KDL rule tree compiled to `rules.json` (`packages/catalog/src/compat/`),
  and TypeScript may only branch on structured facts from `classifyModel()`.
  The rule that matters for us is the *shape*: policy in data, code generic.
- **One worker pattern**: workers re-enter the single CLI entry and are
  dispatched by a hidden argv selector, validated by `--smoke-test` in CI. We
  spawn the kernel and the sidecar as plain children, which is simpler — but
  when we add workers, this is the pattern that survived their bug history
  (issues #1011, #1027, #1150 are all cited at the code).

---

## 6. What we keep, exactly

1. **The Rust memory layer stays as it is.** The journal, the fact/episode
   model, supersede-not-delete, consolidation, the ANN path — this is the
   project's actual differentiator and it has no equivalent in the reference.
   `omp`'s own Rust crate exists for speed; ours exists for the semantics.
2. **The tools stay** (`agent/src/tools/*`): 19 registered tools, the kernel
   dispatcher, the approval gate, hooks, schedules, the harness engine.
3. **pi stays as the interface library**, driven rather than forked — with the
   migration target being "our app, our entry, our onboarding; pi's rendering
   and agent loop underneath".

---

## 7. What changes, in build order

Each stage has a verification that does not require a model: if it cannot be
checked without an API key, it cannot be checked in CI, and it will rot.

**Stage 0 — the Bun application entry (done, this commit).**
`agent/bin/mnemo-bun.ts` is the program: `--dump`, `doctor`, `--version`,
`--help`, `auth`, `traces`, `consolidate`, `init`, `pr`, `schedule`, and the
interface (pi's `main()` with our extension factories). It imports the session
logic from the Node entry rather than copying it. Verified: the frame renders
with no key and no model, `doctor` exits 1 on an unconfigured machine and names
the fix per line, and 8 tests cover it under Bun.

**Stage 1 — installation.** A Bun installer that: installs Bun when missing or
below the floor; builds `memsrv` from `memory-layer/` with Cargo when a Rust
toolchain exists and says so plainly when it does not; places the entry on PATH;
and finishes by rendering a frame. Inverse: an `uninstall` that removes exactly
what it wrote. Reference: `scripts/install.ps1` + `scripts/install-tests/run-ci.sh`.

**Stage 2 — onboarding as versioned scenes.** Ours, not pi's: `scenes/` with
`providers`, `model`, `memory`, `theme`, each carrying `minVersion`; a stored
`setupVersion` in our settings; the same gates (TTY, resume, env, version) and
the same laziness. The first-run frame already prints the three steps — this
stage makes them *act*, and stops greeting a configured machine.

**Stage 3 — status line.** Context usage, model, provider, memory state, kernel
state, in one component with a schema. Doctor already computes every fact;
the status line is the same facts, live.

**Stage 4 — the kernel as the sandbox.** Today `bash_exec` spawns a shell with
approval and the kernel is a separate tool. The direction is: code execution
goes through the long-lived interpreter, the approval gate decides what reaches
it, and the child-process records ("which process tree did this call start")
become the sandbox's audit trail. **Honest note: an ipy kernel is a persistent
interpreter, not an isolation boundary — this stage is about routing and audit,
and real isolation (namespaces, seccomp, a container) is a separate decision
that must be made explicitly rather than assumed.**

**Stage 5 — retire the Go interface** once stages 1–4 pass acceptance: the Go
binary stays until its replacement renders the same information, then it is
archived the way the Rust TUI was.

---

## 8. Findings from this session, recorded rather than remembered

1. **The credentials store ignored `MNEMO_HOME`.** `src/auth/store.ts` defaulted
   every path to `os.homedir()`, so a relocated home moved the journal, the
   skill history and the tool policy and left credentials behind — the app read
   and wrote the real user's `~/.mnemo/auth.json` while believing it was
   elsewhere. Found by a test that pointed the app at an empty home and was told
   the machine had two providers configured. Fixed: one home, one definition.
2. **`bun test` reports a test that ends in `t.skip()` as a failure.** The same
   file passes 25/25 under `node --test`. Consequence: the existing agent suite
   stays on node; Bun runs the new app tests; making the whole suite Bun-native
   is its own task with its own diff.
3. **An assertion's message is evaluated eagerly.** `assert.ok(cond, \`…${readdir()}\`)`
   throws from the message before a *passing* assertion can pass. Read first,
   assert second.
4. **The Node floor is now the wrong floor for the app.** `MIN_NODE = 22.18`
   still guards the Node entry (`bin/mnemo.ts`), which remains the shim; the
   application's own floor is `MIN_BUN = 1.3` (`src/runtime_check.ts`), checked
   first in the Bun entry so an old runtime gets one sentence instead of a
   syntax error.
