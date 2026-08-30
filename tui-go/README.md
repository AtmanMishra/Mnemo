# tui-go — the Mnemo terminal interface

A ground-up rebuild in Go on Bubble Tea v2, replacing `tui/` (Rust, ratatui).
See `DESIGN.md` at the repository root for what it looks like and why.

Both binaries coexist until the Go one passes the same acceptance run; nothing
in `tui/` is deleted before then.

## Layout

| package | owns |
|---|---|
| `internal/theme` | the palette, the glyph set, the styles. No other package names a colour. |
| `internal/tree` | one hierarchical list, used three times: sessions, sub-agents, folders. |

Run `go test ./...` from this directory.
