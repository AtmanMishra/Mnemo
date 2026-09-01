package prompt

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/command"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/theme"
)

// typeInto feeds the prompt key presses, the way the terminal would.
func typeInto(t *testing.T, m *Model, s string) {
	t.Helper()
	for _, r := range s {
		m.Update(tea.KeyPressMsg(tea.Key{Code: r, Text: string(r)}))
	}
}

func TestTypingBuildsUpTheValue(t *testing.T) {
	m := New(true)
	typeInto(t, m, "hello")
	if got := m.Value(); got != "hello" {
		t.Fatalf("Value() = %q", got)
	}
	if m.Empty() {
		t.Fatal("a typed prompt is not empty")
	}
	typeInto(t, m, " world")
	if got := m.Value(); got != "hello world" {
		t.Fatalf("Value() = %q; chunks must continue the line, not restart it", got)
	}
}

func TestWhitespaceOnlyIsStillEmpty(t *testing.T) {
	m := New(true)
	typeInto(t, m, "   ")
	if !m.Empty() {
		t.Fatal("a space-only prompt must not send")
	}
	if got := m.Take(); got != "" {
		t.Fatalf("Take() on whitespace = %q; a stray enter is not a message", got)
	}
}

func TestTakeClearsAndRecords(t *testing.T) {
	m := New(true)
	typeInto(t, m, "first message ")
	if got := m.Take(); got != "first message" {
		t.Fatalf("Take() trims trailing space, got %q", got)
	}
	if got := m.Value(); got != "" {
		t.Fatalf("Take() must clear the prompt, got %q", got)
	}
	if len(m.history) != 1 || m.history[0] != "first message" {
		t.Fatalf("history = %#v", m.history)
	}
}

func TestTakeDoesNotRecordTheSameMessageTwice(t *testing.T) {
	m := New(true)
	typeInto(t, m, "again")
	m.Take()
	m.SetValue("again")
	m.Take()
	if len(m.history) != 1 {
		t.Fatalf("history = %#v; re-sending the same text must not duplicate it", m.history)
	}
}

func TestHistoryPrevAndNextWalkAndUnwalk(t *testing.T) {
	m := New(true)
	for _, s := range []string{"one", "two", "three"} {
		m.SetValue(s)
		m.Take()
	}
	// After Take, the browse position is "not browsing" — the prompt is empty
	// and the next HistoryPrev shows the most recent message.
	if got := m.Value(); got != "" {
		t.Fatalf("prompt = %q; want empty after Take", got)
	}
	if !m.HistoryPrev() || m.Value() != "three" {
		t.Fatalf("first prev shows the newest, got %q", m.Value())
	}
	if !m.HistoryPrev() || m.Value() != "two" {
		t.Fatalf("second prev shows the next newest, got %q", m.Value())
	}
	if !m.HistoryNext() || m.Value() != "three" {
		t.Fatalf("next walks back down, got %q", m.Value())
	}
	if !m.HistoryNext() || m.Value() != "" {
		t.Fatalf("next past the end returns to an empty prompt, got %q", m.Value())
	}
	if m.HistoryNext() {
		t.Fatal("next at the end is a no-op, not a wrap")
	}
	if !m.HistoryPrev() || m.Value() != "three" {
		t.Fatalf("prev works again after walking to the end, got %q", m.Value())
	}
}

func TestHistoryPrevRefusesAMultiLineDraft(t *testing.T) {
	// The arrow keys belong to editing once there is more than one line.
	m := New(true)
	m.SetValue("recorded")
	m.Take()
	m.SetValue("a draft\nthat spans")
	if m.HistoryPrev() {
		t.Fatal("history must not walk under a multi-line draft")
	}
	if !strings.Contains(m.Value(), "draft") {
		t.Fatalf("the draft must survive the refused walk: %q", m.Value())
	}
}

func TestHistoryPrevOnAnEmptyHistoryIsANoOp(t *testing.T) {
	m := New(true)
	if m.HistoryPrev() || m.HistoryNext() {
		t.Fatal("no history, no walk")
	}
}

func TestSetValueMovesTheCursorToEnd(t *testing.T) {
	m := New(true)
	m.SetValue("/sessions extra")
	// The proof the cursor sits after the text: typing continues the line.
	typeInto(t, m, "!")
	if got := m.Value(); got != "/sessions extra!" {
		t.Fatalf("cursor did not land at the end: %q", got)
	}
}

func TestInsertPutsTextWhereTheCursorIs(t *testing.T) {
	m := New(true)
	typeInto(t, m, "read ")
	m.Insert("main.go")
	if got := m.Value(); got != "read main.go" {
		t.Fatalf("Insert() = %q", got)
	}
}

func TestTheSuggestionMenuWalksAndWraps(t *testing.T) {
	m := New(true)
	m.Suggest([]command.Command{
		{Name: "sessions"}, {Name: "memory"}, {Name: "logs"},
	})
	if !m.MenuOpen() {
		t.Fatal("Suggest with commands opens the menu")
	}
	if m.SugIndex() != 0 {
		t.Fatalf("a fresh menu starts at the top, got %d", m.SugIndex())
	}
	m.SugMove(1)
	m.SugMove(1)
	if m.SugIndex() != 2 {
		t.Fatalf("two moves down = %d", m.SugIndex())
	}
	m.SugMove(1)
	if m.SugIndex() != 0 {
		t.Fatalf("the menu wraps, got %d", m.SugIndex())
	}
	m.SugMove(-1)
	if m.SugIndex() != 2 {
		t.Fatalf("the menu wraps backwards, got %d", m.SugIndex())
	}
	// A shorter list clamps the selection instead of pointing past it.
	m.Suggest([]command.Command{{Name: "one"}})
	if m.SugIndex() != 0 {
		t.Fatalf("selection clamped to the list, got %d", m.SugIndex())
	}
}

func TestCompleteWritesTheCommandAndLeavesRoomForArgs(t *testing.T) {
	m := New(true)
	m.Suggest([]command.Command{{Name: "sessions"}, {Name: "memory"}})
	m.SugMove(1)
	if !m.Complete() {
		t.Fatal("Complete on a highlighted row must complete")
	}
	if got := m.Value(); got != "/memory " {
		t.Fatalf("Complete() = %q; the trailing space is where arguments go", got)
	}
	if m.MenuOpen() {
		t.Fatal("completing closes the menu")
	}
	// Completing with nothing highlighted is a no-op, not a panic.
	m.Suggest(nil)
	if m.Complete() {
		t.Fatal("Complete with no menu must refuse")
	}
}

func TestSuggestWithNothingClosesTheMenu(t *testing.T) {
	m := New(true)
	m.Suggest([]command.Command{{Name: "logs"}})
	m.Suggest(nil)
	if m.MenuOpen() || len(m.Suggestions()) != 0 {
		t.Fatal("Suggest(nil) closes the menu")
	}
}

func TestPopQueueIsFIFO(t *testing.T) {
	m := New(true)
	m.Queue("first")
	m.Queue("second")
	if got, _ := m.PopQueue(); got != "first" {
		t.Fatalf("PopQueue() = %q; the queue is a promise about order", got)
	}
	if got, _ := m.PopQueue(); got != "second" {
		t.Fatalf("PopQueue() = %q", got)
	}
	if _, ok := m.PopQueue(); ok {
		t.Fatal("an empty queue must say so, not hand back a phantom message")
	}
}

func TestDropLastQueuedRemovesTheNewestPromise(t *testing.T) {
	m := New(true)
	m.Queue("keep me")
	m.Queue("drop me")
	if !m.DropLastQueued() {
		t.Fatal("DropLastQueued on a loaded queue must drop")
	}
	if q := m.Queued(); len(q) != 1 || q[0] != "keep me" {
		t.Fatalf("queue = %#v; only the newest promise goes", q)
	}
	if m.DropLastQueued() {
		m.DropLastQueued() // drops "keep me"
	}
	if m.DropLastQueued() {
		t.Fatal("dropping from an empty queue must refuse")
	}
}

func TestRowsCountsTheMenuAndTheText(t *testing.T) {
	m := New(true)
	one := m.Rows()
	if one < MinRows {
		t.Fatalf("Rows() = %d, want at least the input", one)
	}
	m.Suggest(make([]command.Command, 20))
	withMenu := m.Rows()
	// 20 suggestions are capped at MenuRows, plus the line that labels the
	// arrows — so the menu adds MenuRows+1, not 21.
	if withMenu != one+MenuRows+1 {
		t.Fatalf("menu of 20 adds %d rows, want %d (capped)", withMenu-one, MenuRows+1)
	}
	m.Suggest(nil)
	if m.Rows() != one {
		t.Fatal("closing the menu gives the rows back")
	}
}

func TestTheViewShowsTheQueueAsNumberedPromises(t *testing.T) {
	m := New(true)
	m.SetWidth(80)
	m.Queue("do this next")
	th := theme.Default()
	v := m.View(th, true)
	if !strings.Contains(v, "1·") || !strings.Contains(v, "do this next") {
		t.Fatalf("a queued message must be visible and numbered:\n%s", v)
	}
}
