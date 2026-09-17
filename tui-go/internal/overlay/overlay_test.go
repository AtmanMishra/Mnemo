package overlay

import (
	"strings"
	"testing"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/theme"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/tree"
	"github.com/charmbracelet/x/ansi"
)

func th() *theme.Theme { return theme.Default() }

func list() *Model {
	return NewList(Palette, "run anything by name", []Item{
		{Label: "open the folder explorer", ID: "explorer", Group: "view", Detail: "^t"},
		{Label: "open every thinking block", ID: "think", Group: "view", Detail: "^e"},
		{Label: "resume a session", ID: "sessions", Group: "session", Detail: "^s"},
	})
}

func TestFilteringIsASubsequenceMatch(t *testing.T) {
	m := list()
	m.SetQuery("ofe")
	if m.Count() != 1 {
		t.Fatalf("got %d matches for %q, want 1", m.Count(), "ofe")
	}
	id, _ := m.Selected()
	if id != "explorer" {
		t.Fatalf("selected %q", id)
	}
}

func TestTypingAChordFindsItsCommand(t *testing.T) {
	m := list()
	m.SetQuery("^t")
	if id, _ := m.Selected(); id != "explorer" {
		t.Fatalf("typing the chord should find its command, got %q", id)
	}
}

func TestSelectionStaysInRangeAsTheListShrinks(t *testing.T) {
	m := list()
	m.Move(5)
	m.SetQuery("zzzz")
	if m.Count() != 0 {
		t.Fatal("nothing should match")
	}
	if _, ok := m.Selected(); ok {
		t.Fatal("an empty list has no selection")
	}
	m.SetQuery("")
	if _, ok := m.Selected(); !ok {
		t.Fatal("clearing the filter must restore a selection")
	}
}

func TestAnEmptyOverlaySaysWhatWouldAppearHere(t *testing.T) {
	// The bug that made two panes meaningless: a pane that says "(none)"
	// tells you nothing about what it is or how to fill it.
	m := NewList(Sessions, "resume a conversation", nil,
		"No sessions yet.",
		"One is written the first time you send a message.",
	)
	m.SetSize(60, 10)
	got := ansi.Strip(m.View(th()))
	if !strings.Contains(got, "written the first time") {
		t.Fatalf("empty state must name the concrete thing that fills it:\n%s", got)
	}
	if strings.Contains(got, "(none)") || strings.Contains(got, "(no ") {
		t.Fatalf("empty state is a parenthetical again:\n%s", got)
	}
}

func TestThePurposeLineIsAlwaysOnScreen(t *testing.T) {
	m := list()
	m.SetSize(60, 10)
	if !strings.Contains(ansi.Strip(m.View(th())), "run anything by name") {
		t.Fatal("the purpose line is what stops a noun being a guess")
	}
}

func TestTypingReplacesThePurposeLineWithTheQuery(t *testing.T) {
	m := list()
	m.SetSize(60, 10)
	m.Rune('o')
	m.Rune('f')
	got := ansi.Strip(m.View(th()))
	if !strings.Contains(got, "/of") {
		t.Fatalf("the query must be visible while filtering:\n%s", got)
	}
}

func TestATreeOverlayIgnoresTypingUntilSlash(t *testing.T) {
	// j/k/h/l must keep working in a tree; only `/` hands the keys to a filter.
	m := NewTree(Sessions, "resume", []*tree.Node{{ID: "a", Label: "alpha"}})
	if m.Typing() {
		t.Fatal("a tree starts in movement mode")
	}
	m.StartTyping()
	if !m.Typing() {
		t.Fatal("slash must switch to filtering")
	}
	m.Rune('x')
	m.Backspace()
	if m.Typing() {
		t.Fatal("emptying the query must hand the keys back to movement, so esc is not the only way out")
	}
}

func TestNeverExceedsItsWidthOrHeight(t *testing.T) {
	m := NewList(Palette, strings.Repeat("a very long purpose ", 8), []Item{
		{Label: strings.Repeat("long-label-", 12), Detail: strings.Repeat("d", 40), Group: "g"},
		{Label: "short", Detail: "x"},
	})
	for _, w := range []int{20, 30, 60, 120} {
		for _, h := range []int{4, 6, 12} {
			m.SetSize(w, h)
			v := m.View(th())
			for _, l := range strings.Split(v, "\n") {
				if got := ansi.StringWidth(l); got > w {
					t.Fatalf("w=%d h=%d: row is %d cells: %q", w, h, got, ansi.Strip(l))
				}
			}
			if n := strings.Count(v, "\n") + 1; n > h {
				t.Fatalf("w=%d h=%d: overlay drew %d rows", w, h, n)
			}
		}
	}
}

func TestGroupHeadingsAppearOnceInOrder(t *testing.T) {
	m := list()
	m.SetSize(60, 12)
	got := ansi.Strip(m.View(th()))
	if strings.Count(got, "VIEW") != 1 || strings.Count(got, "SESSION") != 1 {
		t.Fatalf("group headings should appear exactly once:\n%s", got)
	}
}

func TestATreeOverlayDelegatesToTheTree(t *testing.T) {
	m := NewTree(Sessions, "resume", []*tree.Node{
		{ID: "p", Label: "project", Expanded: true, Children: []*tree.Node{{ID: "s", Label: "a session"}}},
	})
	m.SetSize(60, 10)
	if m.Count() != 2 {
		t.Fatalf("tree overlay reports %d rows", m.Count())
	}
	m.Move(1)
	if id, _ := m.Selected(); id != "s" {
		t.Fatalf("selected %q", id)
	}
	m.SetQuery("session")
	if m.Count() != 2 {
		t.Fatalf("a filtered tree keeps the ancestors, got %d rows", m.Count())
	}
}

func TestKindNamesAreLowercaseForTheRule(t *testing.T) {
	for k, want := range map[Kind]string{Palette: "palette", Sessions: "sessions", Help: "keys", Fork: "fork", None: ""} {
		if k.String() != want {
			t.Fatalf("Kind(%d) = %q, want %q", k, k.String(), want)
		}
	}
}

func TestFieldsAreMatchedSeparatelyNotConcatenated(t *testing.T) {
	// Matching over the joined fields lets a query take one letter from the
	// label and the next from the keybinding, and the palette then returns
	// rows for no reason the reader can see.
	m := NewList(Palette, "x", []Item{{Label: "alpha", Detail: "^z", Group: "g"}})
	m.SetQuery("a^")
	if m.Count() != 0 {
		t.Fatal("a query spanning two fields must not match")
	}
	m.SetQuery("^z")
	if m.Count() != 1 {
		t.Fatal("a query inside one field must match")
	}
}
