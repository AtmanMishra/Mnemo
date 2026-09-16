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

// Glyphs is every non-alphabetic character the interface is allowed to draw.
//
// All of them live in the standard block and box-drawing ranges, so the whole
// interface renders on a plain monospace font with no patched icon font. A
// glyph that needs Nerd Fonts is a glyph that is blank for somebody.
type Glyphs struct {
	// Speaker gutters. Two cells, at the left of every line.
	User  string
	Agent string
	Think string
	Tool  string

	// Folding.
	Closed string
	Open   string

	// Trees.
	Branch string
	Last   string
	Pipe   string
	Gap    string

	// Chrome.
	H    string
	V    string
	TopL string
	TopR string
	BotL string
	BotR string
	TeeL string
	TeeR string
	Nub  string
	Seg  string
	Tick string
}

// Heavy is the shipping glyph set: thick rules, so the chrome reads as
// structure at a glance rather than as faint noise between panes.
var Heavy = Glyphs{
	User:  "▊",
	Agent: "│",
	Think: "·",
	Tool:  "●",

	Closed: "▸",
	Open:   "▾",

	Branch: "├─",
	Last:   "└─",
	Pipe:   "│ ",
	Gap:    "  ",

	H:    "━",
	V:    "┃",
	TopL: "┏",
	TopR: "┓",
	BotL: "┗",
	BotR: "┛",
	TeeL: "┣",
	TeeR: "┫",
	Nub:  "╾",
	Seg:  "▌",
	Tick: "▚",
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
