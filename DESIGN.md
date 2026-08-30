# DESIGN.md — the Mnemo TUI

How `mnemo-agent` looks, why it looks that way, and where to change it.

**Status: this document specifies the Go / Bubble Tea rebuild.** The shipping
TUI today is Rust + ratatui (`tui/`, ~9,000 lines, 213 tests). This document is
the target, not a description of `tui/`. Section 15 is the migration plan and
section 16 the honest risk list. The brand — sections 1 through 3 — is
unchanged by the rebuild and is already implemented; everything from section 4
onward is new.

The rules here are not preferences. Each one exists because the alternative was
tried, or because a terminal makes the alternative actively worse. If you break
one, say why in the code.

---

## 1. The one idea

**Colour is state. Shape is identity. Motion is progress.**

Nothing in this UI is decorated. If something is pink, that is a claim about
what it *is*. If something moves, work is happening. If nothing is happening,
the screen is still.

This is the PICO-8 constraint applied to a terminal: a small fixed palette, a
small fixed glyph vocabulary, no gradients, no shadows, no italics. The limit is
the design. It also degrades honestly — every glyph used here is in the standard
box-drawing and block ranges, so it renders on a plain monospace font with no
patched icons.

---

## 2. The brand

### The name

**Mnemo** — from *Mnemosyne*, the Greek personification of memory and mother of
the Muses. Lowercase in prose (`mnemo-agent` is the command), uppercase in the
wordmark. Never "Mnemo AI", never a tagline bolted onto the name.

The tagline is one line, lowercase, no exclamation mark:

> memory that works like a brain

### The wordmark

Five letters, block-built, strokes three cells thick, with a half-cell lip down
and to the right that gives depth without spending a second colour:

```
███         ███   ███         ███   ████████████   ███         ███      █████████
██████   ██████▒  ██████      ███▒  ███▒▒▒▒▒▒▒▒▒▒  ██████   ██████▒  ███ ▒▒▒▒▒▒▒▒███
███▒▒▒███ ▒▒███▒  ███▒▒▒███   ███▒  █████████      ███▒▒▒███ ▒▒███▒  ███▒        ███▒
███▒   ▒▒▒  ███▒  ███▒   ▒▒██████▒  ███▒▒▒▒▒▒▒     ███▒   ▒▒▒  ███▒  ███▒        ███▒
███▒        ███▒  ███▒      ▒▒███▒  ████████████   ███▒        ███▒   ▒▒█████████ ▒▒▒
 ▒▒▒         ▒▒▒   ▒▒▒         ▒▒▒   ▒▒▒▒▒▒▒▒▒▒▒▒   ▒▒▒         ▒▒▒      ▒▒▒▒▒▒▒▒▒
```

83 cells wide, so it needs an 87-column terminal. Below that a two-cell-stroke
version (57 cells) takes over; below **that** the wordmark is dropped entirely
and the tagline stands alone. **A wordmark that wraps is not a wordmark.**

The lip is drawn in ROSETTE brown, not grey — it is the same ink as the mascot's
markings, which is what makes the logo and the cat look related rather than
merely adjacent.

### Nyx, the Bengal cat

The mascot is a **Bengal cat**, and the breed is the point.

A Bengal's defining feature is the **rosette**: a two-toned spot with a dark ring
and a lighter centre, *clustered* rather than evenly scattered. TICA's breed
standard prefers rosettes over single spots and asks for "extreme" contrast
against the ground colour.

That is a fair description of Mnemo's memory graph — marks that mean something as
a cluster and nothing individually, with sharp boundaries between them. The
mascot is this breed because of what the pattern is, not because cats are
appealing.

The other breed signatures are in the art: bold **mascara** lines running back
from the eyes, small ears on a wide base, a spotted belly, and a thick **ringed
tail**.

```
    ████                    ████
  ██▒▒▒▒██                ██▒▒▒▒██
    ████████████████████████████████
  ██████████████████████████████████
  ██████▓▓████        ████████▓▓████████
  ██████████████████████████████████
──████████████████▄▄▄▄████████████████──
    ████████████████████████████████
      ████████████████████████████
        ████████████████████████            ████
      ████████████████████████████        ████▓▓██
    ██████▒▒████████▓▓████████▒▒██████    ██████▒▒██
    ██████▓▓████████▒▒████████▓▓██████    ██████▓▓██
    ██████▒▒████████▓▓████████▒▒██████    ██████▒▒██
    ██████▓▓████████▒▒████████▓▓██████  ██████▓▓████
    ████████████████████████████████    ██████▒▒████
    ████████████████████████████████  ██████▓▓████
      ████████████████████████████  ████▒▒████████
      ████████████████████████████  ████████████
      ████  ████    ████  ████      ████████
```

**An open eye is a hole in the coat, not a drawn shape.** This is the one rule
about the face that must not be relaxed. Earlier drafts gave her `◗◖` eyes and a
`╰╯` mouth over a pale muzzle slab; the result read as a glare with teeth. A
mascot that greets you at install time must be calm. Negative space is calm, it
needs no colour of its own, and it survives being rendered on any background.
Blinking closes the hole — the same two cells fill with COAT for two frames.

**There is no mouth.** Not a stylistic preference: at two cells per pixel there
is not enough room for a mouth that does not read as a grimace.

**The rosettes are drawn from `DITHER`** — the same density ramp as the thinking
animation. One vocabulary, used twice. That is not a coincidence to preserve
casually: if the ramp changes, the cat changes with it, and that is correct.

**The nose is the only ACCENT-coloured pixel in the entire mascot.** The brand
colour is the cat's nose. A test enforces exactly one accent run — more than one
and it stops being a detail and becomes decoration.

### Nyx walks

She is not only a portrait. A side-view walk cycle runs during **installation**
and through **every step of onboarding** — the two moments a new user is waiting
on something they cannot hurry, and the two moments a still screen reads as a
hang.

Four frames, `[A, B, C, B]`, so the legs gather, spread, gather and the cycle
loops without a jump. A side view is not vanity: a cat walking towards you does
not read as walking. She paces left to right, turns (the art is mirrored, and
mirroring swaps `/` with `\`), and paces back.

```
  ████        ████  ████
  ██▒▒▒▒██      ████████████████
  ██▓▓██      ████    ████████▄▄██
  ██████    ██████████████████████
    ██████████▓▓████████████████
    ██████▒▒████████▓▓██████████
    ████████████████████████████
  ████  ████        ████  ████
```

Timing: legs change every **3 ticks**, a blink every **47 ticks** and lasts
**2**. 47 is prime so the blink never syncs with the gait — a cat that blinks
on the same footfall every time looks like a machine.

Below **44 columns** the walk is not drawn at all. A cropped cat is worse than
no cat.

### Colours of the mascot

| part | colour | hex |
|---|---|---|
| Coat | `ORANGE` | `FFA300` |
| Rosettes, mascara, ringed tail | `BROWN` | `AB5236` |
| Inner ear | `PEACH` | `FFCCAA` |
| Nose | `ACCENT` (pink) | `FF77A8` |
| Eyes | — | the terminal background, showing through |
| Whiskers | `GREY` | `5F574F` |

### Storing the art

Art is stored as **marker strings**, never as pre-coloured spans, so shape and
palette stay one thing each. Exactly one function turns a marker into a glyph
and a colour.

| marker | is | drawn as |
|---|---|---|
| `#` | coat / letterform | `██` in COAT |
| `R` | rosette core | `▓▓` in ROSETTE |
| `r` | rosette edge | `▒▒` in ROSETTE |
| `p` | inner ear | `▒▒` in PEACH |
| `O` | eye, open | two spaces — a hole |
| `_` | eye, blinking | `██` in COAT — the hole closes |
| `n` | nose | `▄▄` in ACCENT |
| `e` | wordmark lip | `▒` in ROSETTE |
| `\` `-` `/` | whisker | `╲` `─` `╱` in GREY |
| `.` | nothing | a space |

Two scales. The mascot is drawn at **2 cells per marker**, because a terminal
cell is about twice as tall as it is wide and a one-cell pixel makes a squashed
cat. The wordmark is already stored at cell resolution — its letterforms are
three cells thick with a half-cell lip, which is what gives them depth — so it
is drawn at **1**. Getting this wrong doubles the wordmark; it has happened.

In Go the art lives in `internal/brand`, in the same marker form:

```go
var CatSit = []string{
    "..##..........##............",
    ".#pp#........#pp#...........",
    "..################..........",
    ".##################.........",
    ".##R##OO####OO##R##.........",
    ".##################.........",
    "-########nn########-........",
    // ...
}

func Ink(m rune) (wide, narrow string, c color.Color)
```

The installer draws the same cat from its own copy of the art (it runs before
the binary exists, so it cannot import it). **A test parses the installer source
and diffs its art, wordmark, tagline and palette against `brand`.** Two copies
of a drawing drift silently; the guard is what makes the duplication safe. It
has caught real drift and must be ported.

---

## 3. Palette

PICO-8's sixteen, plus two greys the original does not have but a terminal
needs. Nothing outside this table is allowed to appear on screen.

| name | hex | means |
|---|---|---|
| `BLACK` | `000000` | ground |
| `DARKGREY` | `2B2825` | agent gutter, inactive chrome |
| `GREY` | `5F574F` | de-emphasis, whiskers, timestamps |
| `INDIGO` | `83769C` | thinking |
| `WHITE` | `FFF1E8` | body text |
| `ACCENT` = `PINK` | `FF77A8` | you, and the one live thing |
| `ORANGE` | `FFA300` | coat |
| `BROWN` | `AB5236` | rosettes, wordmark lip |
| `PEACH` | `FFCCAA` | inner ear |
| `GREEN` | `00E436` | success, tool ok |
| `RED` | `FF004D` | failure |
| `YELLOW` | `FFEC27` | warning — and nothing else |
| `BLUE` | `29ADFF` | links, paths |
| `PURPLE`, `DARKBLUE` | `7E2553`, `1D2B53` | reserved |

### Why the accent is pink, not yellow

Yellow was tried. On a terminal, yellow is the colour of *chrome* — every
prompt, every `WARN`, every `ls` of a directory. An accent that appears
everywhere is not an accent, and worse, it collides with the one thing yellow
must keep meaning: warning. Pink appears nowhere by default, so every pink cell
on screen is one Mnemo put there deliberately.

### Colour on Go

Lip Gloss v2 takes `image/color.Color` and downsamples to the detected profile
(TrueColor → ANSI256 → ANSI → none) on its own. **Do not hand-write ANSI
fallbacks.** Define each colour once as a `lipgloss.Color` and let the library
degrade it.

Background detection is a message, not a global: `tea.RequestBackgroundColor` in
`Init`, `tea.BackgroundColorMsg` in `Update`. Store `isDark` on the model and
pass it to every `DefaultStyles(isDark)` — the v2 Bubbles constructors require
it explicitly rather than sniffing the terminal themselves.

---

## 4. Why Go and Bubble Tea

The Rust TUI works. The reason to leave it is not that ratatui is bad — it is
that a large share of `tui/` is re-implementing things a mature TUI ecosystem
ships, and every one of those re-implementations is ours to maintain and ours to
get wrong.

What the port **deletes outright**:

| Rust, today | replaced by |
|---|---|
| `md.rs` (370 lines) — hand-rolled span-aware wrapping | `ansi.Wordwrap` / `ansi.StringWidth`, plus the v2 viewport's soft wrapping |
| `clipboard.rs` (87) — subprocess `pbcopy`/`xclip`/`wl-copy` | `tea.SetClipboard` (OSC 52 — and it works over SSH) |
| markdown rendering by hand | `glamour` with a Mnemo JSON stylesheet |
| layout arithmetic in `cockpit_ui.rs` | `lipgloss` joins, borders, and the v2 Canvas/Layer compositor |
| mouse hit-testing by row arithmetic | `tea.View.OnMouse` — native, v2 |
| `theme.rs` colour downsampling | Lip Gloss colour profile |
| the `PaneView` trait | `tea.Model` already is that trait |
| spinner, list, table, textarea, viewport, help, key-map | `bubbles` |

What the port **keeps as real domain logic**, because it is Mnemo's and not any
framework's: the pi RPC client, the memsrv client, session discovery and
resume, auth and model listing, and the brand art.

The ecosystem, pinned:

| module | why |
|---|---|
| `charm.land/bubbletea/v2` | the loop. v2's Cursed Renderer (ncurses-derived) plus synchronized output (DECSET 2026) removes tearing |
| `charm.land/lipgloss/v2` | styling, layout, and the Canvas / Layer / Compositor for overlays |
| `charm.land/bubbles/v2` | textarea, viewport, list, table, spinner, help, key |
| `charm.land/glamour/v2` | markdown, styled from JSON |
| `charm.land/log/v2` | structured logs into the Logs overlay |
| `github.com/charmbracelet/harmonica` | spring motion for the overlays |
| `github.com/charmbracelet/x/ansi` | width, wrap, truncate — all ANSI- and wide-char-aware |
| `github.com/charmbracelet/x/exp/teatest/v2` | golden-file tests over the real program |

**Not** `bubblezone`. It solved mouse hit-testing before Bubble Tea had it;
v2's `View.OnMouse` does it natively, and bubblezone's own README warns it may
not work under the Lip Gloss v2 compositor. One dependency avoided.

---

## 5. Architecture

The Elm loop, one root model, messages down and up. No shared mutable state, no
callbacks into the view.

```
main.go
internal/
  brand/      markers, Ink, wordmark, walk cycle, splash
  theme/      the palette, styles, glamour stylesheet
  chat/       transcript: blocks, folding, focus, search
  prompt/     textarea, history, queue and steer
  cmdpal/     the command palette
  overlay/    sessions · memory · logs · help
  rpc/        pi RPC client over line-delimited JSON (ported)
  memsrv/     memory-layer client (ported)
  session/    discovery, resume (ported)
  auth/       login, provider and model listing (ported)
app/
  model.go    the root Model
  update.go   the message switch
  view.go     compose header · transcript · prompt · status
  keys.go     the single key-map, source of truth for `?`
```

The root model is small on purpose — everything else is a sub-model that owns
its own state:

```go
type Model struct {
    mode      Mode          // Insert | Read | Overlay
    chat      chat.Model
    prompt    prompt.Model
    overlay   overlay.Model  // nil when none is up
    keys      KeyMap
    isDark    bool
    w, h      int
    agent     agentState    // idle | thinking | tool | error
}
```

Long-running work — pi RPC, memsrv, tool output — arrives as messages from
`tea.Cmd` goroutines. **Nothing blocks `Update`.** Streaming tokens arrive as
`StreamDeltaMsg` and are appended to the open block.

`View()` returns a `tea.View`, not a string. That is where alt-screen, mouse
mode, window title, cursor position and shape are *declared* rather than
commanded:

```go
func (m Model) View() tea.View {
    v := tea.NewView(m.compose())
    v.AltScreen = true
    v.MouseMode = tea.MouseModeAllMotion
    v.WindowTitle = m.titleForSession()
    v.Cursor = m.prompt.Cursor()   // nil in Read mode — no cursor, no ambiguity
    v.OnMouse = m.onMouse
    return v
}
```

Hiding the cursor in Read mode is not cosmetic: it is how you know, without
reading the status line, that typing will not go into the prompt.

---

## 6. The surface: one screen, not six panes

**This is the part of the rebuild the current TUI most needs.**

Today there is a rail of six panes — Chat, Sessions, Agents, Memory, Skills,
Logs — cycled with Tab. Two problems, both fatal:

1. **A rail of six nouns is a menu of six guesses.** "Agents" and "Sessions" tell
   you nothing about what is inside or why you would open them.
2. **They are not co-equal.** lazygit can justify panes because a git repo has
   several concerns you hold at once. An agent session has one: the
   conversation. You are reading the transcript ~95% of the time, and paying
   three Tab presses to reach memory is three too many.

So: **one surface, four overlays, no rail.**

```
┌────────────────────────────────────────────────────────────────────┐
│ ▞▚ mnemo   ~/self-evolving-agent   deepseek-v4-flash   session 4   │  header, 1 line
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  ▊ can you make the resume flow real                               │  transcript
│                                                                    │  (viewport,
│  · thinking  ░▒▓█▓▒░                                               │   soft-wrapped)
│                                                                    │
│  │ I'll look at how pi stores sessions first.                      │
│                                                                    │
│  ● read  tui/src/sessions.rs                             ▸ 40 ln   │
│  ● 2 sub-agents  ─ probe-rpc · read-jsonl                ▸         │
│                                                                    │
├────────────────────────────────────────────────────────────────────┤
│ ▊ ▏                                                                │  prompt, grows
├────────────────────────────────────────────────────────────────────┤
│ enter send · esc read · ^k palette      12 mem · 2 agents · 4.1k ↑ │  status
└────────────────────────────────────────────────────────────────────┘
```

**What happened to the six panes:**

| was | is now |
|---|---|
| Chat | the surface itself |
| Sessions | overlay, `^s` — a resume picker, which is the only thing anyone ever wanted from it |
| **Agents** | **deleted.** Sub-agent runs are *events in the conversation*, so they are foldable blocks in the transcript, where they happened |
| Memory | overlay, `^m` |
| Skills | a section of the command palette. It was a list you read once |
| Logs | overlay, `^l` |

Deleting the Agents pane also deletes a bug class it kept producing: because
every pi session wrote an episode, the pane listed 45 rows of
`pi session 2026-08-25T03:23:42Z` and claimed "45 episodes · 21 running". A root
that delegated to nobody is a session, not an agent. Inline blocks cannot make
that mistake — a block exists only if a delegation happened.

**The status line replaces what the rail's badges were for.** Counts belong in
one always-visible line, not scattered across six tabs you must visit to read.
It shows: current mode's most useful keys on the left; live counts on the right
(memories written this session, sub-agents running, tokens). A zero is shown,
not hidden — "no memories yet" is information.

### Overlays

An overlay is a Lip Gloss `Layer` composited over a dimmed transcript, centred,
at most 80% of each dimension, entering with a Harmonica spring (a 90ms
overshoot on scale, not a fade — fades in a terminal are just colour steps and
look like a redraw bug). Every overlay:

- is dismissed by `esc`, always, with no confirmation;
- has a one-line **purpose** at the top, in the reader's words;
- when empty, says what will appear here and the concrete thing that causes it —
  never "(no episodes)";
- is filterable by typing, with no mode change.

The four:

**`^k` Command palette.** Fuzzy over one flat list: slash commands, skills,
recent files, sessions, model switch, every keybinding. This subsumes discovery
for the entire app — if you can do it, typing part of its name here finds it.
It is the answer to "I don't know what this thing can do", which no rail of
nouns can be.

**`^s` Sessions.** Resume. Rows are `when · first user message · turns · model`.
The first message is the only reliable name a session has; a timestamp is not a
name. `enter` resumes, `d` deletes, `n` starts fresh.

**`^m` Memory.** Rows sorted by **fact count, newest as tie-break** — sorting by
id buried every real fact under thirty empty `pi session … 0 facts` rows.
`enter` expands one to its facts; `/` searches; `d` forgets, with a confirm,
because that one *is* destructive.

**`^l` Logs.** `charm.land/log` output, level-filtered with `1`–`4`, `/` to
search, `f` to follow the tail. This is where a failing tool call explains
itself.

---

## 7. Keys

Three modes and one rule for leaving them: **`esc` always goes up one level.**

Discoverability is not left to a manual: the status line always names the
current mode's four most useful keys, and `^k` finds any of them by name.

### Insert (the default — you land here)

| key | does |
|---|---|
| *any character* | types into the prompt |
| `enter` | send — or **queue**, if the agent is busy |
| `alt+enter` | **steer**: interrupt what the agent is doing with this |
| `shift+enter` | newline |
| `tab` | complete slash command or file path |
| `↑` / `↓` | prompt history, when the prompt is empty or one line |
| `esc` | → Read mode |

### Read (`esc` from Insert)

The cursor disappears, so the mode is visible without reading anything.

| key | does |
|---|---|
| `j` / `k` | line down / up |
| `^d` / `^u` | half page |
| `g` / `G` | top / bottom |
| `J` / `K` | **next / previous block** — the useful movement, since a transcript is a list of blocks, not of lines |
| `enter` / `space` | fold or unfold the focused block |
| `t` | show / hide all tool blocks at once |
| `y` | yank the focused block · `Y` yanks the whole transcript |
| `/` then `n` / `N` | search, next, previous |
| `?` | help |
| `esc` | → Insert |

### Global (Insert and Read both)

| key | does |
|---|---|
| `^k` | command palette |
| `^s` `^m` `^l` | sessions · memory · logs |
| `^o` | fold/unfold the newest block without leaving Insert |
| `^c` | interrupt the agent; again within 2s quits |
| `^d` | quit (only on an empty prompt) |

Bindings live in one `KeyMap` struct built with `bubbles/key`. `?` and the
palette both render *from that struct*, so a binding cannot exist without being
documented — the help can never drift from the code.

---

## 8. Who is speaking: the gutter

Two cells at the left of every line. This is the only speaker marker; there are
no name labels, no boxes, no timestamps in the flow.

| gutter | colour | who |
|---|---|---|
| `▊ ` | `ACCENT` | you |
| `│ ` | `DARKGREY` | Mnemo |
| `· ` | `INDIGO` | thinking |
| `● ` | GREEN ok / RED failed / ACCENT running | a tool call |

A box around every message costs two columns and two rows per message and says
nothing a two-cell gutter does not. **Wrapped lines keep the gutter**, indented
by its width — a continuation that starts at column 0 reads as a new speaker.

---

## 9. Folding

Thinking and tool blocks arrive collapsed to one line: a verb, its subject, and
a result count.

```
● read  tui/src/sessions.rs                                    ▸ 40 ln
● bash  cargo test -p seatui                                   ▸ 213 ok
● 2 sub-agents  ─ probe-rpc · read-jsonl                       ▸
```

`▸` means there is more; `▾` means it is open. A block is worth opening only if
its one-line summary is honest, so the summary always carries the *result*, not
just the invocation — `▸ 213 ok` tells you not to open it.

Sub-agent blocks nest: open one and its children are blocks with the same
grammar, indented. This is why the Agents pane is not needed.

Folding state is per-block and survives scrolling; `t` toggles every tool block
at once for when you want the shape of a long session at a glance.

---

## 10. Motion

Three animations, and nothing else moves.

**Thinking — the dither wave.** A five-step density ramp,
`[' ', '░', '▒', '▓', '█']`, running as a wave along the thinking line. Same
ramp as the cat's rosettes: one vocabulary, used twice. It reads as *work in
progress* rather than *loading*, and it degrades to a monochrome terminal
without losing meaning, because density is the signal, not colour.

**Tool running — the spinner.** `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` at 80ms, from `bubbles/spinner`.

**Overlays — a spring.** `harmonica.NewSpring(harmonica.FPS(60), 6.0, 0.5)`
driving the overlay's height as it opens. A spring, not a linear tween, because
a slight overshoot is what makes a panel feel like it *arrived* rather than
having been drawn.

Motion stops when work stops. An idle Mnemo is a still screen — a TUI that
animates while nothing is happening is a TUI that burns a laptop battery to
look busy. `NO_COLOR`, a non-TTY, or `CI` disables all three.

---

## 11. The prompt: send, queue, steer

The agent is often mid-turn when you think of the next thing. There are two
different intentions and they need two different keys:

- **`enter` — queue.** "When you're done, do this next." The prompt clears, the
  text is stacked under the prompt as a dim numbered line, and it is sent
  automatically when the turn ends. `^x` drops the last queued item.
- **`alt+enter` — steer.** "Stop and take this into account now." The current
  turn is interrupted and the text is delivered immediately.

The distinction is the whole feature. Anything that silently picks one is wrong
half the time, so the status line names which key does which whenever the agent
is busy and the prompt is non-empty.

The prompt is a `bubbles/textarea`: it grows from 1 to 6 lines and then scrolls,
and it soft-wraps. Bracketed paste arrives as `tea.PasteMsg`, so a multi-line
paste never fires `enter` — a real bug class in hand-rolled prompts.

---

## 12. Mouse, selection, copy

Mouse mode is declared in the view (`v.MouseMode = tea.MouseModeAllMotion`) and
hit-tested in `v.OnMouse`, natively. No zone-marker library.

| gesture | does |
|---|---|
| click a fold header | fold / unfold |
| wheel | scroll the transcript |
| click a path in a tool result | opens `$EDITOR` at that line |
| drag | select — see below |

**The terminal's own selection must keep working.** A TUI in alt-screen with
mouse tracking on steals drag-select, which is the gesture every terminal user
already has. So: **`^g` toggles mouse reporting off**, the status line says so,
and the terminal's native select-and-copy comes back untouched. Copying is the
one thing a user must never be locked out of.

Inside the app, `y` yanks the focused block via `tea.SetClipboard` — OSC 52,
which crosses SSH, unlike a `pbcopy` subprocess.

---

## 13. Markdown

Rendered by `glamour` with a Mnemo JSON stylesheet in `internal/theme`, so
markdown styling and the palette are the same source. Code blocks are
syntax-highlighted, wrapped to the viewport width less the gutter, and never
horizontally scrolled — a horizontally scrolling code block in a chat log is
unreadable.

**Wrap before you slice.** The transcript is tail-anchored: it takes the last
*N* rows. If a logical line silently becomes three rows at render time, the two
newest rows fall off the bottom of the screen. So every block is wrapped to the
final width *before* the viewport takes its slice. This exact bug shipped in the
Rust TUI; it is the reason `md.rs` exists, and the reason the Go version wraps
through `ansi.Wordwrap` at model level rather than trusting the renderer.

---

## 14. Testing

The Rust TUI has 213 tests. The port does not ship until it has an equivalent,
and "equivalent" means the same *properties*, not the same count.

- **Golden files** over the whole program, with `teatest/v2` +
  `x/exp/golden`: send keys, capture the final frame, diff. This covers layout,
  wrapping and colour together, which unit tests over a model do not.
- **Model tests** for the logic that has an answer independent of pixels:
  folding, focus movement, queue/steer, memory sorting, session parsing.
- **Width sweeps.** Render the transcript at 40, 60, 80, 120, 200 columns and
  assert no row exceeds the width. This is the overflow bug as a test.
- **The brand drift guard**, ported: parse the installer's source, diff its art
  against `internal/brand`.
- **Golden files are checked in and reviewed as design.** A diff in a golden
  file is a visual change; if nobody can say why it changed, it is a bug.

---

## 15. Migration

Port in this order. Each step ends green and is pushed.

1. **Scaffold + brand.** Go module, `internal/brand` + `internal/theme`, splash
   and walk cycle, drift guard. Verifies the palette and the art before anything
   depends on them.
2. **The shell.** Root model, three modes, header/transcript/prompt/status,
   key-map, `?` rendered from it. Golden files at five widths.
3. **Transcript.** Blocks, gutters, folding, focus, search, glamour, wrap-before-
   slice. The width sweep lands here.
4. **Ports.** `rpc`, `memsrv`, `session`, `auth` — straight translations of
   working Rust, each with the Rust test cases carried over.
5. **Live agent.** Streaming, queue and steer, interrupt, sub-agent blocks.
6. **Overlays.** Palette, sessions, memory, logs.
7. **Mouse, clipboard, `^g`.**
8. **Onboarding + installer** cut over; the Rust binary is retired only when
   `mnemo-agent` in Go passes the same acceptance run.

Both binaries coexist until step 8. `tui/` is not deleted in step 1.

---

## 16. Risks, stated plainly

- **Go is not installed on this machine.** `go version` → `command not found`.
  Step 0 is installing a toolchain; nothing above has been compiled.
- **Charm v2 is young.** Bubble Tea, Lip Gloss and Bubbles v2 shipped
  2026-02-23 — the first breaking release in six years. Expect thin
  third-party examples and some v1-era blog posts that no longer compile. Pin
  exact versions; do not track `latest`.
- **`teatest` lives in `x/exp`.** Explicitly experimental. If its API moves, the
  golden harness moves with it.
- **213 tests must be re-earned, not counted.** A port that lands with 40 tests
  and a green CI is a regression wearing a checkmark.
- **The Rust TUI is what `install.ts` ships today.** Release, packaging and the
  installer's art guard all change in step 8, not before.
- **This buys maintainability, not features.** The port on its own adds nothing
  a user can see. The parts a user *can* see — one surface instead of six panes,
  the command palette, queue/steer, real folding — are design decisions in this
  document, and could in principle be made in Rust. The case for Go is that
  sections 4's deletion table is roughly 1,500 lines of our code replaced by
  library code that is already tested.

---

## 17. Adding to this

Before adding a colour: which of the fourteen already means this? Before adding
a glyph: is it in the box-drawing or block range, and does it survive a
monochrome terminal? Before adding an animation: is it reporting work, or
decorating a wait?

Before adding a pane: it is an overlay. Before adding an overlay: it is probably
a palette entry.

And before adding a key: put it in the `KeyMap`, or `?` will lie.
