package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/keymap"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/overlay"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/schedule"
)

// writeSchedules drops a store into the fixture's home the way the agent's
// TS side would (same JSON shape, camelCase, optional fields omitted).
func writeSchedules(t *testing.T, m *Model, jobs []schedule.Job) {
	t.Helper()
	if err := schedule.Save(m.cfg.Home, jobs); err != nil {
		t.Fatal(err)
	}
}

func jobFixture(id, name string, enabled bool) schedule.Job {
	now := time.Now().UnixMilli()
	return schedule.Job{
		ID: id, Name: name, Prompt: "run the thing", Enabled: enabled,
		Cron: "0 9 * * 1", LastRun: &now,
	}
}

func TestSchedulesOverlayOpensAndStatesItsPurpose(t *testing.T) {
	m := fixture(t, 100, 30)
	writeSchedules(t, m, []schedule.Job{jobFixture("nightly-0001", "nightly", true)})
	press(t, m, "ctrl+o")
	s := screen(m)
	if m.Overlay() == nil || m.Overlay().Kind != overlay.Schedules {
		t.Fatalf("^o opened nothing:\n%s", s)
	}
	for _, want := range []string{"schedules", "nightly", "enter pauses, n fires now"} {
		if !strings.Contains(s, want) {
			t.Fatalf("^o does not say %q:\n%s", want, s)
		}
	}
}

func TestSchedulesOverlayEmptyStateShowsTheAddPath(t *testing.T) {
	m := fixture(t, 100, 30)
	press(t, m, "ctrl+o")
	s := screen(m)
	for _, want := range []string{"No schedules yet", "mnemo schedule add"} {
		if !strings.Contains(s, want) {
			t.Fatalf("empty schedules overlay should say %q:\n%s", want, s)
		}
	}
}

func TestSchedulesOverlayEnterPausesAndResumes(t *testing.T) {
	m := fixture(t, 100, 30)
	writeSchedules(t, m, []schedule.Job{jobFixture("nightly-0001", "nightly", true)})
	press(t, m, "ctrl+o")
	press(t, m, "enter")
	if !strings.Contains(lastLine(screen(m)), "paused nightly") {
		t.Fatalf("enter should pause the job, got: %s", lastLine(screen(m)))
	}
	jobs, err := schedule.Load(m.cfg.Home)
	if err != nil {
		t.Fatal(err)
	}
	if jobs[0].Enabled {
		t.Fatal("schedules.json should say enabled=false after enter")
	}
	// enter again: resume
	press(t, m, "enter")
	if !strings.Contains(lastLine(screen(m)), "resumed nightly") {
		t.Fatalf("second enter should resume, got: %s", lastLine(screen(m)))
	}
	jobs, _ = schedule.Load(m.cfg.Home)
	if !jobs[0].Enabled {
		t.Fatal("schedules.json should say enabled=true after second enter")
	}
	// the overlay stays open, so a sweep never closes the surface
	if m.Overlay() == nil {
		t.Fatal("pause/resume must keep the schedules overlay open")
	}
}

func TestSchedulesOverlayFireSendsNowToTheAgent(t *testing.T) {
	m := fixture(t, 100, 30)
	writeSchedules(t, m, []schedule.Job{jobFixture("nightly-0001", "nightly", true)})
	press(t, m, "ctrl+o")
	press(t, m, "n")
	// n is the fire key: it sends the same /now the CLI and the in-session
	// ticker use, straight into the agent stream.
	found := false
	for _, b := range m.Chat().Blocks() {
		for _, line := range b.Body {
			if strings.Contains(line, "/now nightly-0001") {
				found = true
			}
		}
	}
	if !found {
		t.Fatal("n should send /now <id> to the agent")
	}
	if !strings.Contains(lastLine(screen(m)), "firing nightly now") {
		t.Fatalf("fire should notify, got: %s", lastLine(screen(m)))
	}
}

func TestSchedulesChipToastsAFreshResult(t *testing.T) {
	m := fixture(t, 100, 30)
	now := time.Now().UnixMilli()
	writeSchedules(t, m, []schedule.Job{{
		ID: "nightly-0001", Name: "nightly", Prompt: "x", Enabled: true,
		Interval: "1h",
		LastRun:  &now,
		Result:   &schedule.JobResult{OK: true, At: now, DurationMs: 3_200},
	}})
	press(t, m, "ctrl+o")
	line := lastLine(screen(m))
	if !strings.Contains(line, "⏱ nightly: ok · 3s") {
		t.Fatalf("a fresh job result should chip on the status line, got: %s", line)
	}
	// once is enough: another poll does not re-toast
	press(t, m, "esc")
	m.Update(noticeMsg{}) // clear the expired chip text
	press(t, m, "ctrl+o")
	if strings.Contains(lastLine(screen(m)), "⏱ nightly") {
		t.Fatalf("the same result must not toast twice:\n%s", lastLine(screen(m)))
	}
}

func TestSchedulesChipSkipsStaleResults(t *testing.T) {
	m := fixture(t, 100, 30)
	old := time.Now().Add(-2 * time.Hour).UnixMilli()
	writeSchedules(t, m, []schedule.Job{{
		ID: "nightly-0001", Name: "nightly", Prompt: "x", Enabled: true,
		Interval: "1h",
		LastRun:  &old,
		Result:   &schedule.JobResult{OK: true, At: old, DurationMs: 3_200},
	}})
	press(t, m, "ctrl+o")
	line := lastLine(screen(m))
	if strings.Contains(line, "⏱ nightly") {
		t.Fatalf("an old result must not pop up as if new, got: %s", line)
	}
}

func TestSchedulesIsOnePressFromEveryMode(t *testing.T) {
	for _, enter := range []string{"", "esc", "ctrl+t"} {
		m := fixture(t, 100, 30)
		if enter != "" {
			press(t, m, enter)
		}
		press(t, m, "ctrl+o")
		if m.Overlay() == nil {
			t.Fatalf("from %q, ^o opened nothing", enter)
		}
	}
}

func TestSchedulesOverlayEscDismisses(t *testing.T) {
	m := fixture(t, 100, 30)
	writeSchedules(t, m, []schedule.Job{jobFixture("nightly-0001", "nightly", true)})
	press(t, m, "ctrl+o")
	press(t, m, "esc")
	if m.Overlay() != nil {
		t.Fatal("esc should dismiss the schedules overlay")
	}
	if m.Mode() != keymap.Insert {
		t.Fatal("esc should return to insert mode")
	}
}

func TestHelpAndPaletteListSchedules(t *testing.T) {
	m := fixture(t, 100, 30)
	press(t, m, "ctrl+h")
	if !strings.Contains(screen(m), "schedules and triggers") {
		t.Fatalf("help should list schedules:\n%s", screen(m))
	}
	press(t, m, "esc")
	press(t, m, "ctrl+k")
	if !strings.Contains(screen(m), "schedules and triggers") {
		t.Fatalf("palette should list schedules:\n%s", screen(m))
	}
	if !strings.Contains(screen(m), "^o") {
		t.Fatalf("palette should show the ^o chord:\n%s", screen(m))
	}
}

func TestSchedulesSaveRoundTripsAgainstConcurrentReaders(t *testing.T) {
	m := fixture(t, 100, 30)
	writeSchedules(t, m, []schedule.Job{
		jobFixture("a-0001", "one", true),
		jobFixture("b-0002", "two", false),
	})
	// Save again after a toggle — the file must stay a readable array (the
	// daemon / in-session ticker read it without a lock).
	jobs := mustLoad(t, m.cfg.Home)
	if jobs[1].Enabled {
		t.Fatal("setup: second job should start paused")
	}
	if err := schedule.Save(m.cfg.Home, jobs); err != nil {
		t.Fatal(err)
	}
	again := mustLoad(t, m.cfg.Home)
	if len(again) != 2 {
		t.Fatalf("round-trip lost jobs: %d", len(again))
	}
}

func mustLoad(t *testing.T, home string) []schedule.Job {
	t.Helper()
	jobs, err := schedule.Load(home)
	if err != nil {
		t.Fatal(err)
	}
	return jobs
}

func TestSchedulesOverlayToleratesACorruptStore(t *testing.T) {
	m := fixture(t, 100, 30)
	if err := os.MkdirAll(filepath.Join(m.cfg.Home, ".mnemo"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(schedule.Path(m.cfg.Home), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	press(t, m, "ctrl+o")
	s := screen(m)
	if !strings.Contains(s, "Could not read the schedules file") {
		t.Fatalf("a corrupt store should say so, not half-render:\n%s", s)
	}
}