package brand

import (
	"flag"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/theme"
	"github.com/charmbracelet/x/ansi"
)

func th() *theme.Theme { return theme.Default() }

// TestAnEyeIsAHoleInTheBody: the rule that must not be relaxed. Drawn eyes
// plus a mouth read as a glare with teeth at this size; that version shipped
// once and was rejected. A closed eye is the same hole filled with body.
func TestAnEyeIsAHoleInTheBody(t *testing.T) {
	wide, _, _ := Ink(th(), 'O')
	if strings.TrimSpace(wide) != "" {
		t.Fatalf("an eye rendered %q; it must be negative space", wide)
	}
	closed, _, _ := Ink(th(), '_')
	if closed != "██" {
		t.Fatalf("blinking must fill the hole with the body, got %q", closed)
	}
}

func TestThereIsNoMouthMarker(t *testing.T) {
	// A mouth marker at two cells per mark is a grimace; the accent pixel is
	// the only thing allowed where a mouth would go.
	for _, c := range Creatures {
		for _, p := range c.Poses() {
			for _, row := range p.Art {
				if strings.ContainsAny(row, "m") {
					t.Fatalf("%s/%s has a mouth marker in %q", c.Name, p.Name, row)
				}
			}
		}
	}
}

// TestTheAccentIsOneRunPerPose: the brand colour has to stay a detail. Two
// runs and it is decoration; nothing at all and the creature has no face.
func TestTheAccentIsOneRunPerPose(t *testing.T) {
	for _, c := range Creatures {
		for _, p := range c.Poses() {
			runs, prev := 0, false
			for _, row := range p.Art {
				for _, m := range row {
					if m == 'n' {
						if !prev {
							runs++
						}
						prev = true
					} else {
						prev = false
					}
				}
			}
			if runs != 1 {
				t.Fatalf("%s/%s has %d accent runs; one is the rule", c.Name, p.Name, runs)
			}
		}
	}
}

func TestTheDetailTonesComeFromTheDitherRamp(t *testing.T) {
	// One vocabulary, used twice: if the ramp changes, the creatures change
	// with it, and that is correct.
	ramp := string(theme.Dither)
	for _, p := range Pixels {
		if p.Role != "detail" && p.Role != "highlight" {
			continue
		}
		for _, g := range p.Wide {
			if !strings.ContainsRune(ramp, g) {
				t.Fatalf("marker %q draws %q, which is not on the dither ramp %q", p.Marker, g, ramp)
			}
		}
	}
}

// TestEveryMarkerHasAMeaning: a character in the art that is not in Pixels
// draws as nothing — the creature quietly loses a limb and nothing fails. This
// is the test that makes that a failure.
func TestEveryMarkerHasAMeaning(t *testing.T) {
	known := map[rune]bool{'.': true} // '.' is the art's own "nothing here"
	for _, p := range Pixels {
		if known[p.Marker] {
			t.Fatalf("marker %q is declared twice", p.Marker)
		}
		known[p.Marker] = true
		if p.Role == "" && p.Wide != "  " {
			t.Fatalf("marker %q has no role but draws %q; a roled mark is colour, and colour needs a role", p.Marker, p.Wide)
		}
	}
	for _, c := range Creatures {
		for _, p := range c.Poses() {
			for _, row := range p.Art {
				for _, m := range row {
					if !known[m] {
						t.Fatalf("%s/%s uses marker %q, which draws nothing", c.Name, p.Name, m)
					}
				}
			}
		}
	}
}

// TestEveryPoseIsTheSameSize is the one that keeps the layout still.
//
// Animation must not be able to jitter the frame: every pose of every creature
// is five marks by five rows, and every one of them paints to exactly ten
// cells, so swapping a frame mid-draw cannot move anything else on the screen.
func TestEveryPoseIsTheSameSize(t *testing.T) {
	const (
		marks = 5
		rows  = 5
		cells = marks * 2
	)
	for _, c := range Creatures {
		for _, p := range c.Poses() {
			if len(p.Art) != rows {
				t.Fatalf("%s/%s is %d rows, want %d", c.Name, p.Name, len(p.Art), rows)
			}
			for i, row := range p.Art {
				if got := len([]rune(row)); got != marks {
					t.Fatalf("%s/%s row %d is %d marks, want %d", c.Name, p.Name, i, got, marks)
				}
			}
			painted := Paint(th(), p.Art, ScaleMascot)
			if len(painted) != rows {
				t.Fatalf("%s/%s painted %d rows", c.Name, p.Name, len(painted))
			}
			for i, line := range painted {
				if got := ansi.StringWidth(line); got != cells {
					t.Fatalf("%s/%s painted row %d is %d cells, want %d — the frame would jitter",
						c.Name, p.Name, i, got, cells)
				}
			}
			if got := Width(p.Art, ScaleMascot); got != cells {
				t.Fatalf("%s/%s measures %d cells, want %d", c.Name, p.Name, got, cells)
			}
		}
	}
}

// TestThePosesAreDifferentFrames: a pose that is identical to idle is a pose
// nobody can see, and the animation would look like a still image with a
// battery cost.
func TestThePosesAreDifferentFrames(t *testing.T) {
	same := func(a, b []string) bool { return strings.Join(a, "\n") == strings.Join(b, "\n") }
	for _, c := range Creatures {
		if same(c.Idle, c.Bob) {
			t.Fatalf("%s: the bob frame is identical to idle", c.Name)
		}
		if same(c.Idle, c.Think) {
			t.Fatalf("%s: the thinking frame is identical to idle", c.Name)
		}
		if same(c.Bob, c.Think) {
			t.Fatalf("%s: the thinking frame is identical to the bob", c.Name)
		}
		if same(Blink(c.Idle), c.Idle) {
			t.Fatalf("%s: blinking changes nothing — the eyes are not holes in this art", c.Name)
		}
		// The blink must be the SAME SHAPE as the frame it blinks on, or the
		// creature twitches when it closes its eyes.
		if got, want := len(Blink(c.Idle)), len(c.Idle); got != want {
			t.Fatalf("%s: blink is %d rows, idle is %d", c.Name, got, want)
		}
	}
}

func TestPaintNeverExceedsTheArtWidth(t *testing.T) {
	art := [][]string{Wordmark, WordmarkSmall}
	for _, c := range Creatures {
		for _, p := range c.Poses() {
			art = append(art, p.Art)
		}
	}
	for _, a := range art {
		for _, scale := range []int{1, 2} {
			w := Width(a, scale)
			for _, l := range Paint(th(), a, scale) {
				if got := ansi.StringWidth(l); got > w {
					t.Fatalf("painted row is %d cells, art is %d", got, w)
				}
			}
		}
	}
}

func TestMascotDrawsTwoCellsPerMarkAndTheWordmarkOne(t *testing.T) {
	// Getting this backwards doubles the logo. It has happened.
	painted := Paint(th(), Karkinos.Idle, ScaleMascot)
	if got, want := ansi.StringWidth(painted[1]), len([]rune(Karkinos.Idle[1]))*2; got != want {
		t.Fatalf("the figure is %d cells, want %d", got, want)
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

func TestCatForDropsTheFigureRatherThanCropping(t *testing.T) {
	if got := CatFor(200); len(got) != len(Shipping.Idle) {
		t.Fatalf("a wide terminal gets the figure, got %d rows", len(got))
	}
	// A cropped creature is worse than no creature: at the width where the
	// figure would lose a claw, the welcome stands on the tagline instead.
	if got := CatFor(Width(Shipping.Idle, ScaleMascot)); got != nil {
		t.Fatal("the figure must be dropped, not cropped, when the margin is gone")
	}
	if MinWalkCols < Width(Shipping.Idle, ScaleMascot) {
		t.Fatalf("MinWalkCols=%d is below the figure's own width", MinWalkCols)
	}
}

func TestTheShipIsOneOfTheCreatures(t *testing.T) {
	found := false
	for _, c := range Creatures {
		if c.Name == Shipping.Name {
			found = true
		}
	}
	if !found {
		t.Fatalf("the shipping figure %q is not in the list the docs and the picker read", Shipping.Name)
	}
	if len(Creatures) != 3 {
		t.Fatalf("%d creatures; the design is three simple ones, not a collection", len(Creatures))
	}
	seen := map[string]bool{}
	for _, c := range Creatures {
		if c.Name == "" || c.Ep == "" {
			t.Fatalf("a creature with no name or no epithet is an unnamed figure in a picker: %#v", c)
		}
		if seen[strings.ToLower(c.Name)] {
			t.Fatalf("%q appears twice", c.Name)
		}
		seen[strings.ToLower(c.Name)] = true
		if _, ok := ByName(" " + strings.ToUpper(c.Name) + " "); !ok {
			t.Fatalf("ByName must fold case and space; %q did not resolve", c.Name)
		}
		if len(c.Poses()) != 4 {
			t.Fatalf("%s has %d poses; idle, blink, bob and thinking are the four", c.Name, len(c.Poses()))
		}
	}
	if _, ok := ByName("nyx"); ok {
		t.Fatal("the cat is gone; a name that resolves to nothing is a name in the picker that does nothing")
	}
}

func TestBobbingIsEveryOtherBeat(t *testing.T) {
	// The creature is on its other foot for one beat in two, and never twice
	// in a row — a bob that stutters reads as a rendering fault.
	prev := Bobbing(0)
	changes := 0
	for tick := 1; tick < WalkEvery*4; tick++ {
		now := Bobbing(tick)
		if now != prev {
			changes++
		}
		prev = now
	}
	if changes != 3 {
		t.Fatalf("%d footfalls in four beats, want 3", changes)
	}
}

func TestBlinkNeverSyncsWithTheGait(t *testing.T) {
	// 47 is prime for this reason: a creature that blinks on the same footfall
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

func TestFrameIsTheShippingCreature(t *testing.T) {
	// Tick 6 is a beat where the creature is not bobbing and not blinking —
	// the one frame that must be the idle art exactly.
	if !sameArt(Frame(WalkEvery*2), Shipping.Idle) {
		t.Fatal("Frame must be the shipping creature's own frame, or the animation is of a figure nobody ships")
	}
	if !sameArt(Frame(WalkEvery), Shipping.Bob) {
		t.Fatal("the bob beat must show the bob frame")
	}
}

func sameArt(a, b []string) bool { return strings.Join(a, "\n") == strings.Join(b, "\n") }

// --- the generated docs --------------------------------------------------

// updateDocs is the golden flag's twin: the docs are rendered from the source,
// and the only way to change them is to change the source and re-render.
var updateDocs = flag.Bool("update-docs", false, "rewrite docs/design-preview.html and docs/mascots.md from the source values")

// TestDocsAreGeneratedFromTheSource is the property, not a formality.
//
// docs/design-preview.html used to be hand-written: it showed the palette, the
// glyphs and the mascots, and every one of them was a copy. A copy of a preview
// is wrong within a day, and wrong in the way that reads as authoritative. So
// the page is rendered here from the live values and this test fails the moment
// the file on disk and the source disagree — the same contract the golden
// frames have, for the same reason.
func TestDocsAreGeneratedFromTheSource(t *testing.T) {
	root := repoRoot(t)
	for _, d := range Docs() {
		path := filepath.Join(root, filepath.FromSlash(d.Path))
		if *updateDocs {
			if err := os.WriteFile(path, []byte(d.Body), 0o644); err != nil {
				t.Fatalf("writing %s: %v", d.Path, err)
			}
			t.Logf("wrote %s (%d bytes)", d.Path, len(d.Body))
			continue
		}
		got, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("%s: %v — generate it with -update-docs", d.Path, err)
		}
		if string(got) != d.Body {
			t.Fatalf("%s is not what the source renders.\nRun: cd tui-go && go test ./internal/brand/ -run Docs -update-docs\nthen read the diff before keeping it.", d.Path)
		}
	}
}

// repoRoot is the repository root: the directory that holds both tui-go/ and
// docs/. Found by walking up rather than by counting "../" so a test run from
// somewhere else still finds it, and fails loudly when it cannot.
func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "tui-go", "go.mod")); err == nil {
			if _, err := os.Stat(filepath.Join(dir, "docs")); err == nil {
				return dir
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("no repository root (a directory holding tui-go/go.mod and docs/) above the test")
		}
		dir = parent
	}
}

// TestTheDocTablesCoverTheSet: the page's two tables and the marker list are
// hand-ordered prose, so they are the one part of the generator that can go
// stale quietly. Each is checked against the data it claims to document.
func TestTheDocTablesCoverTheSet(t *testing.T) {
	inSet := map[string]bool{}
	v := reflect.ValueOf(theme.Heavy)
	for i := 0; i < v.NumField(); i++ {
		inSet[v.Type().Field(i).Name] = true
	}
	seen := map[string]bool{}
	for _, d := range glyphRowDocs {
		if !inSet[d.Field] {
			t.Errorf("the glyph table documents %q, which is not a field of theme.Glyphs", d.Field)
		}
		if d.Means == "" {
			t.Errorf("the glyph table has no meaning for %q", d.Field)
		}
		seen[d.Field] = true
	}
	for name := range inSet {
		if !seen[name] {
			t.Errorf("theme.Glyphs.%s has no line in the glyph table, so the page would not show it", name)
		}
	}
	for _, d := range figureDoc {
		if got := reflectField(d.Field); got == "" {
			t.Errorf("the figure table describes %q, which draws nothing", d.Field)
		}
	}
	for _, p := range Pixels {
		if markerMeans(p) == "" {
			t.Errorf("marker %q has no meaning in the docs", p.Marker)
		}
	}
	// And the prose the generator emits must actually be in the files.
	html := PreviewHTML()
	for _, d := range glyphRowDocs {
		if !strings.Contains(html, reflectField(d.Field)) {
			t.Errorf("the generated page does not contain %s (%q)", d.Field, reflectField(d.Field))
		}
	}
	md := MascotsMarkdown()
	for _, c := range Creatures {
		if !strings.Contains(md, c.Name) || !strings.Contains(md, c.Ep) {
			t.Errorf("%s is missing from the generated mascots page", c.Name)
		}
		for _, p := range c.Poses() {
			if !strings.Contains(md, strings.Join(p.Art, "\n")) {
				t.Errorf("%s/%s art is missing from the generated mascots page", c.Name, p.Name)
			}
		}
	}
}

// TestTheGeneratedPageIsSelfContained: the page is one file with no
// dependencies, opened straight off disk — so it may not reference a stylesheet,
// a script or an image that lives somewhere else.
func TestTheGeneratedPageIsSelfContained(t *testing.T) {
	html := PreviewHTML()
	for _, bad := range []string{"<link ", "<script src=", "<img ", "http://", "https://"} {
		if strings.Contains(html, bad) {
			t.Fatalf("the page reaches outside itself: %q", bad)
		}
	}
	if !strings.Contains(html, "</html>") || !strings.HasPrefix(html, "<!doctype html>") {
		t.Fatal("the page is not a whole document")
	}
	if strings.Contains(html, "<%") {
		t.Fatal("a template action reached the page unrendered: <% in the output means the action never ran")
	}
	// Every pose of every creature must appear at real size in the page.
	for _, c := range Creatures {
		for _, p := range c.Poses() {
			if !strings.Contains(html, artHTML(p.Art, ScaleMascot)) {
				t.Fatalf("%s/%s is not in the generated page at real size", c.Name, p.Name)
			}
		}
	}
}

func TestTaglineHasNoExclamationMark(t *testing.T) {
	if Tagline != strings.ToLower(Tagline) || strings.Contains(Tagline, "!") {
		t.Fatalf("tagline = %q", Tagline)
	}
}

// TestGalleryPrintsTheFigures: not an assertion about pixels — a way to SEE
// them. `go test ./internal/brand/ -run Gallery -v` draws every pose at the
// size the terminal draws it, which is how the art gets reviewed.
func TestGalleryPrintsTheFigures(t *testing.T) {
	if !testing.Verbose() {
		t.Skip("run with -v to see the gallery")
	}
	for _, c := range Creatures {
		t.Logf("%s — %s", c.Name, c.Ep)
		for _, p := range c.Poses() {
			t.Logf("\n%s/%s\n%s", c.Name, p.Name, ansi.Strip(strings.Join(Paint(th(), p.Art, ScaleMascot), "\n")))
		}
	}
}
