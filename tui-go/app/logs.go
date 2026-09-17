package app

import (
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/logging"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/overlay"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/theme"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/trace"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/tree"
)

// logs.go owns the ^l pane: the span tree and the interface's own log, on one
// screen, in two sections that say which is which.
//
// They are different shapes of data. A span carries a parent_id, so a run IS a
// tree, and the pane draws it as one because the question it answers — which
// call was inside which — cannot be asked of a list. A log line is a line: an
// event with a level and some fields, no parent, no duration. Rendering the two
// as one undifferentiated scroll would be a pane that lies about both, which is
// why the sections are labelled and why neither borrows the other's colouring.
//
// The pane reads; it never writes. Nothing here logs its own opening, because a
// pane that appends to the file it is showing is a pane that changes what it
// displays by being opened.

const (
	// spansSection and logSection are the two headings, and the words the
	// empty states use to say which of the two is empty.
	spansSection = "spans"
	logSection   = "log"

	// logPaneLines bounds how much of the log the pane reads. The records are
	// a run's worth of events, not a stream: at a few lines per run this is
	// many sessions of history, and the tail is what a reader wants.
	logPaneLines = 200
)

// logsPane builds the ^l overlay: the two sections, or nothing at all when
// there is nothing in either of them.
//
// Home is the app's own — the same parameter every other reader takes — so the
// pane shows the spans and the log of the run this interface is in, and a test
// pointing Home at a temporary directory can never accidentally read the real
// ~/.mnemo.
func (m *Model) logsPane() *overlay.Model {
	spans := trace.Nodes(trace.Read(m.cfg.Home))
	records := logging.Tail(m.cfg.Home, logPaneLines)
	return overlay.NewTree(overlay.Logs, logsPurpose(), logsSections(m.th, spans, records), logsEmpty()...)
}

// logsPurpose is the pane's one line of purpose. It has to say that two
// different things are in here, or the headings read as a list that lost its
// sort order.
func logsPurpose() string {
	return "every run as a call graph, and the interface's own log beside it"
}

// logsSections is the pane's content.
//
// Both empty is no nodes at all, deliberately: the overlay's own empty state
// says more than two empty headings can, and it is one place to explain what
// makes each of the two appear. One empty is a heading with no children, and
// that row says which of the two it is.
func logsSections(t *theme.Theme, spans []*tree.Node, records []logging.Record) []*tree.Node {
	if len(spans) == 0 && len(records) == 0 {
		return nil
	}
	return []*tree.Node{spansSectionNode(t, spans), logSectionNode(t, records)}
}

// spansSectionNode is the span tree under a heading, unchanged.
//
// Its children are trace.Nodes' own roots, so the failure branches still open
// themselves and everything else still starts closed — the pane does not
// second-guess a tree it did not build.
func spansSectionNode(t *theme.Theme, spans []*tree.Node) *tree.Node {
	if len(spans) == 0 {
		// A leaf, and it says so: the reader must be able to tell "no run
		// recorded a span" from "this pane has nothing in it".
		return &tree.Node{
			ID:     "section:" + spansSection,
			Label:  sectionHeading(t, spansSection, " · nothing recorded yet"),
			Detail: "each run writes one",
			Kind:   tree.Plain,
		}
	}
	return &tree.Node{
		ID:       "section:" + spansSection,
		Label:    sectionHeading(t, spansSection, " · the call graph of each run"),
		Detail:   plural(len(spans), "run"),
		Kind:     tree.Plain,
		Children: spans,
		Expanded: true,
	}
}

// logSectionNode is the interface's own log under a heading.
func logSectionNode(t *theme.Theme, records []logging.Record) *tree.Node {
	if len(records) == 0 {
		// No lines is either "nothing has happened yet" or a level that
		// filters, and the second is worth naming: it is the one a reader can
		// act on.
		return &tree.Node{
			ID:     "section:" + logSection,
			Label:  sectionHeading(t, logSection, " · no lines yet"),
			Detail: "level off, or nothing yet",
			Kind:   tree.Plain,
		}
	}
	return &tree.Node{
		ID:       "section:" + logSection,
		Label:    sectionHeading(t, logSection, " · what the interface said"),
		Detail:   plural(len(records), "line"),
		Kind:     tree.Plain,
		Children: logLineNodes(t, records),
		Expanded: true,
	}
}

// logLineNodes are the records as rows, newest first — the line you just
// caused is the one you came here to read, which is the same reason the span
// tree is sorted newest run first.
func logLineNodes(t *theme.Theme, records []logging.Record) []*tree.Node {
	out := make([]*tree.Node, 0, len(records))
	for i := len(records) - 1; i >= 0; i-- {
		r := records[i]
		out = append(out, &tree.Node{
			ID:     "log:" + itoa(i),
			Label:  logLineLabel(t, r),
			Detail: r.Time.Format("15:04:05"),
			// No Kind and no State: those name what a SPAN is — a session, a
			// turn, a sub-agent — and whether it worked. A log line is none of
			// those things, and dressing one as a turn to borrow its colour is
			// how a pane starts implying a parentage that is not there.
			Kind: tree.Plain,
		})
	}
	return out
}

// logLineLabel is one record: its level, what was said, then its fields.
//
// The colour comes from the theme and from nowhere else — the palette's
// failure red for a failure, its warning ochre for a warning, the faint ink
// for the chatter you only see when you turn the level up, the muted ink for a
// plain record. Each segment states its own style, because the tree renders a
// row's label as a whole: a styled segment that ends without the next one
// saying what it wants leaves the rest of the line in the terminal's own
// colour, which is how half a row ends up in somebody else's theme.
func logLineLabel(t *theme.Theme, r logging.Record) string {
	level := t.Muted
	switch r.Level {
	case logging.Error, logging.Fatal:
		level = t.Fail
	case logging.Warn:
		level = t.Warn
	case logging.Debug:
		level = t.Faint
	}
	line := level.Render(r.Level.String()) + " " + t.Ink.Render(r.Msg)
	if text := r.Text(); text != "" {
		line += t.Faint.Render("  " + text)
	}
	return line
}

// sectionHeading is a section's label: the theme's heading style for the
// heading itself, then a faint tail that says which section this is. Every
// segment says its own style, for the reason above.
func sectionHeading(t *theme.Theme, head, tail string) string {
	return t.Label.Render(head) + t.Faint.Render(tail)
}

// logsEmpty is the both-empty state: nothing traced AND nothing logged. It
// names both, because "nothing here yet" answers neither question a reader
// arrives with, and both answers are actionable — one is an agent that has not
// run, the other is a level that filters.
func logsEmpty() []string {
	return []string{
		"Two different records land here, and neither exists yet.",
		"Spans: a run writes one per operation — the session, each model round",
		"trip, any sub-agent — under ~/.mnemo/logs; they are a tree.",
		"Log: the interface writes a line per spawn, question, answer and",
		"permission decision, at MNEMO_LOG_LEVEL (off silences it).",
	}
}
