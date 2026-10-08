# DESIGN.md — the Mnemo interface

How `mnemo` looks and behaves in a terminal, and where each piece lives.
Status: v0.1, being built in `app/src/ui/` (Ink + React on Bun).
The Go interface's design is archived at `docs/archive/DESIGN-go-tui.md`.

## 1. Principles

1. **A signature, not a copy.** "A memory palace, rendered in pixels": real
   pixels (two per terminal cell — a half block with a foreground and a
   background colour), ASCII for structure (bracketed tabs, box rules, dither
   ramps), and a node-and-wire motif (`◆───◆`) for memory. Mne, a pixel
   elephant (elephants never forget), is the face.
2. **One surface.** In a terminal Mnemo is a full-screen workspace (alternate
   screen): header, sidebar, main area, composer. Everything about the project
   — files, memory, sessions, skills, logs — is a keystroke away, previewed
   in place. `--inline` keeps the older scrollback transcript.
3. **Familiar where it matters.** The composer, the slash menu, `@` for
   files, `esc` to interrupt, shift+tab for modes work the way hands from
   Claude Code or Codex expect.
4. **Motion means something.** The launch sequence plays once per start (any
   key skips it); after that something animates only while work happens. No
   motion with `--no-motion`, in a dump or a pipe.
5. **Colour carries meaning.** Neuron magenta is the agent and focus, synapse
   cyan is structure and links, memory amber is anything memory did; green is
   success, red failure. The rest is parchment on deep ink.
6. **Never lose the user's words.** A draft survives a dialog, an interrupt
   and a failed turn; a message typed while the agent works is queued.

## 2. Palette, pixels and glyphs

One file owns colour: `app/src/ui/theme.ts`. Three themes, switched live with
`/theme` and remembered: **Mnemo Night** (the identity, below), **Game Boy**
(four greens: roles told apart by value) and **Paper** (light). A theme changes
the palette in place; pixel art is drawn in Night and translated, and painted
themes also set the terminal's default colours (OSC 10/11, restored on exit).
Truecolor hex; chalk downsamples, `NO_COLOR` turns it off. Pixels: `app/src/ui/pixel.ts`
(grids → cells → merged runs, a 5×5 pixel font with a drop shadow for the
wordmark, Mne's sprites, noise that resolves into an image).

| Token | Hex | Used for |
|---|---|---|
| ground / panel / rule | `#0E0B16` / `#16111F` / `#2B2238` | background, surfaces, rules |
| text / dim / faint | `#EDE4D3` / `#8A7F94` / `#4A4157` | parchment text, secondary, hints |
| magenta | `#FF5C8A` | the agent, focus, the active tab pill, the wordmark's start |
| cyan | `#3DDBD9` | structure: headings, links, the memory wire, the wordmark's end |
| amber | `#FFB547` | memory: recalled, learned, pitfalls and fixes |
| violet | `#9D7BFF` | thinking |
| green / red | `#7BE07B` / `#FF4F5E` | success / failure, added / removed lines |

| Glyph | Meaning |
|---|---|
| `❯` | your message |
| `◆` | Mnemo's answer; a node on the memory wire |
| `◇` | thinking |
| `▣` | a tool call (`✓` / `✗` when done) |
| `◈` | memory: recalled, learned, the footer's node count |
| `▐ NAME ▌` | a pill: the active pane, a panel title |
| `░ ▒ ▓ █` | the dither ramp: shading and motion |
| `▤ ◈ ▣ ◇ ≡` | the sidebar panes as coloured tiles: files, memory, sessions, skills, logs |
| ` $ ` ` ◉ ` ` ✎ ` ` + ` ` ⌕ ` ` λ ` ` ◈ ` ` ⚇ ` | tool tiles: shell, read, edit, write, search, python, memory, sub-agent |
| `▀` per item | a strip of pixels: a turn's outcome, a changed line, a test |
| `✎` / `!` in the file tree | a file this session changed / one a failing tool named |

## 3. A launch, and the screen

**Boot** (`components/Boot.tsx`, every launch, ~1.6 s): Mne and the wordmark
condense out of dither noise; a magenta scanline sweeps; the memory wire
draws and the tagline types; what memory holds counts up; Mne blinks.

**Introduction** (`components/Onboarding.tsx`, first run; `--intro`): meet
Mne · how it learns (a signal travelling session → reflect → memory) · the
workspace in miniature · your other agents · a model (log in, demo, later).

**Workspace** (`workspace/Workspace.tsx`):

```
▞▚ mnemo  repo ⎇ branch                          ◆ model  ◈ 412  $0.03
▐▤ FILES▌ ◈ ▣ ◇ ≡  │ ──▐ TRANSCRIPT ▌──────────────────────────────────
 ▾ src          12  │ ❯ fix the flaky login test
   · auth.ts        │ ◆ The session cookie expires before …
   · login.ts       │ ▣ bash  pnpm vitest auth   ✓
 ▸ test             │ ◈ recalled 1 pitfall · fix: refresh first
╭──────────────────────────────────────────────────────────────────────╮
│ ❯ ask, or / for commands, @ for files                                │
╰──────────────────────────────────────────────────────────────────────╯
 ⏵⏵ accept edits · ? shortcuts                 model · 12% context · ◈ 412
```

Focus is the composer, the sidebar or the main area: `tab` moves on (from the
composer only when no completion is open), `esc` comes back, `ctrl+b` hides
the sidebar, `1`–`5` switch panes, `↑↓` move, `→`/enter open, `←` close,
`PgUp`/`PgDn` scroll the main area from anywhere. Moving through the sidebar
previews the selection in the main area; a pane's own keys act on it (`r`
resumes a session, `i` puts `@file` in the prompt).

The inline layout (`--inline`, dumps, pipes) is the earlier one:

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
| pulse | a pixel scanner sweeping while a tool runs; violet neurons flickering while the model thinks; one amber pixel breathing while it waits for you (there is no spinner) | what kind of work, at a glance |
| Mne | at icon size beside the working line: eyes glancing while thinking, down at the work for a tool, amber when waiting, violet with a spark after escalation | the agent has a face |
| reactions | the header's light and a label for a few seconds: `✓ 12 passed`, `✗ 1 failed`, `✦ recalled 3`, `◈ +2 learned`, `⚡ escalated` | what just happened |
| dither-in | a new block's mark resolves `░ ▒ ▓` → mark | new things arrive, they do not pop |
| drop | something learned falls into the memory tab as a pixel and shows `+n` | learning is visible |
| toasts | other agents' events slide in at the top right and dissolve | nothing off screen goes unseen |
| shimmer | a brighter band sweeps across the working verb, 120 ms/step | alive, without blinking |
| verb | rotates through memory verbs (*Recalling, Connecting, Consolidating, Thinking, Reasoning, Weaving…*) every few seconds | brand voice |
| elapsed + tokens | counts up every second while working | proves progress, not a hang |
| tool scanner | each running tool scans its own two cells | parallel tool calls stay legible |
| race | `/bestof`: a lane per candidate; the winner keeps its colour, the rest dissolve | test-time compute you can watch |
| exit card | Mne waves over what the run did; one line stays in the scrollback | a session ends, it does not vanish |

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

### Agents (the shell)

One process runs several agents — each its own project, session and
controller, sharing memory and credentials. Screens: **agent** (one workspace,
the default), **split** (up to four side by side, the focused one framed in
magenta), **hub** (a card per agent: what it does, its prompt, a pixel per
turn; recent projects below).

| Key | Does |
|---|---|
| `ctrl+g` | hub (again: back) |
| `ctrl+s` | split / single |
| `ctrl+p` | switch project: open agents, recent folders, siblings, or a typed path; `tab` opens a new agent there |
| `ctrl+n` | another agent on this project, in parallel |
| `alt+1`…`alt+9` | go to agent N |
| `alt+,` / `alt+.` | previous / next agent |
| in the hub | arrows choose, `enter` open, `s` in/out of the split, `x` close, `n` new |
| in the workspace | `m` in the memory pane opens the memory map; `[` `]` step through turns on the timeline |

Closing an agent (`ctrl+d`, `/quit`) closes that agent; closing the last one
ends the program.

## 7. Commands

Built in: `/help`, `/model`, `/login`, `/logout`, `/new`, `/resume`, `/compact`,
`/thinking`, `/cost`, `/clear`, `/memory [words]`, `/remember key: value`, `/mode`,
`/plan`, `/skills`, `/reload`, `/quit`, `/theme`, `/bestof N "<check>" <task>`. Everything pi knows —
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
