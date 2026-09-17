// Package theme is the whole visual vocabulary: fourteen colours, a glyph set,
// and the styles built from them. Nothing else in the program may name a
// colour or a box-drawing character.
//
// It has no dependency on any other package here, which is what lets the look
// be replaced without touching behaviour: swap the Palette, and every pane
// changes.
package theme

import (
	"image/color"
	"strings"

	"charm.land/lipgloss/v2"
)

// Palette is the fourteen. PICO-8's sixteen, minus the two nobody needed,
// plus two greys a terminal does need.
//
// Every field is a role, not a hue. "Accent" is what you are pointing at;
// which colour that happens to be is one line below, and only one line.
type Palette struct {
	Ground   color.Color
	Ink      color.Color
	Muted    color.Color
	Faint    color.Color
	Accent   color.Color
	Thinking color.Color
	Coat     color.Color
	Rosette  color.Color
	Peach    color.Color
	OK       color.Color
	Fail     color.Color
	Warn     color.Color
	Link     color.Color
	Deep     color.Color
}

// PICO8 is the shipping palette.
//
// The accent is PINK and not YELLOW deliberately: on a terminal, yellow is
// the colour of chrome — every prompt, every WARN, every `ls` of a directory
// — so an accent in yellow reads as furniture and collides with the one thing
// yellow must keep meaning. Pink appears nowhere by default, so every pink
// cell on screen is one we put there.
var PICO8 = Palette{
	Ground:   lipgloss.Color("#000000"),
	Ink:      lipgloss.Color("#FFF1E8"),
	Muted:    lipgloss.Color("#5F574F"),
	Faint:    lipgloss.Color("#2B2825"),
	Accent:   lipgloss.Color("#FF77A8"),
	Thinking: lipgloss.Color("#83769C"),
	Coat:     lipgloss.Color("#FFA300"),
	Rosette:  lipgloss.Color("#AB5236"),
	Peach:    lipgloss.Color("#FFCCAA"),
	OK:       lipgloss.Color("#00E436"),
	Fail:     lipgloss.Color("#FF004D"),
	Warn:     lipgloss.Color("#FFEC27"),
	Link:     lipgloss.Color("#29ADFF"),
	Deep:     lipgloss.Color("#1D2B53"),
}

// The other three are §18's register, lifted from docs/design-preview.html
// rather than invented here: the preview carries the presets as fourteen roles
// each, and a picker full of made-up hex codes would be a second design
// document to keep in step. Only the values travel; the reasoning for each
// colour is in DESIGN.md §18.
var (
	// Pottery is the register the name is from: black gloss ground,
	// terracotta slip, ochre for warning, oxblood for failure.
	Pottery = Palette{
		Ground:   lipgloss.Color("#14100E"),
		Ink:      lipgloss.Color("#E8D5B7"),
		Muted:    lipgloss.Color("#7A6A57"),
		Faint:    lipgloss.Color("#2A221C"),
		Accent:   lipgloss.Color("#C1440E"),
		Thinking: lipgloss.Color("#8C6A4A"),
		Coat:     lipgloss.Color("#D97B29"),
		Rosette:  lipgloss.Color("#7A3B18"),
		Peach:    lipgloss.Color("#E8C39E"),
		OK:       lipgloss.Color("#6A8F3C"),
		Fail:     lipgloss.Color("#A62B1F"),
		Warn:     lipgloss.Color("#D9A441"),
		Link:     lipgloss.Color("#4E7A8A"),
		Deep:     lipgloss.Color("#241A14"),
	}

	// Bronze is the same geometry twenty centuries later: olive and gold.
	Bronze = Palette{
		Ground:   lipgloss.Color("#0E0D0B"),
		Ink:      lipgloss.Color("#F0E6D2"),
		Muted:    lipgloss.Color("#6E6355"),
		Faint:    lipgloss.Color("#26221C"),
		Accent:   lipgloss.Color("#B08D57"),
		Thinking: lipgloss.Color("#7C6E88"),
		Coat:     lipgloss.Color("#C9A227"),
		Rosette:  lipgloss.Color("#8C6239"),
		Peach:    lipgloss.Color("#E3C9A6"),
		OK:       lipgloss.Color("#7BA05B"),
		Fail:     lipgloss.Color("#B33A2B"),
		Warn:     lipgloss.Color("#E0B84C"),
		Link:     lipgloss.Color("#5B8FA8"),
		Deep:     lipgloss.Color("#1B1815"),
	}

	// WineDark is the sea, on a navy ground.
	WineDark = Palette{
		Ground:   lipgloss.Color("#0B1018"),
		Ink:      lipgloss.Color("#E6E9EE"),
		Muted:    lipgloss.Color("#5B6472"),
		Faint:    lipgloss.Color("#1B2330"),
		Accent:   lipgloss.Color("#8C6BC8"),
		Thinking: lipgloss.Color("#6E7A99"),
		Coat:     lipgloss.Color("#C9A227"),
		Rosette:  lipgloss.Color("#7A4A2A"),
		Peach:    lipgloss.Color("#D8BFA1"),
		OK:       lipgloss.Color("#4F9E7A"),
		Fail:     lipgloss.Color("#C0392B"),
		Warn:     lipgloss.Color("#D9A441"),
		Link:     lipgloss.Color("#5FA8D3"),
		Deep:     lipgloss.Color("#12203A"),
	}
)

// Shipping is the palette used when nothing has been chosen — a fresh install,
// or a theme.json someone edited into nonsense. It is the name the picker
// marks as in use, and it stays the default on purpose: a choice is opt-in.
const Shipping = "pico8"

// Preset is one named palette: the picker's row, and what a name in
// theme.json resolves to.
type Preset struct {
	Name string
	Desc string
	P    Palette
}

// listed is every named palette, shipping first. The order is the order the picker
// lists them, so the shipping one is always the first thing under the cursor.
//
// A light-ground palette (docs/design-preview.html's "marble & wine") is
// deliberately NOT here yet: nothing in this program paints the terminal's own
// background, so a light palette is only legible in a terminal that is already
// light, and a picker row that can make the interface unreadable is worse than
// a shorter list.
var listed = []Preset{
	{Shipping, "the shipping register — black, pink, orange", PICO8},
	{"pottery", "black gloss, terracotta, ochre", Pottery},
	{"bronze", "olive, gold and bronze", Bronze},
	{"winedark", "navy ground, wine and grain", WineDark},
}

// Presets is every palette a reader can choose, shipping first.
func Presets() []Preset { return listed }

// ByName resolves a palette name, case-insensitively. False means no such
// palette — the caller decides what to do about it, because a name read back
// from a file is not a name a person typed.
func ByName(name string) (Palette, bool) {
	want := strings.ToLower(strings.TrimSpace(name))
	for _, p := range listed {
		if p.Name == want {
			return p.P, true
		}
	}
	return Palette{}, false
}

// The vocabulary. Every character the interface may draw is one of these, or
// two of them side by side.
//
// The idea is the one a terminal forces on you: a cell is not a pixel. It is
// TWO pixels tall (a half block inks one of them) and — for the figures that
// need it — two wide (▌ ▐ ink half a cell each). That is the whole pixel grid
// the interface has, and both the chrome and the mascot are drawn on it, which
// is what makes the screen read as one thing rather than as text with
// ornaments. The names say which pixel is inked, not which character is used:
// a rule is "the top pixel, repeated", not "the ▀ character".
const (
	pxFull = "█" // both pixels of the cell
	pxTop  = "▀" // the upper pixel of the cell — a rule
	pxLow  = "▄" // the lower pixel of the cell — a baseline
	pxQuad = "▚" // a quadrant block: the one mark below half-cell grain
	pxSha  = "░" // the ramp's lightest step: mist, and the thinking figure
	halfL  = "▌" // the left pixel, full height
	halfR  = "▐" // the right pixel, full height
	hairH  = "─" // a hairline, one cell wide
	hairV  = "│" // a hairline, one cell tall
	elbow  = "├" // the tree's branch point: children hang under it
	corner = "└" // the last child: the one elbow that closes the trunk
)

// Glyphs is every non-alphabetic character the interface is allowed to draw.
//
// Everything lives in the block and box-drawing ranges — the same
// compatibility tier, both of them in CP437 — so the interface renders on a
// plain monospace font and no glyph needs a patched icon font, which is
// another way of saying no glyph is blank for somebody.
//
// There is deliberately ONE set and no wide/narrow pair. brand.Ink already
// pairs a wide and a narrow rendering for every pixel of the art, and a second
// mechanism in the theme would be a second thing to keep in step; the theme
// does not need one, because every glyph here is in the tier the interface
// already required (a terminal with ─ has ▀).
//
// Weight is expressed as PIXEL COVERAGE rather than as a heavier stroke: a
// half-block rule (▀) is the loud one and a hairline (─) is the quiet one. That
// is the difference the eye actually reads at this size, and it is drawn from
// the same material as the mascot.
type Glyphs struct {
	// The speaker gutters. Two cells each, and that is the interesting part:
	// a figure built from half blocks is a 2x2-pixel sprite, so it can carry a
	// shape rather than only a colour. One cell can say "a bar"; it cannot say
	// WHO is speaking, and colour only says it to a reader who has already
	// learned the palette. Every other row of the interface is prose.
	//
	// Two cells and not three: the gutter TODAY is a one-cell mark plus a space,
	// so two is the width the transcript already spends, and a replacement that
	// widens it would re-wrap every transcript in every session to buy a
	// picture. The space is inside the figure instead — each of these leaves
	// its last pixel half-empty on the right, which is the air the prose needs.
	User  string // a person: a head, and a shoulder-line under it
	Agent string // a machine: the same mass, no head — a solid slab, walled on the left
	Think string // a thought: the ramp's lightest step over a low pixel — the one gutter that is not solid
	Tool  string // a tool: an upright held in air, narrow, and the row that carries state (ok / fail / running)

	// Folding. The block range has no arrowhead, and a fold marker has to be
	// directional — direction is the one thing half blocks cannot say. These
	// are the smallest triangles in the geometric-shapes range, the same
	// compatibility tier as everything above.
	Closed string
	Open   string

	// Trees. The elbow IS the drawing: a hierarchy is a picture of a box, and
	// the last child is the only one that turns the corner. All four are two
	// cells wide so the trunk cannot bend.
	Branch string
	Last   string
	Pipe   string
	Gap    string

	// Chrome.
	H    string // the loud rule: a region's full width, at the top pixel
	Hair string // the quiet rule: hairlines, and rules too short to carry a label
	V    string // a column divider or a panel's side: a hairline, never a half block
	Nub  string // the label notch: the rule turns down, so the label sits in a slot
	Seg  string // a band's divider, and the marker on the focused row
	Tick string // the header's stamp: the one quadrant block, at a finer grain
}

// roles is every field of Glyphs that holds a glyph, with the width in cells
// that glyph must occupy.
//
// It exists so that a glyph's width is a DECLARATION and not a discovery. This
// interface has already been bitten by width drift — one state carried a
// one-cell marker in a two-cell column, and every continuation line under it
// landed a column out — so the contract is written down next to the glyph and
// a test walks the struct against it. A field added to Glyphs without a line
// here fails that test, which is the whole point of writing it down.
var roles = []struct {
	Field string
	Cells int
}{
	{"User", 2}, {"Agent", 2}, {"Think", 2}, {"Tool", 2}, // gutter figures
	{"Closed", 1}, {"Open", 1}, // folding
	{"Branch", 2}, {"Last", 2}, {"Pipe", 2}, {"Gap", 2}, // tree elbows
	{"H", 1}, {"Hair", 1}, {"V", 1}, {"Nub", 1}, {"Seg", 1}, {"Tick", 1}, // chrome
}

// GutterCells is the column the speaker figure costs: two cells, and no more.
//
// It is here, in the theme, because it is a layout number that follows from a
// glyph: the transcript, the prompt bar and the wrapped continuation lines all
// have to agree on it, and when they disagreed the continuation of a sentence
// started a column left of the sentence and read as a new speaker. It is also
// the number the design page fixed before the figures were drawn — the gutter
// may not widen the transcript — which is why the air the prose needs is inside
// the figure rather than beside it.
const GutterCells = 2

// Heavy is the shipping glyph set.
//
// The name is the caller's — app/model.go names it, and this file's tests and
// every other package's do too — and it still means "the loud chrome". The
// loudness is coverage now: a half-block rule instead of a heavier stroke, so
// the rules, the band, the tree and the mascot are all drawn from the same
// handful of pixels.
var Heavy = Glyphs{
	User:  pxFull + pxLow, // █▄ — head, then shoulders
	Agent: pxFull + halfL, // █▌ — a slab: the same mass as the person, walled, with no head on it
	Think: pxSha + pxLow,  // ░▄ — mist over a low pixel: the ramp is the thinking vocabulary, so the thinking figure is made of it
	Tool:  halfR + halfL,  // ▐▌ — an upright held in air: the narrowest mark, for the row that carries state

	Closed: "▸",
	Open:   "▾",

	Branch: elbow + hairH,
	Last:   corner + hairH,
	Pipe:   hairV + " ",
	Gap:    "  ",

	H:    pxTop,
	Hair: hairH,
	V:    hairV,
	// The notch's ink sits on the LABEL's side of its cell, so the rule appears
	// to step down and bracket the label instead of floating beside it; the
	// other side of the label is this glyph's mirror (halfL), which ui.reverse
	// resolves — the two halves of one cell are two code points.
	Nub:  halfR,
	Seg:  halfL,
	Tick: pxQuad,
}

// Dither is the density ramp, lightest to densest.
//
// It is the entire animation vocabulary — everything that pulses travels
// along this ramp rather than blinking — and it is also what the mascot's
// rosettes are drawn from. One vocabulary, used twice. If this changes, the
// cat changes with it, and that is correct.
var Dither = []rune{' ', '░', '▒', '▓', '█'}

// DitherPeriod is how many frames Wave takes to repeat.
var DitherPeriod = len(Dither)*2 - 2

// Wave is one frame of the thinking animation: a dither band `width` cells
// wide, with density travelling left to right.
//
// A spinner says "something is happening" in one cell. Thinking is not one
// cell of work, so it gets a band — the eye reads motion and direction rather
// than a twitching character. Pure, so the animation is a unit test rather
// than something you have to sit and watch.
func Wave(phase, width int) string {
	if width < 1 {
		width = 1
	}
	span := DitherPeriod
	var b strings.Builder
	for i := 0; i < width; i++ {
		t := (i + phase) % span
		level := t
		if t >= len(Dither) {
			level = span - t
		}
		b.WriteRune(Dither[level])
	}
	return b.String()
}

// Spinner frames, for a single tool call in flight.
var Spinner = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

// SpinnerIntervalMS is how long one spinner frame lasts.
const SpinnerIntervalMS = 80

// Theme is a palette and a glyph set, plus the styles derived from them.
//
// Everything that draws takes a *Theme rather than reaching for a package
// global, so a second theme is a value and not a rewrite.
type Theme struct {
	P Palette
	G Glyphs

	// Derived styles. Built once in New; never rebuilt per frame.
	Ink      lipgloss.Style
	Muted    lipgloss.Style
	Faint    lipgloss.Style
	Accent   lipgloss.Style
	Thinking lipgloss.Style
	OK       lipgloss.Style
	Fail     lipgloss.Style
	Warn     lipgloss.Style
	Link     lipgloss.Style
	Coat     lipgloss.Style
	Rosette  lipgloss.Style

	// Chrome.
	Rule     lipgloss.Style
	Label    lipgloss.Style
	Selected lipgloss.Style
	Key      lipgloss.Style

	// Search hits. Every other match is dim, the one you are on is the
	// accent reversed — so "where am I in the results" is answerable without
	// reading the count.
	Match    lipgloss.Style
	MatchNow lipgloss.Style

	// Texture is the header band at rest. It is drawn in the mascot's own
	// rosette brown rather than in near-black: a band nobody can see is not
	// restraint, it is a missing element, and the screen reads as unfinished.
	Texture lipgloss.Style

	// Said is a line the user typed. It carries a background rather than a
	// colour, because the strongest distinction a terminal can draw between
	// two speakers is one of them sitting on a different ground.
	Said lipgloss.Style
}

// New builds a theme. isDark comes from the terminal, reported as a message
// at startup, and is threaded in here rather than sniffed globally — Bubbles
// v2 wants it explicitly, and a global would make the light variant
// untestable.
func New(p Palette, g Glyphs, isDark bool) *Theme {
	t := &Theme{P: p, G: g}
	if !isDark {
		// On a light terminal the two darkest greys vanish into the page.
		// Nothing else moves: the accent, the states and the coat hold on
		// either ground. Whichever preset is chosen, the three text roles are
		// corrected the same way: every palette offered here is a DARK-ground
		// one, so on a light terminal it is the ink that is wrong, not the
		// accent.
		t.P.Ink = lipgloss.Color("#1D2B53")
		t.P.Muted = lipgloss.Color("#7E6C63")
		t.P.Faint = lipgloss.Color("#C8BEB6")
	}
	s := lipgloss.NewStyle
	t.Ink = s().Foreground(t.P.Ink)
	t.Muted = s().Foreground(t.P.Muted)
	t.Faint = s().Foreground(t.P.Faint)
	t.Accent = s().Foreground(t.P.Accent)
	t.Thinking = s().Foreground(t.P.Thinking)
	t.OK = s().Foreground(t.P.OK)
	t.Fail = s().Foreground(t.P.Fail)
	t.Warn = s().Foreground(t.P.Warn)
	t.Link = s().Foreground(t.P.Link)
	t.Coat = s().Foreground(t.P.Coat)
	t.Rosette = s().Foreground(t.P.Rosette)

	// GREY, not FAINT. The chrome was drawn a shade above the background and
	// the whole interface read as bland — the structure was there and
	// invisible, which is the worst of both.
	t.Rule = s().Foreground(t.P.Muted)
	t.Texture = s().Foreground(t.P.Rosette)
	t.Said = s().Foreground(t.P.Ink).Background(t.P.Faint).Bold(true)
	t.Label = s().Foreground(t.P.Accent).Bold(true)
	t.Selected = s().Foreground(t.P.Ground).Background(t.P.Accent)
	t.Key = s().Foreground(t.P.Accent)
	t.Match = s().Foreground(t.P.Ground).Background(t.P.Warn)
	t.MatchNow = s().Foreground(t.P.Ground).Background(t.P.Accent).Bold(true)
	return t
}

// Default is the shipping theme on a dark terminal.
func Default() *Theme { return New(PICO8, Heavy, true) }
