
# Mascots — five candidates, and the rules they have to keep

Nyx is a Bengal cat: 20 rows × 28 markers (56 cells), four tones, rosette clusters
drawn from the dither ramp, a spotted belly, a ringed tail, mascara lines, and a
walk cycle in four frames — three of which differ only in the legs. Every change
means redrawing all four frames, re-pinning the installer's private copy of the
art, and re-passing the drift test. It is beautiful and it is heavy, and a mascot
whose job is to say *"hello, I am not a hang"* on an empty screen should be
something you can redraw in a minute.

Below: five lighter candidates, all in the same marker language as the cat (so
they render with the same `Ink()` function and re-theme with the same palette),
all 40 cells wide, none taller than 13 rows. Pick one, mix two, or ask for
variations — the art is data, so a change is a few strings.

The rules they all keep, because these are what make the art *work* rather than
merely exist:

| rule | why |
|---|---|
| Eyes are negative space | drawn eyes plus a mouth read as a glare with teeth at this scale — shipped once, rejected |
| Exactly one accent-coloured run | more than one and the brand colour stops being a detail and becomes decoration |
| Markers, never colours | shape and palette stay one thing each; one function turns a marker into a glyph plus a colour |
| Plain monospace only | no Nerd Font requirement — every glyph lives in the block and box-drawing ranges |
| Tone from the 14-value palette | a mascot with private colours cannot be re-themed with the rest of the interface |
| ≤ 13 rows, symmetric | redrawable by hand, poseable without a walk cycle |

For a non-cat mascot the marker vocabulary generalises cleanly: `#` is the body,
`r`/`R` are two depths of detail (scale, plate, band), `p` is a highlight (inner
ear, wing, membrane), `n` is the single accent (beak, nose, stinger, stamp), `O`
is an eye and therefore a *hole*, and `-` `/` `\\` are hairlines.

### owl — *“the one that was already watching”*

12 rows · 40 cells · one accent run · markers only

Athena’s bird: the oldest western emblem of knowledge that just looks at you. Two ear tufts, two big eye-holes, a beak, folded wings.

```
    ████                    ████
  ████████                ████████
    ████████████████████████████████
  ████████████████████████████████████
  ████········████████········████
  ████········████████········████
  ██████████████▄▄▄▄██████████████
    ████████████████████████████████
    ████▒▒▒▒████████████████▒▒▒▒████
    ████▓▓▓▓████████████████▓▓▓▓████
    ████████████████████████████████
      ████  ████        ████  ████
```

<details><summary>markers (paste into Go)</summary>

```go
var Art = []string{
	"..##..........##....",
	".####........####...",
	"..################..",
	".##################.",
	".##OOOO####OOOO##...",
	".##OOOO####OOOO##...",
	".#######nn#######...",
	"..################..",
	"..##rr########rr##..",
	"..##RR########RR##..",
	"..################..",
	"...##.##....##.##...",
}
```

</details>

### tortoise — *“slow, and it shells what it learns”*

9 rows · 40 cells · one accent run · markers only

Hermes strung the first lyre across a tortoise shell — the same gesture as building a tool out of something you happened to be carrying. It is also the calmest possible body: it cannot look alarmed.

```
            ████████████
            ██··████··██
            ████▄▄▄▄████
      ████▒▒▒▒████▒▒▒▒████▒▒▒▒████
    ██▓▓▓▓████▒▒▒▒████▒▒▒▒████▓▓▓▓██
  ████▓▓▓▓████▒▒▒▒████▒▒▒▒████▓▓▓▓████
████████████████████████████████████████
  ████████████████████████████████████
    ████      ████    ████      ████
```

<details><summary>markers (paste into Go)</summary>

```go
var Art = []string{
	"......######........",
	"......#O##O#........",
	"......##nn##........",
	"...##rr##rr##rr##...",
	"..#RR##rr##rr##RR#..",
	".##RR##rr##rr##RR##.",
	"####################",
	".##################.",
	"..##...##..##...##..",
}
```

</details>

### serpent — *“keeper of the spring”*

13 rows · 40 cells · one accent run · markers only

Coiled, one eye-band, an accent snout. The snake guards the spring and the oracle at Delphi spoke through one. Reads best at small sizes because the coil is a single motif.

```
              ████
            ████████
            ██····██
              ▄▄▄▄
        ████████████████████
      ████▒▒▒▒████████▒▒▒▒████
    ████▒▒▒▒████████████▒▒▒▒████
  ████▒▒▒▒████        ████▒▒▒▒████
  ████▒▒▒▒████        ████▒▒▒▒████
    ████▒▒▒▒████████████▒▒▒▒████
      ████▒▒▒▒████████▒▒▒▒████
    ████████████████████████████████
    ████████████████████████████████
```

<details><summary>markers (paste into Go)</summary>

```go
var Art = []string{
	".......##...........",
	"......####..........",
	"......#OO#..........",
	".......nn...........",
	"....##########......",
	"...##rr####rr##.....",
	"..##rr######rr##....",
	".##rr##....##rr##...",
	".##rr##....##rr##...",
	"..##rr######rr##....",
	"...##rr####rr##.....",
	"..################..",
	"..################..",
}
```

</details>

### bee — *“the one that carries it home”*

12 rows · 40 cells · one accent run · markers only

Ephesus struck the bee on its coins and Delphi’s priestesses were the melissae. It carries, it returns to the same place, and it tells the others where it found something.

```
      ████                    ████
          ████            ████
                ████████
              ██··████··██
                ████████
      ▒▒▒▒▒▒████████████▒▒▒▒▒▒
  ████████████████████████████████████
  ████▓▓▓▓████▓▓▓▓████▓▓▓▓████▓▓▓▓████
  ████████████████████████████████████
  ████▓▓▓▓████▓▓▓▓████▓▓▓▓████▓▓▓▓████
    ████████████████████████████████
                ▄▄▄▄
```

<details><summary>markers (paste into Go)</summary>

```go
var Art = []string{
	"...##..........##...",
	".....##......##.....",
	"........####........",
	".......#O##O#.......",
	"........####........",
	"...ppp######ppp.....",
	".##################.",
	".##RR##RR##RR##RR##.",
	".##################.",
	".##RR##RR##RR##RR##.",
	"..################..",
	"........nn..........",
}
```

</details>

### amphora — *“memory has to be carried in something”*

13 rows · 40 cells · one accent run · markers only

The only non-animal: a vessel with a potter’s stamp for the accent. It cannot be posed, which is the point — some things should just be a good object.

```
        ████████████████████
        ██▓▓▓▓████████▓▓▓▓██
            ████████████████
          ████▓▓▓▓████▓▓▓▓████
      ████████████▄▄▄▄████████████
    ████████████████████████████████
    ████████████████████████████████
    ████▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒████
    ████████████████████████████████
    ████████████████████████████████
      ████████████████████████████
        ████████████████████████
          ████████████████████
```

<details><summary>markers (paste into Go)</summary>

```go
var Art = []string{
	"....##########......",
	"....#RR####RR#......",
	"......########......",
	".....##RR##RR##.....",
	"...######nn######...",
	"..################..",
	"..################..",
	"..##rrrrrrrrrrrr##..",
	"..################..",
	"..################..",
	"...##############...",
	"....############....",
	".....##########.....",
}
```

</details>

## Adopting one

1. **Art** — add it to `tui-go/internal/brand/brand.go` next to `CatSit`, as
   marker strings, and a fit function beside `CatFor` (`MascotFor(cols)`) so a
   narrow terminal gets a smaller cut instead of a cropped one.
2. **Installer** — `scripts/install.sh` and `install.ps1` carry their own copy of
   the art because they run before the binary exists. The drift test parses the
   installer and diffs art, wordmark, tagline and palette against `brand`, so the
   copy is safe *because* the guard exists. Extend the guard to the new art.
3. **Tests** — the tests that already exist for the cat are the contract:
   rectangular art, exactly one accent run, eyes are holes, and the walk-cycle
   rules if the mascot animates. Copy `brand_test.go`'s shape.
4. **Splash and onboarding** — `CatFor` is called by the welcome screen and the
   installer's walk; a new mascot needs a two-frame idle (a blink is enough) if
   you want motion, or none at all: stillness is allowed.

## Still open

- No mascot has a **walk or idle animation** except the cat. A blink is two
  frames and reuses `Blink()`; a pose is a second art array. Deliberately not
  designed here — decide the character first, then the motion.
- **Where it appears** is a separate decision from what it is: the candidates are
  sized for the empty transcript, the installer, and the `--version` banner. The
  header band currently carries no mascot at all.
