# tui-go — the Mnemo terminal interface

A ground-up rebuild in Go on Bubble Tea v2, replacing `tui/` (Rust, ratatui).
`DESIGN.md` at the repository root is the specification.

Both binaries coexist until this one passes the same acceptance run; nothing
in `tui/` is deleted before then.

## The shape

One surface, not six panes. The transcript IS the application; everything else
is one control chord away and dismissed with `esc`.

```
▚ MNEMO ░░░░░░░░░░░░░░░░  ~/repo ▌ model      header, the band travels while working
━━╾ TRANSCRIPT ╼━━━━━━━━┃━━╾ EXPLORER ╼━━     regions are always labelled
│ …                     ┃ ▾ repo
● read main.go   ▸ 40 ln┃   ├─▸ app           the explorer, ^t
▊ ▏                                            prompt: enter queues, alt+enter steers
 INSERT ▌ … ▌ …          0/6 thinking ▌ 9 blk  mode, live keys, counts
```

## Keys that matter

| key | does |
|---|---|
| `^e` | open **every** thinking block, one press. `^r` tools, `^a` everything |
| `^t` | folder explorer on the right — and focuses it, so there is no second step |
| `^s` | sessions, as project → session → the sub-agents under it |
| `^k` | run anything by name |
| `esc` | up one level. Always. That is the whole navigation model |

## Packages

| package | owns |
|---|---|
| `internal/theme` | the palette, the glyphs, the styles. Nothing else names a colour. |
| `internal/brand` | Nyx and the wordmark, as marker strings. |
| `internal/tree` | one hierarchical list, used three times: sessions, sub-agents, folders. |
| `internal/chat` | the transcript: blocks, folding, focus, wrapping. |
| `internal/ui` | chrome: rules, bands, chips. Holds no state. |
| `internal/keymap` | every binding. Help and the palette render from it. |
| `internal/overlay` | one modal contract: purpose line, filter, empty state. |
| `internal/session` | pi's stored sessions, as a hierarchy. `home` is always a parameter. |
| `internal/filetree` | a directory as tree nodes, lazily. |
| `internal/prompt` | input, history, and the queue. |
| `internal/agent` | the backend boundary — four methods and some messages. |
| `internal/limits` | the timings and limits, and the `~/.mnemo/limits.json` they come from. |
| `app` | the root model: three modes, one screen. |

## Running and checking

```
go test ./...
go run ./cmd/mnemo                                  # the interface
go run ./cmd/mnemo --dump --cols 110 --rows 24      # one frame, to stdout
go run ./cmd/mnemo --dump --keys "ctrl+t,down,l"    # …after pressing keys
MNEMO_MOUSE=1 go run ./cmd/mnemo                    # mouse on: wheel scrolls, click folds, ^g gives it back
```

`--dump` exists because a TUI cannot be screenshotted from a script, and "it
looked right when I ran it" is not a check anybody else can repeat.

## Timings and limits (`~/.mnemo/limits.json`)

Five numbers the interface used to ship as constants compiled into the packages
that use them. An operator on a slow machine — or a fast one — moves them
without a rebuild. Every key is optional, and the file lives beside the other
preferences (`auth.json`, `theme.json`).

```json
{
  "list_timeout": "20s",
  "memory_timeout": "10s",
  "notice_for": "5s",
  "menu_rows": 8,
  "min_key_len": 8
}
```

**Precedence, per key: flag → environment → file → built-in default.**

| key | flag | environment | default | what it moves |
|---|---|---|---|---|
| `list_timeout` | `--list-timeout` | `MNEMO_LIST_TIMEOUT` | `20s` (`internal/auth/models.go:38`) | how long `/model` waits for the agent's catalogue before it says the listing timed out. Raise it on a slow machine; a provider that hangs holds the pane for this long and not one second more. |
| `memory_timeout` | `--memory-timeout` | `MNEMO_MEMORY_TIMEOUT` | `10s` (`internal/memory/memory.go:34`) | how long one memsrv request may wait. memsrv replays a journal at start up, so the first memory query can be slow: raise it for a big journal. |
| `notice_for` | `--notice-for` | `MNEMO_NOTICE_FOR` | `5s` (`app/model.go:72`) | how long a one-off message stays on the status line before the next frame's silence replaces it. |
| `menu_rows` | `--menu-rows` | `MNEMO_MENU_ROWS` | `8` (`internal/prompt/prompt.go:34`) | how many slash-menu suggestions are shown at once. The menu scrolls inside this window; the transcript keeps the rest. |
| `min_key_len` | `--min-key-len` | `MNEMO_MIN_KEY_LEN` | `8` (`internal/auth/auth.go:90`) | the shortest API key `/login` will accept, and the shortest stored key that counts as logged in. A paste check, not a policy. |

The file is found at `$HOME/.mnemo/limits.json` unless `--limits <path>` or
`MNEMO_LIMITS_FILE` says otherwise (flag over environment). Durations are
written the way Go writes them (`"20s"`, `"1m30s"`) or as a bare number of
seconds (`20`); `menu_rows` and `min_key_len` are whole numbers.

**Nothing here can keep the interface from starting.** A missing file, a
truncated one, an unknown key, a key of the wrong type and a value outside its
range are all the same answer: *that key was not configured*, and the default
answers for it alone — the way a broken `theme.json` falls back to the built-in
palette. Within one file, each key is read on its own, so one typo does not
cost the other four. A value is usable only inside its range: durations from
`1ms` to `24h`, `menu_rows` from 1 to 100, `min_key_len` from 1 to 256. Outside
that it is a typo and the default answers.

The file is read once, at startup, before anything asks for one of these
numbers. An unreadable layer is skipped rather than fatal — a typo in the
environment does not throw away a good file, and a bad flag does not throw away
either.

One detail worth knowing: the notice window lives in `app`, not in a package
under it, because `app` cannot import `internal/limits` without the import
going both ways. `NoticeFor` in `app/model.go` is therefore a `var` set once at
startup from the resolved value (`cmd/mnemo/main.go`, beside `limits.Apply`) —
the same moment and the same reason as every other tunable. Setting it in a
test is safe for the same reason: nothing reads it before `run()`.

## Pi-parity: the gap list

Where this interface stands against pi's own (README "Interactive Mode",
"Sessions", "Skills"). Everything below is the honest remainder, not the
whole — the surfaces pi and Mnemo share (`/model` ↔ `^l`-adjacent `Ctrl+L`,
`/resume` ↔ `^s`, thinking-fold ↔ `Ctrl+T`, tool-fold ↔ `Ctrl+O`, copy-last
↔ `y`/`Y`, skills in the palette ↔ `/skill:name`) are not listed.

**Closed by this build**

| pi | Mnemo |
|---|---|
| `@` fuzzy file reference | `@` in the prompt lists the working tree's files, subsequence-matched, tab/enter inserts the path in place |
| queue: `Alt+Up` retrieves queued messages to edit | `alt+up` pulls the last queued message back into the editor, `alt+down` re-queues a draft first |
| `Ctrl+C` clears the editor, twice quits | first `^c` clears a draft, `^c` while working interrupts, twice quits; the busy line says "^c stops" |
| — | `u` in read mode undoes the last exchange from the transcript (view-level; the agent keeps the turn) |
| `/compact` | `/compact [instructions]` sends pi's own `compact` and reports the outcome through the compaction events the transcript already draws |
| `/fork` | `/fork` asks which messages a branch can start from, forks at the newest one, cuts the transcript back to it and puts it in the editor (see the gap list for what that is not) |
| mouse reporting off (`Ctrl+G`) | mouse reporting is opt-in (`MNEMO_MOUSE=1`): the wheel scrolls the transcript, a click folds the block under the pointer, and `^g` hands selection back to the terminal mid-session |
| `/theme`, `/settings` | `/theme` picks among the four dark-ground presets from DESIGN.md §18, applies on `enter`, and remembers the choice in `~/.mnemo/theme.json` |

**Still gaps**

- **Session branching is one slice deep** — pi's `/tree` (jump to any point,
  continue, switch branches in place) and `/clone` are not built, and neither is
  choosing WHICH message to fork from: `/fork` branches at the newest one. The
  list it already asks for (`get_fork_messages`) is exactly what a picker would
  need; the tree needs a reader for the JSONL session tree, which is
  server-side work this build must not touch.
- **Approval dialogs** — the gate asks through pi's extension-UI protocol and
  this client answers it: `confirm`/`select`/`input`/`editor` become a dialog,
  `notify`/`setStatus` land on the status line, and the answer goes back with
  the matching id. The TUI spawns the agent with `MNEMO_APPROVAL_MODE=interactive`
  so the gate takes its asking path.
- **The palette picker offers dark-ground presets only** — "marble & wine" is
  left out because nothing here paints the terminal's own background, so a light
  palette would only work in a terminal that is already light. Who paints the
  ground is a design decision, not a missing flag.
- **`!command` / `!!command`** boxes, **external editor** (`Ctrl+G` — the chord
  is taken by mouse reporting now), **`/export` `/import` `/share`**, **`/name`**,
  **`/session` info row**, **path completion on tab**, **`/thinking` level
  control** — none wired; all need either agent protocol surface or terminal
  features this build does not reach for yet.
- **Startup header** — Mnemo's header shows cwd + model as pi's does, but not
  the loaded-skills/extensions census.

## Acceptance harness (golden frames)

`app/golden_test.go` does to a curated set of scenarios exactly what `--dump`
does — resize, press keys, render — and pins the resulting text in
`app/testdata/golden/`. The states covered: a fresh session, a conversation
with thinking / tool output / a sub-agent all open, the palette overlay, and
an active search. Colour is deliberately not part of the contract: the frames
are ANSI-free, so a palette change cannot masquerade as a layout change and
a layout change cannot hide behind a colour change.

**Regolding** (only when the change is intentional — a new keyboard model, a
moved status segment):

```
go test ./app/ -run TestAcceptanceGoldenFrames -update
```

Then review the diff before committing. A golden that "just changed a bit" is
a regression wearing a fresh coat of paint.

508 tests. The other suites stay green alongside it: `tui` 213, `agent` 212,
`memory-layer` 44, `harness-engine` 19.
