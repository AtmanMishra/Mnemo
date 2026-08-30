package keymap

import (
	"strings"
	"testing"
)

func TestEveryBindingIsDocumented(t *testing.T) {
	// The whole reason this package exists: help is generated from the same
	// struct the program dispatches on, so it cannot go stale.
	for _, e := range New().Help() {
		if strings.TrimSpace(e.Key) == "" {
			t.Fatalf("a binding has no key label: %+v", e)
		}
		if strings.TrimSpace(e.Desc) == "" {
			t.Fatalf("binding %q has no description; then help would show a blank row", e.Key)
		}
	}
}

func TestGlobalChordsAreUnique(t *testing.T) {
	m := New()
	seen := map[string]string{}
	for _, b := range []struct {
		name string
		keys []string
	}{
		{"Palette", m.Palette.Keys()}, {"Explorer", m.Explorer.Keys()},
		{"Sessions", m.Sessions.Keys()}, {"Memory", m.Memory.Keys()},
		{"Logs", m.Logs.Keys()}, {"AllThink", m.AllThink.Keys()},
		{"AllTools", m.AllTools.Keys()}, {"AllBlocks", m.AllBlocks.Keys()},
		{"Find", m.Find.Keys()}, {"MouseOff", m.MouseOff.Keys()},
		{"Interrupt", m.Interrupt.Keys()}, {"Quit", m.Quit.Keys()},
	} {
		for _, k := range b.keys {
			if prev, dup := seen[k]; dup {
				t.Fatalf("%s and %s both bind %q; one of them would never fire", b.name, prev, k)
			}
			seen[k] = b.name
		}
	}
}

func TestEverySurfaceIsOneChordAway(t *testing.T) {
	// The navigation complaint this rebuild answers: no surface may need two
	// presses to reach.
	m := New()
	for name, b := range map[string][]string{
		"palette": m.Palette.Keys(), "explorer": m.Explorer.Keys(),
		"sessions": m.Sessions.Keys(), "memory": m.Memory.Keys(), "logs": m.Logs.Keys(),
	} {
		if len(b) == 0 {
			t.Fatalf("%s has no binding", name)
		}
		for _, k := range b {
			if !strings.HasPrefix(k, "ctrl+") || len(k) != len("ctrl+")+1 {
				t.Fatalf("%s is bound to %q; it must be a single control chord", name, k)
			}
		}
	}
}

func TestOpenAllThinkingIsOneKey(t *testing.T) {
	m := New()
	k := m.AllThink.Keys()
	if len(k) != 1 || k[0] != "ctrl+e" {
		t.Fatalf("open-every-thinking-block is %v; it must be exactly one chord", k)
	}
}

func TestHintsAreFourOrFewer(t *testing.T) {
	m := New()
	for _, mode := range []Mode{Insert, Read, Browse} {
		for _, busy := range []bool{false, true} {
			if got := len(m.Hints(mode, busy)); got > 4 {
				t.Fatalf("%v busy=%v shows %d hints; a status bar that lists everything is read by nobody", mode, busy, got)
			}
		}
	}
}

func TestBusyInsertNamesBothEnterKeys(t *testing.T) {
	// enter queues and alt+enter steers; guessing wrong is expensive, so while
	// the agent is working the status line must say which is which.
	var keys []string
	for _, e := range New().Hints(Insert, true) {
		keys = append(keys, e.Key)
	}
	joined := strings.Join(keys, " ")
	if !strings.Contains(joined, "enter") || !strings.Contains(joined, "alt+enter") {
		t.Fatalf("busy hints = %v", keys)
	}
}

func TestEscIsTheOnlyWayUp(t *testing.T) {
	if k := New().Back.Keys(); len(k) != 1 || k[0] != "esc" {
		t.Fatalf("Back = %v; one rule for leaving a mode means exactly one key", k)
	}
}

func TestModeNames(t *testing.T) {
	for m, want := range map[Mode]string{Insert: "INSERT", Read: "READ", Browse: "BROWSE"} {
		if m.String() != want {
			t.Fatalf("%d.String() = %q, want %q", m, m.String(), want)
		}
	}
}
