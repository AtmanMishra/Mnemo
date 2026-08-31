package app

import (
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/agent"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/chat"
)

// Acceptance harness: golden frames.
//
// A TUI cannot be screenshotted from a script, and "it looked right when I
// ran it" is not a check anybody else can repeat — so --dump exists, and this
// test does exactly what --dump does (Resize, Press, Render) against curated
// scenarios and pins the resulting text. Colour is deliberately not asserted:
// the frames are ANSI-free, so a palette change cannot masquerade as a layout
// change, and a layout change cannot hide behind a colour change.
//
// Regolding (only when the CHANGE is intentional — a new keyboard model, a
// moved status segment):
//
//	go test ./app/ -run TestAcceptanceGoldenFrames -update
//
// and then look at the diff before committing. A golden that "just changed a
// bit" is a regression wearing a fresh coat of paint.
var update = flag.Bool("update", false, "rewrite the golden frames in app/testdata/golden")

// goldenModel is the app every scenario shares, pointed at paths that cannot
// exist on any machine — the header must be byte-identical on every developer
// and every runner, and a temp directory is not.
func goldenModel(w, h int) *Model {
	m := New(Config{
		Home:  "/home/you/mnemo",
		CWD:   "/home/you/mnemo/tui-go",
		Dark:  true,
		Agent: agent.Offline{Reason: "test"},
	})
	m.Resize(w, h)
	return m
}

// conversation is the shared middle of the busiest scenarios: a user prompt,
// a turn with thinking, a document, two tools — one clean, one failed — and a
// sub-agent, all settled.
func conversation(m *Model) {
	m.chat.Append(&chat.Block{Kind: chat.User, Body: []string{"how does the flag parser work?"}})
	m.Update(agent.Started{})
	m.Update(agent.Think{Text: "The parser lives in `internal/pi`. Let me confirm how it splits flags."})
	m.Update(agent.Text{Text: "It reads **flags** from the process table, not from the keyboard."})
	m.Update(agent.ToolStart{ID: "1", Name: "read", Args: "limit=40 path=main.go"})
	m.Update(agent.ToolEnd{ID: "1", Detail: "40 ln", OK: true, Out: "package main\n\nfunc main() {}"})
	m.Update(agent.ToolStart{ID: "2", Name: "bash", Args: "go test ./..."})
	m.Update(agent.ToolEnd{ID: "2", Detail: "exit 1", OK: false, Out: "FAIL\n\tbuild failed for the parser package"})
	m.Update(agent.Delegated{Label: "scout", Model: "deepseek-v4-flash", Detail: "mapped the flag table", OK: true})
	m.Update(agent.Done{})
}

func TestAcceptanceGoldenFrames(t *testing.T) {
	cases := []struct {
		name string
		run  func(t *testing.T) *Model
	}{
		{"fresh", func(t *testing.T) *Model {
			return goldenModel(100, 30)
		}},
		// Everything open at once: thinking text, native tool output, the
		// sub-agent, and the counts that say so.
		{"conversation", func(t *testing.T) *Model {
			m := goldenModel(100, 30)
			conversation(m)
			press(t, m, "ctrl+a")
			return m
		}},
		{"overlay-palette", func(t *testing.T) *Model {
			m := goldenModel(100, 30)
			conversation(m)
			press(t, m, "ctrl+k")
			return m
		}},
		{"search-active", func(t *testing.T) *Model {
			m := goldenModel(100, 30)
			conversation(m)
			press(t, m, "ctrl+f")
			typeIn(t, m, "parser")
			return m
		}},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			path := filepath.Join("testdata", "golden", c.name+".txt")
			want, err := os.ReadFile(path)
			got := c.run(t).Render()
			switch {
			case err != nil && *update:
				if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
					t.Fatal(err)
				}
				t.Logf("wrote %s", path)
				return
			case err != nil:
				t.Fatalf("no golden frame for %s — run with -update to create it", c.name)
			}

			if *update {
				if string(want) != got {
					if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
						t.Fatal(err)
					}
					t.Logf("updated %s", path)
				}
				return
			}

			if string(want) != got {
				t.Fatalf("%s changed. If the change is intentional, regold with:\n\n"+
					"\tgo test ./app/ -run 'TestAcceptanceGoldenFrames/%s' -update\n\n"+
					"and review the diff — a golden that 'just changed a bit' is a\n"+
					"regression wearing a fresh coat of paint.\n\n--- want ---\n%s\n--- got ---\n%s",
					path, c.name, want, got)
			}
		})
	}
}

// The frames must be pixel-app-free: no stray ANSI survives Render. If this
// fires, something coloured the golden and colour is not part of the contract.
func TestGoldenFramesAreAnsiFree(t *testing.T) {
	for _, name := range []string{"fresh", "conversation", "overlay-palette", "search-active"} {
		raw, err := os.ReadFile(filepath.Join("testdata", "golden", name+".txt"))
		if err != nil {
			continue // not yet written; the harness test reports that
		}
		if strings.Contains(string(raw), "\x1b[") {
			t.Fatalf("%s carries ANSI escapes; goldens assert text, not colour", name)
		}
	}
}