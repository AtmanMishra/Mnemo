package brand

import (
	"strings"
	"testing"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/theme"
	"github.com/charmbracelet/x/ansi"
)

func th() *theme.Theme { return theme.Default() }

func TestAnOpenEyeIsAHoleInTheCoat(t *testing.T) {
	// The rule that must not be relaxed. Drawn eyes plus a mouth read as a
	// glare with teeth at this scale; that version was shipped and rejected.
	wide, _, _ := Ink(th(), 'O')
	if strings.TrimSpace(wide) != "" {
		t.Fatalf("an open eye rendered %q; it must be negative space", wide)
	}
	closed, _, _ := Ink(th(), '_')
	if closed != "██" {
		t.Fatalf("blinking must fill the hole with coat, got %q", closed)
	}
}

func TestThereIsNoMouth(t *testing.T) {
	for _, art := range [][]string{CatSit, CatHead, CatTiny, walkA, walkB, walkC} {
		for _, row := range art {
			if strings.ContainsAny(row, "m") {
				t.Fatalf("a mouth marker survives in %q; at two cells per pixel every mouth is a grimace", row)
			}
		}
	}
}

func TestTheNoseIsTheOnlyAccentPixel(t *testing.T) {
	// The brand colour is the cat's nose. More than one accent run and it
	// stops being a detail and becomes decoration.
	n := 0
	for _, row := range CatSit {
		n += strings.Count(row, "n")
	}
	if n != 2 {
		t.Fatalf("CatSit has %d accent cells; the nose is one run of two", n)
	}
}

func TestRosettesComeFromTheDitherRamp(t *testing.T) {
	// One vocabulary, used twice: if the ramp changes, the cat changes with
	// it, and that is correct.
	ramp := string(theme.Dither)
	for _, m := range []rune{'R', 'r'} {
		wide, _, _ := Ink(th(), m)
		for _, g := range wide {
			if !strings.ContainsRune(ramp, g) {
				t.Fatalf("marker %q draws %q, which is not on the dither ramp %q", m, g, ramp)
			}
		}
	}
}

func TestMascotDrawsTwoCellsPerMarkerAndTheWordmarkOne(t *testing.T) {
	// Getting this backwards doubles the logo. It has happened.
	cat := Paint(th(), CatSit, ScaleMascot)
	if got, want := ansi.StringWidth(cat[2]), len([]rune(CatSit[2]))*2; got > want {
		t.Fatalf("mascot row is %d cells, want at most %d", got, want)
	}
	longest := 0
	for _, r := range Wordmark {
		if n := len([]rune(r)); n > longest {
			longest = n
		}
	}
	if Width(Wordmark, ScaleWordmark) != longest {
		t.Fatalf("the wordmark is stored at cell resolution: Width=%d, longest row=%d",
			Width(Wordmark, ScaleWordmark), longest)
	}
}

func TestTheWordmarkIsDroppedRatherThanWrapped(t *testing.T) {
	if WordmarkFor(200) == nil {
		t.Fatal("a wide terminal gets the full wordmark")
	}
	if got := WordmarkFor(70); got == nil || Width(got, ScaleWordmark) >= Width(Wordmark, ScaleWordmark) {
		t.Fatal("83 cells of logo needs 87 columns; below that the small cut takes over")
	}
	if WordmarkFor(20) != nil {
		t.Fatal("below the small cut the wordmark is dropped entirely — a wordmark that wraps is not a wordmark")
	}
}

func TestPaintNeverExceedsTheArtWidth(t *testing.T) {
	for _, art := range [][]string{CatSit, CatHead, CatTiny, Wordmark, WordmarkSmall} {
		for _, scale := range []int{1, 2} {
			w := Width(art, scale)
			for _, l := range Paint(th(), art, scale) {
				if got := ansi.StringWidth(l); got > w {
					t.Fatalf("painted row is %d cells, art is %d", got, w)
				}
			}
		}
	}
}

func TestTheGaitLoopsWithoutAJump(t *testing.T) {
	if len(Walk) != 4 {
		t.Fatalf("the cycle is %d frames, want 4", len(Walk))
	}
	// A B C B: the first and third frames must differ, and the second and
	// fourth must be the same, or the legs stutter at the loop point.
	if sameArt(Walk[0], Walk[2]) {
		t.Fatal("frames A and C are identical; the legs never spread")
	}
	if !sameArt(Walk[1], Walk[3]) {
		t.Fatal("the cycle must return through the same middle frame or it jumps")
	}
}

func sameArt(a, b []string) bool { return strings.Join(a, "\n") == strings.Join(b, "\n") }

func TestBlinkNeverSyncsWithTheGait(t *testing.T) {
	// 47 is prime for this reason: a cat that blinks on the same footfall
	// every time looks like a machine.
	if BlinkEvery%WalkEvery == 0 {
		t.Fatalf("BlinkEvery=%d is a multiple of WalkEvery=%d", BlinkEvery, WalkEvery)
	}
	blinks := 0
	for i := 0; i < BlinkEvery*3; i++ {
		if Blinking(i) {
			blinks++
		}
	}
	if blinks != BlinkFor*3 {
		t.Fatalf("%d blink frames over three cycles, want %d", blinks, BlinkFor*3)
	}
}

func TestFrameClosesTheEyesWhileBlinking(t *testing.T) {
	open := strings.Join(Frame(WalkEvery*2), "\n")
	if !strings.Contains(open, "O") {
		t.Fatal("an unblinking frame keeps its eye holes")
	}
	if strings.Contains(strings.Join(Frame(0), "\n"), "O") {
		t.Fatal("tick 0 is inside the blink window and must have closed eyes")
	}
}

func TestSplashIsCentredAndSilentWhenTooNarrow(t *testing.T) {
	if Splash(th(), 20) != nil {
		t.Fatal("below the small wordmark the splash gives up and the tagline stands alone")
	}
	lines := Splash(th(), 120)
	if len(lines) == 0 {
		t.Fatal("a wide terminal gets a splash")
	}
	for _, l := range lines {
		if ansi.StringWidth(l) > 120 {
			t.Fatalf("splash row is %d cells", ansi.StringWidth(l))
		}
		if !strings.HasPrefix(l, " ") {
			t.Fatal("the splash is centred, so every row is padded")
		}
	}
}

func TestCatForShrinksRatherThanCropping(t *testing.T) {
	if got := len(CatFor(200)); got != len(CatSit) {
		t.Fatalf("a wide terminal gets the full cat, got %d rows", got)
	}
	if got := len(CatFor(40)); got != len(CatHead) {
		t.Fatalf("a middling terminal gets the head, got %d rows", got)
	}
	if got := len(CatFor(10)); got != len(CatTiny) {
		t.Fatalf("a narrow terminal gets the tiny cat, got %d rows", got)
	}
}

func TestTaglineHasNoExclamationMark(t *testing.T) {
	if Tagline != strings.ToLower(Tagline) || strings.Contains(Tagline, "!") {
		t.Fatalf("tagline = %q", Tagline)
	}
}
