package theme

import (
	"strings"
	"testing"
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

func TestGlyphsAreSingleWidthAndPortable(t *testing.T) {
	// Everything must live in the block or box-drawing ranges. A glyph that
	// needs a patched icon font is a blank cell for somebody.
	for name, g := range map[string]string{
		"User": Heavy.User, "Agent": Heavy.Agent, "Think": Heavy.Think,
		"Tool": Heavy.Tool, "Closed": Heavy.Closed, "Open": Heavy.Open,
		"H": Heavy.H, "V": Heavy.V, "Seg": Heavy.Seg, "Tick": Heavy.Tick,
	} {
		for _, r := range g {
			// U+00B7 MIDDLE DOT is Latin-1 and present in every monospace
			// font ever shipped; everything else must be box-drawing or block.
			if r < 0x2000 && r != 0x00B7 {
				t.Fatalf("%s = %q contains %q below U+2000; use a block or box-drawing glyph", name, g, r)
			}
			if r > 0x2600 {
				t.Fatalf("%s = %q contains %q above U+2600 — that is emoji or icon-font territory", name, g, r)
			}
		}
	}
}

func TestTreeGlyphsAlign(t *testing.T) {
	// Branch, Last, Pipe and Gap are stacked vertically in a tree; if they are
	// not all the same width the trunk bends.
	w := len([]rune(Heavy.Branch))
	for name, g := range map[string]string{"Last": Heavy.Last, "Pipe": Heavy.Pipe, "Gap": Heavy.Gap} {
		if len([]rune(g)) != w {
			t.Fatalf("%s is %d cells, Branch is %d — the trunk would bend", name, len([]rune(g)), w)
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
	for name, c := range map[string]interface{ RGBA() (uint32, uint32, uint32, uint32) }{
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
