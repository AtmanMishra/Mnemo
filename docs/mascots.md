<!-- GENERATED FILE — do not edit by hand.
     Rendered from tui-go/internal/brand/brand.go by MascotsMarkdown().
     Regenerate: cd tui-go && go test ./internal/brand/ -run Docs -update-docs
     The same test fails when this file and the source disagree. -->

# The creatures

Three figures, 5 marks by 5 rows each, drawn at 2 cells to a mark — a 10-cell-wide, 10-pixel-tall sprite, because a terminal cell is two pixels tall.

They replaced a Bengal cat: 20 rows × 28 marks, four tones, a spotted belly, a ringed tail and a walk cycle in four frames — three of which differ only in the legs. Beautiful, and nobody could change it. A figure here is twenty-five marks, so it is redrawable by reading the source for half a minute.

The one that ships on the welcome screen is **Karkinos**. `brand.Frame(tick)` animates it; `brand.ByName(name)` gets any of them.

## The markers

Art is stored as markers, never as coloured spans: the shape and the palette stay one thing each, and one table turns a marker into a glyph, a colour and a role — which is also what the docs page reads, so the two cannot disagree.

| marker | role | drawn at 2 cells | at 1 cell | meaning |
|---|---|---|---|---|
| `#` | coat | `██` | `█` | the body |
| `u` | coat | `▀▀` | `▀` | the body's upper pixel — a raised limb, a wing up |
| `v` | coat | `▄▄` | `▄` | the body's lower pixel — a thin leg, a claw held low |
| `r` | detail | `▒▒` | `▒` | detail, light |
| `R` | detail | `▓▓` | `▓` | detail, heavy — a stripe |
| `e` | detail | `▒▒` | `▒` | the wordmark's lip |
| `p` | highlight | `▒▒` | `▒` | the one highlight: inner ear, wing, a thought forming |
| `n` | accent | `▄▄` | `▄` | THE accent — exactly one run per frame |
| `O` | — | `  ` | ` ` | an eye: a hole in the body, never a drawn shape |
| `_` | coat | `██` | `█` | what a blink fills the hole with |
| `.` | — | `  ` | ` ` | nothing here — the art's own blank |

## Karkinos — memory is the thing that holds on

*this is the one that ships*

the crab — memory is the thing that holds on. His claws are held one pixel low, about to close.

```
idle   blink  bob    thinking
-----  -----  -----  -----
▄   ▄  ▄   ▄  █   █  ▄   ▄
█████  █████  █████  █████
█ █ █  █████  █ █ █  █ █ █
██▄██  ██▄██  ██▄██  ██▄██
▄ ▄ ▄  ▄ ▄ ▄  █ █ █  █████
```

- **idle** — At rest. The one frame that must be legible on its own, because it is the one the welcome screen shows.
- **blink** — The eye holes filled with body: derived, never drawn. A blink cannot drift out of step with the body it blinks on.
- **bob** — The other foot: the limbs move, the body does not. Two rows differ from idle and that is the whole walk.
- **thinking** — Attending: pulled in, with the work showing. A creature that looks the same while it thinks is a logo.

Source (this is the editable form; the drawing above is what it compiles to):

```
# idle
v...v
#####
#O#O#
##n##
v.v.v
```

```
# blink (derived — Blink(idle) fills the eye holes; edit the body, not this)
v...v
#####
#_#_#
##n##
v.v.v
```

```
# bob
#...#
#####
#O#O#
##n##
#.#.#
```

```
# thinking
v...v
#####
#O#O#
##n##
#####
```

## Glaux — Athena's bird

the owl — Athena's bird, the one that was already watching. Eyes are holes; the beak between them is the accent.

```
idle   blink  bob    thinking
-----  -----  -----  -----
█   █  █   █  █   █  █ ▒ █
█████  █████  █████  █████
█ ▄ █  ██▄██  █ ▄ █  █ ▄ █
█████  █████  █████  █████
▄ ▄ ▄  ▄ ▄ ▄  █ █ █  █████
```

- **idle** — At rest. The one frame that must be legible on its own, because it is the one the welcome screen shows.
- **blink** — The eye holes filled with body: derived, never drawn. A blink cannot drift out of step with the body it blinks on.
- **bob** — The other foot: the limbs move, the body does not. Two rows differ from idle and that is the whole walk.
- **thinking** — Attending: pulled in, with the work showing. A creature that looks the same while it thinks is a logo.

Source (this is the editable form; the drawing above is what it compiles to):

```
# idle
#...#
#####
#OnO#
#####
v.v.v
```

```
# blink (derived — Blink(idle) fills the eye holes; edit the body, not this)
#...#
#####
#_n_#
#####
v.v.v
```

```
# bob
#...#
#####
#OnO#
#####
#.#.#
```

```
# thinking
#.p.#
#####
#OnO#
#####
#####
```

## Melissa — Ephesus's mark

the bee — Ephesus's mark, and the melissae were Delphi's priestesses: the one that carries it home.

```
idle   blink  bob    thinking
-----  -----  -----  -----
 ▒ ▒    ▒ ▒    ▀ ▀   ▒ ▒ ▒
█ █ █  █████  █ █ █  █ █ █
█████  █████  █████  █████
▓▓▓▓▓  ▓▓▓▓▓  ▓▓▓▓▓  ▓▓▓▓▓
  ▄      ▄      ▄      ▄
```

- **idle** — At rest. The one frame that must be legible on its own, because it is the one the welcome screen shows.
- **blink** — The eye holes filled with body: derived, never drawn. A blink cannot drift out of step with the body it blinks on.
- **bob** — The other foot: the limbs move, the body does not. Two rows differ from idle and that is the whole walk.
- **thinking** — Attending: pulled in, with the work showing. A creature that looks the same while it thinks is a logo.

Source (this is the editable form; the drawing above is what it compiles to):

```
# idle
.p.p.
#O#O#
#####
RRRRR
..n..
```

```
# blink (derived — Blink(idle) fills the eye holes; edit the body, not this)
.p.p.
#_#_#
#####
RRRRR
..n..
```

```
# bob
.u.u.
#O#O#
#####
RRRRR
..n..
```

```
# thinking
p.p.p
#O#O#
#####
RRRRR
..n..
```

