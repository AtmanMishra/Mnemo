package tree

import (
	"strings"
	"testing"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/theme"
	"github.com/charmbracelet/x/ansi"
)

func leaf(id string) *Node { return &Node{ID: id, Label: id} }

func sample() *Model {
	return New(
		&Node{ID: "a", Label: "a", Expanded: true, Children: []*Node{
			leaf("a1"),
			{ID: "a2", Label: "a2", Children: []*Node{leaf("a2x"), leaf("a2y")}},
		}},
		&Node{ID: "b", Label: "b", Children: []*Node{leaf("b1")}},
	)
}

func labels(m *Model) []string {
	out := make([]string, len(m.Rows()))
	for i, r := range m.Rows() {
		out[i] = r.Node.ID
	}
	return out
}

func TestCollapsedChildrenAreNotVisible(t *testing.T) {
	m := sample()
	got := strings.Join(labels(m), ",")
	if got != "a,a1,a2,b" {
		t.Fatalf("visible rows = %q; a2 and b are closed so their children must not show", got)
	}
}

func TestOpenGoesDeeperThenMovesOn(t *testing.T) {
	m := sample()
	m.Move(2) // onto a2, which is closed
	m.Open()
	if got := strings.Join(labels(m), ","); got != "a,a1,a2,a2x,a2y,b" {
		t.Fatalf("after Open, rows = %q", got)
	}
	if m.Current().ID != "a2" {
		t.Fatal("opening a closed node must not move the cursor off it")
	}
	m.Open() // already open: go to the first child
	if m.Current().ID != "a2x" {
		t.Fatalf("second Open should step onto the first child, got %s", m.Current().ID)
	}
}

func TestCloseJumpsToParentWhenAlreadyClosed(t *testing.T) {
	// The keystroke this package exists to save: leaving a subtree is one
	// press, not "up, up, up".
	m := sample()
	m.Move(2)
	m.Open()  // a2 open
	m.Move(2) // onto a2y
	m.Close() // a leaf: jump to a2
	if m.Current().ID != "a2" {
		t.Fatalf("Close on a leaf should jump to the parent, got %s", m.Current().ID)
	}
	m.Close() // a2 is open: collapse it
	if m.Current().ID != "a2" || m.Current().Expanded {
		t.Fatal("Close on an open node should collapse it and stay put")
	}
	m.Close() // now closed: jump to a
	if m.Current().ID != "a" {
		t.Fatalf("Close should now jump to the parent, got %s", m.Current().ID)
	}
}

func TestExpandAllOpensEverythingAndKeepsTheCursorOnItsNode(t *testing.T) {
	m := sample()
	m.Move(2)
	focus := m.Current()
	m.ExpandAll()
	if got := strings.Join(labels(m), ","); got != "a,a1,a2,a2x,a2y,b,b1" {
		t.Fatalf("ExpandAll left rows = %q", got)
	}
	if m.Current() != focus {
		t.Fatalf("ExpandAll moved the cursor off %s onto %s", focus.ID, m.Current().ID)
	}
}

func TestCollapseAllKeepsRootsOpen(t *testing.T) {
	m := sample()
	m.ExpandAll()
	m.CollapseAll()
	got := strings.Join(labels(m), ",")
	if got != "a,a1,a2,b,b1" {
		t.Fatalf("CollapseAll left rows = %q; roots must stay open or the screen says nothing", got)
	}
}

func TestLazyChildrenLoadOnceOnOpen(t *testing.T) {
	calls := 0
	m := New(&Node{ID: "dir", Label: "dir", Load: func() []*Node {
		calls++
		return []*Node{leaf("f1"), leaf("f2")}
	}})
	if calls != 0 {
		t.Fatal("a closed lazy node must not be walked; that is the whole point of Load")
	}
	if !m.Current().HasChildren() {
		t.Fatal("an unvisited lazy node must render as openable, or there is no way in")
	}
	m.Open()
	m.Close()
	m.Open()
	if calls != 1 {
		t.Fatalf("Load ran %d times, want 1", calls)
	}
	if got := strings.Join(labels(m), ","); got != "dir,f1,f2" {
		t.Fatalf("rows = %q", got)
	}
}

func TestFilterKeepsAncestorsAndOpensThroughThem(t *testing.T) {
	m := sample()
	m.Filter("a2x")
	got := strings.Join(labels(m), ",")
	if got != "a,a2,a2x" {
		t.Fatalf("filtered rows = %q; a match inside a closed parent must still be reachable", got)
	}
	m.Filter("")
	if got := strings.Join(labels(m), ","); got != "a,a1,a2,b" {
		t.Fatalf("clearing the filter should restore the previous shape, got %q", got)
	}
}

func TestCursorStaysInRangeWhenTheTreeShrinks(t *testing.T) {
	m := sample()
	m.Bottom()
	m.SetRoots([]*Node{leaf("only")})
	if m.Cursor() != 0 || m.Current().ID != "only" {
		t.Fatalf("cursor = %d on %v after the tree shrank", m.Cursor(), m.Current())
	}
	m.SetRoots(nil)
	if m.Current() != nil {
		t.Fatal("an empty tree has no current node")
	}
	m.Move(3)
	m.Toggle()
	m.Close() // must not panic
}

func TestScrollFollowsTheCursor(t *testing.T) {
	roots := make([]*Node, 40)
	for i := range roots {
		roots[i] = leaf(string(rune('a' + i%26)))
	}
	m := New(roots...)
	m.SetSize(20, 5)
	m.Bottom()
	view := m.View(theme.Default(), true)
	if n := strings.Count(view, "\n") + 1; n != 5 {
		t.Fatalf("view is %d lines, want exactly the 5 it was given", n)
	}
	if m.offset != 35 {
		t.Fatalf("offset = %d, want 35 so the last row is visible", m.offset)
	}
}

func TestRowsNeverExceedTheWidth(t *testing.T) {
	m := New(&Node{ID: "r", Label: strings.Repeat("long-name-", 12), Expanded: true, Children: []*Node{
		{ID: "c", Label: strings.Repeat("child-", 20), Detail: "9999 facts"},
	}})
	for _, w := range []int{10, 24, 40, 80} {
		m.SetSize(w, 10)
		for _, line := range strings.Split(m.View(theme.Default(), true), "\n") {
			if got := ansi.StringWidth(line); got > w {
				t.Fatalf("at width %d a row rendered %d cells: %q", w, got, line)
			}
		}
	}
}

func TestDetailIsDroppedRatherThanWrapped(t *testing.T) {
	m := New(&Node{ID: "x", Label: "session", Detail: "42 turns"})
	m.SetSize(12, 4)
	v := m.View(theme.Default(), false)
	if strings.Contains(v, "\n") {
		t.Fatal("a single row must stay a single row; a tree that wraps is not scannable")
	}
}

func TestTrunkMarksTheLastSibling(t *testing.T) {
	m := sample()
	m.ExpandAll()
	plain := ansi.Strip(m.View(theme.Default(), false))
	lines := strings.Split(plain, "\n")
	// a2 is the last child of a, so its own children hang under blank space,
	// not under a pipe.
	var a2y string
	for _, l := range lines {
		if strings.Contains(l, "a2y") {
			a2y = l
		}
	}
	if !strings.Contains(a2y, theme.Heavy.Gap+theme.Heavy.Last) {
		t.Fatalf("last-child trunk is wrong: %q", a2y)
	}
}
