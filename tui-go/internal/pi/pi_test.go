package pi

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
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
	// The fixtures are shell programs (printf/redirects/exit); run them from
	// a temp file instead of `sh -c <string>` so the command stays
	// parameterized — and the scripts are file literals in this test, never
	// user input, so there is nothing to inject either way.
	prog := filepath.Join(t.TempDir(), "fake-agent.sh")
	if err := os.WriteFile(prog, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	s, err := Start(exec.Command("sh", prog))
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
	s, err := Spawn(dir, dir, "", "", Trust{})
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

// TestTheSpawnArgsSayWhichWayTrustWent: the flag is never left off. In RPC
// mode an unstated decision means pi ignores the project's own settings,
// extensions, prompts and skills without saying so, so "no flag" is not a
// neutral choice — it is the silent one.
func TestTheSpawnArgsSayWhichWayTrustWent(t *testing.T) {
	yes := spawnArgs("/repo", "/s/session.jsonl", "", Trust{Approve: true})
	no := spawnArgs("/repo", "/s/session.jsonl", "", Trust{})

	if !hasArg(yes, "--approve") {
		t.Fatalf("an approved project must be passed --approve: %q", yes)
	}
	if hasArg(yes, "--no-approve") {
		t.Fatalf("both flags in one argv leaves the answer to pi's parser: %q", yes)
	}
	if !hasArg(no, "--no-approve") {
		t.Fatalf("a project with no recorded decision must be passed --no-approve: %q", no)
	}
	if hasArg(no, "--approve") {
		t.Fatalf("both flags in one argv leaves the answer to pi's parser: %q", no)
	}
	// And the rest of the contract still holds: rpc mode, no built-in tools,
	// the session file appended only when there is one.
	if !hasArg(no, "--mode") || !hasArg(no, "--no-builtin-tools") {
		t.Fatalf("the spawn args lost their mode: %q", no)
	}
	if !hasArg(yes, "/s/session.jsonl") {
		t.Fatalf("a resume must carry its session file: %q", yes)
	}
	if hasArg(spawnArgs("/repo", "", "", Trust{}), "--session") {
		t.Fatal("a fresh spawn must not carry an empty --session")
	}
}

// TestTheSpawnIsToldWhereTheSessionsAre: the browser and the agent must mean
// the same directory, and --session-dir is the only way the child can be told.
//
// The flag is left off when there is nothing to tell — session.SpawnDir
// returns "" for pi's own default — because passing the default path back
// would change it: --session-dir names the session directory itself, so pi
// would stop nesting new sessions under the project directory.
func TestTheSpawnIsToldWhereTheSessionsAre(t *testing.T) {
	over := filepath.Join(t.TempDir(), "elsewhere")
	with := spawnArgs("/repo", "", over, Trust{})
	if !hasArg(with, "--session-dir") {
		t.Fatalf("a configured session directory must reach the child: %q", with)
	}
	if val(with, "--session-dir") != over {
		t.Fatalf("--session-dir = %q, want %q", val(with, "--session-dir"), over)
	}
	if hasArg(spawnArgs("/repo", "", "", Trust{}), "--session-dir") {
		t.Fatal("with nothing configured there is nothing to pass: pi's own default is already the answer")
	}
}

// val is the argument after a flag, or "".
func val(args []string, flag string) string {
	for i, a := range args {
		if a == flag && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}

// TestAnExtensionLoadFailureExplainsItself: the shape pi prints at startup, the
// "Error: " prefix its diagnostics carry, a colourised line, and a load failure
// that is not a conflict — which must not be given the conflict's advice.
func TestAnExtensionLoadFailureExplainsItself(t *testing.T) {
	conflict := `Failed to load extension "/home/me/.pi/extensions/a.ts": Tool "grep" conflicts with /repo/agent/extensions/sea-tools-inline.ts`
	got, ok := extensionLoadFailure(conflict)
	if !ok {
		t.Fatal("the shape pi prints must be recognised")
	}
	for _, want := range []string{
		"/home/me/.pi/extensions/a.ts",
		`Tool "grep" conflicts with /repo/agent/extensions/sea-tools-inline.ts`,
		"remove or rename one of them",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("the transcript line lost %q: %q", want, got)
		}
	}
	if !strings.Contains(got, conflict) {
		t.Fatalf("pi's own words must arrive verbatim, got %q", got)
	}
	if strings.Contains(got, "\x1b") {
		t.Fatalf("a stray escape sequence looks like a rendering bug in us: %q", got)
	}

	if prefixed, ok := extensionLoadFailure("Error: " + conflict); !ok || !strings.HasPrefix(prefixed, `Failed to load`) {
		t.Fatalf("a diagnostics prefix must not become part of the message: %q (%v)", prefixed, ok)
	}
	if coloured, ok := extensionLoadFailure("\x1b[31m" + conflict + "\x1b[39m"); !ok || strings.Contains(coloured, "\x1b") {
		t.Fatalf("colour must be stripped, not shown: %q", coloured)
	}

	broken, ok := extensionLoadFailure(`Failed to load extension "/x/b.ts": Cannot find module "zod"`)
	if !ok {
		t.Fatal("a load failure that is not a conflict is still a load failure")
	}
	if strings.Contains(broken, "remove or rename one of them") {
		t.Fatalf("two extensions do not conflict here; that advice is about a different failure: %q", broken)
	}
	if !strings.Contains(broken, `Cannot find module "zod"`) {
		t.Fatalf("the reason must survive: %q", broken)
	}

	if _, ok := extensionLoadFailure("Error: model not found"); ok {
		t.Fatal("unrelated stderr is not an extension failure")
	}
}

func hasArg(args []string, want string) bool {
	for _, a := range args {
		if a == want {
			return true
		}
	}
	return false
}

// TestTheChildIsToldTheApprovalModeIsInteractive: the gate in the agent reads
// MNEMO_APPROVAL_MODE, and without it a child with no TTY takes the fail-open
// path — where the "ask" tier of ~/.mnemo/permissions.json silently becomes
// allow for bash_exec, write_file, apply_edit and ipy_run. A stale value in
// the parent's environment must not be inherited over it.
func TestTheChildIsToldTheApprovalModeIsInteractive(t *testing.T) {
	t.Setenv(approvalEnv, "off")             // a stale parent value
	t.Setenv("MNEMO_TEST_KEEP", "untouched") // and something innocent beside it

	env := spawnEnv()
	var seen int
	for _, e := range env {
		if strings.HasPrefix(strings.ToUpper(e), approvalEnv+"=") {
			seen++
			if e != approvalEnv+"=interactive" {
				t.Fatalf("the child must be told interactive, got %q", e)
			}
		}
	}
	if seen != 1 {
		t.Fatalf("%s appears %d times; the last one wins and there must be exactly one", approvalEnv, seen)
	}
	var kept bool
	for _, e := range env {
		if e == "MNEMO_TEST_KEEP=untouched" {
			kept = true
		}
	}
	if !kept {
		t.Fatal("the child's environment must still be the parent's, plus the one override")
	}
}
