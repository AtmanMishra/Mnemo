package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/agent"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/auth"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/command"
)

// The command catalogue, both halves of #18.
//
// get_commands is the catalogue for the commands the agent implements: it is
// asked at startup, asked again on every new session, and asked on demand. The
// disk scan is the fallback — the whole list with no agent attached, and the
// rows pi does not answer for otherwise. One name, one row: a command pi
// already answers must not also appear as a disk row under a second spelling.

// catalogueFixture is a configured home, a project with two skills on disk, and
// a live backend. The skills are written before New because the disk scan is a
// startup snapshot: the agent is what is re-asked, not the disk.
func catalogueFixture(t *testing.T) (*Model, *dial) {
	t.Helper()
	home, cwd := t.TempDir(), t.TempDir()
	if _, err := auth.SetKey(home, "anthropic", "«redacted:sk-…»", "claude-x", time.Now()); err != nil {
		t.Fatal(err)
	}
	writeSkill(t, filepath.Join(cwd, ".claude", "skills"), "review", "the project's own review")
	writeSkill(t, filepath.Join(cwd, ".claude", "skills"), "notes", "keep notes")
	d := &dial{}
	m := New(Config{Home: home, CWD: cwd, Dark: true, Agent: d})
	m.Resize(100, 30)
	return m, d
}

// writeSkill puts one SKILL.md on disk, where the fallback scan looks.
func writeSkill(t *testing.T, dir, name, desc string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, name), 0o755); err != nil {
		t.Fatal(err)
	}
	body := "---\nname: " + name + "\ndescription: " + desc + "\n---\n\nbody\n"
	if err := os.WriteFile(filepath.Join(dir, name, "SKILL.md"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func hasCmd(m *Model, name string) bool {
	_, ok := command.Find(m.Commands(), name)
	return ok
}

// countSent is how many times the interface handed a particular thing to the
// backend. The requests go out in the same breath as the notify that follows
// them, so counting is the only way to tell "asked again" from "asked once".
func countSent(d *dial, want string) int {
	n := 0
	for _, s := range d.Sent() {
		if s == want {
			n++
		}
	}
	return n
}

// TestTheAgentIsTheCatalogueForTheCommandsItImplements: before an answer the
// disk scan is the list; after one, pi's row for the same skill replaces it, a
// name pi answers is not listed twice under the disk's spelling, and the disk
// still contributes the rows pi does not answer for.
func TestTheAgentIsTheCatalogueForTheCommandsItImplements(t *testing.T) {
	m, _ := catalogueFixture(t)

	// No answer yet: the disk scan is the whole catalogue.
	for _, want := range []string{"review", "notes"} {
		if !hasCmd(m, want) {
			t.Fatalf("with no answer from the agent, /%s must come from the disk scan: %v", want, names(m))
		}
	}

	m.Update(agent.Commands{List: []agent.CommandInfo{
		{Name: "skill:review", Description: "pi's own row for the same skill", Source: "skill", Location: "project"},
		{Name: "hook", Description: "list and fire hooks", Source: "extension"},
	}})

	if c, ok := command.Find(m.Commands(), "skill:review"); !ok || c.Kind != command.Agent || c.Desc != "pi's own row for the same skill" {
		t.Fatalf("the agent's row must be the one listed: %#v", c)
	}
	if hasCmd(m, "review") {
		t.Fatalf("a name pi already answers must not also appear as a disk row under a second spelling: %v", names(m))
	}
	if !hasCmd(m, "notes") {
		t.Fatalf("the disk still contributes what pi does not answer for: %v", names(m))
	}
	if !hasCmd(m, "hook") {
		t.Fatalf("the agent's extension command is missing: %v", names(m))
	}

	// A second answer replaces the first: pi is the authority, so a package
	// installed mid-session appears and one that is gone disappears, without
	// a restart in either case.
	m.Update(agent.Commands{List: []agent.CommandInfo{{Name: "later", Description: "installed since", Source: "extension"}}})
	if !hasCmd(m, "later") || hasCmd(m, "hook") {
		t.Fatalf("the second answer must replace the first: %v", names(m))
	}
}

// TestTheCatalogueIsAskedAgainOnANewSessionAndOnDemand: the ask at startup is
// not the only one. A pi package installed while this process is running is
// invisible until something asks the question again, and both things that ask
// it — /commands and starting a session — have to be wired.
func TestTheCatalogueIsAskedAgainOnANewSessionAndOnDemand(t *testing.T) {
	m, d := catalogueFixture(t)
	if n := countSent(d, "get_commands"); n != 0 {
		t.Fatalf("the app does not ask for itself — pi asks at spawn — but it sent %d", n)
	}

	typeIn(t, m, "/commands")
	press(t, m, "enter")
	if n := countSent(d, "get_commands"); n != 1 {
		t.Fatalf("/commands must ask, sent %d", n)
	}

	typeIn(t, m, "/new")
	press(t, m, "enter")
	if n := countSent(d, "new_session"); n != 1 {
		t.Fatalf("/new must start a session on the backend, sent %d", n)
	}
	if n := countSent(d, "get_commands"); n != 2 {
		t.Fatalf("a new session must re-ask the catalogue, sent %d", n)
	}
}

// TestAskingOnDemandReportsWhatCameBack: the reader asked a question, so the
// answer is owed to them — including the case where pi answers with nothing.
// The startup answer is not announced: it arrives over the welcome and nobody
// asked for it in so many words.
func TestAskingOnDemandReportsWhatCameBack(t *testing.T) {
	m, _ := catalogueFixture(t)
	m.Update(agent.Commands{List: []agent.CommandInfo{{Name: "hook", Description: "list hooks", Source: "extension"}}})
	if n := m.Notice(); n != "" {
		t.Fatalf("the startup answer is not a reader's question: %q", n)
	}

	typeIn(t, m, "/commands")
	press(t, m, "enter")
	m.Update(agent.Commands{List: []agent.CommandInfo{{Name: "hook", Description: "list hooks", Source: "extension"}}})
	if n := m.Notice(); !strings.Contains(n, "1 command from the agent") {
		t.Fatalf("the on-demand answer must be reported, got %q", n)
	}

	typeIn(t, m, "/commands")
	press(t, m, "enter")
	m.Update(agent.Commands{})
	if n := m.Notice(); !strings.Contains(n, "0 commands from the agent") {
		t.Fatalf("an empty answer is still an answer, got %q", n)
	}
}

// TestThePaletteSaysWhetherTheListIsLiveOrOffDisk: the two lists promise
// different things — what the agent will run, and what is installed — and a
// reader looking for something they just installed needs to know which one they
// are reading.
func TestThePaletteSaysWhetherTheListIsLiveOrOffDisk(t *testing.T) {
	m, _ := catalogueFixture(t)
	press(t, m, "ctrl+k")
	if !strings.Contains(screen(m), "the list on disk") {
		t.Fatalf("before an answer, the palette is the disk scan and must say so:\n%s", screen(m))
	}
	press(t, m, "esc")

	m.Update(agent.Commands{List: []agent.CommandInfo{{Name: "hook", Description: "list hooks", Source: "extension"}}})
	press(t, m, "ctrl+k")
	if !strings.Contains(screen(m), "the agent's list, live") {
		t.Fatalf("after an answer, the palette is pi's list and must say so:\n%s", screen(m))
	}
}

// TestARefusedCatalogQuestionIsNotAFailure: a backend that will not answer
// get_commands leaves the list it already had. The interface stays working,
// which is the whole reason that reply is dropped rather than surfaced.
func TestARefusedCatalogQuestionIsNotAFailure(t *testing.T) {
	m, _ := catalogueFixture(t)
	before := len(m.Commands())
	m.Update(agent.Failed{Err: errString("unknown command")})
	if got := len(m.Commands()); got != before {
		t.Fatalf("the list changed from %d rows to %d", before, got)
	}
	if !hasCmd(m, "review") {
		t.Fatal("the disk fallback is still the catalogue")
	}
}

func names(m *Model) []string {
	out := make([]string, 0, len(m.Commands()))
	for _, c := range m.Commands() {
		out = append(out, c.Name)
	}
	return out
}
