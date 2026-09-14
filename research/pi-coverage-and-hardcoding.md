# Pi coverage and hardcoding — what we are not using, and what is nailed down

*A review of the boundary between Mnemo and the pi agent it is built on
(`@earendil-works/pi-coding-agent` 0.84.3): which of pi's features we actually
use, which we deliberately ignore and what that costs, and every value that is
hardcoded in a place where it will need to change.*

Method: pi's own documentation (18 files shipped inside the installed package)
and its changelog were read against the four Mnemo codebases; every claim below
carries a citation on both sides — what pi documents, and the file:line that
shows our state. Nothing here is inferred from a document alone.

---

## Part A — the boundary

### A1. We speak 4 of pi's 45 RPC commands

| pi's command groups | commands | us |
|---|---|---|
| Prompting | `prompt`, `steer`, `follow_up`, `abort`, `new_session` | **`prompt`, `steer`, `abort`** — `follow_up` and `new_session` unused |
| State | `get_state`, `get_messages` | unused |
| Model | `set_model`, `cycle_model`, `get_available_models` | unused |
| Thinking | `set_thinking_level`, `cycle_thinking_level`, `get_available_thinking_levels` | unused |
| Queue modes | `set_steering_mode`, `set_follow_up_mode` | unused |
| Compaction | `compact`, `set_auto_compaction` | unused |
| Retry | `set_auto_retry`, `abort_retry` | unused |
| Bash | `bash`, `abort_bash` | unused |
| Session | `get_session_stats`, `export_html`, `switch_session`, `fork`, `clone`, `get_fork_messages`, `get_entries`, `get_tree`, `get_last_assistant_text`, `set_session_name` | unused |
| Commands | `get_commands` | **used** (added this cycle) |

Evidence: the only writes to pi anywhere in the interface are
`tui-go/internal/pi/pi.go:368` (`prompt`), `:371` (`steer`), `:374` (`abort`)
and `:300` (`get_commands`). pi's side: `docs/rpc.md` §Commands, headings
`#### prompt` … `#### set_session_name`.

**What that means in practice.**

- **`/model` does not change a running session.** `applyModel`
  (`tui-go/app/update.go:2042`) writes `~/.mnemo/auth.json`; the next session
  picks it up. `set_model` and `cycle_model` are never sent, so the session you
  are looking at keeps its model until you restart it. pi 0.84 even made
  selections session-scoped with an explicit save, which suggests the intended
  granularity.
- **There is no thinking level at all.** pi ships `/thinking` with seven levels
  (`off`…`max`) and two RPC commands; the interface has no way to set one, and
  the header cannot show which is active. For a reasoning model this is the
  cheapest available quality knob and we expose none of it.
- **Compaction is invisible and uncontrollable.** `compact` and
  `set_auto_compaction` are unused, and `compaction_start` / `compaction_end` /
  `summarization_retry_*` are in the deliberately-ignored list (A2). The context
  window can be rewritten underneath the user with nothing on screen.
- **Transient failures look like stalls.** `auto_retry_start` / `auto_retry_end`
  carry `attempt`, `maxAttempts`, `delayMs` and the upstream error; dropping
  them means a provider hiccup is indistinguishable from a hang, and
  `abort_retry` gives the user no way to stop waiting.
- **Sessions cannot be branched, renamed or exported** even though pi supports
  all of it (`fork`, `clone`, `switch_session`, `set_session_name`,
  `export_html`). The interface's sessions browser reads pi's session files from
  disk instead (`tui-go/internal/session/`), which works but tracks the file
  format rather than the supported API.

The plugin/memory/tool extensions Mnemo registers are unaffected by any of this
— they are in-process. This is entirely about the *interface's* controls.

### A2. We draw 6 of pi's 20 event types; 14 are pinned as deliberate non-events

`TestTheDocumentedIgnoredEvents` (`tui-go/internal/pi/contract_test.go:227`)
lists them: `agent_end`, `turn_start`, `message_start`, `message_end`,
`bash_execution_update`, `tool_execution_update`, `queue_update`,
`compaction_start`, `compaction_end`, `auto_retry_start`, `auto_retry_end`,
`summarization_retry_scheduled`, `summarization_retry_attempt_start`,
`summarization_retry_finished`, `extension_error`.

The test exists to catch drift, and the choice is deliberate for the
*transcript*. But four of them are not rendering preferences — they are the only
channel that carries that information:

| ignored event | what is lost |
|---|---|
| `compaction_start/end` (with `result`, `aborted`, `willRetry`) | the session silently got smaller; the user's mental model of its memory is now wrong |
| `auto_retry_*` + `summarization_retry_*` | "why is it sitting there" — a retry is not a hang |
| `extension_error` (extension path, event, error) | an extension that throws says nothing anywhere; we have already spent a day on an agent that died with no message |
| `tool_execution_update` (`partialResult`) | a long tool shows nothing until it finishes |

### A3. pi's extension UI protocol has no implementer

All requests share `type: "extension_ui_request"` with a `method`:
`select`, `confirm`, `input`, `editor` (dialog methods, each with an optional
`timeout`, auto-resolving to `undefined` if unanswered) and
`notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text` (fire and
forget). Responses go back on stdin as `extension_ui_response` with the same
`id` (`docs/rpc.md` §Extension UI Requests at line 1184, §Responses at 1329).

Nothing in `tui-go` mentions `extension_ui_request`; `ParseEvent` has no case
for it, so the request is dropped and never answered.

**This is not theoretical, because our own approval gate depends on it.**
`agent/extensions/approval-gate.ts:10-11` prompts "via `ctx.ui.confirm()`
(native TUI dialog)". In RPC mode that becomes a `confirm` UI request to a
client that cannot answer. The gate's own policy then does what it says it does
with a non-TTY stdin: it **fails open** (`approval-gate.ts:14-15`, and
`isTty()` at `agent/src/approval.ts:73`), so mutating tools — `bash_exec`,
`write_file`, `apply_edit`, and `ipy_run`, which is gated precisely because a
Python cell has full fs/network access — are auto-approved in the TUI path. The
`ask` tier of `~/.mnemo/permissions.json` is effectively an `allow` there; only
explicit `deny` rules still bite.

The interface never sets `MNEMO_APPROVAL_MODE` when it spawns the agent either:
a grep for `APPROVAL` across `tui-go/cmd/mnemo/main.go` and
`tui-go/internal/pi/pi.go` returns nothing, so the child inherits whatever the
parent environment had.

**This is the deepest gap in this review.** It is a correctness bug in a
safety-relevant path, and the fix is the same one that unblocks every other
extension that wants to ask a question.

---

## Part B — hardcoded and duplicated values

### B1. The provider list exists in four places, in two languages

| where | what |
|---|---|
| `agent/src/auth/store.ts:19` | `PROVIDERS = [anthropic, openai, openrouter, opencode, opencode-go]` |
| `agent/src/provider.ts:14` | `SUPPORTED =` the same five |
| `agent/src/auth/store.ts:29` + `agent/src/provider.ts:18` | two copies of the env-var map for the same five |
| `tui-go/internal/auth/auth.go:20` | `Providers = []string{…}` — the same five again |

Adding one provider (a local llama.cpp router, or any of the providers pi ships)
means editing three files in two languages, and **nothing tests that they
agree** — a mismatch would surface as "the wizard offers what the agent refuses"
or the reverse.

### B2. Default sidecar and journal paths are developer-shaped, and duplicated

`agent/src/hooks/memory.ts:23-27` and `agent/extensions/memory-layer.ts:23-29`
each compute `REPO_ROOT`, `MEMSRV_NAME` and `DEFAULT_BINARY` /
`DEFAULT_JOURNAL` under the *checkout*. For anyone running an installed binary
(npm global, or the release tarball) the repo root is the install directory, so
those defaults point at a tree that has no `target/debug/memsrv`. The overrides
exist (`MNEMO_MEMSRV_BIN`, `MNEMO_MEMORY_JOURNAL`, and the interface's
`--memsrv` / `--journal`), but the fallback is wrong for the audience we are
about to hand this to, and the two copies must be kept in step by hand.

Related: `memory-layer/src/bin/mempolicy.rs:17` defaults to the *CWD-relative*
`data/sea-agent-journal.jsonl` — a third convention for the same file.

### B3. One threshold, two numbers, two languages

`agent/extensions/memory-layer.ts:415` `CONSOLIDATE_THRESHOLD = 3` (TypeScript,
decides when consolidation runs) and
`memory-layer/src/consolidate.rs:13` `MIN_OCCURRENCES = 2` (Rust, decides what
counts as a recurring theme). Neither is configurable and neither is mentioned
next to the other.

### B4. A model id is hardcoded in the interface

`tui-go/app/update.go:2029`: if the user leaves the model name empty during the
wizard, the default is `deepseek-v4-flash` — and only for the provider
`opencode-go`; every other provider gets "type a model name, or pick one from
the list". The comment calls it "the canonical default of the build", which is
the tell: a build-specific fact is baked into a general-purpose branch.

### B5. The memory layer's entire tuning surface is compile-time

`memory-layer/src/`: `DIM = 256`, `SEARCH_CACHE_CAP = 256`,
`MIN_OCCURRENCES = 2`, `CROSS_AREA_DISCOUNT = 0.85`, `USEFULNESS_BIAS = 0.02`,
`EMBED_TIMEOUT = 10s`, `EMBED_ATTEMPTS = 2`, `EMBED_BACKOFF = 1s`, and the
steering weights in `steer.rs`/`search.rs`. There is no config file, no env
override and no CLI flag for any of them. For a layer whose whole thesis is that
it learns, its own knobs cannot be touched without a rebuild. (The embedding
*model* name does have an env override — `remote.rs:82` — which shows the
pattern exists.)

### B6. Interface timings that a user may reasonably want to change

`tui-go/internal/auth/models.go:34` `ListTimeout = 20s`,
`tui-go/internal/memory/memory.go:29` `Timeout = 10s`,
`tui-go/app/model.go:60` `NoticeFor = 5s`, `internal/prompt/prompt.go:30`
`MenuRows = 8`, `internal/auth/auth.go:54` `MinKeyLen = 8`. Individually
harmless; collectively they are the whole configuration surface of the
interface, and none of it is a value a user can set.

**Not a problem: secrets.** No key, token or endpoint credential is hardcoded
anywhere in the four codebases; URLs are limited to the search providers
(`agent/src/tools/web.ts:232,245`) and the OpenRouter embeddings endpoint
(`memory-layer/src/remote.rs:34`). The CI scan enforces this.

---

## Part C — what to do, cheapest first

| # | fix | effort | why now |
|---|---|---|---|
| 1 | Implement `extension_ui_request` in the interface (`confirm`, `select`, `input`, `editor` → the existing overlay machinery; `notify`/`setStatus` → the status line) and set `MNEMO_APPROVAL_MODE=interactive` when spawning from the TUI | medium | restores the approval gate to what it claims to be, and unblocks every extension that asks |
| 2 | Surface `compaction_*`, `auto_retry_*`, `summarization_retry_*` and `extension_error` as notices plus a transcript line | small | four events, one case each; turns three silent states into visible ones |
| 3 | `set_model` + `set_thinking_level` on the model picker; show the level in the header | small | makes `/model` mean what it says and gives the reasoning knob back |
| 4 | One provider table, generated or shared, asserted by a test | small | kills a three-file, two-language edit and a whole class of mismatch bugs |
| 5 | Config surface for the memory layer (`~/.mnemo/memory.json`: thresholds, weights, embedder, journal path) | medium | the layer's own knobs stop being compile-time |
| 6 | Resolve the sidecar/journal defaults against the *home*, not the checkout, and delete the duplicated copies | small | installed binaries currently default to a path that does not exist |
| 7 | `fork` / `switch_session` / `set_session_name` / `export_html` in the sessions overlay | medium | replaces file-format scraping with the supported API |
| 8 | `compact` and `set_auto_compaction` in the palette | small | the user can see and steer context compaction |

## Part D — the pi feature-by-feature report

Three parallel readers covered pi's remaining eighteen documents (settings;
environment variables; session format; sessions; compaction; JSON mode; usage;
extensions; TUI; skills; prompt templates; packages; models; custom providers;
themes; security; containerisation; providers; Windows; llama.cpp;
keybindings). Each claim was checked in-repo, and the two decisive ones were
re-run here: the trust probe below was reproduced against the installed pi with
an isolated agent directory, and the resume path was read directly.

### D1. The interface lies about which session you are in

`resume()` (`tui-go/app/update.go:1142-1153`) reads a session file, clears the
transcript and replays its blocks. It never tells the agent to switch, and
`switch_session` is not implemented anywhere in `tui-go` (the only verbs we
write are `prompt`, `steer`, `abort`, `get_commands`). So after picking a
session in `^s`, **the next prompt goes to the session the process was launched
with** — the transcript you are reading and the context the model has are
different conversations, and nothing says so. `/new` is the mirror image: it
clears the view (`app/update.go:803-806`) while pi's session file keeps growing.

Both are cheap: `switch_session` and `new_session` are documented RPC commands
(`docs/rpc.md:531-615`, `:137`) and the interface already holds the file path.
Until then every other observation a user makes about their session is
unreliable.

### D2. Project-local configuration never loads, silently

pi asks before trusting a project; in non-interactive modes a "trust-requiring"
resource is simply **ignored** — `.pi/settings.json`, `.pi/{extensions,skills,
prompts,themes}`, `.pi/SYSTEM.md`, `.pi/APPEND_SYSTEM.md` and project
`.agents/skills` (`docs/security.md:5-29`, `docs/settings.md:14-22`). We spawn
with `--mode rpc --no-builtin-tools` and nothing trust-related
(`tui-go/internal/pi/pi.go:263-273`); `defaultProjectTrust`, `trust.json` and
the `project_trust` event appear nowhere in either codebase.

Reproduced here: `get_commands` returns **7 project-scoped commands with
`--approve` and 0 without** — no prompt, no diagnostic, either way.

The sharp edge is that a *project's own guardrail extension* is exactly the kind
of thing that lives in `.pi/extensions` and will not run, while `AGENTS.md`
still loads (it is trust-exempt), so a partial load looks total. The palette
makes it worse by listing project skills read off disk.

### D3. The extension UI protocol — beyond "no implementer"

Part A3 covers the protocol. The readers found the two concrete failures, and
both are reachable today:

- **Hangs, not just silence.** `agent/src/hooks/commands.ts:163-168` (the
  `/hook add` overwrite path) awaits `ctx.ui.confirm()` with no timeout, and
  pi's RPC `editor()` has none either — `createDialogPromise` parks the promise
  until a response arrives, so only process death recovers. A user extension
  that asks a text question (`ctx.ui.editor`) hangs the same way.
- **Two of our own extensions report through a channel nobody reads.**
  `/hook`, `/schedule`, `/trigger` and `/now` answer with `ui.notify`
  (`agent/extensions/hooks-inline.ts:49-70`,
  `agent/extensions/schedules-inline.ts:101`), and stderr is not piped either
  (`tui-go/internal/pi/pi.go:276-289`) — so they look like no-ops.

### D4. Three skill catalogues that disagree

| who | roots | what it knows |
|---|---|---|
| pi's resource loader | `.pi`, packages, `~/.pi/agent` | everything, but only trusted projects |
| `agent/src/skills/discovery.ts:75-86` | `.pi`, `.agents` | strict flat-YAML frontmatter only |
| the Go palette scan | `.claude`, `.pi`, `.agents` | no packages |

One skill therefore yields two rows (`/name` from disk, `/skill:name` from pi),
`.claude` skills exist only for the Go scan while package skills exist only for
pi, and because `get_commands` is asked exactly once per process
(`internal/pi/pi.go:293-301`) anything a pi package adds mid-session stays
invisible until restart.

### D5. There is no configuration channel into pi

Nothing reads or writes `~/.pi/agent/settings.json` or `.pi/settings.json`, so
`compaction.*`, `retry.*`, `shellPath`, `enabledModels`, `sessionDir`,
`defaultTools` and `thinkingBudgets` are unreachable from any Mnemo surface,
and a project's `.pi/settings.json` is inert (D2). Related: the browser
hardcodes `~/.pi/agent/sessions` (`tui-go/internal/session/session.go:22`) with
no `--session-dir` and no `PI_CODING_AGENT_SESSION_DIR` support, and a third
notion of "sessions" survives at `~/.sea/sessions`
(`agent/src/skills/store.ts:29-31`).

### D6. The shell tools get none of pi's session environment

pi injects `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL` and
`PI_REASONING_LEVEL` into every bash command, resolved per call
(`docs/environment-variables.md:26-45`); it also sets the process markers
`AI_AGENT=pi` and `PI_CODING_AGENT=true` from its CLI entry points. We call the
library `main()` and spawn our own `bash_exec` with `env: scrubChildEnv()`
(`agent/src/tools/bash_exec.ts:44-47`), so a script written against the
documented variables misbehaves quietly. We also never strip *stale* `PI_*`
values, so a nested Mnemo inherits the parent's session metadata.

### D7. Windows: the tool promises a shell it does not use

`bash_exec` spawns with `shell: true` (`agent/src/tools/bash_exec.ts:42`) —
`cmd.exe` on Windows — while the description the *model* reads promises
`/bin/sh -c` (`:9`). pi's own Windows story (Git Bash default, `shellPath`
override, an optional native PowerShell tool) is unavailable: `--no-builtin-tools`
disables `bash` and `powershell` alike and we ship no replacement. The hooks
engine's `sh -c` (`agent/src/hooks/executor.ts:205`) needs Git Bash on `PATH`,
which *is* disclosed.

### D8. Providers: five API keys, and nothing else

`agent/src/auth/store.ts:19-25`, `agent/src/provider.ts:14-21` and
`tui-go/internal/auth/auth.go:20` each hardcode the same five API-key
providers; the wizard only ever writes `kind: "api_key"`
(`agent/src/auth/wizard.ts:61`) and the `oauth` fields in the type are never
populated. The shim exits rather than starting without one of the five
(`agent/bin/mnemo.ts:318-323`). pi's subscription `/login` (Claude Pro/Max,
ChatGPT, Copilot, xAI, OpenRouter OAuth) is implemented in its *interactive*
mode only and is absent from `get_commands`, so it is unreachable from our TUI
as well — meaning a tester whose only credential is a subscription cannot use
Mnemo at all. Local models are in the same bucket: llama.cpp is not one of the
five, yet `/llama` **is** offered by the palette (pi answers it over
`get_commands`) and selecting it is a silent no-op.

### D9. The extension API is barely touched

Ten of pi's thirty-four extension events are used; the never-used set includes
`session_before_compact`, `session_compact`, `session_compact_failed`,
`session_before_tree`, `model_select`, `thinking_level_select`,
`before_provider_request`, `resources_discover` and `project_trust`. Never-used
`ctx` members include `compact`, `getContextUsage`, `signal`, `abort`,
`sessionManager`, `model`, `thinkingLevel`, `hasUI`, `isProjectTrusted`,
`setModel`, `getActiveTools`/`setActiveTools` and `pi.events`. Two consequences
worth naming: no dynamic tool activation (all fourteen tools are in every
prompt, which is a cache-prefix cost as well as a context cost), and the memory
layer cannot see compaction — the single most context-altering thing a session
does.

One dead handler found: `pi.on('shutdown', …)`
(`agent/extensions/tracing.ts:141`) is not a pi event (only `session_shutdown`
is), so it never fires; the span is still closed by `process.once('exit')`.

### D10. Claims in our own documents that were false

Both fixed in this cycle, because a wrong claim is worse than a missing one:

- `README.md:60` said `permissions.json` allow/ask/deny is "enforced even
  without TTY". Only allow and deny are; `ask` needs a human the gate can
  reach, which in the TUI it cannot (issue #15).
- `tui-go/README.md:88-89` said "RPC mode does not emit approval events for
  Mnemo to draw". RPC *does* emit them — verified live — and the missing half is
  the client, not the event.

### D11. What we do that pi does not

Recorded so a later cleanup does not remove it: sub-agent credential scrubbing
(`agent/src/childenv.ts:21-31`), fail-closed asks for delegated children
(`MNEMO_SUBAGENT_CHILD=1`), deny rules honoured with or without a TTY, plan mode
synthesised as prepended rules so a user `allow` cannot punch through, redaction
before every trace write, and `0600` on `auth.json` from both writers. pi ships
no built-in sandbox and says so; neither do we — the difference is that ours is
stated as invariant 8 in `docs/MNEMO-INTERNALS.md`.

---

## Part E — the order to fix this in

| # | fix | effort | why this position |
|---|---|---|---|
| 1 | Answer `extension_ui_request` (confirm/select/input/editor + notify/setStatus) and set `MNEMO_APPROVAL_MODE` when the TUI spawns the agent — issue #15 | medium | restores the gate, unblocks every extension, and stops `/hook`-class commands looking like no-ops |
| 2 | `switch_session` on pick, `new_session` on `/new` — issue #16 | small | until this, the transcript and the model's context are different conversations |
| 3 | Resolve project trust explicitly and say the outcome — issue #17 | small | a whole class of configuration is currently inert with no message |
| 4 | Surface `compaction_*`, `auto_retry_*`, `summarization_retry_*`, `extension_error` as notices | small | four cases in one parser; three silent states become visible |
| 5 | One command catalogue (`get_commands`, re-asked on new session/reload), disk scan as offline fallback only — issue #18 | medium | kills the duplicate rows and the restart-to-see-a-package trap |
| 6 | `set_model` + `set_thinking_level` from the model picker | small | makes `/model` mean what it says |
| 7 | A config file for the memory layer (`~/.mnemo/memory.json`) + the provider table collapsed to one source — issues #19, #20 | medium | the layer's own knobs stop being compile-time; the three-language provider edit stops existing |
| 8 | Resolve sidecar/journal defaults against `$HOME`, honour `sessionDir` | small | installed binaries currently point at a checkout that is not there |
| 9 | `PI_*` session env in `bash_exec`, strip stale ones; set the process markers | small | the documented contract for shell tools |
| 10 | Windows: tell the truth in the tool description, or wire `shellPath`; ship a PowerShell tool | small–medium | the model currently acts on a false promise |
| 11 | Sessions: `fork`, `set_session_name`, `export_html` in the overlay | medium | replaces file-format scraping with the supported API |
| 12 | A containment story for invited testers (pi documents three; we document none) | medium | the one thing a stranger with an untrusted repo needs to read |
