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

The three parallel readers covering pi's remaining documentation — settings and
environment variables, sessions/compaction/JSON mode/usage; extensions, TUI,
skills, prompt templates, packages, models, custom providers, themes; and
security, containerisation, providers, Windows, llama.cpp, keybindings — report
separately. Their findings are appended below as they land, in the same
evidence-plus-citation format.
