package agent

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
)

// The Agent interface is the whole boundary between the interface and
// whatever runs the conversation, which is why its contract is pinned here
// with no backend at all: a scripted fake speaking the real message shapes,
// and Offline for the no-backend case.

// Script is a backend that replays a fixed stream of messages: the shapes a
// live pi turn produces, in the order the interface depends on — Started
// first, exactly one of Done or Failed last.
type Script struct {
	msgs []tea.Msg
	sent []string
}

func (s *Script) Send(prompt string) tea.Cmd {
	s.sent = append(s.sent, prompt)
	return func() tea.Msg { return Started{} }
}

func (s *Script) Steer(prompt string) tea.Cmd { return s.Send(prompt) }
func (s *Script) Interrupt() tea.Cmd          { return nil }

// Next hands out the script one message at a time, the way the program loop
// re-issues it after every agent message.
func (s *Script) Next() tea.Cmd {
	if len(s.msgs) == 0 {
		return nil
	}
	m := s.msgs[0]
	s.msgs = s.msgs[1:]
	return func() tea.Msg { return m }
}

func (s *Script) Model() string { return "scripted" }
func (s *Script) Close() error  { return nil }

func (s *Script) SwitchSession(path string) tea.Cmd {
	s.sent = append(s.sent, "switch_session "+path)
	return nil
}

func (s *Script) NewSession() tea.Cmd {
	s.sent = append(s.sent, "new_session")
	return nil
}

func (s *Script) Answer(d UIDialog, a UIAnswer) tea.Cmd {
	s.sent = append(s.sent, "answer "+d.ID)
	return nil
}

// TestAWholeTurnStreamsInTheOrderTheTranscriptAssumes: the interface builds
// its blocks on this exact order — a tool block opens on ToolStart and is
// filled by ToolEnd, a delegation nests under the turn, stats land when the
// round trip is over.
func TestAWholeTurnStreamsInTheOrderTheTranscriptAssumes(t *testing.T) {
	s := &Script{msgs: []tea.Msg{
		Think{Text: "weighing "},
		Think{Text: "options"},
		Text{Text: "I'll read "},
		Text{Text: "the file."},
		ToolStart{ID: "call_1", Name: "read", Args: "path=main.go"},
		ToolEnd{ID: "call_1", Out: "package main", Detail: "package main", OK: true},
		Delegated{Label: "scout", Model: "haiku", Detail: "mapped the repo", OK: true},
		Stats{TurnStats: TurnStats{Provider: "anthropic", Model: "opus", TokensIn: 10, TokensOut: 5, Cost: 0.01}},
		Done{},
	}}

	// Send starts the turn; the acknowledgement comes back through the cmd.
	if _, ok := s.Send("look at this")().(Started); !ok {
		t.Fatal("Send must acknowledge with Started — the spinner starts there")
	}
	if len(s.sent) != 1 || s.sent[0] != "look at this" {
		t.Fatalf("Send must carry the prompt verbatim, got %q", s.sent)
	}

	// Drive the stream the way the program loop does: Next, feed, repeat.
	var got []tea.Msg
	for {
		cmd := s.Next()
		if cmd == nil {
			break
		}
		m := cmd()
		if m == nil {
			continue
		}
		got = append(got, m)
	}

	if len(got) != 9 {
		t.Fatalf("got %d messages, want 9: %#v", len(got), got)
	}
	// The two-message kinds: two thinks are two chunks, not one overwrite.
	if got[0].(Think).Text != "weighing " || got[1].(Think).Text != "options" {
		t.Fatalf("thinking chunks must arrive as written: %#v %#v", got[0], got[1])
	}
	if got[2].(Text).Text != "I'll read " || got[3].(Text).Text != "the file." {
		t.Fatalf("text chunks must arrive as written: %#v %#v", got[2], got[3])
	}
	// A tool call brackets: start says who and with what, end carries the
	// full result, not just the summary line.
	start := got[4].(ToolStart)
	if start.ID != "call_1" || start.Name != "read" || start.Args != "path=main.go" {
		t.Fatalf("got %#v", start)
	}
	end := got[5].(ToolEnd)
	if end.ID != "call_1" || !end.OK || end.Out != "package main" || end.Detail != "package main" {
		t.Fatalf("got %#v", end)
	}
	// A failed tool is the same message with OK false — the transcript draws
	// the failure from the same fields it draws the success.
	fail := ToolEnd{ID: "call_2", Detail: "denied", OK: false, Out: "permission denied"}
	if fail.OK || fail.Detail != "denied" {
		t.Fatalf("got %#v", fail)
	}
	// Delegation reports a sub-agent run with its own model and outcome.
	d := got[6].(Delegated)
	if d.Label != "scout" || d.Model != "haiku" || !d.OK || d.Detail != "mapped the repo" {
		t.Fatalf("got %#v", d)
	}
	// Stats is what a round trip cost.
	st := got[7].(Stats)
	if st.Provider != "anthropic" || st.Model != "opus" || st.TokensIn != 10 || st.TokensOut != 5 || st.Cost != 0.01 {
		t.Fatalf("got %#v", st.TurnStats)
	}
	// Done ends the turn — the spinner stops there.
	if _, ok := got[8].(Done); !ok {
		t.Fatalf("the turn must end with Done, got %#v", got[8])
	}
}

// TestAFailedTurnEndsWithFailedNotDone: exactly one of Done or Failed, and
// which one it is decides whether the transcript shows an error block.
func TestAFailedTurnEndsWithFailedNotDone(t *testing.T) {
	s := &Script{msgs: []tea.Msg{Text{Text: "half an answer"}, Failed{Err: errString("provider 500")}}}
	var got []tea.Msg
	for {
		cmd := s.Next()
		if cmd == nil {
			break
		}
		if m := cmd(); m != nil {
			got = append(got, m)
		}
	}
	f, ok := got[len(got)-1].(Failed)
	if !ok || f.Err == nil || !strings.Contains(f.Err.Error(), "provider 500") {
		t.Fatalf("got %#v; a dead turn must end in Failed carrying the reason", got[len(got)-1])
	}
}

// TestSteerUsesTheSamePathAsSend: steering is just another turn-starter as
// far as the boundary is concerned — the distinction is the backend's.
func TestSteerUsesTheSamePathAsSend(t *testing.T) {
	s := &Script{}
	s.Steer("actually, no")()
	if len(s.sent) != 1 || s.sent[0] != "actually, no" {
		t.Fatalf("Steer must carry its text, got %q", s.sent)
	}
}

// --- the offline backend --------------------------------------------------

// TestOfflineFailsLoudlyAndSpecifically: an interface that silently does
// nothing when its backend is missing wastes the first ten minutes of
// everyone who tries it. Send must come back as Failed carrying the reason.
func TestOfflineFailsLoudlyAndSpecifically(t *testing.T) {
	o := Offline{Reason: "no agent backend: run with --repo to start one"}
	msg := o.Send("hello")()
	f, ok := msg.(Failed)
	if !ok {
		t.Fatalf("got %#v; an offline send must fail, not pretend to think", msg)
	}
	if !strings.Contains(f.Err.Error(), "--repo") {
		t.Fatalf("the failure must say how to fix it: %v", f.Err)
	}
}

// TestOfflineAlwaysNamesAReason: an Offline built without one still fails
// with words, never a bare empty error.
func TestOfflineAlwaysNamesAReason(t *testing.T) {
	f, ok := Offline{}.Send("x")().(Failed)
	if !ok || f.Err == nil || f.Err.Error() == "" {
		t.Fatalf("got %#v; an empty reason must still become a sentence", f)
	}
}

// TestOfflineIsInertEverywhereElse: Steer is Send (it fails too), and
// Interrupt, Next and Close are no-ops that must not panic — the interface
// calls them without checking whether a backend exists.
func TestOfflineIsInertEverywhereElse(t *testing.T) {
	o := Offline{Reason: "x"}
	if _, ok := o.Steer("y")().(Failed); !ok {
		t.Fatal("Steer on an offline backend must fail like Send")
	}
	if o.Interrupt() != nil {
		t.Fatal("Interrupt offline is a no-op")
	}
	if o.Next() != nil {
		t.Fatal("Next offline is a no-op — nothing will ever arrive")
	}
	if err := o.Close(); err != nil {
		t.Fatalf("Close offline must be clean: %v", err)
	}
	if o.Model() != "offline" {
		t.Fatalf("Model() = %q; the header must say which backend is absent", o.Model())
	}
}

type errString string

func (e errString) Error() string { return string(e) }
