package pi

import (
	"strings"
	"testing"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/logging"
)

// The wiring tests: what this package records about the agent it drives.
//
// They configure the process log at a temporary home, which is the one thing
// cmd/mnemo does for real, and they never start a process — a spawn that
// cannot find its script returns before exec, and a dialog request is a map
// literal. Nothing here spawns a shell, which is what makes it run on Windows.

// logged points the interface's log at a temporary home for one test, and
// closes it before the directory is removed: on Windows an open file stops a
// directory being deleted, and the failure would land in t.TempDir's cleanup
// with no mention of the log that caused it.
func logged(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Cleanup(func() { _ = logging.Close() })
	t.Setenv(logging.EnvFile, "")
	t.Setenv(logging.EnvLevel, "")
	logging.Configure(home)
	return home
}

func TestASpawnThatCannotFindTheAgentIsRecorded(t *testing.T) {
	home := logged(t)
	if _, err := Spawn(t.TempDir(), t.TempDir(), "", "", Trust{}); err == nil {
		t.Fatal("spawning against a directory with no agent script should fail")
	}
	recs := logging.Read(home)
	if len(recs) != 1 {
		t.Fatalf("the log holds %v, want one record about the failed spawn", recs)
	}
	if recs[0].Msg != "agent.spawn" || recs[0].Level != logging.Warn {
		t.Fatalf("record = %+v", recs[0])
	}
	if !strings.Contains(recs[0].Text(), "ok=false") {
		t.Fatalf("the record does not say the spawn failed: %q", recs[0].Text())
	}
}

func TestADialogRequestIsRecordedWithoutItsContents(t *testing.T) {
	home := logged(t)
	ParseEvent(map[string]any{
		"type": "extension_ui_request", "id": "q1", "method": "input",
		"title": "API key", "message": "paste the secret here",
	})

	recs := logging.Read(home)
	if len(recs) != 1 || recs[0].Msg != "dialog.request" {
		t.Fatalf("the log holds %v, want one record about the question", recs)
	}
	if got, want := recs[0].Text(), "method=input id=q1"; got != want {
		t.Fatalf("record says %q, want %q", got, want)
	}
	// What was asked is not in the record. A dialog is exactly where a key or
	// a private path gets typed, and the log is a file that outlives the
	// session it was typed in.
	if said := recs[0].Msg + " " + recs[0].Text(); strings.Contains(said, "secret") || strings.Contains(said, "API key") {
		t.Fatalf("the dialog's contents were logged: %q", said)
	}
}

func TestAnIgnoredDialogMethodIsOnlySaidAtDebug(t *testing.T) {
	home := logged(t)
	ParseEvent(map[string]any{
		"type": "extension_ui_request", "id": "q2", "method": "setEditorText",
	})
	if recs := logging.Read(home); len(recs) != 0 {
		t.Fatalf("an ignored method was logged at the default level: %v", recs)
	}

	t.Setenv(logging.EnvLevel, "debug")
	if err := logging.Close(); err != nil {
		t.Fatal(err)
	}
	logging.Configure(home)
	ParseEvent(map[string]any{
		"type": "extension_ui_request", "id": "q2", "method": "setEditorText",
	})
	recs := logging.Read(home)
	if len(recs) != 1 || recs[0].Level != logging.Debug {
		t.Fatalf("debug level recorded %v, want the ignored method", recs)
	}
	if !strings.Contains(recs[0].Text(), "handled=false") {
		t.Fatalf("the record does not say it was ignored: %q", recs[0].Text())
	}
}

func TestATrustDecisionIsRecordedWithItsReason(t *testing.T) {
	home := logged(t)
	project := t.TempDir()
	ResolveTrust(home, project)

	recs := logging.Read(home)
	if len(recs) != 1 || recs[0].Msg != "trust.decided" {
		t.Fatalf("the log holds %v, want one record about the decision", recs)
	}
	// Nothing recorded for this project, so the safe answer applied — and that
	// is exactly the case a reader comes to the log to check.
	if !strings.Contains(recs[0].Text(), "approve=false") || !strings.Contains(recs[0].Text(), "from=-") {
		t.Fatalf("a defaulted decision reads as %q", recs[0].Text())
	}
}
