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
		// Nothing else moves: the accent, the states and the coat are chosen
		// to hold on either ground.
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
	return t
}

// Default is the shipping theme on a dark terminal.
func Default() *Theme { return New(PICO8, Heavy, true) }
