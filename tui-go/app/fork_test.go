package app

import (
	"strings"
	"testing"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/agent"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/chat"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/overlay"
)

// The branch picker: /fork asks pi which of its messages a branch can start
// from, and the reader chooses. Newest first, the message as the row, where you
// are marked — and esc, a filter that matches nothing, an empty answer, no
// agent and a running turn each end somewhere that says what happened.
//
// Everything here is driven through the scripted backend, the way the rest of
// this package is: nothing spawns a process, and nothing needs a network.

// TestTheForkPickerOffersEveryMessageNewestFirstWithTheTipMarked: the whole
// answer is one list, so the reader gets all of it — the newest message first
// (it is the one just sent, and the row a fork at the tip starts on), the
// message itself as the label, and the position marked rather than left to be
// inferred from the order.
func TestTheForkPickerOffersEveryMessageNewestFirstWithTheTipMarked(t *testing.T) {
	m, d := liveFixture(t, 100, 30)
	typeIn(t, m, "/fork")
	press(t, m, "enter")

	m.Update(agent.ForkPoints{List: []agent.ForkPoint{
		{EntryID: "a1", Text: "an earlier prompt"},
		{EntryID: "b2", Text: "  a  second\none  "},
		{EntryID: "c3", Text: "the message just sent"},
	}})

	ov := m.Overlay()
	if ov == nil || ov.Kind != overlay.Fork {
		t.Fatalf("/fork must open the picker on pi's answer, got %v", ov)
	}
	if ov.Count() != 3 {
		t.Fatalf("every forkable message is a row, got %d", ov.Count())
	}

	// Newest first: the row the cursor starts on is the last one pi listed,
	// and it is marked as where the session is now.
	first, ok := ov.SelectedItem()
	if !ok {
		t.Fatal("the picker opens with a row under the cursor")
	}
	if first.Label != "the message just sent" {
		t.Fatalf("the first row is the newest message, got %q", first.Label)
	}
	if first.Detail != "you are here" {
		t.Fatalf("the current position must be marked, got %q", first.Detail)
	}
	if first.ID != "fork:c3" {
		t.Fatalf("the row means pi's entry id, got %q", first.ID)
	}

	// Oldest last, and the row says how far back it is. The words are the
	// reader's own, so a message typed with newlines and padding reads as the
	// line they meant.
	ov.Move(1)
	older, _ := ov.SelectedItem()
	if older.Label != "a second one" {
		t.Fatalf("a message with newlines and padding previews on one line, got %q", older.Label)
	}
	if older.Detail != "1 message back" {
		t.Fatalf("a row must say how far back it is, got %q", older.Detail)
	}
	ov.Move(1)
	oldest, _ := ov.SelectedItem()
	if oldest.Label != "an earlier prompt" {
		t.Fatalf("the last row is the oldest message, got %q", oldest.Label)
	}
	if oldest.Detail != "2 messages back" {
		t.Fatalf("the oldest row is two messages back, got %q", oldest.Detail)
	}

	if !strings.Contains(screen(m), "where a branch can start — enter branches, esc cancels") {
		t.Fatalf("the picker must say what the keys do, without the panel cutting it off:\n%s", screen(m))
	}
	if got := d.Sent(); len(got) != 1 || got[0] != "get_fork_messages" {
		t.Fatalf("looking is not forking, and nothing may go out, got %q", got)
	}
}

// TestPickingAnEarlierMessageBranchesThereAndCutsTheTranscriptBack: the point
// of the picker. The branch starts where the reader said, and the transcript is
// cut there — not at the newest message — because everything after that message
// belongs to the session the branch leaves behind, and leaving it on screen
// would show a conversation the model no longer has.
func TestPickingAnEarlierMessageBranchesThereAndCutsTheTranscriptBack(t *testing.T) {
	m, d := liveFixture(t, 100, 30)
	typeIn(t, m, "an earlier prompt")
	press(t, m, "enter")
	m.Update(agent.Text{Text: "ok"})
	m.Update(agent.Done{})
	typeIn(t, m, "make it stricter")
	press(t, m, "enter")
	m.Update(agent.Text{Text: "stricter now"})
	m.Update(agent.Done{})
	before := m.Chat().Len()

	typeIn(t, m, "/fork")
	press(t, m, "enter")
	m.Update(agent.ForkPoints{List: []agent.ForkPoint{
		{EntryID: "a1", Text: "an earlier prompt"},
		{EntryID: "b2", Text: "make it stricter"},
	}})

	// One row down from the tip, then the choice.
	press(t, m, "down")
	press(t, m, "enter")
	if got := d.Sent(); got[len(got)-1] != "fork a1" {
		t.Fatalf("the fork must be at the row the reader picked, got %q", got)
	}
	if m.Overlay() != nil {
		t.Fatal("a branch is a move, not a preference: the picker closes on the choice")
	}

	m.Update(agent.Forked{Text: "an earlier prompt"})

	// The cut lands on the FIRST message, so the second one — and the reply to
	// it — are gone from the transcript rather than merely looking stale. What
	// is left is what came before the first message the reader sent (the
	// welcome), and the line that says what happened.
	if got, was := m.Chat().Len(), before; got >= was {
		t.Fatalf("the transcript must be cut back to the branch point: %d blocks, was %d", got, was)
	}
	for i, b := range m.Chat().Blocks() {
		if b.Kind == chat.User {
			t.Fatalf("block %d is a message the branch does not contain", i)
		}
	}
	if v := m.prompt.Value(); v != "an earlier prompt" {
		t.Fatalf("the branch's message belongs back in the editor, got %q", v)
	}
	last := m.Chat().Blocks()[m.Chat().Len()-1]
	if last.Kind != chat.Notice || !strings.Contains(strings.Join(last.Body, " "), "branched at “an earlier prompt”") {
		t.Fatalf("the branch must be said out loud, got %#v", last)
	}
}

// TestEscapingTheForkPickerForksNothing: esc is how you look at what a branch
// would cost and decide against it. The session must be exactly as it was, and
// the status line has to say so — a picker that vanishes in silence is a key
// the reader cannot tell apart from one that did something.
func TestEscapingTheForkPickerForksNothing(t *testing.T) {
	m, d := liveFixture(t, 100, 30)
	typeIn(t, m, "keep me")
	press(t, m, "enter")
	m.Update(agent.Text{Text: "kept"})
	m.Update(agent.Done{})
	blocks := m.Chat().Len()

	typeIn(t, m, "/fork")
	press(t, m, "enter")
	m.Update(agent.ForkPoints{List: []agent.ForkPoint{{EntryID: "a1", Text: "keep me"}}})
	press(t, m, "esc")

	if m.Overlay() != nil {
		t.Fatal("esc leaves the picker")
	}
	// The transcript's own message went to the agent, of course — what must not
	// be there is a fork: nothing was asked for, so nothing may be sent.
	for _, s := range d.Sent() {
		if strings.HasPrefix(s, "fork ") {
			t.Fatalf("esc must fork nothing, got %q", d.Sent())
		}
	}
	if got := d.Sent(); got[len(got)-1] != "get_fork_messages" {
		t.Fatalf("the picker's own ask is the last thing sent, got %q", got)
	}
	if got := m.Chat().Len(); got != blocks {
		t.Fatalf("a fork that was not made must not touch the transcript: %d blocks, was %d", got, blocks)
	}
	if m.prompt.Value() != "" {
		t.Fatalf("no message came back to the editor, got %q", m.prompt.Value())
	}
	if !strings.Contains(screen(m), "no branch") {
		t.Fatalf("the status line must say nothing was forked:\n%s", lastLine(screen(m)))
	}
}

// TestEnteringWithNothingMatchingTheFilterForksNothing: the picker filters as
// you type, so enter on an empty list is a cursor on no row. Forking the row
// that used to be there would be a branch nobody asked for; saying so is the
// whole of it.
func TestEnteringWithNothingMatchingTheFilterForksNothing(t *testing.T) {
	m, d := liveFixture(t, 100, 30)
	typeIn(t, m, "/fork")
	press(t, m, "enter")
	m.Update(agent.ForkPoints{List: []agent.ForkPoint{
		{EntryID: "a1", Text: "an earlier prompt"},
		{EntryID: "b2", Text: "make it stricter"},
	}})

	typeIn(t, m, "zzz")
	if got := m.Overlay().Count(); got != 0 {
		t.Fatalf("the query must have emptied the list, %d rows left", got)
	}
	press(t, m, "enter")

	if got := d.Sent(); len(got) != 1 || got[0] != "get_fork_messages" {
		t.Fatalf("no row, no fork — got %q", got)
	}
	if !strings.Contains(screen(m), "no message chosen") {
		t.Fatalf("the status line must say so:\n%s", lastLine(screen(m)))
	}
}

// TestTheCutLandsOnTheChosenMessageWhenTheSameLineWasSentTwice: sending the
// same line twice is ordinary — a retry, a message resent on a new branch — and
// it is why the cut is a POSITION and not a search. Searching for the words
// would land on the later copy, cutting the transcript at a message the branch
// does not start from and leaving turns on screen the model does not have.
func TestTheCutLandsOnTheChosenMessageWhenTheSameLineWasSentTwice(t *testing.T) {
	blocks := []*chat.Block{
		{Kind: chat.User, Body: []string{"run it again"}},
		{Kind: chat.Agent, Body: []string{"done"}},
		{Kind: chat.User, Body: []string{"run it again"}},
		{Kind: chat.Agent, Body: []string{"done again"}},
	}
	// The first of the two: cutting there keeps nothing of the exchange.
	if got := branchCut(blocks, "run it again", 1); got != 0 {
		t.Fatalf("the first “run it again” is at 0, got %d", got)
	}
	// The newest one, which is the row marked “you are here”.
	if got := branchCut(blocks, "run it again", 0); got != 2 {
		t.Fatalf("the newest “run it again” is at 2, got %d", got)
	}
	// A message the reader typed as several lines is one message: the block
	// holds it split, and the branch's words come back whole.
	multi := []*chat.Block{{Kind: chat.User, Body: []string{"first", "second"}}}
	if got := branchCut(multi, "first\nsecond", 0); got != 0 {
		t.Fatalf("a multi-line message is one block, got %d", got)
	}
}

// TestTheCutFallsBackToTheWordsWhenTheCountDoesNotAgree: the position comes
// from the picker and is checked against what pi says the message was, so a
// transcript that has drifted — resumed from a different file, cleared under
// the picker — still cuts at the right message when it can, and at the newest
// message it sent when it cannot. Cutting somewhere wrong is the one outcome
// worth avoiding: it shows a branch that never existed.
func TestTheCutFallsBackToTheWordsWhenTheCountDoesNotAgree(t *testing.T) {
	blocks := []*chat.Block{
		{Kind: chat.User, Body: []string{"/hook list"}}, // the agent's, not a fork point
		{Kind: chat.Agent, Body: []string{"hooks"}},
		{Kind: chat.User, Body: []string{"make it stricter"}},
		{Kind: chat.Agent, Body: []string{"stricter now"}},
	}
	// Counted from the newest, one back is the command line — which is not the
	// message pi named, so the words decide instead.
	if got := branchCut(blocks, "make it stricter", 1); got != 2 {
		t.Fatalf("the words must decide when the count disagrees, got %d", got)
	}
	// Nothing in the transcript reads like the branch's message: the newest
	// user block is the last position that is certainly after the fork point.
	if got := branchCut(blocks, "a message from another session", 1); got != 2 {
		t.Fatalf("the newest user block is the fallback, got %d", got)
	}
}
