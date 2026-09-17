package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/logging"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/trace"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/tree"
	"github.com/charmbracelet/x/ansi"
)

// The logs pane, tested through the seam the interface calls: logsPane, laid
// out at a real size, rendered by the real overlay.
//
// The fixtures are a span log written by hand and a log written through the
// logger itself. Nothing spawns a process — no shell, no sidecar — which is
// what lets this run on Windows, where the suite is part of CI.

// pane is an app pointed at a temporary home, with the interface's log closed
// when the test ends. The close is registered after the fixture's temporary
// directories, so it runs before them: on Windows an open log file stops a
// directory being removed, and that failure would land in t.TempDir's cleanup
// saying nothing about the log that caused it.
func pane(t *testing.T) *Model {
	t.Helper()
	t.Setenv(logging.EnvFile, "")
	m := fixture(t, 120, 40)
	t.Cleanup(func() { _ = logging.Close() })
	return m
}

// show is the pane as the interface draws it: the real overlay, at the size
// the real layout would give it.
func show(t *testing.T, m *Model) string {
	t.Helper()
	m.ov = m.logsPane()
	m.Resize(120, 40)
	if !m.ov.IsTree() {
		t.Fatal("the logs pane is not a tree")
	}
	return m.ov.View(m.th)
}

// spans writes a span log under a home, in the shape the agent writes: one
// JSON object per line, parents by id.
func spans(t *testing.T, home string, lines ...string) {
	t.Helper()
	dir := trace.Dir(home)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for i, l := range lines {
		name := "run-" + itoa(i) + ".jsonl"
		if err := os.WriteFile(filepath.Join(dir, name), []byte(l+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// span is one span log line. start is a fixed clock — a fixture that reads the
// wall clock makes a label nobody can assert on.
func span(id, parent, kind, name string, start, dur int64, ok bool, attrs string) string {
	p := "null"
	if parent != "" {
		p = `"` + parent + `"`
	}
	if attrs == "" {
		attrs = "{}"
	}
	okStr := "true"
	if !ok {
		okStr = "false"
	}
	return `{"id":"` + id + `","parent_id":` + p + `,"session":"s","kind":"` + kind +
		`","name":"` + name + `","start":` + itoa(int(start)) + `,"duration_ms":` + itoa(int(dur)) +
		`,"ok":` + okStr + `,"attrs":` + attrs + `}`
}

// logged writes a few records through the real logger, so the pane is reading
// what the writer writes rather than a hand-rolled imitation of it.
func logged(t *testing.T, home string) {
	t.Helper()
	t.Setenv(logging.EnvLevel, "")
	lg := logging.Open(home)
	lg.Info("agent.spawn", "pid", 4242)
	lg.Warn("trace.read", "file", "a.jsonl", "skipped", 2)
	lg.Error("agent.start", "ok", false, "err", "no agent script")
}

// rows is the tree as the reader sees it: depth, then the row's label without
// its colour.
func paneRows(t *testing.T, m *Model) []string {
	t.Helper()
	out := make([]string, 0, m.ov.Count())
	for _, r := range m.ov.Tree().Rows() {
		out = append(out, strings.Repeat(" ", r.Depth)+ansi.Strip(r.Node.Label))
	}
	return out
}

func joined(rows []string) string { return strings.Join(rows, "\n") }

// --- two kinds of record, labelled -------------------------------------------

func TestTheLogsPaneShowsSpansAndLogLinesAsTwoLabelledSections(t *testing.T) {
	m := pane(t)
	spans(t, m.Home(),
		span("s1", "", "session", "session", 1_700_000_000_000, 4200, true, `{"cwd":"/work/proj"}`),
		span("s2", "s1", "llm", "claude-x", 1_700_000_001_000, 900, true, `{"model":"claude-x","tokens_in":10,"tokens_out":2}`),
	)
	logged(t, m.Home())

	view := show(t, m)
	plain := ansi.Strip(view)
	want := []string{"spans", "the call graph of each run", "log", "what the interface said"}
	for _, w := range want {
		if !strings.Contains(plain, w) {
			t.Fatalf("the pane does not say %q:\n%s", w, plain)
		}
	}

	// The two sections are the two top-level rows, in this order: spans first
	// because the call graph is what this pane was built for, the log second
	// because it is beside it.
	got := paneRows(t, m)
	if len(got) < 4 {
		t.Fatalf("the pane has %d rows:\n%s", len(got), joined(got))
	}
	if got[0] != "spans · the call graph of each run" {
		t.Fatalf("first section = %q", got[0])
	}
	if !strings.HasPrefix(got[1], " ") || strings.TrimSpace(got[1]) == "" {
		t.Fatalf("the first section has no rows under it: %q", got[1])
	}
	span, log := -1, -1
	for i, r := range got {
		switch {
		case strings.HasPrefix(r, "log · what the interface said"):
			log = i
		case strings.HasPrefix(r, "spans · the call graph"):
			span = i
		}
	}
	if span < 0 || log < 0 || log < span {
		t.Fatalf("the two sections are not labelled top-level rows:\n%s", joined(got))
	}
}

func TestTheLogsPaneKeepsTheSpanTreeATree(t *testing.T) {
	m := pane(t)
	spans(t, m.Home(),
		span("s1", "", "session", "session", 1_700_000_000_000, 4200, true, `{"cwd":"/work/proj"}`),
		span("s2", "s1", "llm", "claude-x", 1_700_000_001_000, 900, true, `{"model":"claude-x"}`),
		span("s3", "s1", "subagent", "reviewer", 1_700_000_002_000, 300, false, `{}`),
	)

	show(t, m)
	got := joined(paneRows(t, m))
	if !strings.Contains(got, "claude-x") || !strings.Contains(got, "reviewer") {
		t.Fatalf("the span tree lost its children:\n%s", got)
	}
	// The session is one row in and its round trips two in: the hierarchy that
	// makes "what happened inside what" answerable is intact under the heading,
	// rather than flattened into it.
	runDepth, childDepth := -1, -1
	for _, r := range m.ov.Tree().Rows() {
		label := ansi.Strip(r.Node.Label)
		switch {
		case strings.Contains(label, "proj"):
			runDepth = r.Depth
		case strings.Contains(label, "claude-x"):
			childDepth = r.Depth
		}
	}
	if runDepth != 1 {
		t.Fatalf("the run sits at depth %d, want 1 — a child of the spans section:\n%s", runDepth, got)
	}
	if childDepth != 2 {
		t.Fatalf("the model round trip sits at depth %d, want 2:\n%s", childDepth, got)
	}
	// A failed span opens its branch, as it always did — the pane does not
	// second-guess the tree it did not build.
	plain := ansi.Strip(show(t, m))
	if !strings.Contains(plain, "reviewer") {
		t.Fatalf("a failing branch did not open itself:\n%s", plain)
	}
}

func TestLogLinesAreColouredFromTheThemeAndSayTheirLevel(t *testing.T) {
	m := pane(t)
	logged(t, m.Home())

	view := show(t, m)
	plain := ansi.Strip(view)
	for _, want := range []string{"agent.spawn", "trace.read", "agent.start", "pid=4242", "skipped=2", "no agent script"} {
		if !strings.Contains(plain, want) {
			t.Fatalf("the pane does not show %q:\n%s", want, plain)
		}
	}
	for _, want := range []string{"info", "warn", "error"} {
		if !strings.Contains(plain, want) {
			t.Fatalf("the pane does not name the level %q:\n%s", want, plain)
		}
	}
	// Level-coloured out of the palette, not out of a hardcoded escape: each
	// of these is the theme's own style rendered around the level word.
	for _, styled := range []string{m.th.Warn.Render("warn"), m.th.Fail.Render("error")} {
		if !strings.Contains(view, styled) {
			t.Fatalf("the pane does not colour a level with the theme's own style %q:\n%q", styled, view)
		}
	}
	// Newest first: the record you just caused is the one you came to read.
	got := paneRows(t, m)
	first, last := -1, -1
	for i, r := range got {
		switch {
		case strings.Contains(r, "agent.start"):
			first = i
		case strings.Contains(r, "agent.spawn"):
			last = i
		}
	}
	if first < 0 || last < 0 || first > last {
		t.Fatalf("the newest line is not at the top:\n%s", joined(got))
	}
}

// --- the empty states --------------------------------------------------------

func TestTheLogsPaneSaysWhichOfTheTwoIsEmpty(t *testing.T) {
	t.Run("neither has anything", func(t *testing.T) {
		m := pane(t)
		plain := ansi.Strip(show(t, m))
		// The overlay's own empty state, naming both kinds and what makes
		// each of them appear. Two empty headings would say less.
		for _, want := range []string{"Spans:", "Log:", "MNEMO_LOG_LEVEL"} {
			if !strings.Contains(plain, want) {
				t.Fatalf("the empty pane does not name %q:\n%s", want, plain)
			}
		}
		if m.ov.Count() != 0 {
			t.Fatalf("the empty pane has %d rows", m.ov.Count())
		}
	})

	t.Run("no spans", func(t *testing.T) {
		m := pane(t)
		logged(t, m.Home())
		plain := ansi.Strip(show(t, m))
		if !strings.Contains(plain, "spans · nothing recorded yet") {
			t.Fatalf("the pane does not say the spans are empty:\n%s", plain)
		}
		if !strings.Contains(plain, "agent.spawn") {
			t.Fatalf("the pane did not show the log it has:\n%s", plain)
		}
	})

	t.Run("no log lines", func(t *testing.T) {
		m := pane(t)
		spans(t, m.Home(), span("s1", "", "session", "session", 1_700_000_000_000, 10, true, `{"cwd":"/work/proj"}`))
		plain := ansi.Strip(show(t, m))
		if !strings.Contains(plain, "log · no lines yet") {
			t.Fatalf("the pane does not say the log is empty:\n%s", plain)
		}
		if !strings.Contains(plain, "proj") {
			t.Fatalf("the pane did not show the spans it has:\n%s", plain)
		}
	})
}

// The pane reads the log; it does not write to it. A pane that appends on open
// changes what it shows by being opened, and the second open would show its
// own first.
func TestOpeningTheLogsPaneWritesNothing(t *testing.T) {
	m := pane(t)
	spans(t, m.Home(), span("s1", "", "session", "session", 1_700_000_000_000, 10, true, `{"cwd":"/work/proj"}`))
	show(t, m)
	show(t, m)
	if recs := logging.Read(m.Home()); len(recs) != 0 {
		t.Fatalf("opening the pane logged %v", recs)
	}
}

// A section that exists is a row even when it has no children, and the tree
// model has to agree: a heading nobody can reach is a heading nobody can open.
func TestTheEmptySectionIsStillARow(t *testing.T) {
	m := pane(t)
	logged(t, m.Home())
	show(t, m)

	var found *tree.Node
	for _, r := range m.ov.Tree().Rows() {
		if strings.Contains(ansi.Strip(r.Node.Label), "nothing recorded yet") {
			found = r.Node
		}
	}
	if found == nil {
		t.Fatal("the empty spans section is not in the tree")
	}
	if found.HasChildren() {
		t.Fatal("the empty spans section claims children")
	}
	if found.Detail == "" {
		t.Fatal("the empty spans section does not say what would fill it")
	}
}
