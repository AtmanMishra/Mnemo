package app

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/agent"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/chat"
)

// The mouse, opt-in.
//
// Reporting stays off unless it was asked for, because turning it on takes
// drag-select away from the terminal — the copy gesture every terminal user
// already has. These tests pin both halves of that decision: nothing happens
// while it is off, and the wheel and the click do what §12 says they do while
// it is on.

// mouseFixture is the shared fixture with the switch set either way.
func mouseFixture(t *testing.T, w, h int, on bool) *Model {
	t.Helper()
	m := New(Config{
		Home: t.TempDir(), CWD: t.TempDir(), Dark: true, Mouse: on,
		Agent: agent.Offline{Reason: "test"},
	})
	m.Resize(w, h)
	return m
}

// transcriptOf fills the transcript with blocks whose rows are countable: one
// paragraph each, so every block is exactly one line tall.
func transcriptOf(m *Model, n int) {
	for i := 0; i < n; i++ {
		m.chat.Append(&chat.Block{Kind: chat.Agent, Body: []string{"a line of prose"}})
	}
}

func wheel(t *testing.T, m *Model, up bool) {
	t.Helper()
	button := tea.MouseWheelDown
	if up {
		button = tea.MouseWheelUp
	}
	m.Update(tea.MouseWheelMsg(tea.Mouse{X: 4, Y: 4, Button: button}))
}

func clickAt(t *testing.T, m *Model, x, y int) {
	t.Helper()
	m.Update(tea.MouseClickMsg(tea.Mouse{X: x, Y: y, Button: tea.MouseLeft}))
}

// TestMouseReportingIsOffUnlessItWasAskedFor is the first half of the trade in
// View(): the terminal's own selection is the default, and the view says so
// rather than leaving a reader to wonder whether drag-select is broken.
func TestMouseReportingIsOffUnlessItWasAskedFor(t *testing.T) {
	if got := mouseFixture(t, 100, 30, false).View().MouseMode; got != tea.MouseModeNone {
		t.Fatalf("a run that did not ask for the mouse declared mode %v", got)
	}
	if got := mouseFixture(t, 100, 30, true).View().MouseMode; got != tea.MouseModeCellMotion {
		t.Fatalf("MNEMO_MOUSE=1 must declare cell motion, got %v", got)
	}
}

// TestNothingHappensToATranscriptWhileTheMouseIsOff: the messages can still
// arrive (a terminal that reports them anyway, or a test), and none of them may
// move anything — otherwise "off" means "off, except".
func TestNothingHappensToATranscriptWhileTheMouseIsOff(t *testing.T) {
	m := mouseFixture(t, 100, 12, false)
	transcriptOf(m, 30) // more rows than the body can show
	before, followed := m.chat.Offset(), m.chat.Following()

	m.Update(tea.MouseClickMsg(tea.Mouse{X: 4, Y: 6, Button: tea.MouseLeft}))
	wheel(t, m, true)
	wheel(t, m, false)

	if got := m.chat.Offset(); got != before {
		t.Fatalf("the transcript scrolled from row %d to %d with the mouse off", before, got)
	}
	if m.chat.Following() != followed {
		t.Fatal("a wheel with the mouse off must not unpin the transcript")
	}
	if m.chat.Focus() != -1 {
		t.Fatalf("a click with the mouse off must not focus a block, got %d", m.chat.Focus())
	}
}

// TestTheWheelScrollsTheTranscript: three lines a notch, one way up and one way
// down, with the end of the transcript as a wall rather than a wrap-around.
func TestTheWheelScrollsTheTranscript(t *testing.T) {
	m := mouseFixture(t, 100, 12, true)
	transcriptOf(m, 30)
	bottom := m.chat.Offset()

	wheel(t, m, true)
	up := m.chat.Offset()
	if up != bottom-wheelLines {
		t.Fatalf("one notch up moved from row %d to %d, want %d", bottom, up, bottom-wheelLines)
	}
	wheel(t, m, false)
	if got := m.chat.Offset(); got != bottom {
		t.Fatalf("one notch down moved to row %d, want back at %d", got, bottom)
	}
	wheel(t, m, false)
	if got := m.chat.Offset(); got != bottom {
		t.Fatalf("the wheel must stop at the newest output, got row %d", got)
	}
}

// TestAClickFoldsTheBlockUnderThePointer: the click arrives as a screen row,
// and the row it lands on is the block that folds. The row is looked up through
// the transcript rather than counted in the test, so a change to the block
// spacing cannot make this pass by accident.
func TestAClickFoldsTheBlockUnderThePointer(t *testing.T) {
	m := mouseFixture(t, 100, 30, true)
	// The welcome is the first block; the two under test follow it.
	prose := m.chat.Len()
	m.chat.Append(&chat.Block{Kind: chat.Agent, Body: []string{"a paragraph, which does not fold"}})
	tool := prose + 1
	m.chat.Append(&chat.Block{Kind: chat.Tool, Title: "read main.go", Body: []string{"package main"}, State: chat.OK})

	row := rowOfBlock(t, m, tool)
	clickAt(t, m, m.margin()+2, m.rows().bodyTop+row)

	if !m.chat.Blocks()[tool].Open {
		t.Fatal("clicking a folded tool block must open it")
	}
	if m.chat.Focus() != tool {
		t.Fatalf("the click must also focus what it folded, focus=%d", m.chat.Focus())
	}

	clickAt(t, m, m.margin()+2, m.rows().bodyTop+row)
	if m.chat.Blocks()[tool].Open {
		t.Fatal("clicking it again must fold it back")
	}

	// Prose has nothing to fold: the click focuses it and stops there.
	clickAt(t, m, m.margin()+2, m.rows().bodyTop+rowOfBlock(t, m, prose))
	if m.chat.Focus() != prose {
		t.Fatalf("a click on prose must still focus it, focus=%d", m.chat.Focus())
	}
}

// TestAClickBelowTheTranscriptIsNotABlock: the header, the rule and the prompt
// are not transcript rows, and a click on the status band must not fold the
// last block someone happened to be reading.
func TestAClickBelowTheTranscriptIsNotABlock(t *testing.T) {
	m := mouseFixture(t, 100, 30, true)
	tool := m.chat.Len()
	m.chat.Append(&chat.Block{Kind: chat.Tool, Title: "read main.go", Body: []string{"package main"}, State: chat.OK})
	rowOfBlock(t, m, tool)

	clickAt(t, m, m.margin()+2, m.rows().bodyTop-1) // the rule above the body
	clickAt(t, m, m.margin()+2, m.h-1)             // the status band
	if m.chat.Blocks()[tool].Open {
		t.Fatal("a click outside the transcript folded a block")
	}
	if m.chat.Focus() != -1 {
		t.Fatalf("a click outside the transcript focused a block, focus=%d", m.chat.Focus())
	}
}

// TestAModalOwnsTheMouseToo: with a palette up, the transcript behind it does
// not scroll and does not fold. The keyboard obeys the same rule — a surface
// with focus takes the input — and the mouse must not be a second rule.
func TestAModalOwnsTheMouseToo(t *testing.T) {
	m := mouseFixture(t, 100, 12, true)
	transcriptOf(m, 30)
	before := m.chat.Offset()
	press(t, m, "ctrl+k")
	if m.Overlay() == nil {
		t.Fatal("^k opens the palette")
	}

	wheel(t, m, true)
	clickAt(t, m, m.margin()+2, m.rows().bodyTop)

	if got := m.chat.Offset(); got != before {
		t.Fatalf("the transcript behind a modal scrolled from %d to %d", before, got)
	}
	if m.chat.Focus() != -1 {
		t.Fatal("a click behind a modal must not focus or fold anything")
	}
}

// TestTheChordHandsSelectionBackToTheTerminal: ^g is the way out, it says so,
// and it is also the way back in — the switch is a preference for this session,
// not a one-way door out of the feature.
func TestTheChordHandsSelectionBackToTheTerminal(t *testing.T) {
	m := mouseFixture(t, 100, 30, true)
	if !strings.Contains(screen(m), "mouse · ^g") {
		t.Fatalf("with reporting on, the status line must say so:\n%s", lastLine(screen(m)))
	}

	press(t, m, "ctrl+g")
	if m.Mouse() {
		t.Fatal("^g must turn reporting off")
	}
	if !strings.Contains(screen(m), "drag-select and copy are the terminal's again") {
		t.Fatalf("^g must say what it gave back:\n%s", lastLine(screen(m)))
	}
	if got := m.View().MouseMode; got != tea.MouseModeNone {
		t.Fatalf("the view still declares %v", got)
	}
	if strings.Contains(screen(m), "mouse · ^g") {
		t.Fatal("the status line must stop advertising a mode that is off")
	}

	press(t, m, "ctrl+g")
	if !m.Mouse() || m.View().MouseMode != tea.MouseModeCellMotion {
		t.Fatal("^g again must turn it back on")
	}
}

// rowOfBlock is the first body row a block is drawn on, or -1.
func rowOfBlock(t *testing.T, m *Model, block int) int {
	t.Helper()
	for row := 0; row < m.bodyHeight(); row++ {
		if m.chat.BlockAtRow(row) == block {
			return row
		}
	}
	t.Fatalf("block %d is not on screen; the fixture no longer fits", block)
	return -1
}
