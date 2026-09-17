package trace

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/logging"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/tree"
)

// write puts a span log under a temporary home. Home is always a parameter
// here; nothing in this file may read the developer's real ~/.mnemo.
//
// It also closes the interface's log when the test is over. Reading spans now
// writes about the ones it had to drop, and a log left open is a temporary
// directory Windows will not remove — a failure that lands in t.TempDir's
// cleanup and mentions nothing about the log that caused it. Cleanups run
// last-in-first-out, so registering the close here puts it before the removal.
func write(t *testing.T, home, name string, lines ...string) {
	t.Helper()
	t.Cleanup(func() { _ = logging.Close() })
	if err := os.MkdirAll(Dir(home), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(Dir(home), name),
		[]byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func span(id, parent, kind, name string, start, dur int64, ok bool, attrs string) string {
	p := "null"
	if parent != "" {
		p = `"` + parent + `"`
	}
	if attrs == "" {
		attrs = "{}"
	}
	return `{"id":"` + id + `","parent_id":` + p + `,"session":"s","kind":"` + kind +
		`","name":"` + name + `","start":` + itoa(int(start)) + `,"duration_ms":` + itoa(int(dur)) +
		`,"ok":` + boolStr(ok) + `,"attrs":` + attrs + `}`
}

func boolStr(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

func rows(nodes []*tree.Node) []string {
	m := tree.New(nodes...)
	m.ExpandAll()
	out := make([]string, 0, len(m.Rows()))
	for _, r := range m.Rows() {
		out = append(out, strings.Repeat(" ", r.Depth)+r.Node.Label)
	}
	return out
}

func TestAMissingLogDirectoryIsNoSpansNotAnError(t *testing.T) {
	if got := Read(t.TempDir()); got != nil {
		t.Fatalf("got %d spans; traces are a convenience and their absence must not look like a failure", len(got))
	}
}

func TestSpansNestByParent(t *testing.T) {
	h := t.TempDir()
	write(t, h, "a.jsonl",
		span("1", "", "session", "session", 100, 900, true, `{"cwd":"/repo/tui"}`),
		span("2", "1", "llm", "round trip", 150, 300, true, `{"model":"opus","tokens_in":10,"tokens_out":5}`),
		span("3", "2", "subagent", "probe", 160, 80, true, ""),
	)
	got := rows(Nodes(Read(h)))
	if len(got) != 3 || !strings.Contains(got[0], "tui") || got[1] != " opus" || got[2] != "  sub-agent · probe" {
		t.Fatalf("hierarchy = %#v", got)
	}
}

func TestASessionRowSaysWhichRunItWas(t *testing.T) {
	// Two dozen rows all reading "session" identify nothing.
	h := t.TempDir()
	write(t, h, "a.jsonl",
		span("1", "", "session", "session", 1788085162761, 900, true, `{"cwd":"/repo/tui"}`),
		span("2", "", "session", "session", 1788085000000, 900, true, `{"cwd":"/repo/agent"}`),
	)
	got := rows(Nodes(Read(h)))
	if got[0] == got[1] {
		t.Fatalf("two runs render identically: %q", got[0])
	}
	for _, g := range got {
		if !strings.Contains(g, ":") {
			t.Fatalf("a session row must carry a clock time: %q", g)
		}
	}
}

func TestNewestRunFirst(t *testing.T) {
	h := t.TempDir()
	write(t, h, "a.jsonl",
		span("old", "", "session", "session", 100, 10, true, `{"cwd":"/a"}`),
		span("new", "", "session", "session", 9000, 10, true, `{"cwd":"/b"}`),
	)
	got := Nodes(Read(h))
	if !strings.Contains(got[0].Label, "b") {
		t.Fatalf("the run you just made is the one you came for: %q", got[0].Label)
	}
}

func TestABranchWithAFailureOpensItself(t *testing.T) {
	h := t.TempDir()
	write(t, h, "a.jsonl",
		span("1", "", "session", "session", 100, 900, true, `{"cwd":"/repo"}`),
		span("2", "1", "llm", "round trip", 150, 300, false, `{"model":"opus","stop_reason":"error"}`),
		span("3", "", "session", "session", 50, 100, true, `{"cwd":"/other"}`),
		span("4", "3", "llm", "fine", 60, 10, true, `{"model":"haiku"}`),
	)
	nodes := Nodes(Read(h))
	var failed, clean *tree.Node
	for _, n := range nodes {
		if strings.Contains(n.Label, "repo") {
			failed = n
		}
		if strings.Contains(n.Label, "other") {
			clean = n
		}
	}
	if failed == nil || !failed.Expanded {
		t.Fatal("a failure must be visible without hunting for it")
	}
	if clean == nil || clean.Expanded {
		t.Fatal("everything else stays closed; forty open sessions is the flat scroll this replaces")
	}
}

func TestAnOrphanIsLabelledNotHungAtTheTopPretendingToBeARoot(t *testing.T) {
	// The log rotates between a parent and its child. Dropping the child
	// loses failures; hanging it at the top makes it look like a session.
	h := t.TempDir()
	write(t, h, "a.jsonl",
		span("kid", "gone", "llm", "round trip", 100, 20, false, `{"model":"opus"}`),
	)
	nodes := Nodes(Read(h))
	if len(nodes) != 1 || nodes[0].Label != "unlinked" {
		t.Fatalf("got %#v", rows(nodes))
	}
	if len(nodes[0].Children) != 1 {
		t.Fatal("the orphan itself must still be there")
	}
	if nodes[0].Detail != "1 span" {
		t.Fatalf("detail = %q", nodes[0].Detail)
	}
}

func TestASpanWithNoEndReadsAsRunning(t *testing.T) {
	// Or the process died mid-flight, which is worth seeing rather than
	// rendering as success.
	h := t.TempDir()
	write(t, h, "a.jsonl", span("1", "", "llm", "round trip", 100, 0, true, `{"model":"opus"}`))
	if got := Nodes(Read(h))[0].State; got != tree.Running {
		t.Fatalf("state = %v, want Running", got)
	}
}

func TestDetailCarriesDurationAndCost(t *testing.T) {
	h := t.TempDir()
	write(t, h, "a.jsonl",
		span("1", "", "llm", "rt", 100, 2800, true, `{"model":"opus","tokens_in":3000,"tokens_out":976}`))
	d := Nodes(Read(h))[0].Detail
	if !strings.Contains(d, "2.8s") || !strings.Contains(d, "3976 tok") {
		t.Fatalf("detail = %q", d)
	}
}

func TestDurationsAreShortEnoughForTheColumn(t *testing.T) {
	for ms, want := range map[int64]string{
		12: "12ms", 999: "999ms", 2800: "2.8s", 59000: "59.0s", 65000: "1m5s", 727000: "12m7s",
	} {
		if got := dur(ms); got != want {
			t.Fatalf("dur(%d) = %q, want %q", ms, got, want)
		}
	}
}

func TestGarbageLinesAreSkippedNotFatal(t *testing.T) {
	h := t.TempDir()
	write(t, h, "a.jsonl",
		"not json",
		`{"no":"id"}`,
		span("1", "", "session", "session", 100, 10, true, `{"cwd":"/x"}`),
		`{"id":"trunc","parent`,
	)
	if got := Read(h); len(got) != 1 {
		t.Fatalf("got %d spans, want the one good line", len(got))
	}
}

func TestFilesAreReadOldestFirst(t *testing.T) {
	h := t.TempDir()
	write(t, h, "2026-08-29.jsonl", span("a", "", "session", "s", 100, 10, true, `{"cwd":"/one"}`))
	write(t, h, "2026-08-30.jsonl", span("b", "", "session", "s", 200, 10, true, `{"cwd":"/two"}`))
	got := Read(h)
	if len(got) != 2 || got[0].ID != "a" {
		t.Fatalf("got %#v", got)
	}
}

// --- what the reader says about what it could not read -----------------------

// Reading spans writes about the ones it had to drop. The record is the only
// place that loss is visible: the tree shows the spans that survived, and a
// file whose parent span was rotated away looks exactly like one that never
// had a parent.
func TestSpansThatHadToBeDroppedAreSaidInTheInterfacesLog(t *testing.T) {
	t.Setenv(logging.EnvLevel, "info")
	t.Setenv(logging.EnvFile, "")
	h := t.TempDir()
	write(t, h, "a.jsonl",
		"not json",
		`{"no":"id"}`,
		span("1", "", "session", "session", 100, 10, true, `{"cwd":"/x"}`),
	)
	if got := Read(h); len(got) != 1 {
		t.Fatalf("got %d spans, want the one good line", len(got))
	}

	recs := logging.Read(h)
	if len(recs) != 1 {
		t.Fatalf("the interface's log holds %v, want one record about the dropped lines", recs)
	}
	if recs[0].Msg != "trace.read" || recs[0].Level != logging.Warn {
		t.Fatalf("record = %+v", recs[0])
	}
	if got, want := recs[0].Text(), "file=a.jsonl skipped=2"; got != want {
		t.Fatalf("record says %q, want %q", got, want)
	}
}

// A span log that reads cleanly writes nothing at all: the file is opened on
// the first record, not on sight, so a reader that has nothing to report
// leaves no trace of its own.
func TestAReadableSpanLogWritesNothing(t *testing.T) {
	t.Setenv(logging.EnvLevel, "")
	t.Setenv(logging.EnvFile, "")
	h := t.TempDir()
	write(t, h, "a.jsonl", span("1", "", "session", "session", 100, 10, true, `{"cwd":"/x"}`))
	if got := Read(h); len(got) != 1 {
		t.Fatalf("got %d spans, want 1", len(got))
	}
	if recs := logging.Read(h); len(recs) != 0 {
		t.Fatalf("a clean read logged %v", recs)
	}
	if _, err := os.Stat(logging.Path(h)); err == nil {
		t.Fatal("a clean read created the interface's log")
	}
}

// A missing span directory is the normal state of a fresh install, so it is
// not worth a log line: the pane's own empty state says it better, and a log
// that fills with "nothing here yet" is a log nobody reads.
func TestAMissingSpanDirectoryIsNotWorthALogLine(t *testing.T) {
	t.Setenv(logging.EnvLevel, "info")
	t.Setenv(logging.EnvFile, "")
	h := t.TempDir()
	if got := Read(h); len(got) != 0 {
		t.Fatalf("got %d spans from a home with no span log", len(got))
	}
	if recs := logging.Read(h); len(recs) != 0 {
		t.Fatalf("a missing span directory was logged as %v", recs)
	}
	if _, err := os.Stat(logging.Dir(h)); err == nil {
		t.Fatal("reading a home with no spans created the span directory")
	}
}
