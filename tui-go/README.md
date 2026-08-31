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
| `app` | the root model: three modes, one screen. |

## Running and checking

```
go test ./...
go run ./cmd/mnemo                                  # the interface
go run ./cmd/mnemo --dump --cols 110 --rows 24      # one frame, to stdout
go run ./cmd/mnemo --dump --keys "ctrl+t,down,l"    # …after pressing keys
```

`--dump` exists because a TUI cannot be screenshotted from a script, and "it
looked right when I ran it" is not a check anybody else can repeat.

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

181 tests. The other suites stay green alongside it: `tui` 213, `agent` 212,
`memory-layer` 44, `harness-engine` 19.
