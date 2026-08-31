package ui

import (
	"charm.land/lipgloss/v2"
	"strings"
	"testing"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/theme"
	"github.com/charmbracelet/x/ansi"
)

func th() *theme.Theme { return theme.Default() }

func TestRuleIsExactlyTheWidthAtEverySize(t *testing.T) {
	for _, w := range []int{0, 1, 3, 4, 8, 12, 40, 200} {
		got := ansi.StringWidth(Rule(th(), w, "TRANSCRIPT"))
		if got != w {
			t.Fatalf("Rule(width=%d) rendered %d cells", w, got)
		}
	}
}

func TestRuleNotchesTheLabelIn(t *testing.T) {
	got := ansi.Strip(Rule(th(), 40, "explorer"))
	if !strings.Contains(got, "EXPLORER") {
		t.Fatalf("label missing: %q", got)
	}
	if strings.Contains(got, "\n") {
		t.Fatal("a rule is one row; a label must not cost a second one")
	}
}

func TestBandKeepsTheRightSideWhenSpaceRunsOut(t *testing.T) {
	// The counts on the right are facts; the hints on the left are a
	// convenience. When they collide, facts win.
	left := []Seg{{Text: "enter send · esc read · ^k palette · ^e thinking"}}
	right := []Seg{{Text: "12 mem"}, {Text: "2 agents"}, {Text: "4.1k"}}
	for _, w := range []int{20, 30, 50, 80, 120} {
		out := Band(th(), w, left, right)
		if got := ansi.StringWidth(out); got != w {
			t.Fatalf("width %d: band rendered %d cells", w, got)
		}
		if w >= 40 && !strings.Contains(ansi.Strip(out), "4.1k") {
			t.Fatalf("width %d dropped the right-hand counts: %q", w, ansi.Strip(out))
		}
	}
}

func TestBandSeparatesSegments(t *testing.T) {
	out := ansi.Strip(Band(th(), 60, []Seg{{Text: "a"}, {Text: "b"}}, nil))
	if !strings.Contains(out, theme.Heavy.Seg) {
		t.Fatalf("segments are not separated: %q", out)
	}
}

func TestBandSkipsEmptySegments(t *testing.T) {
	out := ansi.Strip(Band(th(), 40, []Seg{{Text: "a"}, {Text: ""}, {Text: "b"}}, nil))
	if strings.Count(out, theme.Heavy.Seg) != 1 {
		t.Fatalf("an empty segment left a dangling separator: %q", out)
	}
}

func TestHeaderTravelsOnlyWhileWorking(t *testing.T) {
	facts := []Seg{{Text: "~/repo"}, {Text: "deepseek-v4-flash"}}
	idleA := ansi.Strip(Header(th(), 90, 0, false, facts))
	idleB := ansi.Strip(Header(th(), 90, 7, false, facts))
	if idleA != idleB {
		t.Fatal("an idle header must be still; a screen that animates while nothing happens is burning a battery to look busy")
	}
	workA := ansi.Strip(Header(th(), 90, 0, true, facts))
	workB := ansi.Strip(Header(th(), 90, 1, true, facts))
	if workA == workB {
		t.Fatal("a working header must travel")
	}
}

func TestHeaderIsExactlyTheWidth(t *testing.T) {
	facts := []Seg{{Text: "~/some/project"}, {Text: "model-name"}, {Text: "session 4"}}
	for _, w := range []int{8, 20, 40, 60, 90, 200} {
		for _, working := range []bool{false, true} {
			got := ansi.StringWidth(Header(th(), w, 3, working, facts))
			if got > w {
				t.Fatalf("width %d working=%v: header rendered %d cells", w, working, got)
			}
		}
	}
	if Header(th(), 4, 0, false, facts) != "" {
		t.Fatal("below eight columns the header must give up rather than render a stub")
	}
}

func TestHeaderAlwaysCarriesTheMark(t *testing.T) {
	got := ansi.Strip(Header(th(), 60, 0, false, []Seg{{Text: "x"}}))
	if !strings.Contains(got, "MNEMO") {
		t.Fatalf("the brand mark is not optional: %q", got)
	}
}

func TestPaneIsExactlyTheHeightItWasGiven(t *testing.T) {
	body := "one\ntwo"
	for _, h := range []int{1, 3, 10} {
		got := Pane(th(), 30, h, "logs", body)
		if n := strings.Count(got, "\n") + 1; n != h {
			t.Fatalf("height %d: pane rendered %d rows", h, n)
		}
	}
	if Pane(th(), 30, 0, "x", body) != "" {
		t.Fatal("a zero-height pane renders nothing")
	}
}

func TestPaneNeverOverflowsTheWidth(t *testing.T) {
	body := strings.Repeat("wide ", 40)
	for _, w := range []int{10, 30, 80} {
		for _, l := range strings.Split(Pane(th(), w, 5, "label", body), "\n") {
			if ansi.StringWidth(l) > w {
				t.Fatalf("width %d: %q", w, ansi.Strip(l))
			}
		}
	}
}

func TestPadMakesEveryLineTheSameWidth(t *testing.T) {
	got := Pad("a\nbbbb\ncc", 3)
	for _, l := range strings.Split(got, "\n") {
		if ansi.StringWidth(l) != 3 {
			t.Fatalf("%q is not 3 cells", l)
		}
	}
}

func TestColumnsDrawAnUnbrokenDividerInOneColumn(t *testing.T) {
	// When the callers padded their own sides, the region rule and the body
	// disagreed by a column and the divider zigzagged down the screen.
	got := Columns(th(), 5, "a\nlonger line\nb", 12, "1\n2", 6)
	lines := strings.Split(got, "\n")
	if len(lines) != 5 {
		t.Fatalf("want 5 rows, got %d", len(lines))
	}
	col := -1
	for i, l := range lines {
		plain := ansi.Strip(l)
		at := strings.Index(plain, theme.Heavy.V)
		if at < 0 {
			t.Fatalf("row %d has no divider: %q", i, plain)
		}
		if col == -1 {
			col = at
		} else if at != col {
			t.Fatalf("row %d puts the divider at %d, the first row at %d", i, at, col)
		}
	}
}

func TestColumnsAreExactlyTheirWidths(t *testing.T) {
	got := Columns(th(), 3, "a", 10, "b", 7)
	for _, l := range strings.Split(got, "\n") {
		if w := ansi.StringWidth(l); w != 10+Gap+7 {
			t.Fatalf("row is %d cells, want %d", w, 10+Gap+7)
		}
	}
}

func TestColumnsGiveTheDividerAir(t *testing.T) {
	// Two columns jammed against a bar read as one wall of text.
	got := ansi.Strip(Columns(th(), 1, "abc", 3, "xyz", 3))
	if got != "abc "+theme.Heavy.V+" xyz" {
		t.Fatalf("got %q", got)
	}
}

func TestFloatCentresThePanelOverTheBackdrop(t *testing.T) {
	back := strings.Repeat("backdrop\n", 12)
	panel := Panel(th(), "hello", 20)
	out := Float(th(), back, panel, 60, 12)
	lines := strings.Split(out, "\n")
	if len(lines) != 12 {
		t.Fatalf("float drew %d rows, want the 12 it was given", len(lines))
	}
	for i, l := range lines {
		if got := ansi.StringWidth(l); got != 60 {
			t.Fatalf("row %d is %d cells, want 60 — a ragged backdrop shows as a hole", i, got)
		}
	}
	plain := ansi.Strip(out)
	if !strings.Contains(plain, "hello") {
		t.Fatal("the panel must be on top")
	}
	if !strings.Contains(plain, "backdrop") {
		t.Fatal("the backdrop must survive — that is the whole point of floating")
	}
	// Centred: the first and last rows belong to the backdrop, not the panel.
	if strings.Contains(lines[0], "╭") || strings.Contains(lines[len(lines)-1], "╰") {
		t.Fatal("the panel is flush against an edge instead of centred")
	}
}

func TestPanelDoesNotWrapContentThatFits(t *testing.T) {
	// lipgloss counts border AND padding inside Width, so a body passed
	// through at its own width comes back four cells short and every line
	// wraps.
	body := strings.Repeat("x", 40)
	out := Panel(th(), body, 40)
	if n := strings.Count(out, "\n") + 1; n != 3 {
		t.Fatalf("panel is %d rows, want 3 (border, body, border) — the body wrapped", n)
	}
	if w, _ := lipgloss.Size(out); w != 40+PanelChrome {
		t.Fatalf("panel is %d cells, want content plus %d", w, PanelChrome)
	}
}

func TestDimFlattensTheBackdropToOneColour(t *testing.T) {
	// Two live-looking layers is worse than one: the eye has no way to tell
	// which one the keyboard is talking to.
	lit := th().OK.Render("green") + th().Fail.Render("red")
	out := Dim(th(), lit)
	if strings.Contains(out, "0;228;54") || strings.Contains(out, "255;0;77") {
		t.Fatalf("the backdrop kept its own colours: %q", out)
	}
	if ansi.Strip(out) != "greenred" {
		t.Fatalf("dimming lost text: %q", ansi.Strip(out))
	}
}

func TestFloatDegradesRatherThanCrashingWhenThereIsNoRoom(t *testing.T) {
	panel := Panel(th(), "x", 10)
	for _, wh := range [][2]int{{0, 0}, {2, 1}, {3, 2}, {8, 4}} {
		_ = Float(th(), "back", panel, wh[0], wh[1])
	}
}
