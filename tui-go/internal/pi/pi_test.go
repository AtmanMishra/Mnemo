package pi

import (
	"encoding/json"
	"os/exec"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/agent"
)

// ev parses one recorded protocol line. The whole point of keeping ParseEvent
// pure is that the protocol is testable with no child process, no API key and
// no network.
func ev(t *testing.T, line string) tea.Msg {
	t.Helper()
	var v map[string]any
	if err := json.Unmarshal([]byte(line), &v); err != nil {
		t.Fatalf("bad fixture: %v", err)
	}
	return ParseEvent(v)
}

func TestAnUnknownEventIsIgnoredNotAnError(t *testing.T) {
	// pi adds events between versions. An unrecognised one is not a failure.
	if got := ev(t, `{"type":"something_new","payload":1}`); got != nil {
		t.Fatalf("got %#v", got)
	}
	if got := ev(t, `{}`); got != nil {
		t.Fatalf("got %#v", got)
	}
}

func TestLifecycleEvents(t *testing.T) {
	if _, ok := ev(t, `{"type":"agent_start"}`).(agent.Started); !ok {
		t.Fatal("agent_start begins a turn")
	}
	if _, ok := ev(t, `{"type":"agent_settled"}`).(agent.Done); !ok {
		t.Fatal("agent_settled ends it")
	}
}

func TestOnlyAFailedResponseIsWorthShowing(t *testing.T) {
	if got := ev(t, `{"type":"response","success":true,"command":"prompt"}`); got != nil {
		t.Fatalf("a successful acknowledgement is noise: %#v", got)
	}
	f, ok := ev(t, `{"type":"response","success":false,"error":"model not found"}`).(agent.Failed)
	if !ok || f.Err.Error() != "model not found" {
		t.Fatalf("got %#v", f)
	}
	f2 := ev(t, `{"type":"response","success":false,"command":"steer"}`).(agent.Failed)
	if !strings.Contains(f2.Err.Error(), "steer") {
		t.Fatalf("a failure with no message must still name the command: %v", f2.Err)
	}
}

func TestThinkingAndTextAreToldApart(t *testing.T) {
	th, ok := ev(t, `{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"weighing"}}`).(agent.Think)
	if !ok || th.Text != "weighing" {
		t.Fatalf("got %#v", th)
	}
	if _, ok := ev(t, `{"type":"message_update","assistantMessageEvent":{"type":"reasoning_delta","delta":"x"}}`).(agent.Think); !ok {
		t.Fatal("reasoning is thinking")
	}
	tx, ok := ev(t, `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"hello"}}`).(agent.Text)
	if !ok || tx.Text != "hello" {
		t.Fatalf("got %#v", tx)
	}
}

func TestADeltaCanArriveUnderAnyOfThreeNames(t *testing.T) {
	for _, field := range []string{"delta", "text", "thinking"} {
		line := `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","` + field + `":"x"}}`
		if ev(t, line) == nil {
			t.Fatalf("a delta named %q was dropped", field)
		}
	}
	if got := ev(t, `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":""}}`); got != nil {
		t.Fatal("an empty delta is nothing to render")
	}
}

func TestAToolCallCarriesItsResultNotItsInvocation(t *testing.T) {
	// A collapsed block is worth opening only when its one line is honest,
	// so the summary is the result.
	start := ev(t, `{"type":"tool_execution_start","toolCallId":"7","toolName":"read","args":{"path":"main.go","limit":40}}`).(agent.ToolStart)
	if start.ID != "7" || start.Name != "read" {
		t.Fatalf("got %#v", start)
	}
	if start.Args != "limit=40 path=main.go" {
		t.Fatalf("args = %q; sorted, so the same call renders the same way every frame", start.Args)
	}

	end := ev(t, `{"type":"tool_execution_end","toolCallId":"7","result":"a\nb\nc"}`).(agent.ToolEnd)
	if end.ID != "7" || !end.OK || end.Detail != "3 ln" {
		t.Fatalf("got %#v", end)
	}
	if end.Out != "a\nb\nc" {
		t.Fatalf("the full result must ride along, got %q", end.Out)
	}
	fail := ev(t, `{"type":"tool_execution_end","toolCallId":"8","isError":true,"result":"denied\n"}`).(agent.ToolEnd)
	if fail.OK || fail.Detail != "denied" || fail.Out != "denied\n" {
		t.Fatalf("got %#v", fail)
	}
}

func TestASilentToolStillSaysSomething(t *testing.T) {
	end := ev(t, `{"type":"tool_execution_end","toolCallId":"1","result":null}`).(agent.ToolEnd)
	if end.Detail != "ok" {
		t.Fatalf("a tool that returned nothing must not render as blank: %q", end.Detail)
	}
}

func TestResultTextHandlesEveryShapePiSends(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{`"plain"`, "plain"},
		{`[{"type":"text","text":"a"},{"type":"text","text":"b"}]`, "ab"},
		{`{"content":[{"type":"text","text":"nested"}]}`, "nested"},
		{`{"type":"image","data":"…"}`, "[image]"},
		{`null`, ""},
	} {
		var v any
		if err := json.Unmarshal([]byte(c.in), &v); err != nil {
			t.Fatal(err)
		}
		if got := ResultText(v); got != c.want {
			t.Fatalf("ResultText(%s) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestAnUnknownResultShapeIsShownNotDropped(t *testing.T) {
	// A tool block that silently shows nothing is indistinguishable from one
	// that ran and said nothing.
	var v any
	_ = json.Unmarshal([]byte(`{"weird":true}`), &v)
	if got := ResultText(v); got == "" {
		t.Fatal("an unrecognised shape must render as its JSON")
	}
}

func TestTurnEndCarriesTheCost(t *testing.T) {
	s := ev(t, `{"type":"turn_end","message":{"provider":"anthropic","model":"opus","usage":{"input":120,"output":45,"cost":{"total":0.02}}}}`).(agent.Stats)
	if s.Model != "opus" || s.TokensIn != 120 || s.TokensOut != 45 || s.Cost != 0.02 {
		t.Fatalf("got %#v", s.TurnStats)
	}
}

func TestArgumentsAreTruncatedNotWrapped(t *testing.T) {
	long := strings.Repeat("x", 200)
	var v any
	_ = json.Unmarshal([]byte(`{"body":"`+long+`"}`), &v)
	got := SummariseArgs(v)
	if len([]rune(got)) > 70 {
		t.Fatalf("args are %d cells; a tool line must stay one line", len([]rune(got)))
	}
	if strings.Contains(got, "\n") {
		t.Fatal("arguments must never contain a newline")
	}
}

// --- the live process ----------------------------------------------------

// fake speaks the protocol without needing node, an API key or a network.
func fake(t *testing.T, script string) *Session {
	t.Helper()
	s, err := Start(exec.Command("sh", "-c", script))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func next(t *testing.T, s *Session) tea.Msg {
	t.Helper()
	done := make(chan tea.Msg, 1)
	go func() { done <- s.Next()() }()
	select {
	case m := <-done:
		return m
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for the agent")
		return nil
	}
}

func TestALiveSessionStreamsEventsInOrder(t *testing.T) {
	s := fake(t, `printf '%s\n' \
		'{"type":"agent_start"}' \
		'not json at all' \
		'{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"hi"}}' \
		'{"type":"agent_settled"}'`)
	if _, ok := next(t, s).(agent.Started); !ok {
		t.Fatal("first event is the start")
	}
	// The stray line must be skipped, not treated as a protocol failure.
	if got, ok := next(t, s).(agent.Text); !ok || got.Text != "hi" {
		t.Fatalf("got %#v", got)
	}
	if _, ok := next(t, s).(agent.Done); !ok {
		t.Fatal("last event is settled")
	}
}

func TestTheProcessExitingIsReportedNotSwallowed(t *testing.T) {
	s := fake(t, `exit 0`)
	f, ok := next(t, s).(agent.Failed)
	if !ok || !strings.Contains(f.Err.Error(), "exited") {
		t.Fatalf("got %#v; a dead backend must say so, or the interface just stops responding", f)
	}
}

func TestCommandsAreWrittenAsOneLineEach(t *testing.T) {
	s := fake(t, `cat > /dev/null; sleep 5`)
	for _, cmd := range []tea.Cmd{s.Send("hello"), s.Steer("no, this"), s.Interrupt()} {
		if msg := cmd(); msg != nil {
			t.Fatalf("writing a command should not fail: %#v", msg)
		}
	}
}

func TestModelIsLearnedFromTheStream(t *testing.T) {
	s := fake(t, `printf '%s\n' '{"type":"turn_end","message":{"model":"deepseek-v4-flash","usage":{}}}'; sleep 5`)
	if s.Model() != "pi" {
		t.Fatalf("before any turn the model is a placeholder, got %q", s.Model())
	}
	next(t, s)
	if s.Model() != "deepseek-v4-flash" {
		t.Fatalf("model = %q", s.Model())
	}
}

func TestCloseIsIdempotent(t *testing.T) {
	s := fake(t, `sleep 5`)
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("closing twice must be safe: %v", err)
	}
}

func TestSpawnRejectsARepoWithoutTheAgentScript(t *testing.T) {
	dir := t.TempDir() // empty: no agent/bin/mnemo.ts anywhere in it
	s, err := Spawn(dir, dir, "")
	if s != nil {
		t.Fatalf("Spawn must not return a session for a bad repo root; got %+v", s)
	}
	if err == nil {
		t.Fatal("Spawn must error when the repo root lacks agent/bin/mnemo.ts")
	}
	if !strings.Contains(err.Error(), "--repo must point at the repository root") {
		t.Fatalf("error should tell the user what --repo means, got: %v", err)
	}
}
