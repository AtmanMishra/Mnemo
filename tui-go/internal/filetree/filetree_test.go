package filetree

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/tree"
)

// fixture builds a small repo-shaped directory under the test's own temp dir.
// Every path here is derived from t.TempDir(), never from $HOME — a test that
// touches the real home directory is a test that eventually deletes something.
func fixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	for _, d := range []string{"src", "docs", ".git", "node_modules/pkg", ".hidden"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, f := range []string{"README.md", "src/main.go", "docs/a.md", ".git/HEAD", "node_modules/pkg/i.js"} {
		if err := os.WriteFile(filepath.Join(root, f), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func kids(n *tree.Node) []string {
	m := tree.New(n)
	m.ExpandAll()
	var out []string
	for _, r := range m.Rows() {
		if r.Depth == 1 {
			out = append(out, r.Node.Label)
		}
	}
	return out
}

func TestNoiseIsSkipped(t *testing.T) {
	got := kids(Root(fixture(t)))
	for _, bad := range []string{".git", "node_modules", ".hidden"} {
		for _, g := range got {
			if g == bad {
				t.Fatalf("%s should not appear: %v", bad, got)
			}
		}
	}
}

func TestDirectoriesSortFirstThenFilesAlphabetically(t *testing.T) {
	got := kids(Root(fixture(t)))
	want := []string{"docs", "src", "README.md"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v — directories first, because you are navigating", got, want)
		}
	}
}

func TestChildrenAreNotReadUntilTheNodeOpens(t *testing.T) {
	root := Root(fixture(t))
	// Root is expanded by construction; its children are still lazy until
	// something flattens it.
	sub := filepath.Join(root.ID, "src")
	n := Root(sub)
	n.Expanded = false
	if len(n.Children) != 0 {
		t.Fatal("a closed directory must not have been read")
	}
	if !n.HasChildren() {
		t.Fatal("an unread directory must still render as openable")
	}
	m := tree.New(n)
	m.Open()
	if len(n.Children) == 0 {
		t.Fatal("opening must load")
	}
}

func TestAnUnreadableDirectorySaysSoInsteadOfLookingEmpty(t *testing.T) {
	// Windows does not deny reads through POSIX modes — a 0o000 directory
	// still lists — so on this platform the same branch is exercised with a
	// path that is not a directory at all. Either way children() must report
	// the error instead of handing back an empty folder.
	if runtime.GOOS == "windows" {
		notDir := filepath.Join(t.TempDir(), "not-a-directory")
		if err := os.WriteFile(notDir, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		got := kids(Root(notDir))
		if len(got) != 1 || got[0] == "" {
			t.Fatalf("expected one explanatory row, got %v", got)
		}
		return
	}
	if os.Geteuid() == 0 {
		t.Skip("root can read anything")
	}
	root := t.TempDir()
	locked := filepath.Join(root, "locked")
	if err := os.Mkdir(locked, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o755) })
	got := kids(Root(locked))
	if len(got) != 1 || got[0] == "" {
		t.Fatalf("expected one explanatory row, got %v", got)
	}
}

func TestSizeIsAlwaysShortEnoughToKeepTheColumnStill(t *testing.T) {
	for _, b := range []int64{0, 1, 999, 1000, 5000, 999999, 1 << 20, 1 << 30, 1 << 40} {
		if got := size(b); len(got) > 5 {
			t.Fatalf("size(%d) = %q, too wide for the right column", b, got)
		}
	}
}

func TestMissingPathDoesNotPanic(t *testing.T) {
	n := Root(filepath.Join(t.TempDir(), "nope"))
	_ = kids(n)
}
