package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/agent"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/chat"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/command"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/session"
)

// The transcript and the model's context are two things. These tests pin the
// half that makes them agree: picking a session, /new, and being told in the
// transcript what the agent did with the instruction — including "nothing".

// writeSession puts a minimal stored session where pi would have written it,
// and returns its path. Nothing here reads the developer's real ~/.pi: the
// home is the fixture's temp dir.
func writeSession(t *testing.T, home string) string {
	t.Helper()
	dir := filepath.Join(session.Root(home), "-tmp-proj")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "2026-08-20T10-00-00.jsonl")
	lines := []string{
		`{"type":"session","id":"s1","cwd":"/tmp/proj","timestamp":"2026-08-20T10:00:00Z"}`,
		`{"type":"message","message":{"role":"user","content":[{"type":"text","text":"make the resume flow real"}]}}`,
		`{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"on it"}]}}`,
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestPickingASessionTellsTheAgentToMove(t *testing.T) {
	// The replay is only a view. Without switch_session the next prompt goes
	// to the session this process was launched with, and the reader is
	// looking at one conversation while the model answers from another.
	m, d := liveFixture(t, 100, 30)
	file := writeSession(t, m.Home())

	m.resume(file)

	if got := sent(d); !strings.Contains(got, "switch_session "+file) {
		t.Fatalf("resuming must move the agent too, got %q", got)
	}
	if !strings.Contains(screen(m), "make the resume flow real") {
		t.Fatalf("and the replay is still the point of it:\n%s", screen(m))
	}
}

func TestTheSwitchIsAcknowledgedInTheTranscript(t *testing.T) {
	m, _ := liveFixture(t, 120, 30)
	file := writeSession(t, m.Home())
	m.resume(file)

	m.Update(agent.SessionMoved{Command: "switch_session"})
	if !strings.Contains(screen(m), "the agent switched to "+filepath.Base(file)) {
		t.Fatalf("the agent's side of the switch must be on the record:\n%s", screen(m))
	}
}

func TestARefusedSwitchIsVisibleNotSilent(t *testing.T) {
	// pi answers success + cancelled when an extension vetoes a switch. That
	// is the case where the screen and the model disagree, so it is the one
	// that must never be quiet.
	m, _ := liveFixture(t, 120, 30)
	file := writeSession(t, m.Home())
	m.resume(file)

	m.Update(agent.SessionMoved{Command: "switch_session", Cancelled: true})
	shown := screen(m)
	if !strings.Contains(shown, "the switch was refused") {
		t.Fatalf("a refused switch must say the agent did not move:\n%s", shown)
	}
	if !strings.Contains(shown, "still in the session it had") {
		t.Fatalf("...and say where it still is:\n%s", shown)
	}
	if !strings.Contains(lastLine(shown), "switch refused") {
		t.Fatalf("the status line too: %q", lastLine(shown))
	}
}

func TestNewSessionTellsTheAgentToStartOne(t *testing.T) {
	m, d := liveFixture(t, 120, 30)
	m.Chat().Append(&chat.Block{Kind: chat.User, Body: []string{"a previous conversation"}})

	// /new is the reader's name for it; pi calls the operation new_session.
	typeIn(t, m, "/new")
	press(t, m, "enter")

	if got := sent(d); !strings.Contains(got, "new_session") {
		t.Fatalf("/new must clear the model's context, not just the view, got %q", got)
	}
	if !strings.Contains(lastLine(screen(m)), "the agent starts from nothing") {
		t.Fatalf("and say so: %q", lastLine(screen(m)))
	}
	if !strings.Contains(screen(m), "ready.") || strings.Contains(screen(m), "a previous conversation") {
		t.Fatalf("the transcript is a fresh one again:\n%s", screen(m))
	}
}

func TestTheClearBuiltinIsTheSameOperation(t *testing.T) {
	// /clear is the builtin; /new is pi's name for the operation. One
	// operation, one effect — the palette row and the typed command must not
	// drift.
	m, d := liveFixture(t, 120, 30)
	c, ok := command.Find(m.Commands(), "clear")
	if !ok {
		t.Fatal("the clear builtin vanished from the command list")
	}
	m.runSlash(c, "")
	if got := sent(d); !strings.Contains(got, "new_session") {
		t.Fatalf("/clear must start a session on the agent too, got %q", got)
	}
}

func TestANewSessionTheAgentRefusedIsVisible(t *testing.T) {
	m, _ := liveFixture(t, 120, 30)
	m.Update(agent.SessionMoved{Command: "new_session", Cancelled: true})
	if !strings.Contains(screen(m), "the agent still remembers the turns above") {
		t.Fatalf("a cancelled new_session is a transcript that lies otherwise:\n%s", screen(m))
	}
}

func TestTheTrustDecisionIsOnTheRecord(t *testing.T) {
	// The project-trust outcome is decided at spawn and belongs in the
	// transcript: it decides which of a project's own settings, extensions
	// and skills the agent loads, and in RPC mode pi says nothing about it.
	note := "project trust: no decision recorded for this project — defaulting to --no-approve; " +
		"pi ignores this project's .pi settings, extensions, prompts and skills until one is recorded"
	m := New(Config{Home: t.TempDir(), CWD: t.TempDir(), Dark: true, Agent: agent.Offline{Reason: "test"}, TrustNote: note})
	m.Resize(120, 30)
	if !strings.Contains(screen(m), "no decision recorded") {
		t.Fatalf("the trust decision must be readable in the transcript:\n%s", screen(m))
	}

	// And nothing is invented when nothing was spawned: --dump and offline
	// runs have no decision to report.
	plain := fixture(t, 120, 30)
	if strings.Contains(screen(plain), "project trust") {
		t.Fatal("offline frames must not carry a decision nobody made")
	}
}
