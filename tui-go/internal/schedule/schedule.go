// Package schedule reads and toggles the shared scheduler store
// (~/.mnemo/schedules.json) — the SAME file the agent's daemon, in-session
// ticker and `mnemo schedule` CLI use. The schema round-trips through both
// TypeScript (agent/src/schedule/store.ts) and Go, so this package only
// touches plain data: exactly the fields the TS side writes, optional ones
// omitted when absent.
package schedule

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
)

// Job is one entry in the store. A job is driven by exactly one of Cron,
// Interval or Trigger. Model is an override for the one-shot child.
type Job struct {
	ID       string          `json:"id"`
	Name     string          `json:"name"`
	Prompt   string          `json:"prompt"`
	Cron     string          `json:"cron,omitempty"`
	Interval string          `json:"interval,omitempty"`
	Trigger  *Trigger        `json:"trigger,omitempty"`
	Model    string          `json:"model,omitempty"`
	Scope    string          `json:"scope,omitempty"`
	Enabled  bool            `json:"enabled"`
	LastRun  *int64          `json:"lastRun,omitempty"`
	NextRun  *int64          `json:"nextRun,omitempty"`
	Result   *JobResult      `json:"lastResult,omitempty"`
}

// Trigger is an event-driven driver (10.4): on_failure, on_uncommitted,
// on_cost_over, on_push. Params carries type-specific knobs (budget,
// cooldownMs) as raw JSON so the Go side never has to re-type them.
type Trigger struct {
	Type   string         `json:"type"`
	Params map[string]any `json:"params,omitempty"`
}

// JobResult is the last run's outcome, written by whichever host fired.
type JobResult struct {
	OK         bool   `json:"ok"`
	At         int64  `json:"at"`
	DurationMs int64  `json:"durationMs,omitempty"`
	Detail     string `json:"detail,omitempty"`
}

// Path is where the store lives under a home directory.
func Path(home string) string {
	return filepath.Join(home, ".mnemo", "schedules.json")
}

// Load reads the job list. A missing file is an empty store; a corrupt file
// is an error (the overlay says so rather than half-rendering).
func Load(home string) ([]Job, error) {
	data, err := os.ReadFile(Path(home))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	if len(trimSpace(data)) == 0 {
		return nil, nil
	}
	var jobs []Job
	if err := json.Unmarshal(data, &jobs); err != nil {
		return nil, err
	}
	return jobs, nil
}

// Save writes the whole list (temp file + rename, so a concurrent reader —
// the daemon or the in-session ticker — never sees a torn file).
func Save(home string, jobs []Job) error {
	file := Path(home)
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(jobs, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	tmp := file + ".tmp-go"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, file)
}

// Find returns the job with the id, if present.
func Find(jobs []Job, id string) (Job, bool) {
	for _, j := range jobs {
		if j.ID == id {
			return j, true
		}
	}
	return Job{}, false
}

// ToggleEnabled flips one job's enabled flag in place and returns the new
// value. Callers persist with Save.
func ToggleEnabled(jobs []Job, id string) (bool, bool) {
	for i := range jobs {
		if jobs[i].ID == id {
			jobs[i].Enabled = !jobs[i].Enabled
			return jobs[i].Enabled, true
		}
	}
	return false, false
}

// Describe is a one-line schedule summary for a job row.
func Describe(j Job) string {
	if j.Trigger != nil {
		s := "on " + j.Trigger.Type
		if b, ok := j.Trigger.Params["budget"]; ok {
			s += " · budget $" + number(b)
		}
		return s
	}
	if j.Cron != "" {
		return j.Cron
	}
	return "every " + j.Interval
}

// Recent ages a job result: only results this fresh deserve a status chip,
// so a result left over from yesterday does not pop up every startup.
func Recent(j Job, now int64, windowMs int64) bool {
	return j.Result != nil && j.LastRun != nil && now-*j.LastRun < windowMs
}

func number(v any) string {
	switch n := v.(type) {
	case float64:
		if n == float64(int64(n)) {
			return strconv.FormatInt(int64(n), 10)
		}
		return strconv.FormatFloat(n, 'f', -1, 64)
	case json.Number:
		return n.String()
	default:
		return fmt.Sprint(v)
	}
}

func trimSpace(b []byte) []byte {
	s := 0
	for s < len(b) && (b[s] == ' ' || b[s] == '\t' || b[s] == '\n' || b[s] == '\r') {
		s++
	}
	e := len(b)
	for e > s && (b[e-1] == ' ' || b[e-1] == '\t' || b[e-1] == '\n' || b[e-1] == '\r') {
		e--
	}
	return b[s:e]
}