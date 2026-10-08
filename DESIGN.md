# DESIGN.md — the Mnemo interface

How `mnemo` looks and behaves in a terminal, and where each piece lives.
Status: v0.1, being built in `app/src/ui/` (Ink + React on Bun).
The Go interface's design is archived at `docs/archive/DESIGN-go-tui.md`.

## 1. Principles

1. **Familiar first.** People arrive from Claude Code, Codex CLI, Gemini CLI.
   The input box, slash menu, `esc` to interrupt, `@` for files, a footer with
   the model and context use — these work the way their hands expect. Mnemo's
   difference is the memory, not new keybindings.
2. **The transcript is the terminal's scrollback.** Finished messages are
   written once (Ink `<Static>`) and become ordinary terminal history: scroll,
   search and select them with the terminal's own tools. Only the live turn and
   the input are redrawn.
3. **Motion means work.** Something animates only while the agent is doing
   something. When it is idle the screen is still.
4. **Colour carries meaning.** Lavender is Mnemo (brand, the assistant, memory).
   Green is success or an added line, red is an error or a removed line, amber
   is a question waiting for you. Everything else is the terminal's own
   foreground or a muted grey.
5. **Never lose the user's words.** A draft survives a dialog, an interrupt and
   a failed turn. A message typed while the agent works is queued, not dropped.

## 2. Palette and glyphs

One file owns them: `app/src/ui/theme.ts`. Truecolor hex; chalk downsamples to
256 or 16 colours, and `NO_COLOR` turns it off.

| Token | Hex | Used for |
|---|---|---|
| `accent` | `#B794F6` | brand, assistant bullet, focused border, selection |
| `accent2` | `#7DD3FC` | second stop of the brand gradient, links, file paths |
| `success` | `#86EFAC` | finished tool, added diff line |
| `warning` | `#FCD34D` | approval dialog, queued message, retry |
| `error` | `#FCA5A5` | failed tool, error notice, removed diff line |
| `muted` | `#8B8B96` | secondary text, hints, footer |
| `subtle` | `#4A4A55` | borders at rest, rules, thinking text |
| `addBg` / `removeBg` | `#1C3326` / `#3A1E24` | behind added / removed diff lines |

| Glyph | Meaning |
|---|---|
| `❯` | your message |
| `●` | Mnemo's answer (lavender) |
| `✻` | thinking (collapsed by default) |
| `◆` / spinner | a tool call: animated while running, `✓` green / `✗` red when done |
| `⎿` | a tool's result, indented under its call |
| `◈` | memory: what was recalled or written |
| `▸` | a notice from Mnemo itself (model changed, session resumed, …) |

## 3. The screen, top to bottom

```
╭─────────────────────────────────────────────────────────────╮
│ ✻ mnemo  v0.1.0                                             │   welcome card
│   memory that works like a brain                            │   (once, then
│   ~/code/project · claude-sonnet-4-5 · memory on            │    scrollback)
│   /help for commands · @ to mention a file · esc interrupts │
╰─────────────────────────────────────────────────────────────╯

❯ add a retry to the fetch helper                                 transcript
● I'll look at the helper first.                                  (<Static>)
◆ Read(src/net/fetch.ts)
  ⎿ 84 lines
◆ Edit(src/net/fetch.ts)
  ⎿ +12 −3
      14 + for (let attempt = 0; attempt < 3; attempt++) {
● Done — three attempts with backoff.

⠹ Recalling… (4s · ↓ 1.2k tokens · esc to interrupt)              working line
  ⎿ queued: also update the tests                                 queue

╭─────────────────────────────────────────────────────────────╮
│ ❯ █                                                         │   input
╰─────────────────────────────────────────────────────────────╯
  ? for shortcuts             sonnet-4-5 · think:medium · 12% ctx · $0.04   footer
```

Real frames (the binary in a pseudo-terminal): a finished turn
(`docs/screenshots/turn.png`), mid-turn (`working.png`), the slash menu
(`slash.png`), first-run `/login` (`login.png`), an approval (`approval.png`) and
what memory learned (`memory.png`).

The slash menu, `@file` suggestions and every dialog open **in place of or
directly under the input box** — never as a full-screen takeover — so the
conversation stays visible above.

## 4. Blocks

| Block | Rendering |
|---|---|
| user | `❯ ` + text, wrapped with a hanging indent |
| assistant | `● ` + markdown (headings, lists, emphasis, inline code, links, tables, fenced code with syntax highlight in a dim frame labelled with its language) |
| thinking | while streaming: `✻ Thinking…` plus the last line, dim italic. Finished: one line `✻ Thought for 6s` — `ctrl+o` expands every thinking and tool block |
| tool call | `◆ Name(primary argument)`; spinner while running; result summary under `⎿` (`84 lines`, `+12 −3`, `exit 1`); output truncated to 6 lines with `… +N lines (ctrl+o)` |
| edit/write | a coloured diff, line numbers in muted, `+` lines green, `−` lines red |
| bash | the command in the header, output in the result, non-zero exit in red |
| notice | `▸ ` muted text; warnings amber, errors red |
| memory | `◈ Recalled` under your message (profile facts, matching memories), `◈ Learned 2 facts` after a run, `◈ Memory noted the failure` when steering ran — lavender |

Markdown renders only for finished text; the live block streams as plain
wrapped text and is re-rendered when it completes, so a half-open code fence
never flips the layout mid-stream.

## 5. Motion

| What | How | Why |
|---|---|---|
| working spinner | braille frames `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`, 80 ms | the agent is busy |
| shimmer | a brighter band sweeps across the working verb, 120 ms/step | alive, without blinking |
| verb | rotates through memory verbs (*Recalling, Connecting, Consolidating, Thinking, Reasoning, Weaving…*) every few seconds | brand voice |
| elapsed + tokens | counts up every second while working | proves progress, not a hang |
| tool spinner | each running tool spins its own glyph | parallel tool calls stay legible |

Nothing animates in `--dump`, in tests, or when stdout is not a TTY.

## 6. Keys

| Key | In the input | While the agent works |
|---|---|---|
| `enter` | send | queue as follow-up |
| `alt+enter` / `shift+enter` / `\`+`enter` | newline | — |
| `esc` | close menu / clear on double press | interrupt the turn |
| `ctrl+c` | clear the draft; twice on empty quits | interrupt |
| `ctrl+d` | quit when empty | — |
| `↑` / `↓` | history (or move in menu) | — |
| `←` `→` `home` `end` `ctrl+a` `ctrl+e` | move the cursor | — |
| `ctrl+u` `ctrl+k` `ctrl+w` `alt+backspace` | delete to start / end / word | — |
| `tab` | accept the highlighted suggestion | — |
| `shift+tab` | cycle mode: default → accept edits → plan | |
| `ctrl+t` | cycle thinking level | |
| `ctrl+o` | expand / collapse thinking and tool output (blocks still on screen; scrollback is the terminal's) | |
| `ctrl+l` | clear the screen (the session is kept) | |
| `?` on an empty input | shortcuts panel | |

## 7. Commands

Built in: `/help`, `/model`, `/login`, `/logout`, `/new`, `/resume`, `/compact`,
`/thinking`, `/cost`, `/clear`, `/memory [words]`, `/remember key: value`, `/mode`,
`/plan`, `/skills`, `/reload`, `/quit`. Everything pi knows —
extension commands, prompt templates (`/name`), skills (`/skill:name`) — is
merged into the same menu with its source shown, and runs through pi.

## 8. Dialogs

One component family in `app/src/ui/dialogs/`, used both by Mnemo's own flows
and by pi extensions through the extension UI context (`select`, `confirm`,
`input`, `notify`):

- **Select** — filterable list, `↑↓` to move, type to filter, `enter` choose, `esc` cancel.
- **Confirm** — amber frame, the question, `y` / `n` / `enter` / `esc`.
- **Approval** — amber frame with the call itself: the command, the code, or
  the edit as a red/green diff. `1` yes · `2` yes and don't ask again for this
  command pattern in this project (offered only when the call generalises
  safely) · `3` no, and type what to do instead — those words go back to the
  model as the reason. The working line says "Waiting for you…" meanwhile.
- **Text** — single line, optionally masked (`•`) for keys.

`/login` is pi's own login flow (every provider pi supports, API keys and
OAuth) rendered through these three.

## 9. Modes

`shift+tab` cycles, and the footer shows any mode but the default:

| Mode | Footer | Reads | Edits in the project | Commands, Python |
|---|---|---|---|---|
| default | — | free | ask | ask (unless granted) |
| accept edits | `⏵⏵ accept edits` green | free | free | ask |
| plan | `⏸ plan mode` sky | free | refused | refused |
| yolo (`/mode yolo`, `--yolo`) | `⚠ yolo` red | free | free | free |

Rules in `~/.mnemo/permissions.json` (`{"rules":[{"tool":"bash","pattern":"rm -rf*","action":"deny"}]}`)
come first in every mode, yolo included.

## 10. Code map

| File | Owns |
|---|---|
| `app/src/ui/theme.ts` | palette, glyphs, spinner frames, verbs |
| `app/src/ui/App.tsx` | layout, focus, global keys |
| `app/src/ui/store.ts` | the transcript model: pi events → blocks (pure, tested) |
| `app/src/ui/editor.ts` | the input's text buffer and cursor (pure, tested) |
| `app/src/ui/format.ts` | tool titles, result summaries, previews (pure, tested) |
| `app/src/ui/components/*` | blocks, markdown, diff, working line, footer, welcome |
| `app/src/ui/dialogs/*` | select, confirm, text |
| `app/src/runtime/runtime.ts` | the pi `AgentSessionRuntime`, created in-process |
| `app/src/runtime/controller.ts` | the only caller of the session: submit, interrupt, built-in commands, login |
| `app/src/runtime/ui-context.ts` | pi's extension UI context answered by the Ink interface |
| `app/src/runtime/dialogs.ts` | the question queue shared by Mnemo and pi extensions |
| `app/src/runtime/demo.ts` | the faux-provider script behind `--demo` and the tests |
| `app/src/extensions/*` | Mnemo on pi: policy, memory, kernel, sub-agents, skills, trace |
| `packages/memory/` (`@mnemo/memory`) | the memory loop (`MemorySession`), profiles, recall, learning, steering over the `memsrv` protocol |

## 11. Testing

`bun test` renders components with `ink-testing-library`, types real keystrokes
into them and asserts on the frame text. The whole app runs against a real pi `AgentSession` with pi-ai's
scripted **faux** provider, so a turn — streaming, tool calls, approval, abort —
is tested offline with no key. `mnemo --demo` runs the same scripted turn
interactively, and `mnemo --demo --dump` prints its final frame for scripts.
Screenshots in `docs/screenshots/` are the real binary in a pseudo-terminal,
replayed through xterm.js.
