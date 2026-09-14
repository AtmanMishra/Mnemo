# DESIGN.md — the Mnemo TUI

How `mnemo-agent` looks, why it looks that way, and where to change it.

**Status: built.** The Go / Bubble Tea interface lives in `tui-go/` and runs:
`go run ./cmd/mnemo`. The Rust build in `tui/` still ships and is not deleted
until the Go one passes the same acceptance run. Section 15 tracks what is
done and section 16 what is not.

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
| `charm.land/glamour/v2` | markdown, styled from JSON — **planned, not in yet** |
| `charm.land/log/v2` | structured logs — **planned; the Logs overlay reads the span log directly** |
| `github.com/charmbracelet/harmonica` | spring motion — **planned, not in yet** |
| `github.com/charmbracelet/x/ansi` | width, wrap, truncate — all ANSI- and wide-char-aware |
| `github.com/charmbracelet/x/exp/teatest/v2` | golden-file tests — **planned; the suite composes frames directly instead** |

**Not** `bubblezone`. It solved mouse hit-testing before Bubble Tea had it;
v2's `View.OnMouse` does it natively, and bubblezone's own README warns it may
not work under the Lip Gloss v2 compositor. One dependency avoided.

---

## 5. Architecture

The Elm loop, one root model, messages down and up. No shared mutable state, no
callbacks into the view.

```
cmd/mnemo/       the binary, and --dump
app/             the root model: model.go · update.go · view.go
internal/
  theme/         the palette, glyphs, styles
  brand/         Nyx and the wordmark, as marker strings
  ui/            chrome: rules, bands, chips
  tree/          one hierarchical list, used four times
  chat/          the transcript: blocks, folding, focus, wrapping
  prompt/        input, history, queue
  overlay/       one modal contract
  keymap/        every binding
  session/       pi's stored sessions, and replaying one
  trace/         the span log as a call graph
  memory/        memsrv over line-JSON-RPC
  filetree/      a directory as tree nodes, lazily
  agent/         the backend boundary
  pi/            pi's RPC behind it
```

The root model is small on purpose — everything else is a sub-model that owns
its own state:

```go
type Model struct {
    cfg  Config          // Home, CWD, Agent, memsrv paths — never lookups
    th   *theme.Theme
    keys keymap.Map
    mode keymap.Mode     // Insert | Read | Browse

    chat     *chat.Model
    prompt   *prompt.Model
    explorer *tree.Model
    ov       *overlay.Model   // nil when the transcript has the screen

    agent   agent.Agent
    working bool
    tick    int
}
```

`Config` carries `Home` and `CWD` as fields rather than calling
`os.UserHomeDir`, so a test can point the entire program at a temporary
directory. A forgotten home parameter has caused real bugs here: the test then
reads the developer's actual `~/.pi` and passes for the wrong reason.


Everything the interface knows about the backend is `agent.Agent`: five methods
and a handful of messages. That is what lets the backend be replaced — a live
pi RPC process, a replayed session file, nothing at all — without the
transcript, the keys or the layout knowing.

`Next()` is the one method worth explaining. The backend drives the loop by
being **asked for its next message** rather than by holding a reference to the
program, and every branch that handles an agent message re-arms it. Forgetting
to re-arm once stops the stream dead with no error anywhere, so there is
exactly one place that does it.

`View()` returns a `tea.View`, not a string. That is where alt-screen, mouse
mode, window title, cursor position and shape are *declared* rather than
commanded:

```go
func (m *Model) View() tea.View {
    v := tea.NewView(m.compose())
    v.AltScreen = true
    v.WindowTitle = "mnemo · " + m.relCWD()
    if m.mouse {
        v.MouseMode = tea.MouseModeCellMotion
    }
    if m.mode == keymap.Insert && m.ov == nil && !m.explorerFocus {
        v.Cursor = m.promptCursor()   // nil everywhere else
    }
    return v
}
```

Hiding the cursor in Read mode is not cosmetic: it is how you know, without
reading the status line, that typing will not go into the prompt.

---

## 6. The surface: one screen, not six panes

**This is the change the rebuild exists for.**

The Rust build has a rail of six panes — Chat, Sessions, Agents, Memory,
Skills, Logs — cycled with Tab. Two problems, both fatal:

1. **A rail of six nouns is a menu of six guesses.** "Agents" and "Sessions" tell
   you nothing about what is inside or why you would open them.
2. **They are not co-equal.** lazygit can justify panes because a git repo has
   several concerns you hold at once. An agent session has one: the
   conversation. You are reading the transcript ~95% of the time, and paying
   three Tab presses to reach memory is three too many.

So: **one surface, one optional side pane, five overlays, no rail.**

```
▚ MNEMO ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ ~/self-evolving-agent/tui-go ▌ offline
━━╾ TRANSCRIPT · 1 THINKING HIDDEN · ^E ╼━━━━━━━━━━━━━━━━━━━━┃━━╾ EXPLORER ╼━━━━━━━━━━━━━━━━
● resumed · hi · deepseek-v4-flash                           ┃▌▾ tui-go                     
                                                             ┃   ├─▸ app                    
▊ hi                                                         ┃   ├─▸ cmd                    
                                                             ┃   ├─▸ internal               
· ▸ thinking                                                 ┃   ├─  README.md            3k
                                                             ┃   ├─  go.mod               1k
│ Hi! I'm ready to help with whatever you're working on in   ┃   └─  go.sum               4k
  the `tui` project. What can I do for you?                  ┃                              
                                                             ┃                              
                                                             ┃                              
                                                             ┃                              
                                                             ┃                              
                                                             ┃                              
                                                             ┃                              
▊ ask, or press ^k                                                                          
 EXPLORER  ▌ explorer · enter puts a path in the prompt · esc back                          
```

That is a real frame, printed by `--dump`, not a sketch. The header band
travels while the agent works and is still when it is not; the region rule
names what is under it and, here, that one thinking block is collapsed and
`^e` opens it; the explorer is on the right because `^t` was pressed, and it
took focus in the same press.

**What happened to the six panes:**

| was | is now |
|---|---|
| Chat | the surface itself |
| — | **new:** the folder explorer, `^t`, on the right |
| Sessions | overlay, `^s` — a resume picker, which is the only thing anyone ever wanted from it |
| **Agents** | **deleted.** Sub-agent runs are *events in the conversation*, so they are foldable blocks in the transcript, where they happened |
| Memory | overlay, `^m` |
| Skills | gone for now. It was a list you read once; when it returns it is a palette section, not a pane |
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

An overlay **replaces the body region** and draws its own labelled rule. Not a
floating layer: the compositing version is a later change to one function, and
a half-hidden transcript behind a panel is harder to read than no transcript.
Every overlay:

- is dismissed by `esc`, always, with no confirmation;
- has a one-line **purpose** at the top, in the reader's words;
- when empty, says what will appear here and the concrete thing that causes it —
  never "(no episodes)";
- filters: a flat list as you type, a tree from `/` — so `j`/`k`/`h`/`l` keep
  working in a hierarchy, and a palette needs no keystroke to arm it.

The four:

**`^k` Command palette.** Fuzzy over one flat list: slash commands, skills,
recent files, sessions, model switch, every keybinding. This subsumes discovery
for the entire app — if you can do it, typing part of its name here finds it.
It is the answer to "I don't know what this thing can do", which no rail of
nouns can be.

**`^s` Sessions.** Project → session → the sub-agents under it. A session is
named by its **first user message**, because a timestamp is not a name, and the
project you are standing in opens itself. `enter` on a session replays the
whole conversation through the same blocks a live turn uses — a summary card
would make resuming feel like opening a receipt rather than picking a
conversation back up.

**`^m` Memory.** Brain area → memory → its facts, sorted by **fact count**,
newest as tie-break. Against the real journal that is five memories that know
something above forty-seven empty `pi session …` episodes; by id it was the
other way round, which is precisely what made the old pane useless. An area
that knows nothing starts closed, and a memory's facts are fetched only when it
is opened. Read-only for now.

**`^l` Logs.** The span log as the tree it already is: every span carries a
parent, so this is the **call graph of a run**, not a flat scroll — the only
view where a slow turn shows you which call was slow. Branches containing a
failure open themselves; everything else stays closed. A span whose parent was
rotated out of the log is collected under "unlinked" rather than dropped
(which loses failures) or hung at the top (which makes it look like a session
it is not).

---

## 7. Keys

Three modes and one rule for leaving them: **`esc` always goes up one level.**

Global chords are dispatched **before any surface sees the key**, so nothing
can swallow `^k` and strand you — a test presses every chord from every mode.
Discoverability is not left to a manual: the status line always names the
current mode's most useful keys, and `^k` finds any of them by name.

### Global — live in every mode

| key | does |
|---|---|
| `^e` | **open every thinking block in the transcript.** One press |
| `^r` | the same for tool blocks · `^a` for everything |
| `^t` | folder explorer on the right — **and focuses it** |
| `^s` | sessions: project → session → the sub-agents under it |
| `^m` | memory: brain area → memory → its facts |
| `^l` | logs: every run as a call graph |
| `^k` | the palette — run anything by name |
| `^h` | every key, generated from the table the program dispatches on |
| `^g` | mouse reporting off; drag-select is the terminal's again |
| `^c` | interrupt the agent; again within 2s quits |
| `^d` | quit, on an empty prompt |
| `esc` | up one level |

`^e` is the key the whole rebuild is organised around. Reading a long turn
meant opening eight thinking blocks one at a time — eight keystrokes to answer
one question. Partial state completes to all-open rather than inverting each
block, so the key always finishes the job, and the region rule advertises how
many are hidden: **a reader who cannot see that blocks are collapsed does not
know there is anything to open.**

### Insert — where you land

| key | does |
|---|---|
| *any character* | types into the prompt |
| `enter` | send — or **queue**, if the agent is busy |
| `alt+enter` | **steer**: interrupt what it is doing with this |
| `^j` | newline |
| `↑` / `↓` | prompt history, on a single-line prompt |
| `esc` | → Read |

### Read — `esc` from Insert

The cursor disappears, so the mode is visible without reading anything.

| key | does |
|---|---|
| `j` / `k` | line down / up · `^d` / `^u` half page · `g` / `G` ends |
| `J` / `K` | **next / previous block** — a transcript is a list of blocks |
| `enter` | fold or unfold the focused block |
| `y` / `Y` | copy this block · the whole transcript |
| `i` | back to the prompt |

### Browse — a tree under the hand

The explorer and the tree overlays share one key table, because they are one
model.

| key | does |
|---|---|
| `l` | open, then go deeper |
| `h` | **close, or jump to the parent** |
| `E` / `C` | expand / collapse the whole tree |
| `enter` | on a container: open it **and step inside**, one press. On a leaf: use it |
| `/` | filter — matches keep their ancestors, so the hierarchy still reads |

`h` is the move that saves the most keystrokes in a deep tree: leaving a
subtree is one press, not "up, up, up, left". And `enter` descends in one press
rather than two, because expanding and then pressing again to get inside does
nothing the reader asked for.

Bindings live in one `KeyMap`. `^h` and the palette both render **from that
struct**, so a binding cannot exist without being documented.

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

Three things move, and only while there is work to report.

**The header band.** The dither ramp travels along the top of the screen while
the agent is working, and is a single still step of the same ramp when it is
not. It is the largest motion cue on screen and it costs no row of its own.

**A running tool call.** Its gutter is a braille spinner at 80ms, not a dot. A
static dot on a call that is still out looks exactly like a call that
finished, which is the difference between waiting and being stuck.

**A thinking block still filling.** It draws the ramp beside its title —
density travelling left to right reads as *work in progress*, where a spinner
reads as *loading*.

The other half of motion is stopping it. A turn that ends, or is interrupted,
**clears every running marker**: a spinner nobody stops is a UI that looks
hung. A tool still open when the turn ended is marked failed with "no result",
never ok — it never reported back, and saying ok would be inventing an outcome.

Idle is a still screen. The animation timer only runs while the agent is
working; a TUI that animates while nothing is happening is burning a battery to
look busy.

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

Mouse mode is declared in the view (`v.MouseMode`) rather than commanded, and
would be hit-tested in `v.OnMouse` natively — no zone-marker library. The
row-to-block mapping exists and is tested (`chat.BlockAtRow`); nothing calls it
yet. Click-to-fold and wheel scrolling are in section 16.

**The terminal's own selection must keep working.** A TUI in alt-screen with
mouse tracking on steals drag-select, which is the gesture every terminal user
already has. So: **`^g` toggles mouse reporting off**, the status line says so,
and the terminal's native select-and-copy comes back untouched. Copying is the
one thing a user must never be locked out of.

Inside the app, `y` yanks the focused block via `tea.SetClipboard` — OSC 52,
which crosses SSH, unlike a `pbcopy` subprocess.

---

## 13. Wrapping

**Wrap before you slice.** The transcript is tail-anchored: it takes the last
*N* rows. If a logical line silently becomes three rows at render time, the two
newest rows fall off the bottom of the screen. So every block is wrapped to the
final width *before* the viewport takes its slice.

This exact bug shipped in the Rust build. Wrapping goes through `ansi.Wordwrap`
at model level rather than trusting the renderer, and the width sweep — render
at 20, 40, 60, 80, 120 and 200 columns, assert no row exceeds the width — is
the regression as a test.

Wrapped lines keep the gutter column. A continuation that starts at column 0
reads as a new speaker.

Markdown is **not** rendered yet: text is wrapped and coloured, not styled.
`glamour` with a Mnemo JSON stylesheet is the plan and is listed in section 16
as outstanding, not described here as if it existed.

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

## 15. What is built

`tui-go/`, twenty packages, 406 passing tests, `go vet` clean.

| package | owns |
|---|---|
| `internal/theme` | the palette, the glyphs, the styles. Nothing else names a colour |
| `internal/brand` | Nyx and the wordmark, as marker strings; one `Ink()` turns a marker into a glyph and a colour |
| `internal/tree` | one hierarchical list, used four times: folders, sessions, memory, logs |
| `internal/chat` | the transcript: blocks, folding, focus, wrapping, search |
| `internal/ui` | chrome: rules, bands, chips. Holds no state |
| `internal/keymap` | every binding; help and the palette render from it |
| `internal/overlay` | one modal contract: purpose line, filter, empty state |
| `internal/session` | pi's stored sessions, and replaying one |
| `internal/trace` | the span log, as the call graph it already is |
| `internal/memory` | memsrv over line-JSON-RPC |
| `internal/filetree` | a directory as tree nodes, lazily |
| `internal/prompt` | input, history, and the queue |
| `internal/command` | one command list: built-ins, skills, plugin skills, harness bundles, and the agent's own |
| `internal/markdown` | glamour rendering, cached by content and width |
| `internal/agent` + `internal/pi` | the backend boundary, and pi's RPC behind it |
| `internal/auth` | the key store and the model catalogue |
| `app` | the root model: three modes, one screen |

**One tree, four uses** is the modularity that matters. Folders, sessions,
sub-agents, memories and spans are all the same shape, so they share one model,
one key table and one renderer. A fifth hierarchy costs a `[]*tree.Node`.

`home` and `cwd` are configuration on `app.Config`, never lookups, so no test
can read — or write — the developer's real `~/.pi` or `~/.mnemo`. The memsrv
binary and its journal are parameters for the same reason.

`--dump` renders one frame to stdout, optionally after pressing keys
(`--keys "ctrl+t,down,l"`). A TUI cannot be screenshotted from a script, and
"it looked right when I ran it" is not a check anybody else can repeat.

## 16. What is not built

Stated plainly, because a design document that describes intentions as
features is worse than no document. (This section is kept current: everything
that used to be listed here — markdown rendering, floating overlays with a
compositor, transcript search, memory forget with confirmation, the onboarding
and auth flow, and the golden-frame tests — is built, and the ledger is
corrected rather than preserved.)

- **Mouse works only as a way out.** `^g` hands selection back to the terminal;
  wheel and click do not fold blocks or move focus. `chat.BlockAtRow` exists and
  is tested; nothing calls it. The open question is whether in-app clicks are
  worth losing the terminal's own drag-select.
- **One palette, no picker.** The theme is a value and every pane follows it, but
  nothing lets you choose a second one at runtime — see §18 for where that would
  go.
- **No dockable panes.** Sessions, memory and logs are overlays. Columns are a
  design option, not an implementation gap.
- **Golden frames pin text, not colour.** The four frames catch overflow,
  wrapping and layout; a palette regression is not caught by them.
- **Session branching, fork and compaction are not surfaced in the Go UI**, even
  though pi supports them and the sessions browser reads their records.
- **Charm v2 is young.** Versions are pinned; do not track `latest`.
- **The mascot cannot be posed.** One sitting cat, one four-frame walk, and the
  walk only runs during install and onboarding. §18 and `docs/mascots.md`
  propose the lighter alternatives.

## 17. Adding to this

Before adding a colour: which of the fourteen already means this? Before adding
a glyph: is it in the box-drawing or block range, and does it survive a
monochrome terminal? Before adding an animation: is it reporting work, or
decorating a wait?

Before adding a pane: it is an overlay. Before adding an overlay: it is probably
a palette entry.

And before adding a key: put it in the `KeyMap`, or `?` will lie.

## 18. Direction — the Greek/Roman layer

**Status: proposal, nothing here is implemented.** Two artefacts exist so this
can be decided by looking rather than by reading hex codes:

- **`docs/design-preview.html`** — the whole of this document, rendered: the
  palette, the wordmark, the glyph set, the motion vocabulary, and the mascot
  candidates, with the surface re-skinned live. It carries five palette presets
  (PICO-8, Greek pottery, marble &amp; wine, bronze age, wine-dark sea) and every
  swatch is editable in place, so "what if the accent were oxblood" is a five
  second question instead of a branch.
- **`docs/mascots.md`** — five mascot candidates (owl, tortoise, serpent, bee,
  amphora) in the same marker language as Nyx, each with drawn and marker art,
  plus the rules they keep and what adopting one costs.

The name already points here: **Mnemo** from *Mnemosyne*, memory personified
and mother of the Muses. The interface currently speaks PICO-8 — a game
console's palette and its pixel grammar — which is a coherent register and not
an accident, but it is not the register the name is from. The layers below are
independent; each can be adopted alone, and the first is nearly free.

| layer | now | proposal |
|---|---|---|
| palette | PICO-8: black ground, pink accent, orange coat | pottery: black gloss ground, terracotta slip ink, ochre for warning, oxblood for failure, olive for success. **A palette swap is one struct in `theme.go`; every pane follows, because nothing else names a colour** |
| chrome | heavy box-drawing rules | a **meander** (Greek key) alternation for the outer rule and a **laurel** divider for section heads — one glyph string per role, no layout change |
| words | blocks, gutter, band, overlay | code names stay; user-visible labels take the classical register — *agora* for the palette, *scroll* for the transcript, *amphora* for the memory pane, *oracle* for the model, *stoa* for the sessions browser |
| memory areas | Episodic, Semantic, Procedural, Spatial, Salience, Executive | code names stay; the Memory overlay shows the Muses instead — Calliope (episodes), Clio (facts and history), Polyhymnia (procedure), Urania (spaces), Melpomene (pain markers), Thalia (executive) |
| mascot | Nyx, 56 cells, four tones, a walk cycle | one of the five candidates; the cat can remain as a rare, larger cameo |
| voice | lowercase, no exclamation marks, states facts | unchanged. The restraint *is* the classical register — a temple does not shout |

**What must not change, whatever the register:** fourteen colours and no more;
eyes as negative space; exactly one accent-coloured run per mascot; no Nerd
Fonts; the accent never takes a colour the terminal already uses for its own
chrome (that is why yellow is warning and not the accent); and every colour is a
formal role rather than a hue, so a second palette stays a value and not a
rewrite.

**A theme picker is the natural home for this** (§16): `theme.New(p, g, isDark)`
already takes the palette as an argument, so a picker is a list of `Palette`
values and one key binding — the missing piece is a place to persist the choice
(`~/.mnemo/theme.json`), not any machinery.
