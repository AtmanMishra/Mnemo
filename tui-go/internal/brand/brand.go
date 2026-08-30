// Package brand is Nyx and the wordmark.
//
// Art is stored as MARKER strings, never as pre-coloured spans, so the shape
// and the palette stay one thing each. Ink is the only place a marker becomes
// a glyph and a colour.
//
// Two scales. The mascot is drawn at two cells per marker, because a terminal
// cell is about twice as tall as it is wide and a one-cell pixel makes a
// squashed cat. The wordmark is already stored at cell resolution — three-cell
// strokes with a half-cell lip is what gives the letters depth — so it draws
// at one. Confusing the two doubles the logo; that has happened.
package brand

import (
	"strings"

	"charm.land/lipgloss/v2"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/theme"
	"github.com/charmbracelet/x/ansi"
)

// peachStyle is the inner ear, the one colour the theme does not expose as a
// ready-made style because nothing else uses it.
func peachStyle(t *theme.Theme) lipgloss.Style {
	return lipgloss.NewStyle().Foreground(t.P.Peach)
}

// Scales.
const (
	ScaleMascot   = 2
	ScaleWordmark = 1
)

// Gait timing. 47 is prime so a blink never lands on the same footfall twice
// — a cat that blinks on the same step every time looks like a machine.
const (
	WalkEvery  = 3
	BlinkEvery = 47
	BlinkFor   = 2
)

// MinWalkCols is the width below which the walk is not drawn at all. A
// cropped cat is worse than no cat.
const MinWalkCols = 44

// CatSit is Nyx sitting: the full mascot, shown on an empty transcript and at first run.
var CatSit = []string{
	"..##..........##............",
	".#pp#........#pp#...........",
	"..################..........",
	".##################.........",
	".##R##OO####OO##R##.........",
	".##################.........",
	"-########nn########-........",
	"..################..........",
	"...##############...........",
	"....############.......##...",
	"...##############.....##R#..",
	"..##r####R####r###....##r#..",
	"..##R####r####R###....##R#..",
	"..##r####R####r###....##r#..",
	"..##R####r####R###...##R##..",
	"..################...##r##..",
	"..################..##R##...",
	"...##############..##r###...",
	"...##############.######....",
	"...##.##..##.##...####......",
}

// CatHead is seven rows, as small as the breed markings survive.
var CatHead = []string{
	"..##......##..",
	".####....####.",
	".############.",
	"##.##....##.##",
	"##############",
	".####.nn.####.",
	"..##########..",
}

// CatTiny is three rows, for a cramped header.
var CatTiny = []string{
	".##....##.",
	".########.",
	"##.####.##",
}

// Wordmark is 83 cells wide and needs an 87-column terminal.
var Wordmark = []string{
	"###.........###...###.........###...############...###.........###......#########",
	"######...######e..######......###e..###eeeeeeeeee..######...######e..###.eeeeeeee###",
	"###eee###.ee###e..###eee###...###e..#########......###eee###.ee###e..###e........###e",
	"###e...eee..###e..###e...ee######e..###eeeeeee.....###e...eee..###e..###e........###e",
	"###e........###e..###e......ee###e..############...###e........###e...ee#########.eee",
	".eee.........eee...eee.........eee...eeeeeeeeeeee...eee.........eee......eeeeeeeee",
}

// WordmarkSmall is the 57-cell cut, for narrower terminals.
var WordmarkSmall = []string{
	"##......##..##......##..########..##......##....######",
	"####..####e.####....##e.##eeeeeee.####..####e.##.eeeee##",
	"##ee##.e##e.##ee##..##e.######....##ee##.e##e.##e.....##e",
	"##e..ee.##e.##e..e####e.##eeeee...##e..ee.##e.##e.....##e",
	"##e.....##e.##e....e##e.########..##e.....##e..e######.ee",
	".ee......ee..ee......ee..eeeeeeee..ee......ee....eeeeee",
}

// walkA is one frame of the gait.
var walkA = []string{
	"..##.......##..##...",
	".#rr#.....########..",
	".#R#.....##OO####n#.",
	".###...############.",
	"..#####R##########..",
	"..###r####R#######..",
	"..################..",
	"..##..##....##..##..",
}

// walkB is one frame of the gait.
var walkB = []string{
	"..##.......##..##...",
	".#rr#.....########..",
	".#R#.....##OO####n#.",
	".###...############.",
	"..#####R##########..",
	"..###r####R#######..",
	"..################..",
	"...##..##..##..##...",
}

// walkC is one frame of the gait.
var walkC = []string{
	"..##.......##..##...",
	".#rr#.....########..",
	".#R#.....##OO####n#.",
	".###...############.",
	"..#####R##########..",
	"..###r####R#######..",
	"..################..",
	"..##...##...##...##.",
}

// Walk is the four-frame cycle, played A B C B so the legs gather, spread and
// gather again without a jump. A side view is not vanity: a cat walking
// towards you does not read as walking.
var Walk = [][]string{walkA, walkB, walkC, walkB}

// Ink turns one marker into a glyph pair and a colour.
//
// The face rule that must not be relaxed: AN OPEN EYE IS A HOLE IN THE COAT,
// not a drawn shape. Earlier drafts gave her drawn eyes and a mouth over a
// pale muzzle; at this scale that reads as a glare with teeth, and a mascot
// that greets you at install time must be calm. Negative space is calm, costs
// no colour, and survives any background. Blinking fills the hole.
func Ink(t *theme.Theme, marker rune) (wide, narrow string, style interface{ Render(...string) string }) {
	switch marker {
	case '#':
		return "██", "█", t.Coat
	case 'R':
		return "▓▓", "▓", t.Rosette
	case 'r':
		return "▒▒", "▒", t.Rosette
	case 'p':
		return "▒▒", "▒", peachStyle(t)
	case 'e':
		return "▒▒", "▒", t.Rosette
	case 'n':
		return "▄▄", "▄", t.Accent
	case 'O':
		return "  ", " ", t.Muted
	case '_':
		return "██", "█", t.Coat
	case '\\':
		return "╲ ", "╲", t.Muted
	case '-':
		return "──", "─", t.Muted
	case '/':
		return " ╱", "╱", t.Muted
	}
	return "  ", " ", t.Muted
}

// Paint renders marker art at the given scale.
//
// Runs are grouped by MARKER rather than by style value: two lipgloss.Styles
// that look the same are not required to compare equal, and comparing them
// with != is the kind of thing that works until the day it panics.
func Paint(t *theme.Theme, art []string, scale int) []string {
	out := make([]string, 0, len(art))
	for _, row := range art {
		var b strings.Builder
		var run strings.Builder
		var cur rune
		flush := func() {
			if run.Len() == 0 {
				return
			}
			_, _, st := Ink(t, cur)
			b.WriteString(st.Render(run.String()))
			run.Reset()
		}
		for _, m := range row {
			if run.Len() > 0 && m != cur {
				flush()
			}
			cur = m
			wide, narrow, _ := Ink(t, m)
			if scale == 1 {
				run.WriteString(narrow)
			} else {
				run.WriteString(wide)
			}
		}
		flush()
		out = append(out, strings.TrimRight(b.String(), " "))
	}
	return out
}

// Width is how many cells a piece of art occupies at a scale.
func Width(art []string, scale int) int {
	w := 0
	for _, r := range art {
		if n := len([]rune(r)) * scale; n > w {
			w = n
		}
	}
	return w
}

// WordmarkFor picks the largest wordmark that fits, or nil when even the
// small cut would wrap. A wordmark that wraps is not a wordmark.
func WordmarkFor(cols int) []string {
	if Width(Wordmark, ScaleWordmark)+4 <= cols {
		return Wordmark
	}
	if Width(WordmarkSmall, ScaleWordmark)+4 <= cols {
		return WordmarkSmall
	}
	return nil
}

// CatFor picks the largest cat that fits the width.
func CatFor(cols int) []string {
	if Width(CatSit, ScaleMascot)+4 <= cols {
		return CatSit
	}
	if Width(CatHead, ScaleMascot)+4 <= cols {
		return CatHead
	}
	return CatTiny
}

// Blinking reports whether the eyes are closed on this tick.
func Blinking(tick int) bool { return tick%BlinkEvery < BlinkFor }

// Blink swaps open eyes for closed ones.
func Blink(art []string) []string {
	out := make([]string, len(art))
	for i, r := range art {
		out[i] = strings.ReplaceAll(r, "O", "_")
	}
	return out
}

// Frame is the walk frame for a tick.
func Frame(tick int) []string {
	f := Walk[(tick/WalkEvery)%len(Walk)]
	if Blinking(tick) {
		return Blink(f)
	}
	return f
}

// Splash is the wordmark over the tagline, centred to width. It returns
// nothing below the width where the small wordmark would wrap — the tagline
// then stands alone, which is the caller's business, not ours.
func Splash(t *theme.Theme, cols int) []string {
	w := WordmarkFor(cols)
	if w == nil {
		return nil
	}
	return centre(Paint(t, w, ScaleWordmark), cols)
}

// Tagline is the one line, lowercase, no exclamation mark.
const Tagline = "memory that works like a brain"

func centre(lines []string, cols int) []string {
	out := make([]string, len(lines))
	for i, l := range lines {
		pad := (cols - ansi.StringWidth(l)) / 2
		if pad < 0 {
			pad = 0
		}
		out[i] = strings.Repeat(" ", pad) + l
	}
	return out
}
