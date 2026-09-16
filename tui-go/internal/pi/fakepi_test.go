package pi

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/agent"
)

// The fixture in this file re-executes THIS test binary as a stand-in pi.
//
// The older fixtures in pi_test.go are `#!/bin/sh` scripts written into a temp
// directory, which run only where there is a POSIX shell. What is under test
// here is a protocol — one JSON line in, one JSON line out — and nothing about
// that needs a shell.
const (
	envFakePi     = "MNEMO_TEST_FAKE_PI"
	envFakeLine   = "MNEMO_TEST_FAKE_PI_RECEIVED" // where the fake records what it was sent
	envFakeMute   = "MNEMO_TEST_FAKE_PI_MUTE"     // set: read requests, never answer them
	envFakeUI     = "MNEMO_TEST_FAKE_PI_UI"       // a line the fake emits at startup, e.g. a dialog
	envFakeStderr = "MNEMO_TEST_FAKE_PI_STDERR"   // a line the fake writes to stderr and exits with
)

// TestMain is also the stand-in agent's entry point: when the environment says
// so, this process is a fake pi and never the test runner.
func TestMain(m *testing.M) {
	if os.Getenv(envFakePi) == "1" {
		os.Exit(fakePiMain())
	}
	os.Exit(m.Run())
}

// fakePiMain records every request line and answers the four questions that
// carry data back — get_commands, get_fork_messages, fork and compact — in the
// shapes pi's docs print. It answers nothing else: a prompt arriving here is
// recorded and ignored, because what a client sends is the client's business.
func fakePiMain() int {
	capture := os.Getenv(envFakeLine)
	mute := os.Getenv(envFakeMute) == "1"
	// A backend that dies at startup: the reason goes to stderr and the exit
	// code is non-zero, which is what pi does when an extension will not load.
	// Nothing is said on stdout — there is no protocol left to say it on.
	if fail := os.Getenv(envFakeStderr); fail != "" {
		fmt.Fprintln(os.Stderr, fail)
		return 1
	}
	// One line said before anything is read: how a question from an extension
	// arrives without a real pi. Printed first, so it is the first thing the
	// client sees.
	if ui := os.Getenv(envFakeUI); ui != "" {
		fmt.Println(ui)
	}
	in := bufio.NewScanner(os.Stdin)
	for in.Scan() {
		line := strings.TrimSpace(in.Text())
		if line == "" {
			continue
		}
		if capture != "" {
			if f, err := os.OpenFile(capture, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
				_, _ = f.WriteString(line + "\n")
				_ = f.Close()
			}
		}
		if mute {
			continue
		}
		var v map[string]any
		if json.Unmarshal([]byte(line), &v) != nil {
			continue
		}
		switch v["type"] {
		case "get_commands":
			fmt.Println(`{"id":1,"type":"response","command":"get_commands","success":true,"data":{"commands":[` +
				// The extension is spelled the way the installed pi spells
				// it (sourceInfo, not flat location/path); the other two the
				// way the docs do. Both shapes have to arrive intact.
				`{"name":"hook","description":"list and fire hooks","source":"extension","sourceInfo":{"path":"<inline:sea-hooks>","source":"inline","scope":"temporary"}},` +
				`{"name":"implement","description":"implement a plan","source":"prompt","location":"project","path":"/p/.pi/agent/prompts/implement.md"},` +
				`{"name":"skill:pdf-reader","description":"read pdfs","source":"skill","location":"user","path":"/u/.pi/agent/skills/pdf-reader/SKILL.md"}]}}`)
		case "get_fork_messages":
			// The docs' own example, twice over: entry ids in pi's order,
			// oldest first, which is what a fork at "the last one" needs.
			fmt.Println(`{"id":1,"type":"response","command":"get_fork_messages","success":true,"data":{"messages":[` +
				`{"entryId":"abc123","text":"First prompt..."},` +
				`{"entryId":"def456","text":"Second prompt..."}]}}`)
		case "fork":
			fmt.Println(`{"id":1,"type":"response","command":"fork","success":true,"data":{"text":"Second prompt...","cancelled":false}}`)
		case "compact":
			fmt.Println(`{"id":1,"type":"response","command":"compact","success":true,"data":{"summary":"Summary of conversation...","firstKeptEntryId":"abc123","tokensBefore":150000,"estimatedTokensAfter":32000}}`)
		}
	}
	return 0
}

// liveFake starts a session against the stand-in agent and returns it with the
// file every request line lands in. mute leaves the requests unanswered.
func liveFake(t *testing.T, mute bool) (*Session, string) {
	t.Helper()
	capture := filepath.Join(t.TempDir(), "received.jsonl")
	t.Setenv(envFakePi, "1")
	t.Setenv(envFakeLine, capture)
	if mute {
		t.Setenv(envFakeMute, "1")
	}
	s, err := Start(exec.Command(os.Args[0]))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s, capture
}

func TestALiveSessionAsksForItsCommandsAtStart(t *testing.T) {
	s, capture := liveFake(t, false)

	// The answer exists only because the client asked: the fake replies to
	// get_commands and to nothing else, so Commands arriving at all is proof
	// that the request went over the wire — unasked, nothing would arrive.
	got, ok := next(t, s).(agent.Commands)
	if !ok {
		t.Fatalf("a live session must ask what commands the agent implements, got %#v", got)
	}
	if len(got.List) != 3 {
		t.Fatalf("got %#v", got.List)
	}
	if first := got.List[0]; first.Name != "hook" || first.Source != "extension" || first.Description != "list and fire hooks" {
		t.Fatalf("got %#v", first)
	}
	if c := got.List[0]; c.Location != "temporary" || c.Path != "<inline:sea-hooks>" {
		t.Fatalf("the installed pi's sourceInfo shape must arrive intact: %#v", c)
	}
	if sk := got.List[2]; sk.Name != "skill:pdf-reader" || sk.Source != "skill" || sk.Location != "user" {
		t.Fatalf("source, location and path must survive the trip: %#v", sk)
	}

	// Once, and asked at the start: closing first means anything still in
	// flight would be in the file by now.
	_ = s.Close()
	raw, err := os.ReadFile(capture)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(lines) != 1 {
		t.Fatalf("the session sent %d request lines; one question is the design: %q", len(lines), raw)
	}
	var req map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &req); err != nil {
		t.Fatalf("the request must be one JSON line: %v (%q)", err, lines[0])
	}
	if req["type"] != "get_commands" {
		t.Fatalf("asked for %v, want get_commands", req["type"])
	}
	if req["id"] == nil {
		t.Fatal("pi correlates a reply by the request id; a request without one is unanswerable")
	}
}

func TestABackendThatNeverAnswersCostsNothing(t *testing.T) {
	// A backend that reads the request and says nothing. Silence must be
	// silence: no message, no failure, no hang — the interface keeps the list
	// it built for itself, which is what "non-fatal" has to mean for a
	// question nobody is obliged to answer.
	s, capture := liveFake(t, true)

	// The request goes out regardless of whether it is ever answered. Polled
	// rather than sampled once: the stand-in is a process that has to start
	// before it can read anything, and on a loaded runner that takes longer
	// than any fixed sleep would be honest about.
	waitForRequest(t, capture, "get_commands")

	done := make(chan tea.Msg, 1)
	go func() { done <- s.Next()() }()
	select {
	case msg := <-done:
		t.Fatalf("a silent backend must say nothing, got %#v", msg)
	case <-time.After(250 * time.Millisecond):
	}
}

// waitForRequest polls a capture file until it holds want, or fails.
func waitForRequest(t *testing.T, path, want string) {
	t.Helper()
	waitForLine(t, path, want)
}

// waitForLine polls a capture file until one line contains want, and returns
// that line.
func waitForLine(t *testing.T, path, want string) string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		raw, err := os.ReadFile(path)
		if err == nil {
			for _, l := range strings.Split(string(raw), "\n") {
				if strings.Contains(l, want) {
					return l
				}
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("no line containing %q arrived at the stand-in agent: %v (%q)", want, err, raw)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// liveFakeUI starts a session whose stand-in agent asks one question at
// startup. That is how a dialog reaches the client without a real pi: the
// question is an ordinary line on stdout, printed before the fake reads
// anything.
func liveFakeUI(t *testing.T, request string) (*Session, string) {
	t.Helper()
	capture := filepath.Join(t.TempDir(), "received.jsonl")
	t.Setenv(envFakePi, "1")
	t.Setenv(envFakeLine, capture)
	t.Setenv(envFakeUI, request)
	s, err := Start(exec.Command(os.Args[0]))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s, capture
}

// nextDialog reads until the question arrives, stepping over whatever else
// the stand-in agent had queued (the get_commands reply).
func nextDialog(t *testing.T, s *Session) agent.UIDialog {
	t.Helper()
	for i := 0; i < 5; i++ {
		if d, ok := next(t, s).(agent.UIDialog); ok {
			return d
		}
	}
	t.Fatal("the stand-in agent asked a question; the client never surfaced it")
	return agent.UIDialog{}
}

// TestAConfirmFromAnExtensionIsAnsweredOnTheWire: the whole loop. The fake
// asks; the client's answer is a line on the child's stdin, keyed by the id
// PI chose — not by this session's request counter, which would answer
// nothing — and carrying `confirmed`, the one field pi reads for a confirm.
func TestAConfirmFromAnExtensionIsAnsweredOnTheWire(t *testing.T) {
	s, capture := liveFakeUI(t, `{"type":"extension_ui_request","id":"uuid-2","method":"confirm","title":"Clear session?","message":"All messages will be lost.","timeout":5000}`)

	d := nextDialog(t, s)
	if d.ID != "uuid-2" || d.Method != "confirm" || d.Title != "Clear session?" || d.Message != "All messages will be lost." {
		t.Fatalf("the question must arrive intact — it is what the reader answers: %#v", d)
	}
	if msg := s.Answer(d, agent.UIAnswer{Confirmed: true})(); msg != nil {
		t.Fatalf("answering must not fail: %#v", msg)
	}

	v := parseLine(t, waitForLine(t, capture, `"extension_ui_response"`))
	if v["id"] != "uuid-2" {
		t.Fatalf("the response must carry pi's id, got %v", v["id"])
	}
	if v["confirmed"] != true {
		t.Fatalf("a confirm answer is `confirmed`, got %#v", v)
	}
	if _, has := v["value"]; has {
		t.Fatalf("`value` answers a different question than `confirmed`: %#v", v)
	}
}

// TestADismissalIsCancelledNotAnAnswer: cancelling is its own response
// (`cancelled: true`), because to the extension a dismissed confirm is
// `false` and a dismissed text ask is `undefined` — neither is "answered".
func TestADismissalIsCancelledNotAnAnswer(t *testing.T) {
	s, capture := liveFakeUI(t, `{"type":"extension_ui_request","id":"uuid-3","method":"input","title":"Enter a value"}`)

	d := nextDialog(t, s)
	if msg := s.Answer(d, agent.UIAnswer{Cancelled: true})(); msg != nil {
		t.Fatalf("cancelling must not fail: %#v", msg)
	}

	v := parseLine(t, waitForLine(t, capture, `"extension_ui_response"`))
	if v["id"] != "uuid-3" || v["cancelled"] != true {
		t.Fatalf("got %#v", v)
	}
	if _, has := v["value"]; has {
		t.Fatalf("a cancelled dialog resolves to undefined, not to a value: %#v", v)
	}
}

// TestATextAnswerCarriesTheValue: select, input and editor all answer with
// `value`, and an empty one is still an answer.
func TestATextAnswerCarriesTheValue(t *testing.T) {
	for _, c := range []struct{ method, value string }{
		{"select", "Allow"},
		{"input", "hello world"},
		{"editor", "Line 1\nLine 2"},
	} {
		s, capture := liveFakeUI(t, `{"type":"extension_ui_request","id":"uuid-4","method":"`+c.method+`","title":"asking"}`)
		d := nextDialog(t, s)
		if msg := s.Answer(d, agent.UIAnswer{Value: c.value})(); msg != nil {
			t.Fatalf("%s: answering must not fail: %#v", c.method, msg)
		}
		v := parseLine(t, waitForLine(t, capture, `"extension_ui_response"`))
		if v["value"] != c.value {
			t.Fatalf("%s: value = %#v, want %q", c.method, v["value"], c.value)
		}
		if _, has := v["confirmed"]; has {
			t.Fatalf("%s: a text answer is `value`, got %#v", c.method, v)
		}
	}
}

// TestSwitchSessionGoesOverTheWire: the command name and the field name are
// pi's (sessionPath, not sessionFile), and a switch is only real if pi is
// told about it — the transcript above it is a replay either way.
func TestSwitchSessionGoesOverTheWire(t *testing.T) {
	s, capture := liveFake(t, false)
	if msg := s.SwitchSession("/sessions/other.jsonl")(); msg != nil {
		t.Fatalf("switching must not fail: %#v", msg)
	}
	v := parseLine(t, waitForLine(t, capture, `"switch_session"`))
	if v["type"] != "switch_session" {
		t.Fatalf("got %#v", v)
	}
	if v["sessionPath"] != "/sessions/other.jsonl" {
		t.Fatalf("switch_session reads sessionPath in pi's own types; got %#v", v)
	}
	if v["id"] == nil {
		t.Fatal("a command without an id is one pi's reply cannot be matched to")
	}
}

// TestNewSessionGoesOverTheWire: /new and /clear clear the view, and this is
// what makes the model's context agree with it.
func TestNewSessionGoesOverTheWire(t *testing.T) {
	s, capture := liveFake(t, false)
	if msg := s.NewSession()(); msg != nil {
		t.Fatalf("starting a session must not fail: %#v", msg)
	}
	v := parseLine(t, waitForLine(t, capture, `"new_session"`))
	if v["type"] != "new_session" {
		t.Fatalf("got %#v", v)
	}
}

// liveFakeStderr starts a session against a stand-in agent that writes each
// line to stderr and exits without ever answering anything — pi refusing to
// start, which is the shape #13 is about.
func liveFakeStderr(t *testing.T, lines ...string) *Session {
	t.Helper()
	t.Setenv(envFakePi, "1")
	t.Setenv(envFakeStderr, strings.Join(lines, "\n"))
	s, err := Start(exec.Command(os.Args[0]))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

// TestAnExtensionConflictReachesTheTranscript: the whole of #13, end to end.
// pi aborts at startup, says why on stderr, and the interface must carry that
// sentence — with the way out of it — instead of the old "the agent process
// exited", which told the reader nothing they could act on.
//
// The fixture is pi's own output, captured from a real run: the diagnostics
// prefix, the reason in pi's words, and the Hint line it prints underneath.
func TestAnExtensionConflictReachesTheTranscript(t *testing.T) {
	s := liveFakeStderr(t,
		`Error: Failed to load extension "/home/me/.pi/extensions/grep.ts": Tool "grep" conflicts with /repo/agent/extensions/sea-tools-inline.ts`,
		`Hint: Start without extensions using "pi -ne".`)

	got, ok := next(t, s).(agent.Failed)
	if !ok {
		t.Fatalf("the failure must arrive as a failure, got %#v", got)
	}
	text := got.Err.Error()
	for _, want := range []string{
		"/home/me/.pi/extensions/grep.ts",
		`Tool "grep" conflicts with /repo/agent/extensions/sea-tools-inline.ts`,
		"remove or rename one of them",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("the transcript line lost %q: %q", want, text)
		}
	}
	if strings.HasPrefix(text, "Error: ") {
		t.Fatalf("pi's diagnostics prefix is not part of the sentence: %q", text)
	}

	// And once: pi follows the failure with a hint, and a second notice would
	// be the old bug in a new place — a reader who sees two failures stops at
	// the first, and the first is the one that explains itself.
	done := make(chan tea.Msg, 1)
	go func() { done <- s.Next()() }()
	select {
	case extra := <-done:
		t.Fatalf("the failure was already said; a second notice is noise: %#v", extra)
	case <-time.After(250 * time.Millisecond):
	}
}

// TestAnUnrecognisedStartupFailureStillSaysWhatStderrSaid: not every exit is a
// sentence this client knows how to parse. The exit is still reported, and the
// last thing pi said rides along — labelled as what it is, since a line of
// startup output is not a diagnosis.
func TestAnUnrecognisedStartupFailureStillSaysWhatStderrSaid(t *testing.T) {
	s := liveFakeStderr(t, "Error: unknown provider 'zzz'")

	got, ok := next(t, s).(agent.Failed)
	if !ok {
		t.Fatalf("a dead backend must say so, got %#v", got)
	}
	text := got.Err.Error()
	if !strings.Contains(text, "exited") || !strings.Contains(text, "unknown provider 'zzz'") {
		t.Fatalf("the exit must be reported with pi's own last words, got %q", text)
	}
}

func parseLine(t *testing.T, line string) map[string]any {
	t.Helper()
	var v map[string]any
	if err := json.Unmarshal([]byte(line), &v); err != nil {
		t.Fatalf("the request must be one JSON line: %v (%q)", err, line)
	}
	return v
}

// TestListCommandsAsksAgain: the catalogue is re-asked rather than remembered,
// because a package installed mid-session only shows up in a fresh answer.
// Two asks, two replies — the count is the evidence.
func TestListCommandsAsksAgain(t *testing.T) {
	s, capture := liveFake(t, false)
	if got, ok := next(t, s).(agent.Commands); !ok || len(got.List) != 3 {
		t.Fatalf("the ask at startup, got %#v", got)
	}
	if msg := s.ListCommands()(); msg != nil {
		t.Fatalf("asking again must not fail: %#v", msg)
	}
	if got, ok := next(t, s).(agent.Commands); !ok || len(got.List) != 3 {
		t.Fatalf("the re-ask must produce a second answer, got %#v", got)
	}
	_ = s.Close()
	raw, err := os.ReadFile(capture)
	if err != nil {
		t.Fatal(err)
	}
	if n := strings.Count(string(raw), `"get_commands"`); n != 2 {
		t.Fatalf("the request went out %d times, want 2:\n%s", n, raw)
	}
}

// TestCompactGoesOverTheWire: pi's command name, and its field name for the
// reader's instructions (customInstructions). An empty string is NOT sent as an
// empty instruction — "summarise the context" and "summarise it, and here is
// nothing to focus on" are different requests.
func TestCompactGoesOverTheWire(t *testing.T) {
	s, capture := liveFake(t, false)
	if msg := s.Compact("")(); msg != nil {
		t.Fatalf("compact must not fail: %#v", msg)
	}
	v := parseLine(t, waitForLine(t, capture, `"compact"`))
	if v["type"] != "compact" {
		t.Fatalf("got %#v", v)
	}
	if _, has := v["customInstructions"]; has {
		t.Fatalf("an empty instruction must not be sent as one: %#v", v)
	}
	if v["id"] == nil {
		t.Fatal("a command without an id is one pi's reply cannot be matched to")
	}

	if msg := s.Compact(" keep the parser ")(); msg != nil {
		t.Fatalf("compact must not fail: %#v", msg)
	}
	v = parseLine(t, waitForLine(t, capture, `"customInstructions"`))
	if v["customInstructions"] != "keep the parser" {
		t.Fatalf("pi reads customInstructions verbatim; got %#v", v)
	}
}

// TestForkAsksForItsPointsAndThenForksOne: the two-step the smallest branch
// needs — which messages can a branch start from, then branch at one. The id is
// pi's, so it has to survive the trip intact.
func TestForkAsksForItsPointsAndThenForksOne(t *testing.T) {
	s, capture := liveFake(t, false)
	// The startup answer first: it is queued before anything this test sends.
	if _, ok := next(t, s).(agent.Commands); !ok {
		t.Fatal("the startup get_commands reply comes first")
	}

	if msg := s.ForkPoints()(); msg != nil {
		t.Fatalf("asking for the fork points must not fail: %#v", msg)
	}
	pts, ok := next(t, s).(agent.ForkPoints)
	if !ok {
		t.Fatalf("get_fork_messages must become ForkPoints, got %#v", pts)
	}
	if len(pts.List) != 2 || pts.List[0].EntryID != "abc123" || pts.List[1].Text != "Second prompt..." {
		t.Fatalf("the points must arrive in pi's order, intact: %#v", pts.List)
	}

	if msg := s.Fork(pts.List[1].EntryID)(); msg != nil {
		t.Fatalf("forking must not fail: %#v", msg)
	}
	v := parseLine(t, waitForLine(t, capture, `"fork"`))
	if v["type"] != "fork" || v["entryId"] != "def456" {
		t.Fatalf("fork carries entryId, pi's own field: %#v", v)
	}

	done, ok := next(t, s).(agent.Forked)
	if !ok || done.Text != "Second prompt..." || done.Cancelled {
		t.Fatalf("the branch's message must come back for the editor: %#v", done)
	}
}
