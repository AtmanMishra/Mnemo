# seatui — inline terminal REPL for sea-agent

Claude Code / Codex CLI-style interface: the conversation lives in your
terminal's NATIVE scrollback; only a small bottom region is ratatui-managed.
Scroll, copy, and search transcript text with your terminal as usual.

## Architecture

- **Scrollback**: transcript is inserted above the viewport with ratatui
  inline-viewport `insert_before` (styled `Line`s, no alternate screen).
  Header block (`SEA // self-evolving agent`) + model line once the child
  prints its stderr banner (`sea-agent: provider=<p> model=<m>`).
- **Bottom region** (4 rows base): input editor (double border, visible
  cursor) + status line. Grows for overlays: command palette (auto when
  input starts with `/`, Tab completes), help overlay (`?`), y/n approval
  prompt. Height changes recreate the inline Terminal (the `viewport`
  field is private in ratatui 0.29).
- **Streaming**: assistant deltas are appended to scrollback raw, line by
  line, as they arrive.
- **Markdown-lite** (`md.rs`) renders *completed* messages: headings bold+
  underline, `**bold**`, `` `code` `` dimmed, fenced blocks as bordered dimmed
  blocks, `-` bullets with indentation, URLs underlined cyan.
- **Tool cards**: one line per ended tool event from child stderr
  (`[tool] <name> -> ok|error`): green dot + name (+ grey detail), red dot +
  `error` on failure; apply_edit/write_file render edit summaries when
  details exist.
- **Status line**: model id (cyan) · braille dither context bar
  (~chars/4 of the transcript vs 128k budget, yellow→orange→red) · session
  name + UTC clock. THINKING spinner cycles while child output is fresh
  (idle after 1.5s silence).

## Slash commands

/help /quit /clear /model [id] /context /memory <query> /resume [n]

- `/clear` wipes scrollback + transcript (Clear All + header reprint)
- `/model <id>` sets SEA_MODEL and restarts the child process
- `/memory <q>` queries `memory-layer/target/debug/memsrv` directly over its
  stdio JSON-RPC and prints ranked hits
- sessions auto-save to `~/.sea/sessions/<timestamp>.jsonl`; `/resume`
  lists them, `/resume <n>` re-renders a saved transcript into scrollback

## Flags

```
seatui                live REPL (spawns node ../agent/bin/sea.ts)
--render-once         print one sample frame, exit 0 (no child spawned)
--self-test           internal checks, PASS/FAIL lines, exit != 0 on fail
--yolo                disable the y/n approval gate
--verbose             also print raw child stderr lines into scrollback
```

Env overrides: `SEA_SCRIPT`, `MEMSRV_BIN`, `SEA_MEM_JOURNAL`,
`SEA_SESSIONS_DIR`.

## Honest limitations

1. **Approval gate scope**: the default y/n gate covers only OUR slash
   commands that mutate state (`/clear`, `/model`). Tool approvals for
   write_file/apply_edit/bash_exec happen INSIDE the sea-agent child — we
   cannot intercept mid-tool on the stderr side channel.
   TODO: move tool approval into an RPC surface exposed by the agent
   runtime so seatui can gate individual tool calls (see research/
   agent-tui-design.md §6 RPC plan).
2. **Streaming markdown**: streamed assistant text stays raw/plain; we do
   NOT clear+rewrite the block with styled markdown on completion (v1
   choice — clearing arbitrary wrapped scrollback rows is fragile). The
   full markdown renderer applies to completed content loaded via /resume
   and is ready to attach to a future rewrite pass.
3. Tool durations are not available from the current `[tool] name -> status`
   stderr protocol, so no right-aligned durations yet.
