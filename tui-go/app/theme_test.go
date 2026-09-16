package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/agent"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/overlay"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/theme"
)

// The theme picker: a list of palette values, one key to apply, and a file to
// remember it in.
//
// The theme is already a value and every pane follows it, so the whole feature
// is the list plus ~/.mnemo/theme.json. What these tests pin is the part that
// can silently rot: that the choice survives a restart, that a hand-edited file
// cannot stop the program drawing itself, and that trying a theme does not
// close the surface you are trying it in.

// TestPickingAThemeAppliesItAndRemembersIt: apply and save, in that order, and
// a fresh Model — the next run — comes up in the chosen palette.
func TestPickingAThemeAppliesItAndRemembersIt(t *testing.T) {
	m := fixture(t, 100, 30)
	if m.ThemeName() != theme.Shipping {
		t.Fatalf("a fresh run is %q, want the shipping palette", m.ThemeName())
	}

	press(t, m, "ctrl+k")
	typeIn(t, m, "theme")
	press(t, m, "enter")
	if m.Overlay() == nil || m.Overlay().Kind != overlay.Themes {
		t.Fatalf("/theme opens the picker, got %v", m.Overlay())
	}

	// Pick the second row: one press down, one enter.
	press(t, m, "down")
	if _, ok := m.Overlay().Selected(); !ok {
		t.Fatal("the picker has rows to choose from")
	}
	id, _ := m.Overlay().Selected()
	want := strings.TrimPrefix(id, "theme:")
	press(t, m, "enter")

	if m.ThemeName() != want {
		t.Fatalf("picked %q, theme is %q", want, m.ThemeName())
	}
	if m.Overlay() == nil || m.Overlay().Kind != overlay.Themes {
		t.Fatal("applying a theme must not close the picker you are picking in")
	}
	if !strings.Contains(screen(m), "in use") {
		t.Fatalf("the row in force must say so:\n%s", screen(m))
	}
	raw, err := os.ReadFile(themeFile(m.Home()))
	if err != nil {
		t.Fatalf("the choice must be written down: %v", err)
	}
	if !strings.Contains(string(raw), want) {
		t.Fatalf("theme.json does not name the palette: %q", raw)
	}

	// The next run reads it back. Same home, new Model.
	next := New(Config{Home: m.Home(), CWD: m.CWD(), Dark: true, Agent: agent.Offline{Reason: "test"}})
	next.Resize(100, 30)
	if next.ThemeName() != want {
		t.Fatalf("a restart came up in %q, want the saved %q", next.ThemeName(), want)
	}
	if got, _ := theme.ByName(want); next.th.P.Accent != got.Accent {
		t.Fatal("the restored theme must be the palette, not just the name")
	}
}

// TestAThemeFileThatMakesNoSenseIsNotFatal: no file, a truncated file, and a
// name that is not a palette all mean the same thing — nothing was chosen. A
// preference is not worth a startup failure, and it must not be worth a crash
// either, which is what an unreadable name would otherwise become.
func TestAThemeFileThatMakesNoSenseIsNotFatal(t *testing.T) {
	for _, c := range []struct{ name, body string }{
		{"empty object", `{}`},
		{"truncated json", `{"name": "pot`},
		{"not a palette", `{"name":"navy-and-cream"}`},
		{"not json at all", "pico8\n"},
	} {
		t.Run(c.name, func(t *testing.T) {
			home := t.TempDir()
			if err := os.MkdirAll(filepath.Dir(themeFile(home)), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(themeFile(home), []byte(c.body), 0o644); err != nil {
				t.Fatal(err)
			}
			m := New(Config{Home: home, CWD: t.TempDir(), Dark: true, Agent: agent.Offline{Reason: "test"}})
			m.Resize(80, 24)
			if m.ThemeName() != theme.Shipping {
				t.Fatalf("an unusable file must leave the shipping palette in force, got %q", m.ThemeName())
			}
			if !strings.Contains(screen(m), "MNEMO") {
				t.Fatalf("the screen must still draw:\n%s", screen(m))
			}
		})
	}
}

// TestAThemeThatCannotBeSavedSaysSoAndStaysApplied: a read-only home is the
// case where the picker's one promise — that this survives the restart — is
// broken. Applied is still true, so it stays; saved is not, and the status line
// is where that difference shows.
func TestAThemeThatCannotBeSavedSaysSoAndStaysApplied(t *testing.T) {
	home := t.TempDir()
	// A file where the directory should be: MkdirAll fails, and so the write
	// does, which is the cheapest honest stand-in for a read-only home.
	if err := os.WriteFile(filepath.Join(home, ".mnemo"), []byte("not a directory"), 0o644); err != nil {
		t.Fatal(err)
	}
	m := New(Config{Home: home, CWD: t.TempDir(), Dark: true, Agent: agent.Offline{Reason: "test"}})
	m.Resize(100, 30)

	press(t, m, "ctrl+k")
	typeIn(t, m, "theme")
	press(t, m, "enter")
	press(t, m, "down")
	id, _ := m.Overlay().Selected()
	want := strings.TrimPrefix(id, "theme:")
	press(t, m, "enter")

	if m.ThemeName() != want {
		t.Fatalf("the theme must still apply, got %q", m.ThemeName())
	}
	if n := m.Notice(); !strings.Contains(n, "could not save") {
		t.Fatalf("a preference that was not written down must say so, got %q", n)
	}
}

// TestThePickerOnlyOffersPalettesThatWorkHere: every row is a whole palette,
// and none of them is a light-ground one — this program does not paint the
// terminal's background, so a light palette would be legible only in a terminal
// that is already light. That is a documented decision, and this is the test
// that keeps it from being quietly undone.
func TestThePickerOnlyOffersPalettesThatWorkHere(t *testing.T) {
	m := fixture(t, 100, 30)
	press(t, m, "ctrl+k")
	typeIn(t, m, "theme")
	press(t, m, "enter")
	if got, want := m.Overlay().Count(), len(theme.Presets()); got != want {
		t.Fatalf("the picker shows %d rows for %d presets", got, want)
	}
	for _, p := range theme.Presets() {
		// The ground of every offered palette is dark, measured rather than
		// asserted by name: a light ground would be the marble preset, which
		// is deliberately not shipped.
		r, g, b, _ := p.P.Ground.RGBA()
		if r+g+b > 3*0x4000 {
			t.Fatalf("preset %q has a light ground; it needs the terminal to be light too", p.Name)
		}
	}
}
