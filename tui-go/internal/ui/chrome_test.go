package ui

import (
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

func TestSideBySideDrawsAnUnbrokenRule(t *testing.T) {
	left := Pad("a\nb", 5)
	right := Pad("1\n2", 4)
	got := SideBySide(th(), 4, left, right)
	lines := strings.Split(got, "\n")
	if len(lines) != 4 {
		t.Fatalf("want 4 rows, got %d", len(lines))
	}
	for i, l := range lines {
		if !strings.Contains(ansi.Strip(l), theme.Heavy.V) {
			t.Fatalf("row %d has no divider: %q — a rule with gaps reads as a rendering bug", i, ansi.Strip(l))
		}
	}
}

func TestSideBySideWithNoRightColumnIsJustTheLeft(t *testing.T) {
	if got := SideBySide(th(), 3, "a\nb", ""); got != "a\nb" {
		t.Fatalf("a closed explorer must cost nothing: %q", got)
	}
}
