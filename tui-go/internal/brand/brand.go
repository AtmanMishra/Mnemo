// Package brand is the creatures and the wordmark.
//
// Art is stored as MARKER strings, never as pre-coloured spans, so the shape
// and the palette stay one thing each. Ink is the only place a marker becomes a
// glyph and a colour, and Pixels is the one table that says which marker is
// which role — the docs page reads the same table, because a second copy of
// "which marker is the accent" is a second copy that drifts.
//
// The material is the half block. A terminal cell is two pixels tall, so one
// art character is a 2x2-pixel block at ScaleMascot and a 1x2-pixel block at
// scale 1. Every creature below is five characters by five rows: twenty-five
// marks, which is the size at which somebody reading the source can redraw one
// in half a minute. That is the point of replacing a twenty-row Bengal cat with
// four tones, a spotted belly and a walk cycle: the cat was beautiful and
// nobody could change it.
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
//
// The mascot is drawn at two cells per art character, because a terminal cell
// is about twice as tall as it is wide: at one cell a mark would be a squashed
// 2x1 rectangle, at two it is a square 2x2 pixel — which is what makes the
// figures read as pixel art rather than as stretched text. The wordmark is
// already stored at cell resolution — its strokes are three cells thick — so it
// draws at one. Confusing the two doubles the logo; that has happened.
const (
	ScaleMascot   = 2
	ScaleWordmark = 1
)

// Gait timing. 47 is prime so a blink never lands on the same footfall twice:
// a creature that blinks on the same step every time looks like a machine.
const (
	WalkEvery  = 3
	BlinkEvery = 47
	BlinkFor   = 2
)

// MinWalkCols is the width below which the welcome shows prose only.
//
// The figure is ten cells; the tagline under it is thirty-one. A welcome whose
// tagline is cut in half is worse than a welcome with no figure at all, and
// this is the number that decides which of those two you get.
const MinWalkCols = 36

// Pixel is one art character: the marker in the art, what it draws at each
// scale, and the ROLE it paints.
//
// The role is a word rather than a style because the art is drawn by more than
// one renderer — the terminal, and the docs page in HTML — and both have to
// agree on which mark is the accent without either holding a second table.
type Pixel struct {
	Marker rune
	Role   string // coat, detail, highlight, accent, or empty for a hole
	Wide   string // what one mark draws at ScaleMascot (2 cells, 2 pixels)
	Narrow string // and at scale 1 (1 cell, 2 pixels)
}

// Pixels is the whole art vocabulary.
//
// Every one of these is a half block or a dither from the ramp in theme.Dither:
// one vocabulary, used twice — the ramp that animates a thinking block is the
// same ink the wings and the stripes are drawn from. If the ramp changes, the
// creatures change with it, and that is correct.
var Pixels = []Pixel{
	{'#', "coat", "██", "█"},      // the body
	{'u', "coat", "▀▀", "▀"},      // the body's upper pixel: a raised limb, a wing up
	{'v', "coat", "▄▄", "▄"},      // the body's lower pixel: a thin leg, a claw held low
	{'r', "detail", "▒▒", "▒"},    // detail, light — a plate, a band
	{'R', "detail", "▓▓", "▓"},    // detail, heavy — a stripe
	{'e', "detail", "▒▒", "▒"},    // the wordmark's lip
	{'p', "highlight", "▒▒", "▒"}, // the one highlight: inner ear, wing, a thought forming
	{'n', "accent", "▄▄", "▄"},    // THE accent: one run per creature, never more
	{'O', "", "  ", " "},          // an eye: a hole in the body, never a drawn shape
	{'_', "coat", "██", "█"},      // what a blink fills the hole with
}

// byMarker indexes Pixels, built once.
var byMarker = func() map[rune]Pixel {
	m := make(map[rune]Pixel, len(Pixels))
	for _, p := range Pixels {
		m[p.Marker] = p
	}
	return m
}()

// Ink turns one marker into a glyph pair and the style that paints it.
//
// The face rule that must not be relaxed: AN EYE IS A HOLE IN THE BODY, not a
// drawn shape. Drawn eyes plus a mouth over a pale muzzle read as a glare with
// teeth at this size — that version shipped once and was rejected. Negative
// space is calm, costs no colour, and survives any background. Blinking fills
// the hole.
func Ink(t *theme.Theme, marker rune) (wide, narrow string, style interface{ Render(...string) string }) {
	p, ok := byMarker[marker]
	if !ok {
		// A marker with no entry draws as nothing. Silence is the right
		// failure: an unknown marker that draws a visible block would put a
		// shape in the art that nobody asked for, and it would be found by
		// looking, not by the compiler.
		return "  ", " ", t.Muted
	}
	switch p.Role {
	case "coat":
		return p.Wide, p.Narrow, t.Coat
	case "detail":
		return p.Wide, p.Narrow, t.Rosette
	case "highlight":
		return p.Wide, p.Narrow, peachStyle(t)
	case "accent":
		return p.Wide, p.Narrow, t.Accent
	}
	return p.Wide, p.Narrow, t.Muted // a hole: drawn as blank, so the ground shows through
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

// Pose is one frame of a creature: its art, and why it is drawn that way.
type Pose struct {
	Name string
	Why  string
	Art  []string
}

// Creature is one of the figures, in every pose it wears.
//
// Three of them, not one complicated one, because a mascot whose job is to say
// "hello, I am not a hang" on an empty screen should be replaceable in an
// evening: twenty-five marks per pose, four poses, no walk cycle to redraw in
// four frames that differ only in the legs.
type Creature struct {
	Name  string // the name in the register the design doc set
	Ep    string // one line: why this creature and not another
	Idle  []string
	Bob   []string
	Think []string
}

// The three creatures, in the Greek/Mnemo register DESIGN.md §18 already set:
// animals that were already looking at us, holding on, or carrying things home.
var (
	// Karkinos is the crab — the one that holds on.
	//
	// The claws are held one pixel low (v at the top) so the figure reads as
	// claws ABOUT to close rather than as horns; the mouth is the single
	// accent, so the one coloured pixel on the line is the one that speaks.
	Karkinos = Creature{
		Name: "Karkinos",
		Ep:   "the crab — memory is the thing that holds on. His claws are held one pixel low, about to close.",
		Idle: []string{
			"v...v",
			"#####",
			"#O#O#",
			"##n##",
			"v.v.v",
		},
		Bob: []string{
			"#...#",
			"#####",
			"#O#O#",
			"##n##",
			"#.#.#",
		},
		Think: []string{
			"v...v",
			"#####",
			"#O#O#",
			"##n##",
			"#####",
		},
	}

	// Glaux is the owl — the one that was already watching.
	//
	// Athena's bird, and the oldest western emblem of knowledge that simply
	// looks at you. The beak is the accent and sits between two eye holes, so
	// the eyes are the space either side of it.
	Glaux = Creature{
		Name: "Glaux",
		Ep:   "the owl — Athena's bird, the one that was already watching. Eyes are holes; the beak between them is the accent.",
		Idle: []string{
			"#...#",
			"#####",
			"#OnO#",
			"#####",
			"v.v.v",
		},
		Bob: []string{
			"#...#",
			"#####",
			"#OnO#",
			"#####",
			"#.#.#",
		},
		Think: []string{
			"#.p.#",
			"#####",
			"#OnO#",
			"#####",
			"#####",
		},
	}

	// Melissa is the bee — the one that carries it home.
	//
	// The bee was Ephesus's mark and Delphi's priestesses were the melissae.
	// The wings are the highlight tone, the stripe band is the detail tone, and
	// the stinger is the one accent pixel, so the creature's one coloured mark
	// is the thing it works with.
	Melissa = Creature{
		Name: "Melissa",
		Ep:   "the bee — Ephesus's mark, and the melissae were Delphi's priestesses: the one that carries it home.",
		Idle: []string{
			".p.p.",
			"#O#O#",
			"#####",
			"RRRRR",
			"..n..",
		},
		Bob: []string{
			".u.u.", // wings up: the dither highlight becomes a raised pixel
			"#O#O#",
			"#####",
			"RRRRR",
			"..n..",
		},
		Think: []string{
			"p.p.p",
			"#O#O#",
			"#####",
			"RRRRR",
			"..n..",
		},
	}
)

// Creatures is every creature, shipping first.
var Creatures = []Creature{Karkinos, Glaux, Melissa}

// Shipping is the figure the interface shows: the crab, because the reference
// pack is crab-shaped and because claws are the plainest thing to redraw.
var Shipping = Karkinos

// ByName resolves a creature, case-insensitively — for a picker, and for the
// docs, which name them.
func ByName(name string) (Creature, bool) {
	want := strings.ToLower(strings.TrimSpace(name))
	for _, c := range Creatures {
		if strings.ToLower(c.Name) == want {
			return c, true
		}
	}
	return Creature{}, false
}

// Poses is every frame a creature wears, in the order the docs page shows them:
// the four the design asks for, each with the reason it is drawn that way.
//
// Blink is a derived frame rather than art anyone drew: it is Idle with the eye
// holes filled, which is why "blinking" can never fall out of step with the
// body — there is no second drawing to keep in sync.
func (c Creature) Poses() []Pose {
	return []Pose{
		{"idle", "At rest. The one frame that must be legible on its own, because it is the one the welcome screen shows.", c.Idle},
		{"blink", "The eye holes filled with body: derived, never drawn. A blink cannot drift out of step with the body it blinks on.", Blink(c.Idle)},
		{"bob", "The other foot: the limbs move, the body does not. Two rows differ from idle and that is the whole walk.", c.Bob},
		{"thinking", "Attending: pulled in, with the work showing. A creature that looks the same while it thinks is a logo.", c.Think},
	}
}

// Blinking reports whether the eyes are closed on this tick.
func Blinking(tick int) bool { return tick%BlinkEvery < BlinkFor }

// Bobbing reports whether the creature is on its other foot this tick.
func Bobbing(tick int) bool { return (tick/WalkEvery)%2 == 1 }

// Blink swaps open eyes for closed ones: the hole gets filled with body.
func Blink(art []string) []string {
	out := make([]string, len(art))
	for i, r := range art {
		out[i] = strings.ReplaceAll(r, "O", "_")
	}
	return out
}

// Pose is the frame a creature shows at a tick: the bob on the walk beat, the
// eyes closed on the blink window.
//
// Blink wins over bob. It is the rarer event, and a creature caught mid-step
// with its eyes shut still reads as itself — suppressing the blink instead
// would make it almost invisible, which is the same as not drawing it.
func (c Creature) Pose(tick int) []string {
	art := c.Idle
	if Bobbing(tick) {
		art = c.Bob
	}
	if Blinking(tick) {
		art = Blink(art)
	}
	return art
}

// Frame is the shipping creature's frame for a tick. It exists because the
// animation is one call for the callers that do not care which creature it is.
func Frame(tick int) []string { return Shipping.Pose(tick) }

// CatFor picks the figure that fits the width, or nil when even the smallest
// would be cropped — the welcome then stands on its tagline alone.
//
// The name is the caller's: app/view.go has called it this since the mascot was
// a cat. Renaming it would rename it there too, and the figure it returns is
// now a creature of five marks by five rows rather than a twenty-row Bengal.
func CatFor(cols int) []string {
	if Width(Shipping.Idle, ScaleMascot)+4 <= cols {
		return Shipping.Idle
	}
	return nil
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

// Splash is the wordmark, centred to width. It returns nothing below the width
// where the small wordmark would wrap — the tagline then stands alone, which is
// the caller's business, not ours.
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
