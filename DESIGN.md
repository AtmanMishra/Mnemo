# DESIGN.md — the Mnemo TUI

How `mnemo-agent` looks, why it looks that way, and where to change it.

The rules here are not preferences. Each one exists because the alternative
was tried, or because a terminal makes the alternative actively worse. If you
break one, say why in the code.

---

## 1. The one idea

**Colour is state. Shape is identity. Motion is progress.**

Nothing in this UI is decorated. If something is pink, that is a claim about
what it *is*. If something moves, work is happening. If nothing is happening,
the screen is still.

This is the PICO-8 constraint applied to a terminal: a small fixed palette, a
small fixed glyph vocabulary, and no gradients, no shadows, no italics. The
limit is the design. It also degrades honestly — every glyph used here is in
the standard box-drawing and block ranges, so it renders on a plain monospace
font with no patched icons.

---

## 2. The brand

### The name

**Mnemo** — from *Mnemosyne*, the Greek personification of memory and mother of
the Muses. Lowercase in prose (`mnemo-agent` is the command), uppercase in the
wordmark. Never "Mnemo AI", never a tagline bolted onto the name.

The tagline is one line, lowercase, no exclamation mark:

> memory that works like a brain

### The wordmark

Five letters, block-built, strokes three cells thick, with a half-cell lip
down and to the right that gives depth without spending a second colour:

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

The lip is drawn in ROSETTE brown, not grey — it is the same ink as the
mascot's markings, which is what makes the logo and the cat look related
rather than merely adjacent.

### Nyx, the Bengal cat

The mascot is a **Bengal cat**, and the breed is the point.

A Bengal's defining feature is the **rosette**: a two-toned spot with a dark
ring and a lighter centre, *clustered* rather than evenly scattered. TICA's
breed standard prefers rosettes over single spots and asks for "extreme"
contrast against the ground colour.

That is a fair description of Mnemo's memory graph — marks that mean something
as a cluster and nothing individually, with sharp boundaries between them. The
mascot is this breed because of what the pattern is, not because cats are
appealing.

The other breed signatures are all in the art: bold **mascara** lines running
back from the eyes, small ears on a wide base, a heavy muzzle, a spotted belly,
and a thick **ringed tail**.

```
    ████                    ████
  ████████                ████████
  ████████████████████████████████
████████████████████████████████████
████▓▓████    ████████    ████▓▓████      ← mascara beside the eyes
████████████████████████████████████
  ████████████▄▄▄▄▄▄▄▄████████████        ← the nose: the one accent pixel
    ████████            ████████
      ████████████████████████
        ████████████████████              ████
      ████████████████████████          ████▓▓██
    ████▒▒████████▓▓████████▒▒████      ████▒▒██
    ████▓▓████████▒▒████████▓▓████      ████▓▓██  ← ringed tail
    ████▒▒████████▓▓████████▒▒████      ████▒▒██
    ████▓▓████████▒▒████████▓▓████    ████▓▓████
    ████████████████████████████████  ████▒▒████
    ████████████████████████████████  ████▓▓████
      ████████████████████████████  ████▒▒██████
        ████████████████████████  ████████████
        ████            ████      ████████
```

**The rosettes are drawn from `theme::DITHER`** — the same density ramp as the
thinking animation. One vocabulary, used twice. That is not a coincidence to
preserve casually: if the ramp changes, the cat changes with it, and that is
correct.

**The nose is the only ACCENT-coloured pixel in the entire mascot.** The brand
colour is the cat's nose. A test enforces exactly one accent run — more than
one and it stops being a detail and becomes decoration.

#### Three sizes

| Art | Cells | Where |
|---|---|---|
| `CAT_SIT` | 48 × 20 | First run, and the empty Chat pane. The full mascot. |
| `CAT_HEAD` | 28 × 7 | A narrower welcome card. |
| `CAT_TINY` | 20 × 3 | A cramped header. Mascara is gone; ears and eyes still read. |

Seven rows is the floor for the head: below it the mascara and the muzzle
merge into a blob and it stops being a Bengal. `cat_for(cols, beside)` picks;
the mascot shrinks before it ever overflows.

#### Where the mascot appears

- **First run** — the splash: wordmark, tagline, Nyx sitting.
- **An empty Chat pane** — the welcome card: Nyx on the left, name, tagline,
  project directory and a one-line hint on the right.

That is all. The first message you send replaces the card entirely. A mascot
you see on every screen is a mascot you stop seeing.

`/login` and `/model` get the wordmark **without** the cat: by then you know
what this is, and a cat every time you switch model is noise.

Run `mnemo-agent --brand` to print the whole identity — a TUI is the one thing
you cannot screenshot from a script.

### Colours of the mascot

| Role | Token | Hex |
|---|---|---|
| Coat (golden Bengal ground) | `COAT` = `ORANGE` | `FFA300` |
| Rosettes and the wordmark lip | `ROSETTE` = `BROWN` | `AB5236` |
| Nose | `ACCENT` | `FF77A8` |
| Eyes | *negative space* | — |

The eyes are holes in the coat, not drawn pixels. At this resolution a drawn
eye becomes a smudge; a gap stays sharp at every size and needs no colour.

The coat is golden rather than silver or charcoal — the golden brown Bengal is
the archetype, and its rosettes carry the most contrast. Pink chrome over a
golden mascot is also simply not a combination another terminal tool is using.

### Storing the art

Art lives in [tui/src/brand.rs](tui/src/brand.rs) as **marker strings**, never
as pre-coloured spans, so shape and palette stay one thing each:

| marker | is | drawn as |
|---|---|---|
| `#` | coat / letterform | `█` in COAT |
| `R` | rosette core | `▓` in ROSETTE |
| `r` | rosette edge | `▒` in ROSETTE |
| `n` | nose | `▄` in ACCENT |
| `e` | wordmark lip | `▒` in ROSETTE |
| `.` | nothing | a space |

`paint_at(art, scale)` is the only place a glyph becomes a colour. Two scales
exist: the **mascot** is stored as pixels and drawn 2 cells wide (a terminal
cell is about twice as tall as it is wide, and a one-cell pixel makes a
squashed cat); the **wordmark** is stored at cell resolution already and drawn
1:1.

Tests enforce the things that only break on someone else's terminal: every art
row the same width, no marker the painter does not know, rosettes present and
clustered, exactly one accent pixel, and the art shrinking rather than
overflowing.


## 3. Palette

Defined once in [tui/src/theme.rs](tui/src/theme.rs). Never write a
`Color::Rgb` anywhere else.

| Token | Hex | Means |
|---|---|---|
| `ACCENT` (= `PINK`) | `FF77A8` | **You.** Pane titles, the selected row, the focused border, your own messages, the fold caret. |
| `BLUE` | `29ADFF` | A machine name: tool names, the model in the status bar, links. |
| `GREEN` | `00E436` | Succeeded. Also `+` in a diff, and inline code. |
| `RED` | `FF004D` | Failed. Also `-` in a diff, and "no model set". |
| `ORANGE` | `FFA300` | Running, not yet resolved. |
| `INDIGO` | `83769C` | The agent's private state: thinking blocks, queued messages, fold hints. |
| `PEACH` | `FFCCAA` | Continuation lines of your own multi-line message. |
| `WHITE` | `FFF1E8` | Ordinary content. |
| `GREY` | `5F574F` | Metadata you can ignore: token counts, argument summaries, unfocused borders. |
| `DARKGREY` | `2B2825` | The agent's gutter rail. Present, never read. |
| `BROWN` | `AB5236` | Mascot only: rosette ink and the wordmark's lip. |
| `ORANGE` (as `COAT`) | `FFA300` | Running — and, in the mascot, the Bengal's ground colour. |

### Why the accent is pink, not yellow

It used to be yellow. Yellow is what every other terminal programme uses for a
warning, so the eye had already learned to read it as chrome — the titles
disappeared and nothing on screen said "this is where you are". Pink is not
claimed by anything else in a terminal, so it can mean one thing: **the thing
you are pointing at, or the thing you said.**

Yellow is still in the palette. It is no longer the accent.

---

## 4. Layout

```
┌ RAIL ─┐┌─ BODY ───────────────────────────────────┐
│ ▶1 Chat││ ▚ CHAT ▞                                 │
│  2 Sess││                                          │
│  3 Memo││  ▊ what you said                         │
│  4 Agen││  · thinking (43 words) — o to open       │
│  5 Skil││  ● bash_exec command=ls   ▸ 12 lines     │
│  6 Logs││  │ what the agent said                   │
└────────┘└──────────────────────────────────────────┘
          ┌─ PROMPT ─────────────────────────────────┐
          │ › your next message▌                     │
          │ 1. something queued behind it            │
          └──────────────────────────────────────────┘
           CHAT  opencode-go/model  3 entries · hints
```

Four regions, always: **rail**, **body**, **prompt**, **status**.
[`cockpit_ui::layout_with`](tui/src/cockpit_ui.rs) owns the split. The prompt
box grows to show queued messages, capped at four rows — the transcript it is
queued behind matters more than the tail of the queue.

**Chrome is double-line, and never nested.** One `ring()` per region. Focus is
carried by the border *colour*, not by a second frame — a focus ring inside a
frame is two boxes saying one thing.

---

## 5. Who is speaking: the gutter

Every transcript line starts with a two-cell gutter. Speaker identity is a
column you scan, not a punctuation mark you read.

| Gutter | Colour | Whose |
|---|---|---|
| `▊ ` | ACCENT | You. Runs the full height of a multi-line message, so a pasted block reads as one thing. |
| `│ ` | DARKGREY | The agent. A rail, deliberately almost invisible. |
| `· ` | INDIGO | Thinking. |
| `● ` | GREEN / RED / ORANGE | A tool call, coloured by outcome. |
| `▊ ` | RED | An error. |

A blank line sits before each of your messages — never at the very top. The
turn boundary is the single thing the eye needs most and it costs one row.

**Why a solid block for you and a thin rail for the agent:** you are
outnumbered. In a long session the agent produces most of the lines, so the
rare thing gets the heavy mark. Reversing it makes the screen a wall of solid
bars.

---

## 6. Folding

Thinking blocks and tool cards are **closed by default** and each says what is
behind it (`thinking (43 words)`, `▸ 12 lines`). Opening a block should be an
informed choice.

| Key | Does |
|---|---|
| `[` `]` | Move the fold caret `▶` to the previous / next foldable block. |
| `o` | Open or close the block under the caret. |
| `t` | Open or close **all** thinking blocks. |
| `T` | Open or close **all** tool cards. |
| `y` | Copy the focused block — or the whole transcript when nothing is focused. |
| `esc` | Drop the caret. |

Two design points worth keeping:

- **The first `]` lands on the LAST block, not the first.** The transcript is
  tail-anchored, so the block you want is the one you can see.
- **The caret is an index into `entries`, not a position from the end.** A
  cursor counted from the end moves under you every time the agent speaks.

Per-block state (`opened`) is separate from the show-all flags
(`show_thinking`, `show_tools`), so reading one tool's output does not bury
the transcript under every other one.

---

## 7. Motion

There is exactly one animation vocabulary: the **dither ramp**
`[' ', '░', '▒', '▓', '█']`.

While the agent is working, the status bar shows a travelling dither wave:

```
░▒▓█▓▒░ ░▒▓█ thinking
```

`theme::dither_wave(phase, width)` is a pure function — a triangle wave over
the ramp, offset by cell position, so density travels left to right. It is a
unit test, not something you have to sit and watch.

**Why not a spinner.** A spinner twitches in one cell and says "a process
exists". Thinking is not one cell of work. A band that travels reads as
progress and direction; the same character flickering in place reads as a
stuck process. The braille spinner is still in `theme.rs` for meters, and is
no longer the thinking indicator.

The prompt cursor also pulses (on/off, not a ramp) while streaming. Frame
interval for everything is `SPINNER_INTERVAL_MS = 80`.

---

## 8. The prompt: send, queue, steer

Typing while the agent works is normal. Both outcomes are one keystroke.

| Key | While idle | While the agent is working |
|---|---|---|
| `enter` | Send. | **Queue it.** It runs when the current turn settles. |
| `alt+enter` | Send. | **Steer.** Interrupt this turn with it now. |

Queued messages are listed under the prompt in INDIGO, numbered. This is not
optional polish: a message that vanished into a buffer with no sign of it
looks exactly like one that was dropped.

The queue drains **one message per settle**, so each gets a whole turn. A
steered message appears in the transcript prefixed `↯`.

The status bar names both keys, but only while they differ —
`enter queue · alt+enter steer` appears only when something is running.

---

## 9. Mouse, selection, copy

**Mouse capture is off by default. That is a decision, not an omission.**

While the app does not capture the mouse, the *terminal's* own drag-select and
copy keep working — and the terminal's selection is better than anything a TUI
can reimplement, because it knows the font, the scrollback, and the platform
clipboard.

`/mouse` turns capture on when you want it:

- wheel scrolls the focused pane
- click on the rail switches pane
- click on a thinking block or tool card opens it

The cost is native drag-select. Most terminals give it back if you hold
**shift** (**option** on macOS Terminal).

Independently of all that, `y` copies the focused block via
[tui/src/clipboard.rs](tui/src/clipboard.rs) — `pbcopy`, `wl-copy`, `xclip`,
`xsel`, first one that exists. It reports which tool took it, or why none did:
silently not copying is indistinguishable from copying until you paste.

Click-to-open needs `ChatPane::line_owners`, which is built by running the
*same* render function as `lines()`. Deriving that map separately is how a
click ends up landing one block off after a folding change.

---

## 10. Panes

Every pane implements [`PaneView`](tui/src/pane.rs): `lines(height)`,
`on_key`, `status()`, `help()`. Adding a pane is a module, a field on `Panes`,
and a match arm. Nothing else.

| Pane | Shows |
|---|---|
| Chat | The transcript. Streaming text, thinking, tool cards, diffs, turn cost. |
| Sessions | Projects → sessions → a subagent's run. Your launch directory pinned top and marked `here`. |
| Memory | Memory nodes grouped by brain area, with area-filtered search. |
| Agents | The delegation tree from journal episodes. |
| Skills | Discovered `SKILL.md` files and harness bundles. |
| Logs | Live journal tail; `s` flips to the trace store. |

**Panes are pure state plus a pure render.** No pane touches the terminal, the
filesystem, or a process — the event loop does that and hands results in. That
is what makes every key path a unit test, and it is why `lines()` returns
`Vec<Line>` instead of drawing.

---

## 11. Keys

Global, from any focus:

| Key | Does |
|---|---|
| `tab` / `shift-tab` | Next / previous pane |
| `alt+1`…`alt+6` | Jump to a pane (works mid-sentence) |
| `1`…`6` | Jump to a pane — **only** when the body has focus |
| `esc` | Leave the prompt, focus the body |
| `i` / `enter` | Focus the prompt |
| `/` | Command palette (subsequence matching, `tab` completes) |
| `?` | Keybinding card — global keys plus the current pane's |
| `ctrl+c` | Quit |

A bare digit navigates only when the body has focus. Typing "I need 3 things"
into the prompt must not teleport you to the Memory pane.

---

## 12. Adding to this

- **A new colour?** Only if no existing token means that state. Add it to
  `theme.rs` and to the table above.
- **A new animation?** Use the dither ramp. A second vocabulary makes the
  first one meaningless.
- **A new pane?** Implement `PaneView`. Do not reach for the terminal.
- **A new key?** Put it in the pane's `help()`. A key that only exists in the
  source does not exist.
- **Never** italics (many terminals render them as inverse), nested borders,
  or a colour that means two things.

Test totals and how to run the suites live in [README.md](README.md); what
happened and why lives in [STATUS.md](STATUS.md). How the system actually
works — process topology, data flow, the kernel, pi, the memory layer, with
diagrams — lives in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
