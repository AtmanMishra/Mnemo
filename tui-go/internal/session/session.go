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
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/tree"
)

// Pi resolves its session directory from the environment and from its global
// settings before falling back to a default (pi's docs/settings.md §Sessions
// and docs/environment-variables.md):
//
//  1. PI_CODING_AGENT_SESSION_DIR
//  2. `sessionDir` in the global settings.json
//  3. <agentDir>/sessions, agentDir being PI_CODING_AGENT_DIR or ~/.pi/agent
//
// Only the third was implemented here, and the failure mode of guessing wrong
// is silent: a browser pointed at a directory pi never writes shows an empty
// list, which reads as "you have no sessions" rather than "look somewhere
// else".
const (
	envAgentDir   = "PI_CODING_AGENT_DIR"
	envSessionDir = "PI_CODING_AGENT_SESSION_DIR"
)

// AgentDir is pi's configuration directory: PI_CODING_AGENT_DIR when set,
// else <home>/.pi/agent.
func AgentDir(home string) string {
	if dir := strings.TrimSpace(os.Getenv(envAgentDir)); dir != "" {
		return expandTilde(dir, home)
	}
	return filepath.Join(home, ".pi", "agent")
}

// Root is the directory pi stores sessions in under `home`, resolved the way
// pi resolves it — see the constants above.
//
// Two layouts live under this answer and both are read here. pi's default
// directory is a PARENT: one subdirectory per project, named after the
// project's path. A directory configured explicitly is the session directory
// ITSELF, and pi fills it flat — SessionManager.create uses the configured
// path as-is and filters its listing by each session's own recorded cwd.
func Root(home string) string {
	if dir := strings.TrimSpace(os.Getenv(envSessionDir)); dir != "" {
		return expandTilde(dir, home)
	}
	agentDir := AgentDir(home)
	if dir := settingsSessionDir(agentDir); dir != "" {
		return expandTilde(dir, home)
	}
	return filepath.Join(agentDir, "sessions")
}

// SpawnDir is the --session-dir a spawned pi must be handed so it writes where
// this browser looks, or "" when it must be handed none.
//
// The empty answer is not a shrug: `--session-dir` names the session directory
// itself, so passing pi its own default back would stop it nesting new
// sessions under the project directory — and pi's own /resume lists one
// directory, without recursing, so the sessions already nested there would
// vanish from pi's picker. With nothing configured, this browser and pi
// already agree on the default; the flag exists for the case where they would
// not.
func SpawnDir(home string) string {
	root := Root(home)
	if root == filepath.Join(AgentDir(home), "sessions") {
		return ""
	}
	return root
}

// settingsSessionDir reads `sessionDir` from pi's global settings.json.
//
// The GLOBAL file, which sits in the agent directory: that is where pi looks
// for the setting that decides where sessions go, and it is what
// PI_CODING_AGENT_DIR moves. A missing file, unreadable JSON or a non-string
// value all read as "not configured" — pi runs with its default in every one
// of those cases, and a browser that refused to open would show nothing at
// all.
func settingsSessionDir(agentDir string) string {
	raw, err := os.ReadFile(filepath.Join(agentDir, "settings.json"))
	if err != nil {
		return ""
	}
	var settings struct {
		SessionDir string `json:"sessionDir"`
	}
	if json.Unmarshal(raw, &settings) != nil {
		return ""
	}
	return strings.TrimSpace(settings.SessionDir)
}

// expandTilde resolves the one path shorthand pi resolves: `~`, `~/…` and, on
// Windows, `~\…`. It expands against the home this package was handed, never
// os.UserHomeDir — the rule the rest of this file follows, and the reason a
// test can exercise it. A relative path is left alone, as pi leaves it.
func expandTilde(p, home string) string {
	switch {
	case p == "~":
		return home
	case strings.HasPrefix(p, "~/"):
		return filepath.Join(home, p[2:])
	case runtime.GOOS == "windows" && strings.HasPrefix(p, `~\`):
		return filepath.Join(home, p[2:])
	}
	return p
}

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
//
// Both layouts under Root are read. pi's default directory holds one
// subdirectory per project; a directory it was configured with is filled flat,
// with the session files sitting beside any subdirectories. Reading only the
// first layout is how a configured session directory shows up as empty.
func Projects(home string) []Project {
	root := Root(home)
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	var out []Project
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		ss := sessionsIn(filepath.Join(root, e.Name()))
		if len(ss) == 0 {
			continue
		}
		path := DecodeDir(e.Name())
		if ss[0].CWD != "" {
			path = ss[0].CWD
		}
		out = append(out, Project{Path: path, Dir: e.Name(), Sessions: ss})
	}
	// A flat session belongs to the project its own header names, so it joins
	// that project's row rather than opening a second one for the same
	// directory.
	for _, flat := range flatProjects(root, entries) {
		if i := indexOfPath(out, flat.Path); i >= 0 {
			out[i].Sessions = append(out[i].Sessions, flat.Sessions...)
			sortSessions(out[i].Sessions)
			continue
		}
		out = append(out, flat)
	}
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].Sessions[0].Started.After(out[j].Sessions[0].Started)
	})
	return out
}

// flatProjects groups the session files lying directly in the session
// directory by the cwd each one recorded.
//
// pi writes them there when a session directory is configured explicitly: the
// configured path IS the session directory, and pi tells the projects apart by
// reading each file's own header (SessionManager.create, and the cwd filter in
// its listing). The label falls back to the directory's name for a header with
// no cwd at all, because a row still has to say something.
func flatProjects(root string, entries []os.DirEntry) []Project {
	var out []Project
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		s, ok := Read(filepath.Join(root, e.Name()))
		if !ok {
			continue
		}
		i := indexOfPath(out, s.CWD)
		if i < 0 {
			out = append(out, Project{Path: s.CWD, Dir: filepath.Base(root)})
			i = len(out) - 1
		}
		out[i].Sessions = append(out[i].Sessions, s)
	}
	for i := range out {
		sortSessions(out[i].Sessions)
	}
	return out
}

// indexOfPath finds a project by its path, ignoring the empty path — two
// sessions whose headers name no cwd are not evidence of one project.
func indexOfPath(ps []Project, path string) int {
	if path == "" {
		return -1
	}
	for i := range ps {
		if ps[i].Path == path {
			return i
		}
	}
	return -1
}

// Sessions reads every session in one encoded project directory, newest first.
func Sessions(home, dir string) []Session { return sessionsIn(filepath.Join(Root(home), dir)) }

// sessionsIn reads every session file in one directory, newest first.
func sessionsIn(dir string) []Session {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []Session
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		if s, ok := Read(filepath.Join(dir, e.Name())); ok {
			out = append(out, s)
		}
	}
	sortSessions(out)
	return out
}

func sortSessions(ss []Session) {
	sort.SliceStable(ss, func(i, j int) bool { return ss[i].Started.After(ss[j].Started) })
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
