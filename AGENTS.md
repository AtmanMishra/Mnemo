# Mnemo TUI — Go Rebuild Handover

## What's been built

**tui-go**: Complete rebuild of the Mnemo terminal interface from Rust (ratatui) to Go (Charm.land v2 ecosystem). Lives alongside `tui/` (Rust) until acceptance testing confirms feature parity.

The terminal UI is **one unified surface** — no tab switching. The transcript is the primary view; everything else (palette, sessions, explorer, memory, logs) floats as a modal and dismisses with `esc`.

### Core features delivered

**Navigation & Input**

- Three keyboard modes: Insert (typing), Read (esc activates), Browse (tree focus)
- Global chords reachable in one press: `^k` palette, `^t` explorer, `^s` sessions, `^m` memory, `^l` logs
- `esc` always goes up one level — complete model
- Arrow keys and vim keys throughout (j/k for scroll, J/K for block nav, etc.)
- Tab cycles: prompt → transcript → explorer → prompt
- Search via `^f`: live query, case-insensitive, wraps around, highlights in context

**Rendering & Layout**

- Markdown rendering via Glamour with palette-generated stylesheet
- Hierarchical transcript: user/agent/think/tool/delegation/notice block types
- One-key toggle (`^e` think/`^r` tools/`^a` all) opens/closes blocks by type across the whole transcript
- Folding on click, focus-by-block navigation, `y`/`Y` copy to clipboard
- Floating overlays over dimmed backdrop (palette, sessions, memory, logs, help)
- Lazy-loaded folder explorer with size display

**State & Integration**

- Sessions browser: project → session → sub-agent hierarchy
- Memory management: read-only view with forget capability (`d` key, requires confirmation)
- Live agent integration: spawns pi process, streams messages, handles interrupts
- Command discovery: slash commands populate from SKILL.md files and plugin manifests
- Model selection: `/model` lists what logged-in providers offer
- Authentication: `/login` and `/logout` manage API keys per provider

**Testing & Quality**

- 329 green tests across all packages
- Mock agent for offline testing
- Test fixtures for common scenarios (session resume, search, overlays, key dispatch)
- go vet clean, zero warnings

## Architecture

### Package map

| Package | Owns | Key exports |
| --------- | ------ | ------------- |
| `internal/theme` | Palette, glyphs, styles. Single source of color. | Theme struct, 14-colour PICO-8, dither ramp, spinner |
| `internal/brand` | Nyx mascot and wordmark, marker-based art system | Paint(), CatFor(), Wordmark sizes, walk cycle, blink |
| `internal/tree` | Hierarchical list model, one impl, three uses | Model, Node, ExpandAll/CollapseAll, Filter, Toggle |
| `internal/chat` | Transcript: blocks, folding, focus, wrapping, search | Block, Model, ToggleAll, Search, Highlight, SetFocus |
| `internal/ui` | Chrome: rules, bands, chips, floating panels | Rule, Band, Chip, Header, Panel, Float, Dim |
| `internal/keymap` | Every binding. Help & palette render from it. | Map (struct), Mode enum, Help/Hints/OverlayHints |
| `internal/overlay` | One modal contract: purpose, filter, empty state | Model (flat or tree), NewList/NewTree, SetQuery |
| `internal/session` | Pi's stored sessions as hierarchy | Session, Project, Subs, Load, Nodes, Transcript |
| `internal/filetree` | Directory → tree.Nodes, lazy-loaded | Root, size display, skip common dirs (.git, etc.) |
| `internal/prompt` | Input, history, queue, completion | Model, Value, Suggest, Complete, Queue, HistoryPrev/Next |
| `internal/agent` | Backend boundary: spawn, stream, interrupt | Agent interface, Started/Think/Text/ToolStart/ToolEnd/Delegated/Done/Failed messages |
| `internal/auth` | API key store & model catalogue | File (JSON), SetKey, LoggedKey, Fetch/Filter models |
| `internal/markdown` | Glamour v2 renderer with palette stylesheet | Renderer, Render (cached by content lines + width) |
| `internal/command` | Command discovery: built-ins, skills, plugins | Kind enum, Builtins(), Roots(), ScanSkills, Load, Match |
| `internal/memory` | Brain areas from pi's memory server | Client, Nodes, Forget, read-only state view |
| `internal/pi` | Live pi RPC backend, message streaming | Spawn, Chan for messages, Interrupt, Close |
| `app` | Root model: modes, state machine, layout | Model, Update, View, Config, layout owner for hit-testing |

### Key design decisions

**One owner for layout math**: The `rows()` struct in app/view.go computes all region boundaries in one place. Two functions computing it separately disagreed by one row, putting the terminal cursor off and breaking click hit-testing. Unified computation fixed it.

**Markdown cache by (content, width)**: Glamour renders on every keystroke, but only re-parses when the source text or viewport width changes. Cache key is (source lines count, width). Invalidate on SetBody.

**Streaming continues the previous line**: If a delta arrives as two chunks, the second chunk continues the first, not a fresh line. Critical for not splitting words at chunk boundaries.

**Palette filters by field, not joined**: Query against label/group/detail SEPARATELY. Matching joined fields lets a query like "a^" match by taking 'a' from label and '^' from detail thirty words apart. Per-field prevents false positives.

**Two-tier query matching**: Names use subsequence (every char in order: "sess" finds `/sessions`). Prose uses substring (Descriptions are sentences). Prevents three-letter queries returning the whole list.

**Confirmations precede global chords**: Only destructive actions ask first (forgetting a memory). The question must outrank `^t` and other globals, or a chord walks past it. Confirmation state owns the keyboard.

## Running

### Prerequisites

```bash
go 1.22+
node (for --list-models; queries pi agent)
pi repository at REPO_ROOT
```

### Build

```bash
cd tui-go
go build -o mnemo ./cmd/mnemo
```

### Run offline (no agent)

```bash
./mnemo --dump --rows 30 --cols 100
# Renders one frame to stdout, exits. Useful for testing layout.
```

### Run live with agent

```bash
./mnemo --repo $REPO_ROOT --cwd $CWD
# Spawns pi agent via agent/bin/mnemo.ts
# --home $HOME (default ~/.mnemo) for sessions & auth store
# --memsrv path/to/memsrv --journal ~/.mnemo/journal.jsonl (optional)
# --bundles path/to/harness (optional, for tool discovery)
```

### Flags for debugging

```bash
--dump             render one frame and exit
--keys <chord>     press keys before dump (e.g., --keys "ctrl+k,e,s,p")
--rows, --cols     set viewport size for dump
```

## What's left

### Not in this build (by design)

1. **Onboarding/auth/model switching**: First-run wizard still in Rust tui/src/auth.rs. Go side assumes pre-configured ~/.mnemo/auth.json. Can be migrated if needed. **(DONE 2026-08-31:** the /login + /model + logout flow, the provider→key→model wizard and first-run detection now ship in tui-go; see STATUS.md TUI-GO COMFORT run 2.**)**
2. **Mouse click/wheel hit-testing**: Mouse reporting requested but never acted on. Choice: terminal drag-select (current) vs. in-app clicks (complicated, loses terminal's copy gesture).
3. **Golden-file tests**: Tests check logic and text, not colour. Colour regressions not caught. Low value; would need visual-diff harness.
4. **Overlay compositor**: Overlays float over a dimmed backdrop via Compositor (done). Harmonica springs not used; current spring physics is simple Y-offset (good enough).

### If continued

**High value, reasonable scope**:

- Onboarding integration: Move auth flow to Go so --repo works for first-timers
- Memory write operations: full CRUD (currently read + forget only)
- Acceptance test harness: automated screenshots for regression testing
- Tool output capture in transcript: currently quoted as text, could render natively

**Medium value, higher scope**:

- Plugin system UI: create/upload/manage plugins from within TUI (plugin API exists)
- Dockable panes: sessions/memory/logs as toggleable columns, not modals
- Theme picker: user-selectable palettes (already structured for it)
- Macro recording: capture and replay key sequences

## How to continue

1. **Understand context**: `graft map` for token-budgeted orientation. `graft ask "<question>" --source` to find code.
2. **Small changes**: Read the package that owns the concern. One-owner design means minimal blast radius.
3. **Test before committing**: `go test ./...` must pass. `go vet ./...` must be clean.
4. **Refresh the graph**: After big code changes, `graft build` updates the index.
5. **Commit hygiene**: Include WHY in messages, not just WHAT. Code already says WHAT.

## Repo structure

```
self-evolving-agent/
  tui-go/                   ← the Go rebuild (this one)
    cmd/mnemo/              entry point, config wiring
    internal/*/             all packages listed in Architecture above
    app/                    root model & layout
    *.go                    per-package main, tests
    go.mod / go.sum         dependencies
    DESIGN.md               user-facing feature spec
    README.md               running & architecture overview
  agent/                    pi agent (spawned as subprocess)
  memory-layer/             memsrv memory backend (optional)
  DESIGN.md                 the TUI spec (root)
  AGENTS.md                 this file
```

> The Rust `tui/` was archived on branch `archive/tui-rust` (see git history
> before commit 2240ac4); it is not part of the main system anymore.

## Dependencies

Go modules only (go.mod). Pin versions; no k8s-style floating.

- charm.land/bubbletea/v2 (v2.0.9): TUI framework
- charm.land/lipgloss/v2 (v2.0.6): styling & layout (compositor)
- charm.land/bubbles/v2 (v2.2.1): reusable components (textarea, etc.)
- github.com/charmbracelet/glamour (latest): Markdown rendering
- github.com/charmbracelet/x/ansi: ANSI-aware string ops

Rust (memory-layer only, if memsrv used):

- serde/serde_json: serialization
- tokio: async runtime
- jsonrpc: RPC protocol

## Contact & references

- **Design spec**: DESIGN.md (root)
- **Code graph**: graft/ (auto-indexed)
- **Test suite**: `go test ./...` runs all, `go test ./app/` for a package
- **Live view**: `go run ../tui-go/cmd/mnemo -- --repo $(pwd)` — run from the REPO ROOT (--repo must be the root containing agent/, not tui-go/)
- **Original Rust TUI**: archived on branch `archive/tui-rust`; not in the main system.
