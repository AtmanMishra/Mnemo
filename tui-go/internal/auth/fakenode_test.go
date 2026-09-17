package auth

import (
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
	"time"
)

// The catalogue call shells out to node, so testing what it does about a
// provider that never answers means standing in for node.
//
// The stand-in is THIS test binary, copied into a temp directory under node's
// name and re-executed — the memory package's fake sidecar, one command name
// over. A `#!/bin/sh` script would be unrunnable on Windows and would take the
// whole package with it (there is no shebang and no POSIX shell there), and
// nothing about "wait for a command" needs one.
const (
	envFakeNode  = "MNEMO_TEST_FAKE_NODE"
	envFakeDelay = "MNEMO_TEST_FAKE_NODE_DELAY_MS"
)

// TestMain is also the fake node's entry point: when the environment says so,
// this process is the stand-in and never the test runner.
func TestMain(m *testing.M) {
	if os.Getenv(envFakeNode) == "1" {
		// A catalogue call that takes its time and then says nothing. The
		// delay is read once, here, so a test that wants a fast fake and one
		// that wants a silent one do not disturb each other.
		time.Sleep(time.Duration(fakeDelayMS()) * time.Millisecond)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// fakeDelayMS is how long the stand-in takes before it exits. Ten seconds when
// nobody said otherwise: longer than any bound a test here sets, so the only
// way a call in flight finishes is by giving up.
func fakeDelayMS() int {
	n, err := strconv.Atoi(os.Getenv(envFakeDelay))
	if err != nil || n < 0 {
		return 10_000
	}
	return n
}

// fakeNode puts the stand-in at the front of PATH and returns a repository root
// for the call to be pointed at. The script the command names does not have to
// exist: node is the fake, and the fake ignores its arguments.
func fakeNode(t *testing.T, delayMS int) string {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	name := "node"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	if err := os.WriteFile(filepath.Join(dir, name), raw, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	t.Setenv(envFakeNode, "1")
	t.Setenv(envFakeDelay, strconv.Itoa(delayMS))

	repo := t.TempDir()
	if err := os.MkdirAll(filepath.Join(repo, "agent", "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	return repo
}
