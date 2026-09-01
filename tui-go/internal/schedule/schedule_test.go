package schedule

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRoundTripMatchesTheTSShape(t *testing.T) {
	home := t.TempDir()
	now := int64(1_700_000_000_000)
	jobs := []Job{
		{ID: "nightly-0001", Name: "nightly", Prompt: "check CI and fix failures",
			Cron: "0 9 * * 1", Enabled: true},
		{ID: "commit-0ca3", Name: "commit", Prompt: "commit the work", Enabled: true,
			Trigger: &Trigger{Type: "on_uncommitted", Params: map[string]any{"cooldownMs": 300_000}}},
		{ID: "spend-0f1e", Name: "spend", Prompt: "summarise spend", Enabled: false,
			Trigger: &Trigger{Type: "on_cost_over", Params: map[string]any{"budget": 2.5}},
			LastRun: &now, NextRun: &now, Result: &JobResult{OK: true, At: now, DurationMs: 900}},
	}
	if err := Save(home, jobs); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(Path(home))
	if err != nil {
		t.Fatal(err)
	}
	// the file stays a flat array the TS side parses with normalizeJob
	got, err := Load(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("round-trip lost jobs: %d", len(got))
	}
	if got[0].Cron != "0 9 * * 1" || !got[0].Enabled {
		t.Fatalf("cron job mangled: %+v", got[0])
	}
	if got[1].Trigger == nil || got[1].Trigger.Type != "on_uncommitted" {
		t.Fatalf("trigger mangled: %+v", got[1])
	}
	if got[2].Enabled {
		t.Fatal("paused flag lost")
	}
	if got[2].Result == nil || !got[2].Result.OK || got[2].Result.DurationMs != 900 {
		t.Fatalf("lastResult mangled: %+v", got[2].Result)
	}
	if b, ok := got[2].Trigger.Params["budget"].(float64); !ok || b != 2.5 {
		t.Fatalf("budget param mangled: %v", got[2].Trigger.Params["budget"])
	}
	if c, ok := got[1].Trigger.Params["cooldownMs"].(float64); !ok || c != 300_000 {
		t.Fatalf("cooldownMs param mangled: %v", got[1].Trigger.Params["cooldownMs"])
	}
	_ = data
}

func TestMissingFileIsAnEmptyStore(t *testing.T) {
	jobs, err := Load(t.TempDir())
	if err != nil || jobs != nil {
		t.Fatalf("missing file should mean empty store, got %v / %v", jobs, err)
	}
}

func TestToggleEnabledFlipsAndPersists(t *testing.T) {
	home := t.TempDir()
	jobs := []Job{{ID: "a-1", Name: "a", Prompt: "p", Enabled: true}}
	if err := Save(home, jobs); err != nil {
		t.Fatal(err)
	}
	loaded := mustLoad(home)
	enabled, ok := ToggleEnabled(loaded, "a-1")
	if !ok || enabled {
		t.Fatal("toggle should flip true -> false")
	}
	if _, ok := ToggleEnabled(loaded, "missing"); ok {
		t.Fatal("missing id must not toggle")
	}
	if err := Save(home, loaded); err != nil {
		t.Fatal(err)
	}
	again := mustLoad(home)
	if again[0].Enabled {
		t.Fatal("disabled state did not persist")
	}
}

func TestCorruptFileIsAnError(t *testing.T) {
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Dir(Path(home)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(Path(home), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(home); err == nil {
		t.Fatal("corrupt file must be an error, not an empty store")
	}
}

func TestDescribeNamesTheDriver(t *testing.T) {
	if got := Describe(Job{Cron: "0 9 * * 1"}); got != "0 9 * * 1" {
		t.Fatalf("cron describe: %q", got)
	}
	if got := Describe(Job{Interval: "30m"}); got != "every 30m" {
		t.Fatalf("interval describe: %q", got)
	}
	tr := Describe(Job{Trigger: &Trigger{Type: "on_cost_over", Params: map[string]any{"budget": 3.5}}})
	if got := tr; got != "on on_cost_over · budget $3.5" {
		t.Fatalf("trigger describe: %q", got)
	}
}

func mustLoad(home string) []Job {
	jobs, err := Load(home)
	if err != nil {
		panic(err)
	}
	return jobs
}