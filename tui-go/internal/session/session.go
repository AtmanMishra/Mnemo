// Package session reads what pi has already written to disk and turns it into
// a hierarchy: project → session → sub-agent runs.
//
// Every function takes `home` explicitly rather than calling os.UserHomeDir.
// A forgotten home parameter has caused real bugs here before: a test then
// reads — or writes — the developer's actual ~/.pi, and passes for the wrong
// reason.
package session

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/tree"
)

// Root is pi's session directory under a given home.
func Root(home string) string { return filepath.Join(home, ".pi", "agent", "sessions") }

// TraceDir is where Mnemo's own traces live; it is the only place a
// sub-agent's parent link is recorded.
func TraceDir(home string) string { return filepath.Join(home, ".mnemo", "logs") }

// Session is one stored conversation.
type Session struct {
	ID       string
	File     string
	CWD      string
	Started  time.Time
	Model    string
	Messages int
	Title    string
	Subs     []Sub
}

// Sub is one sub-agent run, as recorded in a trace.
type Sub struct {
	Session string
	Label   string
	Model   string
	OK      bool
}

// Project is one directory pi has sessions for.
type Project struct {
	Path     string
	Dir      string // pi's encoded directory name
	Sessions []Session
}

// Name is the last path component, which is what a human calls the project.
func (p Project) Name() string {
	if b := filepath.Base(p.Path); b != "" && b != "." && b != string(filepath.Separator) {
		return b
	}
	return p.Dir
}

// DecodeDir undoes pi's encoding of a working directory: separators become
// dashes. It is lossy — a directory with a dash in its name cannot be
// recovered — which is why a session's own header cwd is preferred wherever
// one can be read.
func DecodeDir(dir string) string {
	return "/" + strings.Trim(strings.ReplaceAll(strings.Trim(dir, "-"), "-", "/"), "/")
}

// Projects lists every project pi has sessions for, most recently active
// first.
func Projects(home string) []Project {
	entries, err := os.ReadDir(Root(home))
	if err != nil {
		return nil
	}
	var out []Project
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		ss := Sessions(home, e.Name())
		if len(ss) == 0 {
			continue
		}
		path := DecodeDir(e.Name())
		if ss[0].CWD != "" {
			path = ss[0].CWD
		}
		out = append(out, Project{Path: path, Dir: e.Name(), Sessions: ss})
	}
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].Sessions[0].Started.After(out[j].Sessions[0].Started)
	})
	return out
}

// Sessions reads every session in one encoded project directory, newest first.
func Sessions(home, dir string) []Session {
	entries, err := os.ReadDir(filepath.Join(Root(home), dir))
	if err != nil {
		return nil
	}
	var out []Session
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		if s, ok := Read(filepath.Join(Root(home), dir, e.Name())); ok {
			out = append(out, s)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Started.After(out[j].Started) })
	return out
}

// Read parses one session file.
//
// A partial or truncated file is normal — pi is often still writing — so
// every line is parsed defensively and a bad line is skipped rather than
// failing the file.
func Read(path string) (Session, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Session{}, false
	}
	s := Session{File: path}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var v map[string]any
		if json.Unmarshal([]byte(line), &v) != nil {
			continue
		}
		switch str(v, "type") {
		case "session":
			s.ID = str(v, "id")
			s.CWD = str(v, "cwd")
			s.Started = parseTime(str(v, "timestamp"))
		case "model_change":
			// The LAST model_change is the model the session ended on.
			s.Model = str(v, "modelId")
		case "message":
			s.Messages++
			if s.Title == "" {
				if t := firstUserText(v); t != "" {
					s.Title = t
				}
			}
		}
	}
	if s.ID == "" {
		return Session{}, false
	}
	if s.Title == "" {
		s.Title = "(no prompt yet)"
	}
	return s, true
}

// SubsByParent reads trace files and groups sub-agent runs by the session
// that spawned them. A missing or pruned log means no sub-agents shown, never
// an error: traces are the only place the parent link exists, and their
// absence is not a failure of the session.
func SubsByParent(home string) map[string][]Sub {
	out := map[string][]Sub{}
	entries, err := os.ReadDir(TraceDir(home))
	if err != nil {
		return out
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".jsonl") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for _, n := range names {
		data, err := os.ReadFile(filepath.Join(TraceDir(home), n))
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(data), "\n") {
			if strings.TrimSpace(line) == "" {
				continue
			}
			var v map[string]any
			if json.Unmarshal([]byte(line), &v) != nil || str(v, "kind") != "subagent" {
				continue
			}
			attrs, _ := v["attrs"].(map[string]any)
			parent := str(attrs, "parent_session")
			if parent == "" {
				continue
			}
			ok := true
			if b, is := v["ok"].(bool); is {
				ok = b
			}
			label := str(v, "name")
			if label == "" {
				label = "sub-agent"
			}
			out[parent] = append(out[parent], Sub{
				Session: str(v, "session"), Label: label,
				Model: str(attrs, "model"), OK: ok,
			})
		}
	}
	return out
}

// Load builds the whole hierarchy with sub-agents attached.
func Load(home string) []Project {
	ps := Projects(home)
	subs := SubsByParent(home)
	for i := range ps {
		for j := range ps[i].Sessions {
			ps[i].Sessions[j].Subs = subs[ps[i].Sessions[j].ID]
		}
	}
	return ps
}

// Nodes turns the hierarchy into a tree, with the project matching `cwd`
// expanded — you almost always want the one you are standing in.
//
// Every row says something. A session is named by its first user message,
// because a timestamp is not a name; a sub-agent row carries its own model,
// because "which model ran this" is the question you open it to answer.
func Nodes(projects []Project, cwd string) []*tree.Node {
	out := make([]*tree.Node, 0, len(projects))
	for _, p := range projects {
		pn := &tree.Node{
			ID: p.Dir, Label: p.Name(), Kind: tree.Dir,
			Detail:   plural(len(p.Sessions), "session"),
			Expanded: sameDir(p.Path, cwd),
		}
		for _, s := range p.Sessions {
			sn := &tree.Node{
				ID: s.File, Label: s.Title, Kind: tree.Session,
				Detail: strings.TrimSpace(ago(s.Started) + " · " + plural(s.Messages, "msg")),
			}
			for _, sub := range s.Subs {
				st := tree.OK
				if !sub.OK {
					st = tree.Failed
				}
				sn.Children = append(sn.Children, &tree.Node{
					ID: sub.Session, Label: sub.Label, Kind: tree.Agent,
					Detail: sub.Model, State: st,
				})
			}
			pn.Children = append(pn.Children, sn)
		}
		out = append(out, pn)
	}
	return out
}

func sameDir(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	return filepath.Clean(a) == filepath.Clean(b)
}

func plural(n int, unit string) string {
	s := itoa(n) + " " + unit
	if n != 1 {
		s += "s"
	}
	return s
}

// ago is a coarse relative time. Coarse on purpose: "3d" is what you need to
// pick a session, and a full timestamp in a narrow column pushes out the
// title, which is the part that actually identifies it.
func ago(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return "now"
	case d < time.Hour:
		return itoa(int(d.Minutes())) + "m"
	case d < 24*time.Hour:
		return itoa(int(d.Hours())) + "h"
	default:
		return itoa(int(d.Hours()/24)) + "d"
	}
}

func str(v map[string]any, k string) string {
	if v == nil {
		return ""
	}
	s, _ := v[k].(string)
	return s
}

// firstUserText pulls the first user message's text, flattened to one line
// and cut to something that fits a column.
func firstUserText(v map[string]any) string {
	msg, _ := v["message"].(map[string]any)
	if str(msg, "role") != "user" {
		return ""
	}
	content, _ := msg["content"].([]any)
	var parts []string
	for _, c := range content {
		cm, _ := c.(map[string]any)
		if str(cm, "type") == "text" {
			parts = append(parts, str(cm, "text"))
		}
	}
	one := strings.Join(strings.Fields(strings.Join(parts, " ")), " ")
	if one == "" {
		return ""
	}
	r := []rune(one)
	if len(r) > 70 {
		return string(r[:70])
	}
	return one
}

// parseTime accepts the ISO-8601 pi writes, and returns the zero time for
// anything else — an unparseable timestamp must not drop the session.
func parseTime(s string) time.Time {
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t
		}
	}
	return time.Time{}
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

// Entry is one message of a stored session, in the order it was written.
//
// It mirrors what the live backend emits, so a resumed transcript and a
// running one render through the same blocks. Anything less and resuming
// looks like reading a log rather than continuing a conversation.
type Entry struct {
	Role   string // "user" | "assistant" | "thinking" | "tool"
	Text   string
	ID     string // tool call id
	Name   string // tool name
	Detail string // tool arguments, or its result summary
	OK     *bool  // nil while a call has no recorded result
}

// Transcript replays a stored session file.
//
// pi writes a tool call and its result as two separate lines, so a result is
// matched back onto its call by id rather than appended. A resumed transcript
// has to read like the live one, not like a log.
func Transcript(path string, summarise func(any) string) []Entry {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var out []Entry
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var v map[string]any
		if json.Unmarshal([]byte(line), &v) != nil || str(v, "type") != "message" {
			continue
		}
		msg, _ := v["message"].(map[string]any)
		if msg == nil {
			continue
		}
		switch str(msg, "role") {
		case "user":
			if t := contentText(msg); t != "" {
				out = append(out, Entry{Role: "user", Text: t})
			}
		case "assistant":
			parts, _ := msg["content"].([]any)
			for _, p := range parts {
				pm, _ := p.(map[string]any)
				switch str(pm, "type") {
				case "text":
					if t := str(pm, "text"); t != "" {
						out = append(out, Entry{Role: "assistant", Text: t})
					}
				case "thinking":
					if t := str(pm, "thinking"); t != "" {
						out = append(out, Entry{Role: "thinking", Text: t})
					}
				case "toolCall":
					args := ""
					if summarise != nil {
						args = summarise(pm["arguments"])
					}
					out = append(out, Entry{
						Role: "tool", ID: str(pm, "id"), Name: str(pm, "name"), Detail: args,
					})
				}
			}
		case "toolResult":
			id := str(msg, "toolCallId")
			isErr, _ := msg["isError"].(bool)
			ok := !isErr
			matched := false
			for i := len(out) - 1; i >= 0; i-- {
				if out[i].Role == "tool" && out[i].ID == id {
					out[i].OK = &ok
					matched = true
					break
				}
			}
			if !matched {
				// A result with no matching call still has to be visible;
				// dropping it is how a failure disappears.
				out = append(out, Entry{Role: "tool", ID: id, Name: str(msg, "toolName"), OK: &ok})
			}
		}
	}
	return out
}

// contentText concatenates the text parts of a message's content array.
func contentText(msg map[string]any) string {
	parts, _ := msg["content"].([]any)
	var b []string
	for _, p := range parts {
		pm, _ := p.(map[string]any)
		if str(pm, "type") == "text" {
			b = append(b, str(pm, "text"))
		}
	}
	return strings.TrimSpace(strings.Join(b, ""))
}
