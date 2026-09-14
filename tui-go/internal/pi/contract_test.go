package pi

import (
	"encoding/json"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/agent"
)

// This file pins ParseEvent to pi's DOCUMENTED protocol, not to our memory of
// it. Every fixture below is copied verbatim from the Events chapter of
// docs/rpc.md in @earendil-works/pi-coding-agent (pinned here against
// 0.84.4, the installed version; the repo's agent runs ^0.84.3). If pi
// renames a field — toolCallId, assistantMessageEvent, the usage shape —
// this file goes red BEFORE the transcript goes quiet in a live session.
//
// Two deliberate non-goals, recorded so nobody "fixes" them:
//   - unknown EVENT TYPES return nil, not an error: pi adds events between
//     versions and an unrecognised one is not a failure;
//   - the version pin in agent/package.json stays a caret (^0.84.3). An
//     exact pin needs evidence of a breaking change, and the risk of drift
//     is carried HERE instead: this file is the tripwire.

func doc(t *testing.T, line string) tea.Msg {
	t.Helper()
	var v map[string]any
	if err := json.Unmarshal([]byte(line), &v); err != nil {
		t.Fatalf("fixture is not the JSON the docs print: %v\n%s", err, line)
	}
	return ParseEvent(v)
}

// TestTheDocumentedLifecycle: the doc's agent_start and agent_settled are
// field-free events; they must land on the interface's turn boundaries.
func TestTheDocumentedLifecycle(t *testing.T) {
	if _, ok := doc(t, `{"type": "agent_start"}`).(agent.Started); !ok {
		t.Fatal("doc: agent_start begins a turn")
	}
	if _, ok := doc(t, `{"type": "agent_settled"}`).(agent.Done); !ok {
		t.Fatal("doc: agent_settled ends it")
	}
}

// TestTheDocumentedResponseShape: responses carry command + success (+ the
// request's id, per the doc's framing rules). Success is noise; failure is
// the only one worth showing.
func TestTheDocumentedResponseShape(t *testing.T) {
	if got := doc(t, `{"id": "req-1", "type": "response", "command": "prompt", "success": true}`); got != nil {
		t.Fatalf("doc: a successful acknowledgement is noise, got %#v", got)
	}
	if got := doc(t, `{"type": "response", "command": "steer", "success": true}`); got != nil {
		t.Fatalf("doc: same for steer, got %#v", got)
	}
}

// TestTheDocumentedGetCommandsReply: the doc's get_commands example, verbatim
// — the one response that is an answer rather than an acknowledgement, and the
// one the interface asks for at session start.
func TestTheDocumentedGetCommandsReply(t *testing.T) {
	got, ok := doc(t, `{
  "type": "response",
  "command": "get_commands",
  "success": true,
  "data": {
    "commands": [
      {"name": "session-name", "description": "Set or clear session name", "source": "extension", "path": "/home/user/.pi/agent/extensions/session.ts"},
      {"name": "fix-tests", "description": "Fix failing tests", "source": "prompt", "location": "project", "path": "/home/user/myproject/.pi/agent/prompts/fix-tests.md"},
      {"name": "skill:brave-search", "description": "Web search via Brave API", "source": "skill", "location": "user", "path": "/home/user/.pi/agent/skills/brave-search/SKILL.md"}
    ]
  }
}`).(agent.Commands)
	if !ok {
		t.Fatal("doc: the get_commands example must become Commands, not an acknowledgement")
	}
	if len(got.List) != 3 {
		t.Fatalf("doc: three commands in the example, got %#v", got.List)
	}
	ext := got.List[0]
	if ext.Name != "session-name" || ext.Source != "extension" || ext.Location != "" {
		t.Fatalf("doc: an extension command has no location, got %#v", ext)
	}
	if ext.Path != "/home/user/.pi/agent/extensions/session.ts" {
		t.Fatalf("doc: the path must survive, got %q", ext.Path)
	}
	if pr := got.List[1]; pr.Source != "prompt" || pr.Location != "project" || pr.Description != "Fix failing tests" {
		t.Fatalf("doc: prompt template fields, got %#v", pr)
	}
	if sk := got.List[2]; sk.Name != "skill:brave-search" || sk.Source != "skill" || sk.Location != "user" {
		t.Fatalf("doc: skill command fields, got %#v", sk)
	}

	// The other half of the contract: a get_commands that FAILS is not a
	// session failure. A backend too old to know the request answers this way,
	// and the interface must keep the list it already has.
	if m := doc(t, `{"type":"response","command":"get_commands","success":false,"error":"unknown command"}`); m != nil {
		t.Fatalf("a failed get_commands must not surface as a failure, got %#v", m)
	}
	// ...and an answer with no commands in it at all is an empty list, not a
	// crash: pi's docs mark every field but the name optional.
	empty, ok := doc(t, `{"type":"response","command":"get_commands","success":true}`).(agent.Commands)
	if !ok || len(empty.List) != 0 {
		t.Fatalf("got %#v", empty)
	}
	partial, ok := doc(t, `{"type":"response","command":"get_commands","success":true,"data":{"commands":[{"name":"hook"},{"description":"nameless"}]}}`).(agent.Commands)
	if !ok || len(partial.List) != 1 || partial.List[0].Name != "hook" {
		t.Fatalf("a command with only a name is still a command; a nameless one is not: %#v", partial.List)
	}

	// And the shape the INSTALLED pi actually sends: not the doc's flat
	// location/path but a sourceInfo object. Verified against a live
	// get_commands reply, not assumed — the doc's own example is the other
	// arm of this test. Both spellings must land in the same fields, or every
	// row loses where its command came from.
	moved, ok := doc(t, `{"type":"response","command":"get_commands","success":true,"data":{"commands":[{"name":"hook","description":"Hooks","source":"extension","sourceInfo":{"path":"<inline:sea-hooks>","source":"inline","scope":"temporary","origin":"top-level"}}]}}`).(agent.Commands)
	if !ok || len(moved.List) != 1 {
		t.Fatalf("got %#v", moved)
	}
	if c := moved.List[0]; c.Location != "temporary" || c.Path != "<inline:sea-hooks>" {
		t.Fatalf("sourceInfo.scope/path are the installed pi's spelling of location/path: %#v", c)
	}
}

// TestTheDocumentedMessageUpdate: the doc's streaming example, verbatim,
// including the top-level usage field our parser must step over to reach
// assistantMessageEvent.
func TestTheDocumentedMessageUpdate(t *testing.T) {
	full := `{
  "type": "message_update",
  "usage": {
    "input": 100,
    "output": 1,
    "cacheRead": 0,
    "cacheWrite": 0,
    "totalTokens": 101,
    "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}
  },
  "assistantMessageEvent": {
    "type": "text_delta",
    "contentIndex": 0,
    "delta": "Hello "
  }
}`
	tx, ok := doc(t, full).(agent.Text)
	if !ok || tx.Text != "Hello " {
		t.Fatalf("doc: the text_delta example must surface its delta, got %#v", tx)
	}

	// thinking_delta is the doc's other content chunk.
	th, ok := doc(t, `{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"weighing"}}`).(agent.Think)
	if !ok || th.Text != "weighing" {
		t.Fatalf("doc: thinking_delta must surface as thinking, got %#v", th)
	}
}

// TestTheDocumentedNonDeltaMessageUpdates: the doc's block delimiters —
// text_start, text_end, thinking_start/end, toolcall_start/delta/end — are
// bookkeeping, not content. They must be stepped over without a message and
// without a crash; toolcall_start's id/toolName are NOT a tool call beginning
// (that is tool_execution_start's job).
func TestTheDocumentedNonDeltaMessageUpdates(t *testing.T) {
	for _, line := range []string{
		`{"type":"message_update","assistantMessageEvent":{"type":"text_start","contentIndex":0}}`,
		`{"type":"message_update","assistantMessageEvent":{"type":"text_end","contentIndex":0,"content":"Hello world"}}`,
		`{"type":"message_update","assistantMessageEvent":{"type":"thinking_start","contentIndex":0}}`,
		`{"type":"message_update","assistantMessageEvent":{"type":"thinking_end","contentIndex":0}}`,
		`{"type":"message_update","assistantMessageEvent":{"type":"toolcall_start","contentIndex":1,"id":"call_abc123","toolName":"write"}}`,
		`{"type":"message_update","assistantMessageEvent":{"type":"toolcall_delta","contentIndex":1,"delta":"{\"path\":"}}`,
	} {
		if got := doc(t, line); got != nil {
			t.Fatalf("doc: %s is bookkeeping, must not become a message: %#v",
				inner(line), got)
		}
	}
}

// TestTheDocumentedToolExecutionEvents: the doc's own bash example, verbatim,
// start and end — including the end's result shape: a content array with a
// details sibling, not a bare string.
func TestTheDocumentedToolExecutionEvents(t *testing.T) {
	start, ok := doc(t, `{
  "type": "tool_execution_start",
  "toolCallId": "call_abc123",
  "toolName": "bash",
  "args": {"command": "ls -la"}
}`).(agent.ToolStart)
	if !ok || start.ID != "call_abc123" || start.Name != "bash" {
		t.Fatalf("doc: tool_execution_start example, got %#v", start)
	}
	if start.Args != "command=ls -la" {
		t.Fatalf("doc: args must render on one line, got %q", start.Args)
	}

	// The doc's end example prints "details": {...} — its elision. The
	// details object is spelled out below (from the doc's own
	// tool_execution_update example) so the fixture stays the doc's shape
	// AND valid JSON.
	end, ok := doc(t, `{
  "type": "tool_execution_end",
  "toolCallId": "call_abc123",
  "toolName": "bash",
  "result": {
    "content": [{"type": "text", "text": "total 48\n..."}],
    "details": {"truncation": null, "fullOutputPath": null}
  },
  "isError": false
}`).(agent.ToolEnd)
	if !ok {
		t.Fatal("doc: tool_execution_end example must become a ToolEnd")
	}
	if end.ID != "call_abc123" || !end.OK {
		t.Fatalf("got %#v", end)
	}
	if end.Out != "total 48\n..." {
		t.Fatalf("doc: the content array's text is the result, got %q", end.Out)
	}
	if end.Detail != "2 ln" {
		t.Fatalf("doc: a multi-line result summarises as its line count, got %q", end.Detail)
	}
}

// TestTheDocumentedIgnoredEvents: every other event type in the doc's table
// is one the transcript deliberately does not draw. Pinned so that a new pi
// version ADDING fields to them, or our parser ACCIDENTALLY consuming one,
// both show up here as a change to a recorded list.
func TestTheDocumentedIgnoredEvents(t *testing.T) {
	for _, line := range []string{
		`{"type": "agent_end", "messages": [], "willRetry": false}`,
		`{"type": "turn_start"}`,
		`{"type": "message_start", "message": {...}}`,
		`{"type": "message_end", "message": {...}}`,
		`{"type": "bash_execution_update", "id": "req-1", "delta": "total 48\n"}`,
		`{"type": "tool_execution_update", "toolCallId": "call_abc123", "toolName": "bash", "args": {"command": "ls -la"}, "partialResult": {"content": [{"type": "text", "text": "partial output so far..."}], "details": {"truncation": null, "fullOutputPath": null}}}`,
		`{"type": "queue_update", "steering": ["Focus on error handling"], "followUp": ["After that, summarize the result"]}`,
		`{"type": "compaction_start", "reason": "threshold"}`,
		`{"type": "compaction_end", "reason": "threshold", "result": null, "aborted": false, "willRetry": false}`,
		`{"type": "auto_retry_start", "attempt": 1, "maxAttempts": 3, "delayMs": 2000, "errorMessage": "529 overloaded"}`,
		`{"type": "auto_retry_end", "success": true, "attempt": 2}`,
		`{"type": "summarization_retry_scheduled", "attempt": 1, "maxAttempts": 3, "delayMs": 2000, "errorMessage": "terminated"}`,
		`{"type": "summarization_retry_attempt_start", "source": "compaction", "reason": "threshold"}`,
		`{"type": "summarization_retry_finished"}`,
		`{"type": "extension_error", "extensionPath": "/path/to/extension.ts", "event": "tool_call", "error": "Error message..."}`,
	} {
		// the doc prints {...} for elided objects; make the lines parseable
		// without changing the shape we are pinning
		line = strings.ReplaceAll(line, `{...}`, `{"elided":true}`)
		if got := doc(t, line); got != nil {
			t.Fatalf("doc lists %s as an event we do not draw, got %#v", inner(line), got)
		}
	}
}

// TestTheDocumentedTurnEnd: turn_end carries the assistant message whose
// usage block is the doc's shape (input/output/…/cost.total). Our Stats must
// read exactly those fields.
func TestTheDocumentedTurnEnd(t *testing.T) {
	st, ok := doc(t, `{
  "type": "turn_end",
  "message": {
    "provider": "anthropic",
    "model": "claude-opus-4",
    "usage": {
      "input": 50000,
      "output": 10000,
      "cacheRead": 40000,
      "cacheWrite": 5000,
      "totalTokens": 105000,
      "cost": {"input": 0.01, "output": 0.02, "cacheRead": 0, "cacheWrite": 0, "total": 0.03}
    }
  },
  "toolResults": []
}`).(agent.Stats)
	if !ok {
		t.Fatal("doc: turn_end must become Stats")
	}
	if st.Provider != "anthropic" || st.Model != "claude-opus-4" {
		t.Fatalf("got %#v", st.TurnStats)
	}
	if st.TokensIn != 50000 || st.TokensOut != 10000 {
		t.Fatalf("doc: usage.input/output are the token counts, got %#v", st.TurnStats)
	}
	if st.Cost != 0.03 {
		t.Fatalf("doc: cost.total is the price, got %v", st.Cost)
	}
}

// TestAShapeWeDoNotKnowFailsLoudlyNotSilently: the contract's other half.
// An event we DO draw, arriving in a shape we have never seen, must still
// produce something readable — never a silent blank block. (A tool end with
// an unrecognised result renders as its JSON; a response failure with no
// error string still names its command.)
func TestAShapeWeDoNotKnowFailsLoudlyNotSilently(t *testing.T) {
	end, ok := doc(t, `{"type":"tool_execution_end","toolCallId":"z","result":{"weird":"shape"}}`).(agent.ToolEnd)
	if !ok || end.Out == "" {
		t.Fatalf("got %#v; an unknown result shape must render, not vanish", end)
	}
	if !strings.Contains(end.Out, "weird") {
		t.Fatalf("the unknown shape must be visible in the output: %q", end.Out)
	}
	f, ok := doc(t, `{"type":"response","success":false,"command":"abort"}`).(agent.Failed)
	if !ok || !strings.Contains(f.Err.Error(), "abort") {
		t.Fatalf("got %#v; a wordless failure must still name its command", f)
	}
}

// inner names an event line for failure messages: the type field, and the
// assistantMessageEvent type when there is one.
func inner(line string) string {
	var v map[string]any
	_ = json.Unmarshal([]byte(line), &v)
	t, _ := v["type"].(string)
	if ev, ok := v["assistantMessageEvent"].(map[string]any); ok {
		if k, ok := ev["type"].(string); ok {
			return t + "/" + k
		}
	}
	return t
}
