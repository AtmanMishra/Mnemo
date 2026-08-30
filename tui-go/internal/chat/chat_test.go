package chat

import (
	"strings"
	"testing"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/theme"
	"github.com/charmbracelet/x/ansi"
)

func th() *theme.Theme { return theme.Default() }

func withThinking(n int) *Model {
	m := New()
	m.SetSize(60, 40)
	for i := 0; i < n; i++ {
		m.Append(&Block{Kind: Think, Title: "thinking", Body: []string{"step one", "step two"}})
		m.Append(&Block{Kind: Agent, Body: []string{"an answer"}})
	}
	return m
}

func TestOneKeyOpensEveryThinkingBlock(t *testing.T) {
	m := withThinking(5)
	if open, total := m.CountOpen(Think); open != 0 || total != 5 {
		t.Fatalf("blocks start collapsed: open=%d total=%d", open, total)
	}
	if want := m.ToggleAll(Think); !want {
		t.Fatal("first press must open, not close")
	}
	if open, total := m.CountOpen(Think); open != total {
		t.Fatalf("one press left %d of %d thinking blocks open", open, total)
	}
	if want := m.ToggleAll(Think); want {
		t.Fatal("second press must close them all again")
	}
	if open, _ := m.CountOpen(Think); open != 0 {
		t.Fatalf("%d thinking blocks still open after the second press", open)
	}
}

func TestToggleAllLeavesOtherKindsAlone(t *testing.T) {
	m := withThinking(2)
	m.Append(&Block{Kind: Tool, Title: "bash", Detail: "213 ok", Body: []string{"..."}, State: OK})
	m.ToggleAll(Think)
	if open, _ := m.CountOpen(Tool); open != 0 {
		t.Fatal("opening thinking blocks must not open tool blocks")
	}
}

func TestToggleAllIsAllOpenWhenMerelySomeAreOpen(t *testing.T) {
	// The failure mode to avoid: with three of five open, one press should
	// finish the job, not invert each block and leave a mess.
	m := withThinking(5)
	blocks := m.Blocks()
	blocks[0].Open, blocks[2].Open = true, true
	m.ToggleAll(Think)
	if open, total := m.CountOpen(Think); open != total {
		t.Fatalf("partial state should complete to all-open, got %d/%d", open, total)
	}
}

func TestToggleAllOnAnEmptyTranscriptIsNotAnError(t *testing.T) {
	m := New()
	if m.ToggleAll(Think) || m.ToggleEverything() {
		t.Fatal("nothing to open should report nothing opened")
	}
}

func TestNothingEverExceedsTheWidth(t *testing.T) {
	// The overflow bug, as a test.
	m := New()
	m.Append(&Block{Kind: User, Body: []string{strings.Repeat("word ", 60)}})
	m.Append(&Block{Kind: Tool, Title: "read", Detail: "40 ln", Open: true,
		Body: []string{"/a/very/long/unbreakable/path/that/has/no/spaces/at/all/anywhere/in/it/x.rs"}})
	m.Append(&Block{Kind: Agent, Body: []string{strings.Repeat("supercalifragilistic", 12)}})
	for _, w := range []int{20, 40, 60, 80, 120, 200} {
		m.SetSize(w, 200)
		for i, l := range m.Lines(th()) {
			if got := ansi.StringWidth(l); got > w {
				t.Fatalf("width %d: row %d is %d cells: %q", w, i, got, ansi.Strip(l))
			}
		}
	}
}

func TestWrappedLinesKeepTheGutterColumn(t *testing.T) {
	m := New()
	m.SetSize(30, 20)
	m.Append(&Block{Kind: User, Body: []string{strings.Repeat("alpha ", 20)}})
	lines := m.Lines(th())
	if len(lines) < 2 {
		t.Fatal("expected the line to wrap at width 30")
	}
	for i, l := range lines[1:] {
		if !strings.HasPrefix(ansi.Strip(l), "  ") {
			t.Fatalf("continuation %d starts at column 0 (%q); it would read as a new speaker", i, ansi.Strip(l))
		}
	}
}

func TestCollapsedBlockShowsOnlyItsSummary(t *testing.T) {
	m := New()
	m.SetSize(60, 20)
	m.Append(&Block{Kind: Tool, Title: "bash", Detail: "213 ok", State: OK,
		Body: []string{"line one", "line two", "line three"}})
	got := ansi.Strip(strings.Join(m.Lines(th()), "\n"))
	if strings.Contains(got, "line one") {
		t.Fatal("a collapsed block must not render its body")
	}
	if !strings.Contains(got, "213 ok") {
		t.Fatal("the summary must carry the result; that is what tells you not to open it")
	}
	m.Blocks()[0].Open = true
	if !strings.Contains(ansi.Strip(strings.Join(m.Lines(th()), "\n")), "line three") {
		t.Fatal("an open block must render its body")
	}
}

func TestSubAgentRunsNestInsideTheTranscript(t *testing.T) {
	m := New()
	m.SetSize(70, 30)
	m.Append(&Block{Kind: Delegation, Title: "2 sub-agents", Open: true, State: OK,
		Children: []*Block{
			{Kind: Agent, Title: "probe-rpc", Body: []string{"found it"}, Open: true, State: OK},
			{Kind: Agent, Title: "read-jsonl", Body: []string{"parsed"}, Open: true, State: OK},
		}})
	got := ansi.Strip(strings.Join(m.Lines(th()), "\n"))
	if !strings.Contains(got, "probe-rpc") || !strings.Contains(got, "read-jsonl") {
		t.Fatalf("children missing:\n%s", got)
	}
	// A child must be indented, or nesting says nothing.
	for _, l := range strings.Split(got, "\n") {
		if strings.Contains(l, "probe-rpc") && !strings.HasPrefix(l, "  ") {
			t.Fatalf("child is not indented: %q", l)
		}
	}
}

func TestTailAnchoredViewKeepsTheNewestRows(t *testing.T) {
	m := New()
	m.SetSize(40, 5)
	for i := 0; i < 30; i++ {
		m.Append(&Block{Kind: Agent, Body: []string{"line " + string(rune('a'+i%26))}})
	}
	v := ansi.Strip(m.View(th()))
	if n := strings.Count(v, "\n") + 1; n != 5 {
		t.Fatalf("view is %d rows, want the 5 it was given", n)
	}
	last := ansi.Strip(m.Lines(th())[len(m.Lines(th()))-1])
	if !strings.Contains(v, strings.TrimSpace(last)) {
		t.Fatalf("the newest row is not on screen:\nview=%q\nlast=%q", v, last)
	}
}

func TestWrappingHappensBeforeSlicing(t *testing.T) {
	// The regression that shipped: one logical line becoming three rows must
	// not push the newest rows off the bottom.
	m := New()
	m.SetSize(24, 4)
	m.Append(&Block{Kind: Agent, Body: []string{strings.Repeat("long ", 30)}})
	m.Append(&Block{Kind: User, Body: []string{"NEWEST"}})
	if !strings.Contains(ansi.Strip(m.View(th())), "NEWEST") {
		t.Fatalf("the newest block fell off the bottom:\n%s", ansi.Strip(m.View(th())))
	}
}

func TestFocusStepsBetweenBlocksNotLines(t *testing.T) {
	m := withThinking(3)
	m.FocusNext()
	if m.Focus() != m.Len()-1 {
		t.Fatalf("entering block navigation should start at the newest block, got %d", m.Focus())
	}
	m.FocusPrev()
	m.FocusPrev()
	if m.Focus() != m.Len()-3 {
		t.Fatalf("focus = %d", m.Focus())
	}
	for i := 0; i < 50; i++ {
		m.FocusPrev()
	}
	if m.Focus() != 0 {
		t.Fatal("focus must clamp at the first block")
	}
	for i := 0; i < 50; i++ {
		m.FocusNext()
	}
	if m.Focus() != m.Len()-1 {
		t.Fatal("focus must clamp at the last block")
	}
}

func TestToggleFocusedOnlyTouchesTheFocusedBlock(t *testing.T) {
	m := withThinking(3)
	m.FocusNext()
	m.FocusPrev() // onto a thinking block
	before, _ := m.CountOpen(Think)
	if !m.ToggleFocused() {
		t.Fatal("the focused block is foldable")
	}
	after, _ := m.CountOpen(Think)
	if after != before+1 {
		t.Fatalf("toggling one block changed %d blocks", after-before)
	}
}

func TestYankFallsBackToTheWholeTranscript(t *testing.T) {
	m := withThinking(1)
	all := m.YankFocused()
	if !strings.Contains(all, "an answer") || !strings.Contains(all, "step one") {
		t.Fatalf("with no focus, yank should return everything:\n%s", all)
	}
	m.FocusNext()
	one := m.YankFocused()
	if strings.Contains(one, "step one") {
		t.Fatal("with a block focused, yank should return only that block")
	}
	if strings.Contains(one, "\x1b[") {
		t.Fatal("yanked text must be plain: you are pasting it somewhere else")
	}
}

func TestAppendKeepsTheViewPinnedUntilYouScroll(t *testing.T) {
	m := New()
	m.SetSize(40, 4)
	for i := 0; i < 20; i++ {
		m.Append(&Block{Kind: Agent, Body: []string{"row"}})
	}
	if !m.Following() {
		t.Fatal("a fresh transcript follows the newest output")
	}
	m.Scroll(-5)
	if m.Following() {
		t.Fatal("scrolling up must unpin, or reading history is impossible while output streams")
	}
	m.Bottom()
	if !m.Following() {
		t.Fatal("jumping to the bottom must re-pin")
	}
}

func TestBlockAtRowMapsClicksBack(t *testing.T) {
	m := New()
	m.SetSize(50, 20)
	m.Append(&Block{Kind: User, Body: []string{"first"}})
	m.Append(&Block{Kind: Tool, Title: "read", Detail: "40 ln", Body: []string{"x"}})
	if got := m.BlockAtRow(0); got != 0 {
		t.Fatalf("row 0 belongs to block %d, want 0", got)
	}
	if got := m.BlockAtRow(1); got != -1 {
		t.Fatalf("the blank separator belongs to no block, got %d", got)
	}
	if got := m.BlockAtRow(2); got != 1 {
		t.Fatalf("row 2 belongs to block %d, want 1", got)
	}
	if got := m.BlockAtRow(999); got != -1 {
		t.Fatal("a click past the end belongs to no block")
	}
}

func TestClearResetsEverything(t *testing.T) {
	m := withThinking(3)
	m.FocusNext()
	m.Scroll(-3)
	m.Clear()
	if m.Len() != 0 || m.Focus() != -1 || !m.Following() {
		t.Fatal("Clear must reset contents, focus and follow together")
	}
}

func TestNarrowWidthsDoNotPanic(t *testing.T) {
	m := New()
	m.Append(&Block{Kind: Tool, Title: "a very long tool title indeed", Detail: "exit 1", State: Failed,
		Body: []string{"some body"}, Open: true})
	for _, w := range []int{1, 2, 3, 8, 12} {
		m.SetSize(w, 3)
		_ = m.View(th())
	}
}

func TestARunningBlockAnimatesAndAFinishedOneDoesNot(t *testing.T) {
	// A static dot on a call that is still out looks exactly like a call that
	// finished. That is the difference between waiting and being stuck.
	m := New()
	m.SetSize(60, 20)
	m.Append(&Block{Kind: Tool, Title: "bash", State: Running})
	a := ansi.Strip(m.View(th()))
	m.SetTick(3)
	b := ansi.Strip(m.View(th()))
	if a == b {
		t.Fatal("a running tool block must animate")
	}
	m.Blocks()[0].State = OK
	c := ansi.Strip(m.View(th()))
	m.SetTick(7)
	if ansi.Strip(m.View(th())) != c {
		t.Fatal("a finished block must be still")
	}
}

func TestAThinkingBlockShowsTheRampNotASpinner(t *testing.T) {
	m := New()
	m.SetSize(60, 20)
	m.Append(&Block{Kind: Think, Title: "thinking", Body: []string{"x"}, State: Running})
	got := ansi.Strip(m.View(th()))
	if !strings.ContainsAny(got, string(theme.Dither[1:])) {
		t.Fatalf("thinking should draw the density ramp:\n%s", got)
	}
}
