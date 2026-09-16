package main

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/session"
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
	if want := filepath.Join("/somewhere/self-evolving-agent", "memory-layer", "target", "debug", memsrvName()); o.memsrv != want {
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

// TestSpawnPlanResolvesTrustForTheProject: the decision pi is given is read
// from ~/.mnemo/trust.json under the home the run was pointed at, for the
// project's ABSOLUTE path — and with nothing recorded it is the safe answer.
// Nothing here reads the developer's real home: the fixture's temp dir is the
// home, the project and the decision file both.
func TestSpawnPlanResolvesTrustForTheProject(t *testing.T) {
	home, project := t.TempDir(), t.TempDir()

	cwd, sessionDir, trust := spawnPlan(options{home: home, cwd: project})
	if !filepath.IsAbs(cwd) {
		t.Fatalf("the child's working directory must be absolute (the session forks by it): %q", cwd)
	}
	if sessionDir != "" {
		t.Fatalf("with nothing configured, the session directory is pi's own default and there is nothing to pass: %q", sessionDir)
	}
	if trust.Approve || trust.From != "" {
		t.Fatalf("an unrecorded project must be refused, explicitly: %+v", trust)
	}
	if !strings.Contains(trust.Note(), "--no-approve") {
		t.Fatalf("and the transcript must say which way it went: %q", trust.Note())
	}

	// A recorded decision is what flips it — nothing else.
	path := filepath.Join(home, ".mnemo", "trust.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"`+strings.ReplaceAll(project, `\`, `\\`)+`": true}`), 0o644); err != nil {
		t.Fatal(err)
	}
	_, _, trust = spawnPlan(options{home: home, cwd: project})
	if !trust.Approve || trust.From != project {
		t.Fatalf("a recorded yes must be used: %+v", trust)
	}

	// And an empty --cwd means the process's own directory, made absolute.
	cwd, _, _ = spawnPlan(options{home: home})
	if !filepath.IsAbs(cwd) || filepath.Base(cwd) != filepath.Base(wd(t)) {
		t.Fatalf("an empty --cwd must resolve to the process directory, got %q", cwd)
	}
}

// TestSpawnPlanHandsOverTheSessionDirectoryTheBrowserReads: the browser and the
// spawned agent must mean one directory (#19). The resolution is shared, and
// what reaches the spawn is session.SpawnDir — the resolved path when the user
// configured one, and "" when pi's own default is already the answer.
func TestSpawnPlanHandsOverTheSessionDirectoryTheBrowserReads(t *testing.T) {
	home, project, sessions := t.TempDir(), t.TempDir(), t.TempDir()
	t.Setenv("PI_CODING_AGENT_SESSION_DIR", sessions)

	_, sessionDir, _ := spawnPlan(options{home: home, cwd: project})
	if sessionDir != sessions {
		t.Fatalf("spawnPlan handed over %q, want the directory the browser reads (%q)", sessionDir, sessions)
	}
	if got := session.Root(home); got != sessionDir {
		t.Fatalf("the browser reads %q while the agent is told %q", got, sessionDir)
	}
}

// wd is the process's working directory, so the test above can compare
// against it without assuming a root.
func wd(t *testing.T) string {
	t.Helper()
	d, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	return d
}

// TestTheMouseSwitchIsOptIn: MNEMO_MOUSE=1 turns mouse reporting on, and
// anything else — unset, empty, "0", a typo — leaves it off. The failure mode
// of a typo is then the terminal's own selection, which is a feature the reader
// already has, rather than a mode they did not ask for and cannot see.
func TestTheMouseSwitchIsOptIn(t *testing.T) {
	for _, on := range []string{"1", "true", "TRUE", " yes ", "on"} {
		if !mouseEnabled(on) {
			t.Fatalf("%q must turn mouse reporting on", on)
		}
	}
	for _, off := range []string{"", " ", "0", "false", "no", "off", "ture", "2", "yes please"} {
		if mouseEnabled(off) {
			t.Fatalf("%q must leave mouse reporting off", off)
		}
	}
	if mouseEnv != "MNEMO_MOUSE" {
		t.Fatalf("the switch is %q; it is documented as MNEMO_MOUSE", mouseEnv)
	}
}
