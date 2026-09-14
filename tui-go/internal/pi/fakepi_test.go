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
	envFakePi   = "MNEMO_TEST_FAKE_PI"
	envFakeLine = "MNEMO_TEST_FAKE_PI_RECEIVED" // where the fake records what it was sent
	envFakeMute = "MNEMO_TEST_FAKE_PI_MUTE"     // set: read requests, never answer them
	envFakeUI   = "MNEMO_TEST_FAKE_PI_UI"       // a line the fake emits at startup, e.g. a dialog
)

// TestMain is also the stand-in agent's entry point: when the environment says
// so, this process is a fake pi and never the test runner.
func TestMain(m *testing.M) {
	if os.Getenv(envFakePi) == "1" {
		os.Exit(fakePiMain())
	}
	os.Exit(m.Run())
}

// fakePiMain records every request line and answers get_commands with the
// shape pi's docs print. It answers nothing else: a prompt arriving here is
// recorded and ignored, because what a client sends is the client's business.
func fakePiMain() int {
	capture := os.Getenv(envFakeLine)
	mute := os.Getenv(envFakeMute) == "1"
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
		if v["type"] == "get_commands" {
			fmt.Println(`{"id":1,"type":"response","command":"get_commands","success":true,"data":{"commands":[` +
				// The extension is spelled the way the installed pi spells
				// it (sourceInfo, not flat location/path); the other two the
				// way the docs do. Both shapes have to arrive intact.
				`{"name":"hook","description":"list and fire hooks","source":"extension","sourceInfo":{"path":"<inline:sea-hooks>","source":"inline","scope":"temporary"}},` +
				`{"name":"implement","description":"implement a plan","source":"prompt","location":"project","path":"/p/.pi/agent/prompts/implement.md"},` +
				`{"name":"skill:pdf-reader","description":"read pdfs","source":"skill","location":"user","path":"/u/.pi/agent/skills/pdf-reader/SKILL.md"}]}}`)
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

func parseLine(t *testing.T, line string) map[string]any {
	t.Helper()
	var v map[string]any
	if err := json.Unmarshal([]byte(line), &v); err != nil {
		t.Fatalf("the request must be one JSON line: %v (%q)", err, line)
	}
	return v
}
