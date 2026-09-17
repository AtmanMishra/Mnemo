package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/agent"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/chat"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/pi"
)

// Yolo, from the interface's side.
//
// The mode itself lives in internal/pi/yolo.go and the decision it relaxes
// lives in the agent's gate; what this file pins is the conversation — that
// the command writes the file it says it writes, that the status line admits
// the mode is on, and that the caveat is stated where the reader chose it
// rather than only in a log they will not read.

func yoloFixture(t *testing.T) *Model {
	t.Helper()
	return New(Config{
		Home: t.TempDir(), CWD: t.TempDir(), Dark: true,
		Agent: agent.Offline{Reason: "test"},
	})
}

// lastNotice is the prose of the most recent notice block in the transcript.
func lastNotice(m *Model) string {
	blocks := m.chat.Blocks()
	for i := len(blocks) - 1; i >= 0; i-- {
		if blocks[i].Kind == chat.Notice {
			return strings.Join(blocks[i].Body, "\n")
		}
	}
	return ""
}

func TestYoloOnWritesTheProjectFile(t *testing.T) {
	m := yoloFixture(t)
	m.yoloCommand("on")

	file := pi.YoloFile(m.cfg.CWD)
	if _, err := os.Stat(file); err != nil {
		t.Fatalf("yolo on must write %s: %v", file, err)
	}
	if !pi.Yolo(m.cfg.CWD, m.cfg.Home) {
		t.Fatal("the mode must be readable back from the file it wrote")
	}
	if !m.yolo {
		t.Fatal("the model must know the mode is on, or the status line will lie")
	}
	if !strings.Contains(lastNotice(m), file) {
		t.Fatalf("the notice must name the file it wrote, got %q", lastNotice(m))
	}
}

func TestYoloWithoutAnArgumentMeansOn(t *testing.T) {
	m := yoloFixture(t)
	m.yoloCommand("")
	if !m.yolo {
		t.Fatal("typing the mode's name is the obvious way to mean it")
	}
}

func TestYoloOffAsksAgain(t *testing.T) {
	m := yoloFixture(t)
	m.yoloCommand("on")
	m.yoloCommand("off")

	if m.yolo {
		t.Fatal("off must leave the mode off")
	}
	if pi.Yolo(m.cfg.CWD, m.cfg.Home) {
		t.Fatal("off must be written, not just remembered in this process")
	}
}

func TestYoloRefusesAnArgumentItCannotRead(t *testing.T) {
	m := yoloFixture(t)
	m.yoloCommand("banana")

	if m.yolo {
		t.Fatal("an unreadable argument must not turn anything on")
	}
	if _, err := os.Stat(pi.YoloFile(m.cfg.CWD)); err == nil {
		t.Fatal("a usage message must not leave a permissions file behind")
	}
	if !strings.Contains(lastNotice(m), "/yolo on") {
		t.Fatalf("the reader must be told the two things they can say, got %q", lastNotice(m))
	}
}

// The caveat, at the moment it matters: a person who has just turned the mode
// on is the one person guaranteed to read it.
func TestYoloSaysWhichProhibitionsStillHold(t *testing.T) {
	m := yoloFixture(t)
	dir := filepath.Join(m.cfg.CWD, ".mnemo")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	body := `{"version":1,"default":"ask","rules":[
		{"tool":"bash_exec","pattern":"rm -rf *","action":"deny"},
		{"tool":"bash_exec","pattern":"git status*","action":"allow"}
	]}`
	if err := os.WriteFile(filepath.Join(dir, "permissions.json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}

	m.yoloCommand("on")
	notice := lastNotice(m)
	if !strings.Contains(notice, "1 deny rule is") {
		t.Fatalf("a deny rule that survives yolo must be named, got %q", notice)
	}
	if !strings.Contains(notice, "never prohibitions") {
		t.Fatalf("the limit of the mode belongs in the notice, got %q", notice)
	}
}

// Toggling the mode must not cost the reader the grants they made: the file
// holds both, and a writer that re-encodes from a struct it understands fully
// is how a person loses rules they never touched.
func TestYoloKeepsTheGrantsAlreadyInTheFile(t *testing.T) {
	m := yoloFixture(t)
	dir := filepath.Join(m.cfg.CWD, ".mnemo")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	body := `{"version":1,"default":"ask","rules":[{"tool":"bash_exec","pattern":"npm test*","action":"allow"}]}`
	if err := os.WriteFile(filepath.Join(dir, "permissions.json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}

	m.yoloCommand("on")

	raw, err := os.ReadFile(pi.YoloFile(m.cfg.CWD))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "npm test*") {
		t.Fatalf("the grant must survive the toggle, got %s", raw)
	}
}

func TestTheStatusLineSaysYoloIsOn(t *testing.T) {
	off := yoloFixture(t)
	off.Resize(120, 30)
	if strings.Contains(off.View().Content, "yolo") {
		t.Fatal("a mode that is off must not be announced")
	}

	on := yoloFixture(t)
	on.yoloCommand("on")
	on.Resize(120, 30)
	if !strings.Contains(on.View().Content, "yolo") {
		t.Fatal("a mode that is on must be visible: nobody remembers turning it on")
	}
}
