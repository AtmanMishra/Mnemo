package theme

import (
	"image/color"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"
)

func TestWaveTravels(t *testing.T) {
	a := Wave(0, 12)
	b := Wave(1, 12)
	if a == b {
		t.Fatal("consecutive frames are identical: the band would not read as motion")
	}
	if Wave(0, 12) != Wave(DitherPeriod, 12) {
		t.Fatalf("wave must repeat after DitherPeriod=%d frames", DitherPeriod)
	}
	for i := 0; i < 40; i++ {
		if got := len([]rune(Wave(i, 12))); got != 12 {
			t.Fatalf("frame %d is %d cells, want 12 — a band that changes width shifts the layout", i, got)
		}
	}
}

func TestWaveAdjacentCellsDifferByOneStep(t *testing.T) {
	// This is what makes it read as travel rather than as noise.
	idx := map[rune]int{}
	for i, r := range Dither {
		idx[r] = i
	}
	for _, r := range Wave(3, 30) {
		if _, ok := idx[r]; !ok {
			t.Fatalf("wave drew %q, which is not on the ramp", r)
		}
	}
	f := []rune(Wave(3, 30))
	for i := 1; i < len(f); i++ {
		if d := idx[f[i]] - idx[f[i-1]]; d != 1 && d != -1 {
			t.Fatalf("cells %d and %d are %d steps apart, want 1", i-1, i, d)
		}
	}
}

func TestWaveNeverZeroWidth(t *testing.T) {
	if Wave(0, 0) == "" || Wave(0, -5) == "" {
		t.Fatal("a zero or negative width must still produce one cell, not an empty band")
	}
}

// --- the glyph family ----------------------------------------------------

// TestEveryGlyphIsTheWidthItsContractDeclares: the contract (roles) is the
// declaration; this is the check. Width is measured in CELLS with
// ansi.StringWidth, never in bytes or runes — a rune count says 2 for "▀▀" and
// also says 2 for "é" followed by anything, and only one of those is two cells.
//
// Width drift has already bitten this interface once: a one-cell marker in a
// two-cell column, and every line under it landed a column out. The test walks
// the STRUCT, so a field added to the set without a line in roles fails here
// rather than on somebody's screen.
func TestEveryGlyphIsTheWidthItsContractDeclares(t *testing.T) {
	v := reflect.ValueOf(Heavy)
	declared := map[string]int{}
	for _, r := range roles {
		if _, dup := declared[r.Field]; dup {
			t.Fatalf("%s is declared twice in roles", r.Field)
		}
		declared[r.Field] = r.Cells
	}
	for i := 0; i < v.NumField(); i++ {
		name := v.Type().Field(i).Name
		if v.Field(i).Kind() != reflect.String {
			t.Fatalf("Glyphs.%s is not a string; every field of the set is a glyph", name)
		}
		cells, ok := declared[name]
		if !ok {
			t.Fatalf("Glyphs.%s has no width in roles — declare what it must occupy, "+
				"or the next reader will discover it on a misaligned screen", name)
		}
		g := v.Field(i).String()
		if g == "" {
			t.Fatalf("Glyphs.%s is empty; an empty glyph is a missing element nobody noticed", name)
		}
		if got := ansi.StringWidth(g); got != cells {
			t.Fatalf("Glyphs.%s = %q renders %d cells, the contract says %d", name, g, got, cells)
		}
	}
}

// TestTheGutterIsTheFigure: the gutter is the one place the layout and the art
// have to agree on a number, and the number is the one the design page fixed
// before the figures were drawn — a two-cell figure, because the transcript
// already spends two columns on its gutter and none of these may widen it.
func TestTheGutterIsTheFigure(t *testing.T) {
	if GutterCells != 2 {
		t.Fatalf("GutterCells = %d; the gutter is the two-cell figure and nothing else", GutterCells)
	}
	for _, f := range []string{"User", "Agent", "Think", "Tool"} {
		g := reflect.ValueOf(Heavy).FieldByName(f).String()
		if got := ansi.StringWidth(g); got != GutterCells {
			t.Fatalf("%s is %d cells; the gutter is %d and may not widen", f, got, GutterCells)
		}
		// The air the prose needs is the figure's own last pixel: a figure that
		// ends in a full-height solid puts the words against a wall.
		last := []rune(g)[len([]rune(g))-1]
		if last == '█' || last == '▐' {
			t.Fatalf("%s ends in %q, which leaves no air before the prose", f, last)
		}
	}
	// The four figures must be distinguishable without colour: a reader who
	// has not learned the palette still has to see who is speaking.
	seen := map[string]string{}
	for _, f := range []string{"User", "Agent", "Think", "Tool"} {
		g := reflect.ValueOf(Heavy).FieldByName(f).String()
		if prev, dup := seen[g]; dup {
			t.Fatalf("%s and %s are the same figure (%q); colour alone must not be the difference", f, prev, g)
		}
		seen[g] = f
	}
}

// TestNoGlyphIsOrphaned: every glyph in the set is drawn by something.
//
// A character kept "for later" is the start of a second vocabulary: it is in
// the set, nothing renders it, and the next person redesigns the family around
// a glyph that is not on screen — which is how the six box-drawing corners and
// tees this family replaced survived so long. The check walks the fields and
// requires each name to appear in non-test source as a G.<Field> reference.
func TestNoGlyphIsOrphaned(t *testing.T) {
	root := moduleRoot(t)
	// One matcher per role, compiled once: `G.H` must not be satisfied by
	// `G.Hair`, and word boundaries are the cheap way to say that.
	type want struct {
		field string
		re    *regexp.Regexp
	}
	wants := make([]want, 0, len(roles))
	for _, r := range roles {
		wants = append(wants, want{r.Field, regexp.MustCompile(`\bG\.` + regexp.QuoteMeta(r.Field) + `\b`)})
	}
	used := map[string]int{}
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // an unreadable corner of the tree is not a glyph problem
		}
		if d.IsDir() {
			if name := d.Name(); name == ".git" || name == "testdata" || name == "node_modules" {
				return fs.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		if filepath.Base(path) == "theme.go" {
			return nil // the set itself does not count as a reader of itself
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		for _, w := range wants {
			if w.re.Match(src) {
				used[w.field]++
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walking the module: %v", err)
	}
	for _, r := range roles {
		if used[r.Field] == 0 {
			t.Errorf("Glyphs.%s is in the set and nothing draws it — either draw it or delete it", r.Field)
		}
	}
}

// moduleRoot walks up from the test's working directory to the go.mod.
func moduleRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("no go.mod above the test's directory")
		}
		dir = parent
	}
}

// TestTheFamilyIsBlockAndBoxDrawing: nothing outside the two ranges this
// language is made of, because those are the two a plain monospace font always
// has — and a glyph that needs a patched icon font is a blank cell for
// somebody. The ranges are named rather than derived from "looks like a box
// drawing character", so a stray em dash in a future glyph fails here.
func TestTheFamilyIsBlockAndBoxDrawing(t *testing.T) {
	inRange := func(r rune) (string, bool) {
		switch {
		case r == ' ':
			return "", true
		case r >= 0x2500 && r <= 0x257F:
			return "", true // box drawing: ─ │ ├ └
		case r >= 0x2580 && r <= 0x259F:
			return "", true // block elements: ▀ ▄ █ ▌ ▐ ▚
		case r >= 0x25A0 && r <= 0x25FF:
			return "", true // geometric shapes: the two fold triangles ▸ ▾
		}
		return "outside the block, box-drawing and geometric-shapes ranges", false
	}
	v := reflect.ValueOf(Heavy)
	for i := 0; i < v.NumField(); i++ {
		name := v.Type().Field(i).Name
		for _, r := range v.Field(i).String() {
			if why, ok := inRange(r); !ok {
				t.Fatalf("Glyphs.%s = %q contains %q (U+%04X): %s", name, v.Field(i).String(), r, r, why)
			}
		}
	}
}

// TestTreeGlyphsAlign: Branch, Last, Pipe and Gap are stacked vertically in a
// tree; if they are not all the same width the trunk bends. Declared in roles
// and checked again here, because this is the failure the declaration prevents.
func TestTreeGlyphsAlign(t *testing.T) {
	w := ansi.StringWidth(Heavy.Branch)
	for name, g := range map[string]string{"Last": Heavy.Last, "Pipe": Heavy.Pipe, "Gap": Heavy.Gap} {
		if ansi.StringWidth(g) != w {
			t.Fatalf("%s is %d cells, Branch is %d — the trunk would bend", name, ansi.StringWidth(g), w)
		}
	}
}

func TestLightThemeMovesOnlyTheGreys(t *testing.T) {
	d, l := New(PICO8, Heavy, true), New(PICO8, Heavy, false)
	if d.P.Accent != l.P.Accent || d.P.OK != l.P.OK || d.P.Fail != l.P.Fail || d.P.Coat != l.P.Coat {
		t.Fatal("accent and state colours must hold on either ground; only the greys may move")
	}
	if d.P.Ink == l.P.Ink {
		t.Fatal("body ink must change on a light terminal or it is unreadable")
	}
}

func TestPaletteIsFourteenDistinctColours(t *testing.T) {
	seen := map[string]string{}
	for name, c := range map[string]interface {
		RGBA() (uint32, uint32, uint32, uint32)
	}{
		"Ground": PICO8.Ground, "Ink": PICO8.Ink, "Muted": PICO8.Muted, "Faint": PICO8.Faint,
		"Accent": PICO8.Accent, "Thinking": PICO8.Thinking, "Coat": PICO8.Coat,
		"Rosette": PICO8.Rosette, "Peach": PICO8.Peach, "OK": PICO8.OK, "Fail": PICO8.Fail,
		"Warn": PICO8.Warn, "Link": PICO8.Link, "Deep": PICO8.Deep,
	} {
		r, g, b, _ := c.RGBA()
		k := string(rune(r)) + string(rune(g)) + string(rune(b))
		if prev, dup := seen[k]; dup {
			t.Fatalf("%s and %s are the same colour; a role without its own colour is not a role", name, prev)
		}
		seen[k] = name
	}
	if len(seen) != 14 {
		t.Fatalf("palette has %d colours, want 14", len(seen))
	}
}

func TestSpinnerIsBraille(t *testing.T) {
	if len(Spinner) != 10 {
		t.Fatalf("spinner has %d frames, want 10", len(Spinner))
	}
	for _, f := range Spinner {
		if !strings.ContainsFunc(f, func(r rune) bool { return r >= 0x2800 && r <= 0x28FF }) {
			t.Fatalf("spinner frame %q is not braille", f)
		}
	}
}

// --- the presets a reader can choose -------------------------------------

// TestEveryPresetIsAWholePalette: fourteen roles, no zeroes. A preset missing
// one draws that role as the terminal's default in a palette that was chosen
// for its colours, and the failure only appears on the screen of whoever picks
// it — which is exactly the bug a picker full of half-filled values ships.
func TestEveryPresetIsAWholePalette(t *testing.T) {
	seen := map[string]bool{}
	for _, p := range Presets() {
		if p.Name == "" || p.Desc == "" {
			t.Fatalf("a preset with no name or no description is a blank picker row: %#v", p)
		}
		if p.Name != strings.ToLower(p.Name) {
			t.Fatalf("preset names are what theme.json holds; %q is not canonical", p.Name)
		}
		if seen[p.Name] {
			t.Fatalf("%q appears twice; the picker would list one name two ways", p.Name)
		}
		seen[p.Name] = true
		for role, c := range map[string]color.Color{
			"ground": p.P.Ground, "ink": p.P.Ink, "muted": p.P.Muted,
			"faint": p.P.Faint, "accent": p.P.Accent, "thinking": p.P.Thinking,
			"coat": p.P.Coat, "rosette": p.P.Rosette, "peach": p.P.Peach,
			"ok": p.P.OK, "fail": p.P.Fail, "warn": p.P.Warn,
			"link": p.P.Link, "deep": p.P.Deep,
		} {
			if c == nil {
				t.Fatalf("%s leaves %s unset", p.Name, role)
			}
		}
	}
}

// TestTheShippingPaletteIsTheFirstRow: the picker marks the one in force, and
// a reader who has never chosen anything is looking at the shipping palette.
// If the first row is not that, the first thing the picker says is wrong.
func TestTheShippingPaletteIsTheFirstRow(t *testing.T) {
	if got := Presets()[0].Name; got != Shipping {
		t.Fatalf("the first row is %q, but a fresh install draws %q", got, Shipping)
	}
	if p, ok := ByName(Shipping); !ok || p != PICO8 {
		t.Fatalf("ByName(%q) = %v, %v; the default name must resolve to the shipping palette", Shipping, p, ok)
	}
}

// TestByNameSaysNoRatherThanGuessing: the name comes out of a file, so the
// answers that matter are the lenient ones (case, stray spaces) and the honest
// one for a name that is not a palette.
func TestByNameSaysNoRatherThanGuessing(t *testing.T) {
	if _, ok := ByName("  POTTERY "); !ok {
		t.Fatal("a name from a file may carry case and spaces; folding them is not guessing")
	}
	if _, ok := ByName("marble"); ok {
		t.Fatal("a palette that is not offered must not resolve — the picker's list and this map cannot disagree")
	}
	if _, ok := ByName(""); ok {
		t.Fatal("no name is not a palette")
	}
}
