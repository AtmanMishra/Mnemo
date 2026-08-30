// Package trace reads Mnemo's span log and turns it into a hierarchy.
//
// The spans already form a tree — every one carries a parent_id — so the logs
// view is the call graph of a run rather than a flat scroll of lines. That is
// the difference between "what happened" and "what happened inside what".
package trace

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/tree"
)

// Dir is where the span log lives under a given home. Home is a parameter,
// never a lookup: a test that reads the real ~/.mnemo passes for the wrong
// reason.
func Dir(home string) string { return filepath.Join(home, ".mnemo", "logs") }

// Span is one recorded operation.
type Span struct {
	ID       string
	ParentID string
	Session  string
	Kind     string
	Name     string
	Start    int64
	Duration int64
	OK       bool
	Attrs    map[string]any
}

// Read parses every span log under home, oldest file first.
//
// A missing directory is no spans, never an error: traces are a convenience,
// and their absence must not look like a failure of the thing being traced.
func Read(home string) []Span {
	entries, err := os.ReadDir(Dir(home))
	if err != nil {
		return nil
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".jsonl") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)

	var out []Span
	for _, n := range names {
		data, err := os.ReadFile(filepath.Join(Dir(home), n))
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(data), "\n") {
			if strings.TrimSpace(line) == "" {
				continue
			}
			var v map[string]any
			if json.Unmarshal([]byte(line), &v) != nil {
				continue
			}
			s := Span{
				ID:      str(v, "id"),
				Session: str(v, "session"),
				Kind:    str(v, "kind"),
				Name:    str(v, "name"),
				Start:   i64(v, "start"),
				OK:      true,
			}
			if p, ok := v["parent_id"].(string); ok {
				s.ParentID = p
			}
			s.Duration = i64(v, "duration_ms")
			if b, ok := v["ok"].(bool); ok {
				s.OK = b
			}
			s.Attrs, _ = v["attrs"].(map[string]any)
			if s.ID == "" {
				continue
			}
			out = append(out, s)
		}
	}
	return out
}

// Nodes builds the span tree, newest session first.
//
// A span whose parent is missing — the log was truncated, or rotated between
// the parent and the child — is hung at the top rather than dropped. Losing a
// failure because its parent was pruned is exactly the wrong trade.
func Nodes(spans []Span) []*tree.Node {
	byID := make(map[string]*tree.Node, len(spans))
	order := make([]Span, len(spans))
	copy(order, spans)
	sort.SliceStable(order, func(i, j int) bool { return order[i].Start < order[j].Start })

	for i := range order {
		s := order[i]
		byID[s.ID] = &tree.Node{
			ID:     s.ID,
			Label:  label(s),
			Detail: detail(s),
			Kind:   kindOf(s),
			State:  stateOf(s),
		}
	}

	type root struct {
		node  *tree.Node
		start int64
	}
	var roots []root
	var orphans []*tree.Node
	for _, s := range order {
		n := byID[s.ID]
		switch {
		case s.ParentID == "":
			roots = append(roots, root{n, s.Start})
		default:
			if p, ok := byID[s.ParentID]; ok {
				p.Children = append(p.Children, n)
				continue
			}
			// The log was truncated or rotated between the parent and the
			// child. Dropping the child loses failures; hanging it at the top
			// makes it look like a session it is not. So: say what it is.
			orphans = append(orphans, n)
		}
	}
	if len(orphans) > 0 {
		roots = append(roots, root{&tree.Node{
			ID:       "orphans",
			Label:    "unlinked",
			Detail:   plural(len(orphans), "span"),
			Kind:     tree.Plain,
			Children: orphans,
		}, -1})
	}

	// Newest first: the run you just made is the one you came here to read.
	sort.SliceStable(roots, func(i, j int) bool { return roots[i].start > roots[j].start })
	out := make([]*tree.Node, 0, len(roots))
	for _, r0 := range roots {
		r := r0.node
		out = append(out, r)
		// A failure must be visible without hunting for it, so any branch
		// containing one opens itself. Everything else stays closed: forty
		// open sessions is the flat scroll this view exists to replace.
		if !openFailures(r) && len(r.Children) > 0 {
			r.Expanded = false
		}
	}
	return out
}

// openFailures expands every ancestor of a failed span, and reports whether
// this subtree contains one.
func openFailures(n *tree.Node) bool {
	bad := n.State == tree.Failed
	for _, c := range n.Children {
		if openFailures(c) {
			bad = true
		}
	}
	if bad && len(n.Children) > 0 {
		n.Expanded = true
	}
	return bad
}

func plural(n int, unit string) string {
	s := itoa(n) + " " + unit
	if n != 1 {
		s += "s"
	}
	return s
}

func label(s Span) string {
	switch s.Kind {
	case "session":
		// Two dozen rows all reading "session" identify nothing. The
		// directory says which project, the clock says which run.
		when := s.Started().Format("15:04")
		if cwd := attr(s, "cwd"); cwd != "" {
			return when + "  " + filepath.Base(cwd)
		}
		return when + "  session"
	case "llm":
		if m := attr(s, "model"); m != "" {
			return m
		}
	case "subagent":
		return "sub-agent · " + s.Name
	}
	if s.Name != "" {
		return s.Name
	}
	return s.Kind
}

// detail is what the row is worth reading for: how long, and what it cost.
func detail(s Span) string {
	var parts []string
	if s.Duration > 0 {
		parts = append(parts, dur(s.Duration))
	}
	if in, out := num(s, "tokens_in"), num(s, "tokens_out"); in+out > 0 {
		parts = append(parts, itoa(in+out)+" tok")
	}
	if r := attr(s, "stop_reason"); r != "" && r != "stop" {
		parts = append(parts, r)
	}
	return strings.Join(parts, " · ")
}

func dur(ms int64) string {
	switch {
	case ms < 1000:
		return itoa(int(ms)) + "ms"
	case ms < 60000:
		return itoa(int(ms/1000)) + "." + itoa(int((ms%1000)/100)) + "s"
	default:
		return itoa(int(ms/60000)) + "m" + itoa(int((ms%60000)/1000)) + "s"
	}
}

func kindOf(s Span) tree.Kind {
	switch s.Kind {
	case "session":
		return tree.Session
	case "subagent":
		return tree.Agent
	case "llm":
		return tree.Turn
	}
	return tree.Plain
}

func stateOf(s Span) tree.State {
	if !s.OK {
		return tree.Failed
	}
	// A span with no end recorded is still running — or the process died
	// mid-flight, which is worth seeing rather than rendering as success.
	if s.Duration == 0 {
		return tree.Running
	}
	return tree.OK
}

// Started is when a span began, for callers that want a wall-clock label.
func (s Span) Started() time.Time { return time.UnixMilli(s.Start) }

func attr(s Span, k string) string {
	if s.Attrs == nil {
		return ""
	}
	v, _ := s.Attrs[k].(string)
	return v
}

func num(s Span, k string) int {
	if s.Attrs == nil {
		return 0
	}
	f, _ := s.Attrs[k].(float64)
	return int(f)
}

func str(v map[string]any, k string) string {
	s, _ := v[k].(string)
	return s
}

func i64(v map[string]any, k string) int64 {
	f, _ := v[k].(float64)
	return int64(f)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}
