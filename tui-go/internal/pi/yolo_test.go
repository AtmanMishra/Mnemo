package pi

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The yolo switch, at the level that decides it.
//
// What matters here is the reading, because a mode that misreads itself is
// worse than one that does not exist: absent, unreadable and corrupt must all
// mean "off", and a project file must not be able to switch the mode off for
// a user who turned it on everywhere.

func writePermissions(t *testing.T, file, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestYoloIsOffWhenNothingSaysOtherwise(t *testing.T) {
	project, home := t.TempDir(), t.TempDir()
	t.Setenv("MNEMO_YOLO", "")
	if Yolo(project, home) {
		t.Fatal("the mode must be off unless it was asked for")
	}
}

func TestYoloReadsTheProjectFile(t *testing.T) {
	project, home := t.TempDir(), t.TempDir()
	t.Setenv("MNEMO_YOLO", "")
	writePermissions(t, YoloFile(project), `{"version":1,"rules":[],"yolo":true}`)
	if !Yolo(project, home) {
		t.Fatal("a project that turned the mode on must be read as on")
	}
}

func TestYoloReadsTheUserFile(t *testing.T) {
	project, home := t.TempDir(), t.TempDir()
	t.Setenv("MNEMO_YOLO", "")
	writePermissions(t, GlobalYoloFile(home), `{"version":1,"rules":[],"yolo":true}`)
	if !Yolo(project, home) {
		t.Fatal("a user-wide yolo must apply to projects that say nothing")
	}
}

func TestACorruptFileDoesNotTurnTheModeOn(t *testing.T) {
	project, home := t.TempDir(), t.TempDir()
	t.Setenv("MNEMO_YOLO", "")
	writePermissions(t, YoloFile(project), `{"yolo": tru`)
	if Yolo(project, home) {
		t.Fatal("a file nobody can parse must not be read as consent")
	}
}

func TestYoloReadsTheEnvironment(t *testing.T) {
	project, home := t.TempDir(), t.TempDir()
	t.Setenv("MNEMO_YOLO", "1")
	if !Yolo(project, home) {
		t.Fatal("MNEMO_YOLO=1 must be enough on its own")
	}
}

func TestSetProjectYoloKeepsTheRulesAndRoundTrips(t *testing.T) {
	project, home := t.TempDir(), t.TempDir()
	t.Setenv("MNEMO_YOLO", "")
	writePermissions(t, YoloFile(project), `{"version":1,"default":"ask","rules":[
		{"tool":"bash_exec","pattern":"npm test*","action":"allow"},
		{"tool":"bash_exec","pattern":"rm -rf *","action":"deny"}
	]}`)

	file, err := SetProjectYolo(project, true)
	if err != nil {
		t.Fatal(err)
	}
	if file != YoloFile(project) {
		t.Fatalf("wrote %s, expected the project file", file)
	}

	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Version int    `json:"version"`
		Default string `json:"default"`
		Yolo    bool   `json:"yolo"`
		Rules   []struct {
			Tool, Pattern, Action string
		} `json:"rules"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("the file must stay parseable: %v\n%s", err, raw)
	}
	if !doc.Yolo || doc.Version != 1 || doc.Default != "ask" {
		t.Fatalf("the document's other keys must survive, got %s", raw)
	}
	if len(doc.Rules) != 2 {
		t.Fatalf("both rules must survive a mode toggle, got %s", raw)
	}
	if !Yolo(project, home) {
		t.Fatal("the mode must read back as on")
	}

	if _, err := SetProjectYolo(project, false); err != nil {
		t.Fatal(err)
	}
	if Yolo(project, home) {
		t.Fatal("off must read back as off")
	}
}

// A file that does not exist yet is the common case — the first toggle in a
// project — and it must produce a valid document, not a file with no shape.
func TestSetProjectYoloCreatesAWellFormedFile(t *testing.T) {
	project := t.TempDir()
	t.Setenv("MNEMO_YOLO", "")
	if _, err := SetProjectYolo(project, true); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(YoloFile(project))
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("a fresh file must be valid JSON: %v", err)
	}
	for _, key := range []string{"version", "default", "rules", "yolo"} {
		if _, ok := doc[key]; !ok {
			t.Fatalf("a fresh file must carry %q, got %s", key, raw)
		}
	}
}
