package pi

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/agent"
)

// TestLivePiExtensionConflict is the check that the shape we parse is pi's
// CURRENT one rather than a guess: it runs a real pi in a scratch project whose
// two extensions register the same flag, and reads the failure through the same
// pipe the interface uses.
//
// Skipped unless MNEMO_LIVE_PI_CONFLICT points at such a project (create one:
// .pi/extensions/a.ts and b.ts, each calling pi.registerFlag("dupe", …)), since
// it needs a real pi on PATH and takes half a minute. The fake-agent test above
// covers the same path on every run.
func TestLivePiExtensionConflict(t *testing.T) {
	proj := os.Getenv("MNEMO_LIVE_PI_CONFLICT")
	if proj == "" {
		t.Skip("set MNEMO_LIVE_PI_CONFLICT=<dir with two conflicting .pi/extensions> to run")
	}
	repo, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("node", filepath.Join(repo, "agent", "bin", "mnemo.ts"),
		"--mode", "rpc", "--no-builtin-tools", "--approve")
	cmd.Dir = proj
	cmd.Env = append(os.Environ(), "MNEMO_PROVIDER=llama.cpp")
	s, err := Start(cmd)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()

	done := make(chan tea.Msg, 1)
	go func() { done <- s.Next()() }()
	select {
	case msg := <-done:
		f, ok := msg.(agent.Failed)
		if !ok {
			t.Fatalf("got %#v", msg)
		}
		t.Logf("TRANSCRIPT LINE: %s", f.Err)
		if !strings.Contains(f.Err.Error(), "Failed to load extension") {
			t.Fatalf("missing the real message: %v", f.Err)
		}
		if !strings.Contains(f.Err.Error(), "remove or rename one of them") {
			t.Fatalf("missing the way out: %v", f.Err)
		}
	case <-time.After(60 * time.Second):
		t.Fatal("no message")
	}
}
