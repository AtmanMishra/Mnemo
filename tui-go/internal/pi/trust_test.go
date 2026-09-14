package pi

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Project trust is decided here because in RPC mode pi does not ask: with no
// saved decision it ignores a project's own settings, extensions, prompts and
// skills and says nothing about it. Every test below writes its decision file
// into a temp home — nothing in this file may read the developer's real
// ~/.mnemo.

// record writes a trust file under home, the way a reader would.
func record(t *testing.T, home string, d map[string]bool) string {
	t.Helper()
	path := TrustFile(home)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(d)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// TestNoRecordedDecisionIsTheSafeAnswer: the default must be "no". A trust
// decision that quietly defaults to yes the first time nobody wrote one down
// is not a decision the reader made.
func TestNoRecordedDecisionIsTheSafeAnswer(t *testing.T) {
	home := t.TempDir()
	project := t.TempDir()

	got := ResolveTrust(home, project)
	if got.Approve {
		t.Fatal("an unrecorded project must not be approved by default")
	}
	if got.From != "" {
		t.Fatalf("nothing was recorded, so nothing can be cited: %q", got.From)
	}
	if got.File != filepath.Join(home, ".mnemo", "trust.json") {
		t.Fatalf("the decision file must be the one under home, got %q", got.File)
	}
	if got.Err != "" {
		t.Fatalf("a missing file is the normal case, not an error: %q", got.Err)
	}
	if got.Flag() != "--no-approve" {
		t.Fatalf("flag = %q", got.Flag())
	}
	note := got.Note()
	if !strings.Contains(note, "--no-approve") || !strings.Contains(note, "no decision recorded") {
		t.Fatalf("the note must say which way it went and why: %q", note)
	}
	if !strings.Contains(note, got.File) {
		t.Fatalf("the note must say where a decision would be recorded: %q", note)
	}
}

// TestARecordedDecisionIsUsedVerbatim: true → --approve, false → --no-approve,
// and in both cases the note names the entry it came from.
func TestARecordedDecisionIsUsedVerbatim(t *testing.T) {
	for _, want := range []bool{true, false} {
		home := t.TempDir()
		project := t.TempDir()
		record(t, home, map[string]bool{project: want})

		got := ResolveTrust(home, project)
		if got.Approve != want {
			t.Fatalf("recorded %v, resolved %v", want, got.Approve)
		}
		if got.From != project {
			t.Fatalf("the note must cite the entry it came from: %q", got.From)
		}
		flag := "--no-approve"
		word := "denied"
		if want {
			flag, word = "--approve", "approved"
		}
		if got.Flag() != flag {
			t.Fatalf("flag = %q, want %q", got.Flag(), flag)
		}
		if note := got.Note(); !strings.Contains(note, word) || !strings.Contains(note, project) {
			t.Fatalf("note = %q; it must say %q and name %q", note, word, project)
		}
	}
}

// TestADecisionForAParentCoversItsChildren: deciding once for ~/src is the
// common case, and choosing per checkout is not. The closest entry wins, the
// same rule pi applies to its own trust store.
func TestADecisionForAParentCoversItsChildren(t *testing.T) {
	home := t.TempDir()
	parent := t.TempDir()
	child := filepath.Join(parent, "checkout")
	record(t, home, map[string]bool{parent: true})

	got := ResolveTrust(home, child)
	if !got.Approve || got.From != parent {
		t.Fatalf("a parent's yes must cover the checkout (got approve=%v from=%q)", got.Approve, got.From)
	}

	// And an entry for the child itself outranks the parent's.
	record(t, home, map[string]bool{parent: true, child: false})
	got = ResolveTrust(home, child)
	if got.Approve {
		t.Fatal("the closest recorded decision must win")
	}
	if got.From != child {
		t.Fatalf("from = %q, want the child entry", got.From)
	}
}

// TestABrokenTrustFileIsTheSafeAnswerNotACrash: a file someone hand-edited
// into invalid JSON must not become an implicit yes, and must not take the
// interface down either. The note carries the reason.
func TestABrokenTrustFileIsTheSafeAnswerNotACrash(t *testing.T) {
	home := t.TempDir()
	project := t.TempDir()
	path := TrustFile(home)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("not json at all"), 0o644); err != nil {
		t.Fatal(err)
	}

	got := ResolveTrust(home, project)
	if got.Approve {
		t.Fatal("a file that cannot be read must not trust anything")
	}
	if got.Err == "" {
		t.Fatal("the reader must be told the file could not be read")
	}
	if note := got.Note(); !strings.Contains(note, got.Err) {
		t.Fatalf("the note must carry the reason: %q", note)
	}
	if got.ShortNote() == "" {
		t.Fatal("a status-line form is still a sentence")
	}
}

// TestTheDecisionIsMadeForTheAbsolutePath: a relative project path is the
// caller's convenience, not the key that was recorded.
func TestTheDecisionIsMadeForTheAbsolutePath(t *testing.T) {
	home := t.TempDir()
	dir := t.TempDir()
	record(t, home, map[string]bool{dir: true})

	old, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	// Walk into the project and resolve it the way a shell would.
	if err := os.Chdir(dir); err != nil {
		t.Skipf("cannot chdir to the temp dir: %v", err)
	}
	t.Cleanup(func() { _ = os.Chdir(old) })

	got := ResolveTrust(home, ".")
	if !got.Approve {
		t.Fatalf("a relative path must resolve to the same absolute key (from=%q)", got.From)
	}
}

// TestASymlinkedPathStillMatches: the same directory reached by two spellings
// is one project.
//
// Found by CI, not by us: on macOS /tmp is a symlink to /private/tmp, so
// t.TempDir() hands back one spelling and os.Getwd() the other. Linux and
// Windows agree with themselves and hid it, which is why the suite runs on all
// three. The symlink is made here so the case is testable anywhere.
func TestASymlinkedPathStillMatches(t *testing.T) {
	home := t.TempDir()
	real := t.TempDir()
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("cannot create a symlink here: %v", err) // Windows without the privilege
	}

	// Recorded through the link, resolved through the real path — and the
	// other way round. Either order has to agree, because which one a user
	// typed depends on how they got to the directory.
	record(t, home, map[string]bool{link: true})
	if got := ResolveTrust(home, real); !got.Approve {
		t.Fatalf("a decision recorded through a symlink must apply to the real path (from=%q)", got.From)
	}

	record(t, home, map[string]bool{real: true})
	if got := ResolveTrust(home, link); !got.Approve {
		t.Fatalf("a decision recorded for the real path must apply through a symlink (from=%q)", got.From)
	}
}

// TestAPathThatDoesNotExistYetStillResolves: a decision can be recorded before
// the checkout exists, so canonicalisation must not depend on the leaf being
// real — it resolves the longest existing prefix and keeps the rest.
func TestAPathThatDoesNotExistYetStillResolves(t *testing.T) {
	home := t.TempDir()
	parent := t.TempDir()
	missing := filepath.Join(parent, "not", "cloned", "yet")

	record(t, home, map[string]bool{missing: true})
	if got := ResolveTrust(home, missing); !got.Approve {
		t.Fatalf("a key for a path that does not exist must still match itself (from=%q)", got.From)
	}
	// And its ancestor rule still holds for a child of that imaginary path.
	if got := ResolveTrust(home, filepath.Join(missing, "deeper")); !got.Approve {
		t.Fatalf("a child of a recorded path must inherit the decision (from=%q)", got.From)
	}
}
