package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/theme"
)

// The chosen palette, on disk.
//
// A preference survives a restart or it is not a preference — the reader who
// picked pottery does not want to pick it again every morning — so the choice
// is written next to the other things this program keeps in ~/.mnemo
// (auth.json, trust.json, schedules.json) and read back at startup.
//
// home is a parameter, like everywhere else here: a function that finds its own
// home is one that, in a test, finds the developer's.

// themeFile is where the choice lives: one field, one file.
func themeFile(home string) string {
	return filepath.Join(home, ".mnemo", "theme.json")
}

// themeChoice is the file's contents. A struct rather than a bare string so
// the file can grow a second field (glyph set, say) without the reader having
// to guess what it is looking at.
type themeChoice struct {
	Name string `json:"name"`
}

// savedTheme is the palette name from the file, or "" when there is nothing to
// read.
//
// Every failure — no file, no directory, truncated JSON, a name that is not a
// palette — is the same answer: nothing was chosen. A preference is not worth
// an error dialog, and a hand-edited file must not stop the program drawing
// itself.
func savedTheme(home string) string {
	raw, err := os.ReadFile(themeFile(home))
	if err != nil {
		return ""
	}
	var c themeChoice
	if json.Unmarshal(raw, &c) != nil {
		return ""
	}
	if _, ok := theme.ByName(c.Name); !ok {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(c.Name))
}

// saveTheme writes the choice, creating ~/.mnemo if this is the first thing to
// need it. The error is returned rather than swallowed: a picker that says
// "saved" while the write failed is a picker that lies about the one thing it
// promises (that this survives the restart).
func saveTheme(home, name string) error {
	dir := filepath.Dir(themeFile(home))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	raw, err := json.Marshal(themeChoice{Name: name})
	if err != nil {
		return err
	}
	return os.WriteFile(themeFile(home), append(raw, '\n'), 0o644)
}
