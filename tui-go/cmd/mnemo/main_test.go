package main

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// captureStdout swaps os.Stdout for a pipe for the duration of fn. --dump is
// a stdout feature, so testing it means owning stdout for a moment.
func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	old := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = w
	defer func() { os.Stdout = old }()
	fn()
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	out, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

// TestRunDumpRendersAFrameOffline pins the restructure: run() returns nil on
// the dump path — no os.Exit mid-function — and the frame goes to stdout
// with no agent configured. This is the path scripts and the golden frames
// rely on, so it must not drift.
func TestRunDumpRendersAFrameOffline(t *testing.T) {
	dir := t.TempDir()
	var out string
	out = captureStdout(t, func() {
		if err := run(options{dump: true, cols: 100, rows: 30, home: dir, cwd: dir}); err != nil {
			t.Errorf("run(dump) = %v, want nil", err)
		}
	})
	if !strings.Contains(out, "MNEMO") {
		t.Fatalf("a dumped frame should carry the wordmark:\n%s", out)
	}
	if !strings.Contains(out, "ask, or press ^k") {
		t.Fatalf("a dumped frame should carry the prompt:\n%s", out)
	}
}

// TestRunDumpPressesKeysFirst proves the --keys path: the frame dumped is the
// frame AFTER the chords, which is what every scripted screenshot depends on.
func TestRunDumpPressesKeysFirst(t *testing.T) {
	dir := t.TempDir()
	out := captureStdout(t, func() {
		if err := run(options{dump: true, cols: 100, rows: 30, home: dir, cwd: dir, keys: "ctrl+k"}); err != nil {
			t.Errorf("run(dump,keys) = %v, want nil", err)
		}
	})
	if !strings.Contains(out, "PALETTE") {
		t.Fatalf("^k before the dump should open the palette:\n%s", out)
	}
}

// TestRunWithoutARepoIsOfflineNotBroken pins the no-backend contract: with no
// --repo the interface still comes up, and says why sending would fail.
func TestRunWithoutARepoIsOfflineNotBroken(t *testing.T) {
	dir := t.TempDir()
	out := captureStdout(t, func() {
		if err := run(options{dump: true, cols: 100, rows: 30, home: dir, cwd: dir}); err != nil {
			t.Errorf("run(offline dump) = %v, want nil", err)
		}
	})
	if !strings.Contains(out, "ready") {
		t.Fatalf("offline should still be a working surface:\n%s", out)
	}
}

// TestParseFlagsReadsEveryOption keeps the flag surface honest: a flag lost
// in a refactor is a flag somebody's script stops understanding.
func TestParseFlagsReadsEveryOption(t *testing.T) {
	o := parseFlags([]string{
		"--home", "/h", "--cwd", "/c", "--dump", "--cols", "80", "--rows", "24",
		"--keys", "ctrl+t,down", "--repo", "/r", "--session", "s.jsonl",
		"--memsrv", "/m", "--journal", "/j", "--bundles", "/b",
	})
	want := options{home: "/h", cwd: "/c", dump: true, cols: 80, rows: 24,
		keys: "ctrl+t,down", repo: "/r", session: "s.jsonl",
		memsrv: "/m", journal: "/j", bundles: "/b"}
	if o != want {
		t.Fatalf("got %#v, want %#v", o, want)
	}
	if parseFlags(nil).cols != 100 || parseFlags(nil).rows != 32 {
		t.Fatal("default viewport size changed — the golden frames depend on it")
	}
}

// TestADumpInTheCwdOfARealFolder guards the cwd wiring: filetree.Root walks
// the working directory, so a cwd that does not exist would panic a dump
// that used to work.
func TestADumpInTheCwdOfARealFolder(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	out := captureStdout(t, func() {
		if err := run(options{dump: true, cols: 100, rows: 30, home: t.TempDir(), cwd: dir, keys: "ctrl+t"}); err != nil {
			t.Errorf("run(dump, explorer) = %v, want nil", err)
		}
	})
	if !strings.Contains(out, "note.txt") {
		t.Fatalf("the explorer should list the file in --cwd:\n%s", out)
	}
}

func TestDefaultMemorySidecarDerivesFromRepoAndHome(t *testing.T) {
	o := options{repo: "/somewhere/self-evolving-agent", home: "/Users/tester"}
	defaultMemorySidecar(&o)
	// Built with filepath.Join, not a literal: the derivation is a path
	// join, so the expectation has to be one too or it only holds on Unix.
	if want := filepath.Join("/somewhere/self-evolving-agent", "memory-layer", "target", "debug", "memsrv"); o.memsrv != want {
		t.Fatalf("memsrv = %q, want %q", o.memsrv, want)
	}
	if want := filepath.Join("/Users/tester", ".mnemo", "journal.jsonl"); o.journal != want {
		t.Fatalf("journal = %q, want %q", o.journal, want)
	}
}

func TestDefaultMemorySidecarRespectsExplicitFlags(t *testing.T) {
	o := options{repo: "/r", home: "/h", memsrv: "/custom/memsrv", journal: "/custom/journal.jsonl"}
	defaultMemorySidecar(&o)
	if o.memsrv != "/custom/memsrv" || o.journal != "/custom/journal.jsonl" {
		t.Fatalf("explicit flags must win; got memsrv=%q journal=%q", o.memsrv, o.journal)
	}
}

func TestDefaultMemorySidecarNoRepoMeansNoDerivation(t *testing.T) {
	o := options{home: "/h"}
	defaultMemorySidecar(&o)
	if o.memsrv != "" || o.journal != "" {
		t.Fatalf("with no repo, nothing should be derived; got memsrv=%q journal=%q", o.memsrv, o.journal)
	}
}
