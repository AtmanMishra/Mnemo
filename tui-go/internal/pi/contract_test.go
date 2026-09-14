package pi

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

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

// TestTheDocumentedIgnoredEvents: every OTHER event type in the doc's table
// is one the transcript deliberately does not draw, plus the three extension
// UI methods this interface has no surface for. Pinned so that a new pi
// version ADDING fields to them, or our parser ACCIDENTALLY consuming one,
// both show up here as a change to a recorded list.
//
// The four families that used to be in this list — compaction, auto-retry,
// summarization-retry and extension_error — are drawn now, and have tests of
// their own below. The split is the point: "ignored" here means a rendering
// decision, and it is only a defensible decision while the events that carry
// information nothing else carries are NOT in this list.
func TestTheDocumentedIgnoredEvents(t *testing.T) {
	for _, line := range []string{
		`{"type": "agent_end", "messages": [], "willRetry": false}`,
		`{"type": "turn_start"}`,
		`{"type": "message_start", "message": {...}}`,
		`{"type": "message_end", "message": {...}}`,
		`{"type": "bash_execution_update", "id": "req-1", "delta": "total 48\n"}`,
		`{"type": "tool_execution_update", "toolCallId": "call_abc123", "toolName": "bash", "args": {"command": "ls -la"}, "partialResult": {"content": [{"type": "text", "text": "partial output so far..."}], "details": {"truncation": null, "fullOutputPath": null}}}`,
		`{"type": "queue_update", "steering": ["Focus on error handling"], "followUp": ["After that, summarize the result"]}`,
		// Fire-and-forget extension UI methods with no surface here:
		// setWidget wants a panel above or below the editor, a region this
		// interface does not have; setTitle wants the terminal window title,
		// which View() already owns; set_editor_text would type into the
		// reader's editor for them. None of the three changes what the agent
		// does, so ignoring them loses no function — unlike the dialogs,
		// which are dropped only at the cost of a parked extension.
		`{"type": "extension_ui_request", "id": "uuid-7", "method": "setWidget", "widgetKey": "my-ext", "widgetLines": ["--- My Widget ---", "Line 1"], "widgetPlacement": "aboveEditor"}`,
		`{"type": "extension_ui_request", "id": "uuid-8", "method": "setTitle", "title": "pi - my project"}`,
		`{"type": "extension_ui_request", "id": "uuid-9", "method": "set_editor_text", "text": "prefilled text for the user"}`,
		`{"type": "extension_ui_request", "id": "uuid-10", "method": "something_new"}`,
	} {
		// the doc prints {...} for elided objects; make the lines parseable
		// without changing the shape we are pinning
		line = strings.ReplaceAll(line, `{...}`, `{"elided":true}`)
		if got := doc(t, line); got != nil {
			t.Fatalf("doc lists %s as an event we do not draw, got %#v", inner(line), got)
		}
	}
}

// TestTheDocumentedCompactionIsDrawn: compaction rewrites what the model
// remembers, and the two events carry the only account of it — the reason it
// ran, the sizes before and after, and the two ways it can end badly.
func TestTheDocumentedCompactionIsDrawn(t *testing.T) {
	start, ok := doc(t, `{"type": "compaction_start", "reason": "threshold"}`).(agent.Compaction)
	if !ok || !start.Started || start.Reason != "threshold" {
		t.Fatalf("doc: compaction_start example, got %#v", start)
	}

	end, ok := doc(t, `{
  "type": "compaction_end",
  "reason": "threshold",
  "result": {
    "summary": "Summary of conversation...",
    "firstKeptEntryId": "abc123",
    "tokensBefore": 150000,
    "estimatedTokensAfter": 32000,
    "usage": {"input": 32000, "output": 1200, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 33200,
      "cost": {"input": 0.01, "output": 0.02, "cacheRead": 0, "cacheWrite": 0, "total": 0.03}},
    "details": {}
  },
  "aborted": false,
  "willRetry": false
}`).(agent.Compaction)
	if !ok {
		t.Fatal("doc: compaction_end example must become a Compaction")
	}
	if end.Started || end.TokensBefore != 150000 || end.TokensAfter != 32000 {
		t.Fatalf("doc: the sizes are the point — the window shrank — got %#v", end)
	}
	if end.Aborted || end.WillRetry || end.Err != "" {
		t.Fatalf("a clean compaction is none of aborted/retrying/failed: %#v", end)
	}

	// Aborted: result is null, aborted is true.
	abort, ok := doc(t, `{"type": "compaction_end", "reason": "manual", "result": null, "aborted": true, "willRetry": false}`).(agent.Compaction)
	if !ok || !abort.Aborted || abort.TokensBefore != 0 {
		t.Fatalf("doc: an aborted compaction has no result and must say so: %#v", abort)
	}

	// Failed: result is null, aborted false, errorMessage explains it.
	fail, ok := doc(t, `{"type": "compaction_end", "reason": "threshold", "result": null, "aborted": false, "errorMessage": "quota exceeded"}`).(agent.Compaction)
	if !ok || fail.Err != "quota exceeded" || fail.Aborted {
		t.Fatalf("doc: a failed compaction carries errorMessage, got %#v", fail)
	}

	// Overflow that succeeded: the agent retries the prompt on the smaller
	// context, and willRetry is how the reader learns why the turn restarts.
	overflow, ok := doc(t, `{"type": "compaction_end", "reason": "overflow", "result": {"tokensBefore": 200000, "estimatedTokensAfter": 40000}, "aborted": false, "willRetry": true}`).(agent.Compaction)
	if !ok || !overflow.WillRetry || overflow.Reason != "overflow" {
		t.Fatalf("doc: willRetry must survive, got %#v", overflow)
	}
}

// TestTheDocumentedRetriesAreDrawn: a provider hiccup retried three times with
// a two-second wait is the difference between a patient program and a hang,
// and these two events are the only place that is said.
func TestTheDocumentedRetriesAreDrawn(t *testing.T) {
	start, ok := doc(t, `{
  "type": "auto_retry_start",
  "attempt": 1,
  "maxAttempts": 3,
  "delayMs": 2000,
  "errorMessage": "529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}"
}`).(agent.Retry)
	if !ok {
		t.Fatal("doc: auto_retry_start example must become a Retry")
	}
	if start.Phase != agent.RetryStart || start.Kind != agent.RetryTurn {
		t.Fatalf("a retry of the turn starts the turn: %#v", start)
	}
	if start.Attempt != 1 || start.MaxAttempts != 3 || start.Delay != 2*time.Second {
		t.Fatalf("doc: attempt/maxAttempts/delayMs are what 'why is it waiting' means, got %#v", start)
	}
	if !strings.Contains(start.Err, "overloaded_error") {
		t.Fatalf("doc: errorMessage must survive so the wait has a cause: %q", start.Err)
	}

	ok2, ok := doc(t, `{"type": "auto_retry_end", "success": true, "attempt": 2}`).(agent.Retry)
	if !ok || ok2.Phase != agent.RetryEnd || !ok2.OK || ok2.Attempt != 2 {
		t.Fatalf("doc: a successful retry, got %#v", ok2)
	}

	gone, ok := doc(t, `{"type": "auto_retry_end", "success": false, "attempt": 3, "finalError": "529 overloaded_error: Overloaded"}`).(agent.Retry)
	if !ok || gone.OK || !strings.Contains(gone.Final, "overloaded") {
		t.Fatalf("doc: exhausted retries carry finalError, got %#v", gone)
	}
}

// TestTheDocumentedSummarizationRetriesAreDrawn: the same story for the
// summarizer, which retries separately from the turn.
func TestTheDocumentedSummarizationRetriesAreDrawn(t *testing.T) {
	sched, ok := doc(t, `{
  "type": "summarization_retry_scheduled",
  "attempt": 1,
  "maxAttempts": 3,
  "delayMs": 2000,
  "errorMessage": "terminated"
}`).(agent.Retry)
	if !ok || sched.Phase != agent.RetryScheduled || sched.Kind != agent.RetrySummary {
		t.Fatalf("doc: a scheduled summarization retry, got %#v", sched)
	}
	if sched.Err != "terminated" || sched.Delay != 2*time.Second {
		t.Fatalf("got %#v", sched)
	}

	comp, ok := doc(t, `{"type": "summarization_retry_attempt_start", "source": "compaction", "reason": "threshold"}`).(agent.Retry)
	if !ok || comp.Phase != agent.RetryAttempt || comp.Kind != agent.RetryComp {
		t.Fatalf("doc: the compaction source, got %#v", comp)
	}

	branch, ok := doc(t, `{"type": "summarization_retry_attempt_start", "source": "branchSummary"}`).(agent.Retry)
	if !ok || branch.Kind != agent.RetryBranch {
		t.Fatalf("doc: a branch summary says so, and has no reason field: %#v", branch)
	}

	fin, ok := doc(t, `{"type": "summarization_retry_finished"}`).(agent.Retry)
	if !ok || fin.Phase != agent.RetryFinished {
		t.Fatalf("doc: summarization_retry_finished must close the loop, got %#v", fin)
	}
}

// TestTheDocumentedExtensionErrorIsDrawn: an extension that throws says
// nothing anywhere else. This is the whole channel.
func TestTheDocumentedExtensionErrorIsDrawn(t *testing.T) {
	e, ok := doc(t, `{
  "type": "extension_error",
  "extensionPath": "/path/to/extension.ts",
  "event": "tool_call",
  "error": "Error message..."
}`).(agent.ExtensionError)
	if !ok {
		t.Fatal("doc: extension_error example must become an ExtensionError")
	}
	if e.Path != "/path/to/extension.ts" || e.Event != "tool_call" || e.Err != "Error message..." {
		t.Fatalf("all three fields are what the reader needs to find the culprit: %#v", e)
	}
}

// TestTheDocumentedExtensionUIRequests: the doc's ten methods, asked and
// answered. Four are dialogs and must arrive intact — an answer needs the id,
// the method decides which response field pi reads, and a dropped request
// parks the extension that sent it. Two are fire-and-forget notices. Three
// are pinned as ignored in the test above.
func TestTheDocumentedExtensionUIRequests(t *testing.T) {
	confirm, ok := doc(t, `{
  "type": "extension_ui_request",
  "id": "uuid-2",
  "method": "confirm",
  "title": "Clear session?",
  "message": "All messages will be lost.",
  "timeout": 5000
}`).(agent.UIDialog)
	if !ok {
		t.Fatal("doc: a confirm request is a dialog and must not be dropped")
	}
	if confirm.ID != "uuid-2" || confirm.Method != "confirm" || confirm.Title != "Clear session?" || confirm.Message != "All messages will be lost." {
		t.Fatalf("got %#v", confirm)
	}
	if confirm.Timeout != 5*time.Second {
		t.Fatalf("the timeout is pi's deadline and the reader should see it: %v", confirm.Timeout)
	}

	sel, ok := doc(t, `{"type": "extension_ui_request", "id": "uuid-1", "method": "select", "title": "Allow dangerous command?", "options": ["Allow", "Block"], "timeout": 10000}`).(agent.UIDialog)
	if !ok || len(sel.Options) != 2 || sel.Options[0] != "Allow" || sel.Options[1] != "Block" {
		t.Fatalf("doc: the options are the answer set, in pi's order: %#v", sel)
	}

	in, ok := doc(t, `{"type": "extension_ui_request", "id": "uuid-3", "method": "input", "title": "Enter a value", "placeholder": "type something..."}`).(agent.UIDialog)
	if !ok || in.Placeholder != "type something..." || in.Timeout != 0 {
		t.Fatalf("doc: input has a placeholder and no timeout, got %#v", in)
	}

	ed, ok := doc(t, `{"type": "extension_ui_request", "id": "uuid-4", "method": "editor", "title": "Edit some text", "prefill": "Line 1\nLine 2\nLine 3"}`).(agent.UIDialog)
	if !ok || ed.Prefill != "Line 1\nLine 2\nLine 3" {
		t.Fatalf("doc: the editor's prefill survives, newlines and all: %#v", ed)
	}
	if ed.Timeout != 0 {
		t.Fatalf("editor waits forever; that is why it must be answerable: %v", ed.Timeout)
	}

	note, ok := doc(t, `{"type": "extension_ui_request", "id": "uuid-5", "method": "notify", "message": "Command blocked by user", "notifyType": "warning"}`).(agent.UINotify)
	if !ok || note.Message != "Command blocked by user" || note.Kind != "warning" {
		t.Fatalf("doc: notify is dropped nowhere — our own commands report through it: %#v", note)
	}

	st, ok := doc(t, `{"type": "extension_ui_request", "id": "uuid-6", "method": "setStatus", "statusKey": "my-ext", "statusText": "Turn 3 running..."}`).(agent.UIStatus)
	if !ok || st.Key != "my-ext" || st.Text != "Turn 3 running..." {
		t.Fatalf("doc: setStatus carries a key and a text, got %#v", st)
	}
	// Clearing omits statusText on the wire; it must read as "clear", not as
	// a request with a missing field.
	clear, ok := doc(t, `{"type": "extension_ui_request", "id": "uuid-6", "method": "setStatus", "statusKey": "my-ext"}`).(agent.UIStatus)
	if !ok || clear.Key != "my-ext" || clear.Text != "" {
		t.Fatalf("doc: an omitted statusText clears the entry, got %#v", clear)
	}
}

// TestTheDocumentedSessionReplies: switch_session and new_session answer with
// success + data.cancelled. A cancelled one is a success that did nothing,
// which is exactly the reply a reader must not miss — the transcript says one
// conversation and the model remembers another.
func TestTheDocumentedSessionReplies(t *testing.T) {
	moved, ok := doc(t, `{"type": "response", "command": "switch_session", "success": true, "data": {"cancelled": false}}`).(agent.SessionMoved)
	if !ok || moved.Command != "switch_session" || moved.Cancelled {
		t.Fatalf("doc: a completed switch, got %#v", moved)
	}
	refused, ok := doc(t, `{"type": "response", "command": "switch_session", "success": true, "data": {"cancelled": true}}`).(agent.SessionMoved)
	if !ok || !refused.Cancelled {
		t.Fatalf("doc: an extension-vetoed switch, got %#v", refused)
	}
	fresh, ok := doc(t, `{"type": "response", "command": "new_session", "success": true, "data": {"cancelled": false}}`).(agent.SessionMoved)
	if !ok || fresh.Command != "new_session" || fresh.Cancelled {
		t.Fatalf("doc: a new session, got %#v", fresh)
	}

	// A hard failure is not a cancellation: it surfaces as the failure it is.
	f, ok := doc(t, `{"type": "response", "command": "switch_session", "success": false, "error": "Session not found: /nope.jsonl"}`).(agent.Failed)
	if !ok || !strings.Contains(f.Err.Error(), "Session not found") {
		t.Fatalf("a failed switch must be visible, not silent: %#v", f)
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
