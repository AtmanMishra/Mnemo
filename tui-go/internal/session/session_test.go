package session

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/tree"
)

// home builds a fake ~ under the test's own temp dir. Nothing in this file
// may read the real home directory: a test that does passes for the wrong
// reason and, one day, writes there.
func home(t *testing.T) string {
	t.Helper()
	return t.TempDir()
}

func write(t *testing.T, home, dir, name string, lines ...string) string {
	t.Helper()
	d := filepath.Join(Root(home), dir)
	if err := os.MkdirAll(d, 0o755); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(d, name)
	if err := os.WriteFile(p, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func header(id, cwd, ts string) string {
	return `{"type":"session","id":"` + id + `","cwd":"` + cwd + `","timestamp":"` + ts + `"}`
}

func userMsg(text string) string {
	return `{"type":"message","message":{"role":"user","content":[{"type":"text","text":"` + text + `"}]}}`
}

func TestASessionIsNamedByItsFirstUserMessage(t *testing.T) {
	h := home(t)
	p := write(t, h, "-tmp-proj", "a.jsonl",
		header("s1", "/tmp/proj", "2026-08-20T10:00:00Z"),
		userMsg("make the resume flow real"),
		`{"type":"model_change","modelId":"deepseek-v4-flash"}`,
		userMsg("and fix the overflow"),
	)
	s, ok := Read(p)
	if !ok {
		t.Fatal("session did not parse")
	}
	if s.Title != "make the resume flow real" {
		t.Fatalf("title = %q; a timestamp is not a name, the first message is", s.Title)
	}
	if s.Model != "deepseek-v4-flash" {
		t.Fatalf("model = %q", s.Model)
	}
	if s.Messages != 2 {
		t.Fatalf("messages = %d", s.Messages)
	}
}

func TestTheLastModelChangeWins(t *testing.T) {
	h := home(t)
	p := write(t, h, "-tmp-p", "a.jsonl",
		header("s", "/tmp/p", "2026-08-20T10:00:00Z"),
		`{"type":"model_change","modelId":"first"}`,
		`{"type":"model_change","modelId":"last"}`,
	)
	s, _ := Read(p)
	if s.Model != "last" {
		t.Fatalf("model = %q; the session ended on the last one", s.Model)
	}
}

func TestATruncatedFileStillParses(t *testing.T) {
	// pi is often mid-write. A half-line must skip, not fail the file.
	h := home(t)
	p := write(t, h, "-tmp-p", "a.jsonl",
		header("s", "/tmp/p", "2026-08-20T10:00:00Z"),
		userMsg("hello"),
		`{"type":"message","message":{"role":"user","cont`,
	)
	s, ok := Read(p)
	if !ok || s.Title != "hello" {
		t.Fatalf("ok=%v title=%q", ok, s.Title)
	}
}

func TestASessionWithNoHeaderIsNotASession(t *testing.T) {
	h := home(t)
	p := write(t, h, "-tmp-p", "a.jsonl", userMsg("orphan"))
	if _, ok := Read(p); ok {
		t.Fatal("a file with no session header has no id and cannot be resumed")
	}
}

func TestAnEmptyOrMissingRootIsNoProjects(t *testing.T) {
	if got := Projects(home(t)); len(got) != 0 {
		t.Fatalf("got %d projects from an empty home", len(got))
	}
	if got := Projects(filepath.Join(home(t), "nope")); got != nil {
		t.Fatal("a missing session root is no projects, not an error")
	}
}

func TestProjectsPreferTheHeaderCwdOverTheEncodedDirectoryName(t *testing.T) {
	// Decoding is lossy: a dash in a directory name cannot be recovered.
	h := home(t)
	write(t, h, "-Users-me-my-project", "a.jsonl",
		header("s", "/Users/me/my-project", "2026-08-20T10:00:00Z"), userMsg("x"))
	ps := Projects(h)
	if len(ps) != 1 {
		t.Fatalf("got %d projects", len(ps))
	}
	if ps[0].Path != "/Users/me/my-project" {
		t.Fatalf("path = %q; the header's own cwd is authoritative", ps[0].Path)
	}
	if ps[0].Name() != "my-project" {
		t.Fatalf("name = %q", ps[0].Name())
	}
}

func TestProjectsAreNewestFirstAndSessionsWithin(t *testing.T) {
	h := home(t)
	write(t, h, "-a", "old.jsonl", header("s1", "/a", "2026-01-01T00:00:00Z"), userMsg("old one"))
	write(t, h, "-b", "new.jsonl", header("s2", "/b", "2026-08-01T00:00:00Z"), userMsg("new one"))
	write(t, h, "-b", "newer.jsonl", header("s3", "/b", "2026-08-20T00:00:00Z"), userMsg("newest"))
	ps := Projects(h)
	if len(ps) != 2 || ps[0].Path != "/b" {
		t.Fatalf("projects = %+v; most recently active first", ps)
	}
	if ps[0].Sessions[0].Title != "newest" {
		t.Fatalf("sessions = %+v", ps[0].Sessions)
	}
}

func TestSubAgentsAttachToTheSessionThatSpawnedThem(t *testing.T) {
	h := home(t)
	write(t, h, "-p", "a.jsonl", header("parent-1", "/p", "2026-08-20T10:00:00Z"), userMsg("go"))
	logs := TraceDir(h)
	if err := os.MkdirAll(logs, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(logs, "t.jsonl"), []byte(strings.Join([]string{
		`{"kind":"subagent","name":"probe-rpc","session":"kid-1","ok":true,"attrs":{"parent_session":"parent-1","model":"haiku"}}`,
		`{"kind":"subagent","name":"read-jsonl","session":"kid-2","ok":false,"attrs":{"parent_session":"parent-1"}}`,
		`{"kind":"subagent","name":"orphan","session":"kid-3","ok":true,"attrs":{}}`,
		`{"kind":"span","name":"not-a-subagent"}`,
	}, "\n")), 0o644); err != nil {
		t.Fatal(err)
	}
	ps := Load(h)
	subs := ps[0].Sessions[0].Subs
	if len(subs) != 2 {
		t.Fatalf("got %d sub-agents, want 2 (the parentless one has nowhere to hang)", len(subs))
	}
	if subs[0].Model != "haiku" {
		t.Fatalf("a sub-agent row must carry its own model: %+v", subs[0])
	}
	if subs[1].OK {
		t.Fatal("a failed run must report as failed")
	}
}

func TestMissingTracesAreNotAnError(t *testing.T) {
	h := home(t)
	write(t, h, "-p", "a.jsonl", header("s", "/p", "2026-08-20T10:00:00Z"), userMsg("x"))
	ps := Load(h)
	if len(ps) != 1 || len(ps[0].Sessions[0].Subs) != 0 {
		t.Fatal("no trace log means no sub-agents shown, never a failure")
	}
}

func TestNodesBuildProjectSessionAgentHierarchy(t *testing.T) {
	h := home(t)
	write(t, h, "-p", "a.jsonl", header("parent", "/p", "2026-08-20T10:00:00Z"), userMsg("the task"))
	logs := TraceDir(h)
	_ = os.MkdirAll(logs, 0o755)
	_ = os.WriteFile(filepath.Join(logs, "t.jsonl"),
		[]byte(`{"kind":"subagent","name":"kid","session":"k","ok":true,"attrs":{"parent_session":"parent"}}`+"\n"), 0o644)

	nodes := Nodes(Load(h), "/p")
	m := tree.New(nodes...)
	m.ExpandAll()
	var got []string
	for _, r := range m.Rows() {
		got = append(got, strings.Repeat(" ", r.Depth)+r.Node.Label)
	}
	want := []string{"p", " the task", "  kid"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("hierarchy = %v, want %v", got, want)
	}
}

func TestTheProjectYouAreStandingInOpensItself(t *testing.T) {
	h := home(t)
	write(t, h, "-a", "a.jsonl", header("s1", "/a", "2026-08-20T10:00:00Z"), userMsg("one"))
	write(t, h, "-b", "b.jsonl", header("s2", "/b", "2026-08-21T10:00:00Z"), userMsg("two"))
	nodes := Nodes(Load(h), "/a")
	for _, n := range nodes {
		if n.Label == "a" && !n.Expanded {
			t.Fatal("the project you are in must open itself; that is one fewer press every time")
		}
		if n.Label == "b" && n.Expanded {
			t.Fatal("other projects must stay closed or the list is unreadable")
		}
	}
}

func TestEveryRowSaysSomething(t *testing.T) {
	// The Sessions pane failed before by listing rows that carried no
	// information. Every node must have a label, and every session a detail.
	h := home(t)
	write(t, h, "-p", "a.jsonl", header("s", "/p", time.Now().Add(-3*time.Hour).Format(time.RFC3339)), userMsg("do the thing"))
	m := tree.New(Nodes(Load(h), "/p")...)
	m.ExpandAll()
	for _, r := range m.Rows() {
		if strings.TrimSpace(r.Node.Label) == "" {
			t.Fatalf("a row with no label: %+v", r.Node)
		}
		if r.Node.Kind == tree.Session && !strings.Contains(r.Node.Detail, "3h") {
			t.Fatalf("session detail = %q, want a relative age", r.Node.Detail)
		}
	}
}

func TestDecodeDirIsLossyButNeverPanics(t *testing.T) {
	for _, in := range []string{"", "-", "--", "-a-b-c", "a"} {
		_ = DecodeDir(in)
	}
	if got := DecodeDir("-Users-me-repo"); got != "/Users/me/repo" {
		t.Fatalf("DecodeDir = %q", got)
	}
}

func TestAgoIsCoarse(t *testing.T) {
	now := time.Now()
	for in, want := range map[time.Duration]string{
		30 * time.Second: "now", 5 * time.Minute: "5m",
		3 * time.Hour: "3h", 50 * time.Hour: "2d",
	} {
		if got := ago(now.Add(-in)); got != want {
			t.Fatalf("ago(%v) = %q, want %q", in, got, want)
		}
	}
	if ago(time.Time{}) != "" {
		t.Fatal("an unparseable timestamp shows nothing rather than 1970")
	}
}

func TestTranscriptReplaysAConversationNotALog(t *testing.T) {
	h := home(t)
	p := write(t, h, "-p", "a.jsonl",
		header("s", "/p", "2026-08-20T10:00:00Z"),
		userMsg("read the file"),
		`{"type":"message","message":{"role":"assistant","content":[`+
			`{"type":"thinking","thinking":"where is it"},`+
			`{"type":"text","text":"looking now"},`+
			`{"type":"toolCall","id":"t1","name":"read","arguments":{"path":"main.go"}}]}}`,
		`{"type":"message","message":{"role":"toolResult","toolCallId":"t1","isError":false}}`,
		`{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}`,
	)
	got := Transcript(p, nil)
	want := []string{"user", "thinking", "assistant", "tool", "assistant"}
	if len(got) != len(want) {
		t.Fatalf("got %d entries: %#v", len(got), got)
	}
	for i, r := range want {
		if got[i].Role != r {
			t.Fatalf("entry %d is %q, want %q", i, got[i].Role, r)
		}
	}
	if got[3].OK == nil || !*got[3].OK {
		t.Fatal("the result must land on its own call, matched by id")
	}
}

func TestAToolCallWithNoRecordedResultIsNotClaimedToHaveWorked(t *testing.T) {
	// The session file ends mid-call. Saying "ok" would be inventing one.
	h := home(t)
	p := write(t, h, "-p", "a.jsonl",
		header("s", "/p", "2026-08-20T10:00:00Z"),
		`{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"t1","name":"bash"}]}}`,
	)
	got := Transcript(p, nil)
	if len(got) != 1 || got[0].OK != nil {
		t.Fatalf("got %#v", got)
	}
}

func TestAResultWithNoCallIsStillVisible(t *testing.T) {
	h := home(t)
	p := write(t, h, "-p", "a.jsonl",
		header("s", "/p", "2026-08-20T10:00:00Z"),
		`{"type":"message","message":{"role":"toolResult","toolCallId":"ghost","toolName":"bash","isError":true}}`,
	)
	got := Transcript(p, nil)
	if len(got) != 1 || got[0].Name != "bash" || got[0].OK == nil || *got[0].OK {
		t.Fatalf("dropping an orphan result is how a failure disappears: %#v", got)
	}
}

func TestTranscriptOfAMissingFileIsEmptyNotAPanic(t *testing.T) {
	if got := Transcript(filepath.Join(t.TempDir(), "nope.jsonl"), nil); got != nil {
		t.Fatalf("got %#v", got)
	}
}

// --- where pi keeps its sessions (#19) ------------------------------------

// writeFlat puts a session directly in dir, the layout pi uses when a session
// directory is configured explicitly: the configured path IS the session
// directory, and the project a session belongs to is the cwd in its own header.
func writeFlat(t *testing.T, dir, name, id, cwd string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, name)
	body := header(id, cwd, "2026-08-20T10:00:00Z") + "\n" + userMsg("flat one") + "\n"
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// writeSettings writes pi's global settings.json under an agent directory.
func writeSettings(t *testing.T, agentDir, sessionDir string) {
	t.Helper()
	if err := os.MkdirAll(agentDir, 0o755); err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(map[string]string{"sessionDir": sessionDir})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(agentDir, "settings.json"), body, 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestTheSessionDirectoryComesFromTheEnvironmentFirst: pi documents
// PI_CODING_AGENT_SESSION_DIR as the first word on where sessions live. A
// browser that ignores it shows an empty list — which reads as "you have no
// sessions" rather than "we looked in the wrong place".
func TestTheSessionDirectoryComesFromTheEnvironmentFirst(t *testing.T) {
	h := home(t)
	over := t.TempDir()
	writeFlat(t, over, "a.jsonl", "env-1", "/tmp/from-env")
	// And a perfectly good session where the hardcoded default used to be, to
	// prove the environment is what decided.
	write(t, h, "-tmp-default", "b.jsonl", header("def-1", "/tmp/default", "2026-08-20T10:00:00Z"), userMsg("default"))

	t.Setenv(envSessionDir, over)

	if got := Root(h); got != over {
		t.Fatalf("Root = %q, want the configured %q", got, over)
	}
	ps := Projects(h)
	if len(ps) != 1 {
		t.Fatalf("got %d projects; the default directory must not be read when one is configured", len(ps))
	}
	if ps[0].Path != "/tmp/from-env" {
		t.Fatalf("path = %q; a flat session's project is the cwd in its own header", ps[0].Path)
	}
	if got := ps[0].Sessions[0].Title; got != "flat one" {
		t.Fatalf("title = %q", got)
	}
}

// TestTheSessionDirectoryCanComeFromPisSettingsFile: the second source, in
// pi's GLOBAL settings.json — and the file is found through
// PI_CODING_AGENT_DIR, which is what moves pi's whole agent directory.
func TestTheSessionDirectoryCanComeFromPisSettingsFile(t *testing.T) {
	h := home(t)
	agentDir := filepath.Join(h, "custom-agent-dir")
	over := t.TempDir()
	writeFlat(t, over, "a.jsonl", "set-1", "/tmp/from-settings")
	writeSettings(t, agentDir, over)

	t.Setenv(envAgentDir, agentDir)

	if got := Root(h); got != over {
		t.Fatalf("Root = %q, want %q from settings.json", got, over)
	}
	if ps := Projects(h); len(ps) != 1 || ps[0].Sessions[0].ID != "set-1" {
		t.Fatalf("the browser must read the directory the setting names: %+v", ps)
	}
}

// TestAgentDirMovesTheDefaultToo: with no sessionDir anywhere, the agent
// directory is still the one PI_CODING_AGENT_DIR names — the default is
// relative to it, not to the home.
func TestAgentDirMovesTheDefaultToo(t *testing.T) {
	h := home(t)
	agentDir := filepath.Join(h, "elsewhere", "agent")
	t.Setenv(envAgentDir, agentDir)

	if got, want := Root(h), filepath.Join(agentDir, "sessions"); got != want {
		t.Fatalf("Root = %q, want %q", got, want)
	}
}

// TestPrecedenceIsPisPrecedence: environment, then settings.json, then the
// default — the order pi documents, in the order it checks them.
func TestPrecedenceIsPisPrecedence(t *testing.T) {
	h := home(t)
	agentDir := filepath.Join(h, ".pi", "agent")
	fromSettings := filepath.Join(h, "from-settings")
	fromEnv := filepath.Join(h, "from-env")
	writeSettings(t, agentDir, fromSettings)

	if got := Root(h); got != fromSettings {
		t.Fatalf("with only a setting, Root = %q, want %q", got, fromSettings)
	}
	t.Setenv(envSessionDir, fromEnv)
	if got := Root(h); got != fromEnv {
		t.Fatalf("the environment must beat settings.json: Root = %q", got)
	}
}

// TestASessionDirWithATildeIsResolved: pi expands `~`, and it expands against
// the home this package was handed — not os.UserHomeDir, which in a test is
// somebody's real home.
func TestASessionDirWithATildeIsResolved(t *testing.T) {
	h := home(t)
	t.Setenv(envSessionDir, "~/pi-sessions")

	if got, want := Root(h), filepath.Join(h, "pi-sessions"); got != want {
		t.Fatalf("Root = %q, want %q", got, want)
	}
}

// TestSpawnDirSpeaksOnlyWhenPisDefaultIsNotTheAnswer: the spawned agent has to
// write where this browser looks, and `--session-dir` is how it is told.
//
// Except when the answer IS pi's default, where being told would change it:
// --session-dir names the session directory itself, so passing the default
// path back would stop pi nesting sessions under the project directory.
func TestSpawnDirSpeaksOnlyWhenPisDefaultIsNotTheAnswer(t *testing.T) {
	h := home(t)
	if got := SpawnDir(h); got != "" {
		t.Fatalf("SpawnDir = %q with nothing configured; pi's own default is already the answer", got)
	}

	over := t.TempDir()
	t.Setenv(envSessionDir, over)
	if got := SpawnDir(h); got != over {
		t.Fatalf("SpawnDir = %q, want the configured %q — otherwise the agent writes where we do not look", got, over)
	}
}
