package app

import (
	"strings"
	"sync"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/agent"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/auth"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/chat"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/command"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/overlay"
)

// The command surface, both halves of it: a name the interface does not know
// is routed to the agent that does, and the agent gets to say which commands
// those are. Tested with a scripted backend, the way everything here is —
// nothing in this file spawns a process or needs a network.

// dial is a backend with a live agent's shape and no process behind it: it
// keeps every line it was sent, which is the only way to check routing without
// a real agent. Deliberately not agent.Offline, so the interface treats it as
// live; deliberately mute, so what it was ASKED is the whole of the evidence.
type dial struct {
	mu   sync.Mutex
	sent []string
}

var _ agent.Agent = (*dial)(nil)

func (d *dial) Send(text string) tea.Cmd  { d.keep(text); return nil }
func (d *dial) Steer(text string) tea.Cmd { d.keep(text); return nil }
func (d *dial) Interrupt() tea.Cmd        { return nil }
func (d *dial) Next() tea.Cmd             { return nil }
func (d *dial) Model() string             { return "dial" }
func (d *dial) Close() error              { return nil }

func (d *dial) keep(text string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.sent = append(d.sent, text)
}

// Sent is everything the interface handed to the backend, in order.
func (d *dial) Sent() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.sent...)
}

// liveFixture is the shared fixture with a live agent attached. The home is
// configured first: a first run with a real backend opens the accounts list,
// and a test whose keystrokes land in an overlay would be testing that instead.
func liveFixture(t *testing.T, w, h int) (*Model, *dial) {
	t.Helper()
	home, cwd := t.TempDir(), t.TempDir()
	if _, err := auth.SetKey(home, "anthropic", "sk-test-0123456789abcdef", "claude-x", time.Now()); err != nil {
		t.Fatal(err)
	}
	d := &dial{}
	m := New(Config{Home: home, CWD: cwd, Dark: true, Agent: d})
	m.Resize(w, h)
	return m, d
}

// answer is what a live session's get_commands reply looks like once pi's
// fields have been mapped onto this list's — the message the app folds.
func answer() agent.Commands {
	return agent.Commands{List: []agent.CommandInfo{
		{Name: "hook", Description: "list and fire hooks", Source: "extension"},
		{Name: "implement", Description: "implement a plan", Source: "prompt", Location: "project",
			Path: "/p/.pi/agent/prompts/implement.md"},
	}}
}

func TestAnUnknownCommandGoesToTheAgentWhenOneIsAttached(t *testing.T) {
	// /hook is the agent's: pi registers it as an extension command, this
	// list has never heard of it, and refusing the line was the bug.
	m, d := liveFixture(t, 100, 30)
	typeIn(t, m, "/hook list")
	press(t, m, "enter")

	if got := d.Sent(); len(got) != 1 || got[0] != "/hook list" {
		t.Fatalf("the line must reach the agent exactly as typed, got %q", got)
	}
	blocks := m.Chat().Blocks()
	if last := blocks[len(blocks)-1]; last.Kind != chat.User || strings.Join(last.Body, " ") != "/hook list" {
		t.Fatalf("the transcript must show what was sent, got %#v", last)
	}
	if !strings.Contains(screen(m), "sent /hook to the agent") {
		t.Fatalf("the status line must say what happened rather than read like a refusal:\n%s", lastLine(screen(m)))
	}
}

func TestAnUnknownCommandIsRefusedWhenNoAgentIsAttached(t *testing.T) {
	// The other half of the router, and the half that must not be lost: with
	// nothing attached there is nothing to route to, so a typo stays a typo
	// instead of becoming a question for a model that is not there.
	m := fixture(t, 100, 30)
	typeIn(t, m, "/hook list")
	press(t, m, "enter")
	if !strings.Contains(screen(m), "no command called /hook") {
		t.Fatalf("it must say so:\n%s", lastLine(screen(m)))
	}
	if m.Chat().Len() != 1 {
		t.Fatal("nothing may be sent when there is no agent to send it to")
	}
}

func TestACommandTheAgentImplementsGoesOverVerbatim(t *testing.T) {
	m, d := liveFixture(t, 100, 30)
	m.Update(answer())

	// The merge puts it in the one list, tagged as the agent's own so it
	// renders under its own heading instead of pretending to be a skill.
	c, ok := command.Find(m.Commands(), "hook")
	if !ok || c.Kind != command.Agent || c.Desc != "list and fire hooks" || c.Scope != "extension" {
		t.Fatalf("got %#v", c)
	}
	if c, ok := command.Find(m.Commands(), "implement"); !ok || c.Scope != "prompt · project" || c.Path != "/p/.pi/agent/prompts/implement.md" {
		t.Fatalf("source and location become the scope, and the path survives: %#v", c)
	}

	// pi expands a prompt template and executes an extension command. Both
	// have to arrive as the line you typed: rewritten into a "use the X
	// skill" prompt, neither would run at all.
	typeIn(t, m, "/implement tidy the imports")
	press(t, m, "enter")
	if got := d.Sent(); len(got) != 1 || got[0] != "/implement tidy the imports" {
		t.Fatalf("got %q", got)
	}
}

func TestARoutedCommandWaitsForTheTurnLikeTypedText(t *testing.T) {
	// Mid-turn, the line queues. pi runs an extension command during
	// streaming but rejects a prompt template or a skill command while it is
	// streaming, and one honest path beats a rule that depends on which of
	// the three kinds you happened to type.
	m, d := liveFixture(t, 100, 30)
	m.Update(answer())
	m.working = true
	typeIn(t, m, "/hook list")
	press(t, m, "enter")

	if got := d.Sent(); len(got) != 0 {
		t.Fatalf("nothing goes out mid-turn, got %q", got)
	}
	if q := m.prompt.Queued(); len(q) != 1 || q[0] != "/hook list" {
		t.Fatalf("got %q", q)
	}
	if !strings.Contains(screen(m), "queued /hook") {
		t.Fatalf("the status line must say what happened:\n%s", lastLine(screen(m)))
	}
}

func TestTheAgentsCommandsShowUpInThePaletteAndTheSlashMenu(t *testing.T) {
	m, _ := liveFixture(t, 110, 30)
	m.Update(answer())

	// The palette is the surface that claims to list everything.
	press(t, m, "ctrl+k")
	typeIn(t, m, "hook")
	s := screen(m)
	if !strings.Contains(s, "/hook") || !strings.Contains(s, "AGENT") {
		t.Fatalf("the palette must show it, under the agent's own heading:\n%s", s)
	}
	press(t, m, "esc")

	// And the slash menu, which the same list feeds.
	press(t, m, "/")
	typeIn(t, m, "hoo")
	if !strings.Contains(screen(m), "/hook") {
		t.Fatalf("the slash menu must offer it:\n%s", screen(m))
	}
}

func TestHelpListsTheAgentsCommandsAndRunsThem(t *testing.T) {
	m, d := liveFixture(t, 110, 30)
	m.Update(answer())

	press(t, m, "ctrl+h")
	if m.Overlay() == nil || m.Overlay().Kind != overlay.Help {
		t.Fatal("^h opens the help list")
	}
	// Filtered to it, because a help list is long and the rows that matter
	// here are the ones no other surface would show.
	typeIn(t, m, "hook")
	if !strings.Contains(screen(m), "/hook") {
		t.Fatalf("help says \"every key and command\"; the agent's commands are the commands:\n%s", screen(m))
	}
	// A row that looks runnable must be runnable, whichever list it is in.
	press(t, m, "enter")
	if got := d.Sent(); len(got) != 1 || got[0] != "/hook" {
		t.Fatalf("enter on a command row must run it, got %q", got)
	}
}

func TestAShadowedNameKeepsTheInterfacesOwnCommand(t *testing.T) {
	// The agent may well have a "help" of its own. The interface's is the one
	// that can open a surface, so it keeps the name; the agent's row is
	// dropped rather than renamed.
	m, d := liveFixture(t, 100, 30)
	m.Update(agent.Commands{List: []agent.CommandInfo{
		{Name: "help", Description: "the agent's own help", Source: "extension"},
		{Name: "model", Description: "the agent's model picker", Source: "extension"},
	}})

	help, ok := command.Find(m.Commands(), "help")
	if !ok || help.Kind != command.Builtin || help.Chord != "^h" {
		t.Fatalf("a shadowed name must keep the interface's command: %#v", help)
	}
	n := 0
	for _, c := range m.Commands() {
		if c.Name == "help" {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("one name, one row — got %d rows called help", n)
	}
	typeIn(t, m, "/help")
	press(t, m, "enter")
	if m.Overlay() == nil || m.Overlay().Kind != overlay.Help {
		t.Fatal("typing /help must still open the help list, not go round the agent and back")
	}
	if got := d.Sent(); len(got) != 0 {
		t.Fatalf("nothing should have been sent, got %q", got)
	}
}

func TestAnEmptyAnswerChangesNothing(t *testing.T) {
	// No reply, a failed reply, a reply with no commands in it: all three
	// arrive as "nothing to merge" and must leave the list exactly as it was.
	// A collision-free merge that quietly emptied the list would take the
	// built-ins with it, and ^k would be a blank panel.
	m, _ := liveFixture(t, 100, 30)
	before := len(m.Commands())
	m.Update(agent.Commands{})
	m.Update(agent.Commands{List: []agent.CommandInfo{{Name: "", Description: "nameless"}}})
	if got := len(m.Commands()); got != before {
		t.Fatalf("the list went from %d rows to %d", before, got)
	}
	if _, ok := command.Find(m.Commands(), "help"); !ok {
		t.Fatal("the interface's own commands must survive an empty answer")
	}
}
