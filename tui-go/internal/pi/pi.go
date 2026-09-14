// Package pi drives the agent through pi's line-delimited JSON RPC mode.
//
// ParseEvent is pure, so the entire protocol layer is testable from recorded
// lines: no child process, no API key, no network. That is deliberate — the
// parts of this that break are the parts that are hard to run.
package pi

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/agent"
)

// ParseEvent turns one protocol line into at most one interface message.
//
// An unknown event type is ignored on purpose: pi adds events between
// versions, and an unrecognised one is not an error.
func ParseEvent(v map[string]any) tea.Msg {
	switch str(v, "type") {
	case "agent_start":
		return agent.Started{}

	case "agent_settled":
		return agent.Done{}

	case "response":
		// A command acknowledgement is only interesting when it failed —
		// except for the answers we asked for. get_commands carries data,
		// so a successful reply to it is not an acknowledgement: it is the
		// list of commands the agent implements. switch_session and
		// new_session carry `data.cancelled`: a success that did nothing is
		// the one reply the reader must not miss.
		if ok, is := v["success"].(bool); is && !ok {
			if str(v, "command") == "get_commands" {
				// Non-fatal on purpose: a backend that will not answer
				// leaves the interface with exactly the list it already
				// had, which is a working interface.
				return nil
			}
			return agent.Failed{Err: errors.New(errText(v))}
		}
		switch str(v, "command") {
		case "get_commands":
			return agent.Commands{List: commandList(v)}
		case "switch_session", "new_session":
			data, _ := v["data"].(map[string]any)
			return agent.SessionMoved{Command: str(v, "command"), Cancelled: boolean(data, "cancelled")}
		}
		return nil

	case "extension_ui_request":
		return uiRequest(v)

	case "compaction_start":
		return agent.Compaction{Started: true, Reason: str(v, "reason")}

	case "compaction_end":
		// result is null when compaction was aborted or failed, so the token
		// counts are read defensively and stay zero — "compacted, sizes
		// unknown" is said differently from "compacted, 150k → 32k".
		res, _ := v["result"].(map[string]any)
		return agent.Compaction{
			Reason:       str(v, "reason"),
			Aborted:      boolean(v, "aborted"),
			WillRetry:    boolean(v, "willRetry"),
			Err:          str(v, "errorMessage"),
			TokensBefore: num(res, "tokensBefore"),
			TokensAfter:  num(res, "estimatedTokensAfter"),
		}

	case "auto_retry_start":
		return agent.Retry{
			Phase: agent.RetryStart, Kind: agent.RetryTurn,
			Attempt: num(v, "attempt"), MaxAttempts: num(v, "maxAttempts"),
			Delay: millis(v, "delayMs"), Err: str(v, "errorMessage"),
		}

	case "auto_retry_end":
		return agent.Retry{
			Phase: agent.RetryEnd, Kind: agent.RetryTurn,
			Attempt: num(v, "attempt"),
			OK:      boolean(v, "success"), Final: str(v, "finalError"),
		}

	case "summarization_retry_scheduled":
		return agent.Retry{
			Phase: agent.RetryScheduled,
			// RetrySummary, not RetryComp: nothing has said yet whether it
			// is the compaction summary or a branch summary being retried;
			// the attempt_start event that follows is where the source
			// arrives.
			Kind:    agent.RetrySummary,
			Attempt: num(v, "attempt"), MaxAttempts: num(v, "maxAttempts"),
			Delay: millis(v, "delayMs"), Err: str(v, "errorMessage"),
		}

	case "summarization_retry_attempt_start":
		kind := agent.RetryComp
		if src := str(v, "source"); src != "" {
			kind = src // "compaction" | "branchSummary"
		}
		return agent.Retry{Phase: agent.RetryAttempt, Kind: kind}

	case "summarization_retry_finished":
		return agent.Retry{Phase: agent.RetryFinished, Kind: agent.RetrySummary}

	case "extension_error":
		return agent.ExtensionError{
			Path: str(v, "extensionPath"), Event: str(v, "event"), Err: str(v, "error"),
		}

	case "message_update":
		ev, _ := v["assistantMessageEvent"].(map[string]any)
		if ev == nil {
			return nil
		}
		kind := str(ev, "type")
		delta := first(str(ev, "delta"), str(ev, "text"), str(ev, "thinking"))
		if delta == "" {
			return nil
		}
		switch {
		case strings.Contains(kind, "thinking"), strings.Contains(kind, "reasoning"):
			return agent.Think{Text: delta}
		case strings.Contains(kind, "text"):
			return agent.Text{Text: delta}
		}
		return nil

	case "tool_execution_start":
		return agent.ToolStart{
			ID:   str(v, "toolCallId"),
			Name: str(v, "toolName"),
			Args: SummariseArgs(v["args"]),
		}

	case "tool_execution_end":
		isErr, _ := v["isError"].(bool)
		out := ResultText(v["result"])
		return agent.ToolEnd{
			ID:     str(v, "toolCallId"),
			Detail: summary(out, isErr),
			OK:     !isErr,
			Out:    out,
		}

	case "turn_end":
		msg, _ := v["message"].(map[string]any)
		usage, _ := msg["usage"].(map[string]any)
		cost, _ := usage["cost"].(map[string]any)
		return agent.Stats{TurnStats: agent.TurnStats{
			Provider:  str(msg, "provider"),
			Model:     str(msg, "model"),
			TokensIn:  num(usage, "input"),
			TokensOut: num(usage, "output"),
			Cost:      f64(cost, "total"),
		}}
	}
	return nil
}

// commandList reads the get_commands answer.
//
// pi's docs mark description, location and path optional, so a command with
// only a name is still a command — the palette has a row for it either way. An
// entry with no name is the one thing that cannot be shown or run, and is
// dropped rather than rendered as an empty row.
//
// The docs print location and path flat, and the installed pi (0.84) sends
// neither: it nests them in a sourceInfo object (`scope` and `path`). Both are
// read, because a row that says where a command came from is the point, and
// which of the two shapes carries it is pi's business, not ours.
func commandList(v map[string]any) []agent.CommandInfo {
	data, _ := v["data"].(map[string]any)
	raw, _ := data["commands"].([]any)
	out := make([]agent.CommandInfo, 0, len(raw))
	for _, r := range raw {
		m, _ := r.(map[string]any)
		if str(m, "name") == "" {
			continue
		}
		out = append(out, agent.CommandInfo{
			Name:        str(m, "name"),
			Description: str(m, "description"),
			Source:      str(m, "source"),
			Location:    first(str(m, "location"), nested(m, "sourceInfo", "scope")),
			Path:        first(str(m, "path"), nested(m, "sourceInfo", "path")),
		})
	}
	return out
}

// uiRequest reads one extension UI request — a question pi is waiting on an
// answer to, or a fire-and-forget notice.
//
// The protocol's ten methods split three ways here:
//
//   - select, confirm, input and editor are dialogs. They become a UIDialog
//     and the interface must answer with a matching id, or the extension
//     parks.
//   - notify and setStatus are fire-and-forget. They become messages too,
//     because dropping them is what made our own /hook, /schedule, /trigger
//     and /now commands look like no-ops: they report through ui.notify and
//     nothing was reading it.
//   - setWidget, setTitle and set_editor_text are deliberately ignored.
//     setWidget wants a panel above or below the editor — a region this
//     interface does not have and would not invent for a message nothing
//     depends on; setTitle wants the terminal window title, which View()
//     already owns (an extension renaming the window would fight the
//     program for it); set_editor_text would type into the reader's editor,
//     i.e. put words in their mouth. All three are fire-and-forget and none
//     of them changes what the agent does, so ignoring them loses no
//     function — and ignoring them is not the same as dropping a question.
func uiRequest(v map[string]any) tea.Msg {
	id, method := str(v, "id"), str(v, "method")
	switch method {
	case "select", "confirm", "input", "editor":
		d := agent.UIDialog{
			ID: id, Method: method,
			Title:       str(v, "title"),
			Message:     str(v, "message"),
			Placeholder: str(v, "placeholder"),
			Prefill:     str(v, "prefill"),
			Timeout:     millis(v, "timeout"),
		}
		if opts, ok := v["options"].([]any); ok {
			d.Options = make([]string, 0, len(opts))
			for _, o := range opts {
				d.Options = append(d.Options, ResultText(o))
			}
		}
		return d
	case "notify":
		return agent.UINotify{Message: str(v, "message"), Kind: str(v, "notifyType")}
	case "setStatus":
		return agent.UIStatus{Key: str(v, "statusKey"), Text: str(v, "statusText")}
	}
	return nil
}

// nested reads one string field out of a sub-object.
func nested(v map[string]any, obj, key string) string {
	sub, _ := v[obj].(map[string]any)
	return str(sub, key)
}

// summary is the one line a collapsed tool block shows.
//
// It carries the RESULT rather than the invocation, because that is what
// tells you whether opening the block is worth it.
func summary(out string, isErr bool) string {
	out = strings.TrimSpace(out)
	if out == "" {
		if isErr {
			return "failed"
		}
		return "ok"
	}
	lines := strings.Count(out, "\n") + 1
	if lines > 1 {
		return fmt.Sprintf("%d ln", lines)
	}
	if len([]rune(out)) > 40 {
		return string([]rune(out)[:37]) + "…"
	}
	return out
}

// ResultText renders whatever a tool returned as text.
//
// pi's result is a plain string, a content array of typed blocks, or an
// object. An unknown shape is shown as its JSON rather than dropped: a tool
// block that silently shows nothing is indistinguishable from one that ran
// and said nothing.
func ResultText(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case []any:
		var b strings.Builder
		for _, p := range t {
			b.WriteString(ResultText(p))
		}
		return b.String()
	case map[string]any:
		if c, ok := t["content"]; ok {
			return ResultText(c)
		}
		kind := str(t, "type")
		if kind == "text" {
			if s, ok := t["text"].(string); ok {
				return s
			}
		}
		if kind != "" {
			// An image block has no text; say what it is rather than nothing.
			return "[" + kind + "]"
		}
	}
	b, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return string(b)
}

// SummariseArgs renders tool arguments on one line.
func SummariseArgs(v any) string {
	m, ok := v.(map[string]any)
	if !ok {
		if v == nil {
			return ""
		}
		return ResultText(v)
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	// Sorted, so the same call renders the same way every time. Map order in
	// Go is randomised, and a tool block that reorders its own arguments
	// between frames looks like it is doing something.
	sortStrings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		val := ResultText(m[k])
		val = strings.ReplaceAll(val, "\n", " ")
		if len([]rune(val)) > 60 {
			val = string([]rune(val)[:60])
		}
		parts = append(parts, k+"="+val)
	}
	return strings.Join(parts, " ")
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

// Session is a live agent process.
type Session struct {
	cmd   *exec.Cmd
	stdin io.WriteCloser
	msgs  chan tea.Msg

	mu     sync.Mutex
	nextID int
	model  string
	closed bool
}

// Spawn starts `node <repo>/agent/bin/mnemo.ts --mode rpc` in cwd.
//
// cwd is what makes the agent work in the project you picked rather than the
// one you launched in: pi derives its session directory from the working
// directory, so resuming without it forks the session into the wrong project.
//
// The trust decision always goes on the command line, either way, because
// the default in RPC mode is to say nothing to anyone: an unstated decision
// is a project whose .pi/settings.json, .pi/extensions and .agents/skills
// silently do not load, and the failure mode of that is a project's own
// guardrail extension not running while AGENTS.md still loads, so a partial
// load looks total.
func Spawn(repoRoot, cwd, sessionFile string, trust Trust) (*Session, error) {
	entry := filepath.Join(repoRoot, "agent", "bin", "mnemo.ts")
	if _, err := os.Stat(entry); err != nil {
		return nil, fmt.Errorf("no agent script at %s (--repo must point at the repository root, not a subdirectory)", entry)
	}
	// SAFETY: args is a slice (never a shell string) and entry is a file path
	// resolved under the operator-provided --repo root; exec.Command passes
	// argv verbatim with no shell interpretation, so a hostile repo path
	// cannot execute extra commands.
	cmd := exec.Command("node", spawnArgs(repoRoot, sessionFile, trust)...)
	cmd.Dir = cwd
	cmd.Env = spawnEnv()
	return Start(cmd)
}

// spawnArgs is the agent's argv, split out from Spawn so the flags — in
// particular --approve/--no-approve, which decide whether a project's own
// settings, extensions and skills load — are assertable without starting a
// node process.
func spawnArgs(repoRoot, sessionFile string, trust Trust) []string {
	args := []string{
		filepath.Join(repoRoot, "agent", "bin", "mnemo.ts"),
		"--mode", "rpc", "--no-builtin-tools",
		trust.Flag(),
	}
	if sessionFile != "" {
		args = append(args, "--session", sessionFile)
	}
	return args
}

// spawnEnv is the environment the agent runs in.
//
// MNEMO_APPROVAL_MODE=interactive is the reason this exists. The approval
// gate reads it (agent/src/approval.ts) and decides from it whether an "ask"
// tier has anyone to ask; without it a spawned child with no TTY takes the
// fail-open path, where the ask tier of ~/.mnemo/permissions.json silently
// becomes allow for bash_exec, write_file, apply_edit and ipy_run. The TUI
// can answer dialogs now, so the asking path is exactly the path it should
// take. A value already in the parent's environment is dropped rather than
// inherited: this process knows what mode its own child runs in.
func spawnEnv() []string {
	parent := os.Environ()
	out := make([]string, 0, len(parent)+1)
	for _, e := range parent {
		if strings.HasPrefix(strings.ToUpper(e), strings.ToUpper(approvalEnv+"=")) {
			continue
		}
		out = append(out, e)
	}
	return append(out, approvalEnv+"=interactive")
}

// approvalEnv is the switch the gate reads. MNEMO_ is the current spelling;
// the gate also accepts the legacy SEA_ one, which we simply never set.
const approvalEnv = "MNEMO_APPROVAL_MODE"

// Start attaches to any command speaking the protocol. Tests use a fake.
func Start(cmd *exec.Cmd) (*Session, error) {
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	s := &Session{cmd: cmd, stdin: stdin, msgs: make(chan tea.Msg, 256), nextID: 1, model: "pi"}
	go s.read(stdout)
	// One question, asked once, at the start: which commands do you implement?
	// pi is the authority on that — extension commands like /hook, prompt
	// templates, /skill:name — and asking is the only way a client can know
	// them rather than keep a copy that drifts.
	//
	// The answer is not required. A write that fails, a backend too old to
	// answer, a reply that never comes: the interface keeps the list it
	// discovered on disk and carries on, so the error is dropped here on
	// purpose.
	_ = s.write(map[string]any{"type": "get_commands"})
	return s, nil
}

func (s *Session) read(r io.Reader) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var v map[string]any
		if json.Unmarshal([]byte(line), &v) != nil {
			// A non-JSON line is stray output, not a protocol failure.
			continue
		}
		msg := ParseEvent(v)
		if msg == nil {
			continue
		}
		if st, ok := msg.(agent.Stats); ok && st.Model != "" {
			s.mu.Lock()
			s.model = st.Model
			s.mu.Unlock()
		}
		s.emit(msg)
	}
	s.emit(agent.Failed{Err: errors.New("the agent process exited")})
}

func (s *Session) emit(msg tea.Msg) {
	defer func() { _ = recover() }() // a send on a closed channel is not worth a crash
	s.msgs <- msg
}

// Next blocks until the process says something.
func (s *Session) Next() tea.Cmd {
	return func() tea.Msg { return <-s.msgs }
}

func (s *Session) write(cmd map[string]any) error {
	s.mu.Lock()
	cmd["id"] = fmt.Sprint(s.nextID)
	s.nextID++
	s.mu.Unlock()
	return s.send(cmd)
}

// send marshals and writes one line, preserving whatever id it carries.
//
// write's id is this session's request counter — pi echoes it back so a
// reply can be matched — but not every message is a request: an extension UI
// response is keyed by the id PI chose when it asked, and overwriting it
// would answer nothing. Hence two functions, one line of difference.
func (s *Session) send(cmd map[string]any) error {
	b, err := json.Marshal(cmd)
	if err != nil {
		return err
	}
	_, err = s.stdin.Write(append(b, '\n'))
	return err
}

func (s *Session) command(kind, message string) tea.Cmd {
	return func() tea.Msg {
		c := map[string]any{"type": kind}
		if message != "" {
			c["message"] = message
		}
		if err := s.write(c); err != nil {
			return agent.Failed{Err: err}
		}
		return nil
	}
}

// Send starts a turn.
func (s *Session) Send(prompt string) tea.Cmd { return s.command("prompt", prompt) }

// Steer interrupts the running turn and delivers text to it.
func (s *Session) Steer(prompt string) tea.Cmd { return s.command("steer", prompt) }

// Interrupt stops the running turn.
func (s *Session) Interrupt() tea.Cmd { return s.command("abort", "") }

// SwitchSession loads a stored session file into the running conversation.
//
// The field is sessionPath, not sessionFile: that is the name in pi's command
// type (dist/modes/rpc/rpc-types.js) and the name its handler reads. The
// session file on disk is a .jsonl path either way.
//
// A refused switch (an extension vetoing it) is not an error: pi answers
// success with data.cancelled, and the interface says which of the two
// happened. A hard failure surfaces as agent.Failed through the response
// path, like every other command.
func (s *Session) SwitchSession(path string) tea.Cmd {
	return func() tea.Msg {
		if err := s.write(map[string]any{"type": "switch_session", "sessionPath": path}); err != nil {
			return agent.Failed{Err: err}
		}
		return nil
	}
}

// NewSession starts a fresh conversation on the backend.
func (s *Session) NewSession() tea.Cmd { return s.command("new_session", "") }

// Answer responds to a dialog from the extension UI protocol.
//
// The shape is decided by the method, because pi reads the response by it: a
// confirm is confirmed:true/false, select/input/editor carry value, and a
// dismissal is cancelled:true. Sending the wrong field leaves the promise on
// the other side unresolved until its timeout, which for `editor` never
// comes.
func (s *Session) Answer(d agent.UIDialog, a agent.UIAnswer) tea.Cmd {
	return func() tea.Msg {
		cmd := map[string]any{"type": "extension_ui_response", "id": d.ID}
		switch {
		case a.Cancelled:
			cmd["cancelled"] = true
		case d.Method == "confirm":
			cmd["confirmed"] = a.Confirmed
		default:
			cmd["value"] = a.Value
		}
		if err := s.send(cmd); err != nil {
			return agent.Failed{Err: err}
		}
		return nil
	}
}

// Model is the model the last turn ran on.
func (s *Session) Model() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.model
}

// Close kills the process.
func (s *Session) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	s.mu.Unlock()
	_ = s.stdin.Close()
	if s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
	}
	_ = s.cmd.Wait()
	return nil
}

func str(v map[string]any, k string) string {
	if v == nil {
		return ""
	}
	s, _ := v[k].(string)
	return s
}

func num(v map[string]any, k string) int {
	if v == nil {
		return 0
	}
	f, _ := v[k].(float64)
	return int(f)
}

func f64(v map[string]any, k string) float64 {
	if v == nil {
		return 0
	}
	f, _ := v[k].(float64)
	return f
}

// boolean reads a JSON bool that may be absent. An absent flag reads false,
// which is what pi's own defaults are (`aborted`, `willRetry`, `success`).
func boolean(v map[string]any, k string) bool {
	b, _ := v[k].(bool)
	return b
}

// millis reads a duration pi writes in milliseconds.
func millis(v map[string]any, k string) time.Duration {
	return time.Duration(num(v, k)) * time.Millisecond
}

func first(ss ...string) string {
	for _, s := range ss {
		if s != "" {
			return s
		}
	}
	return ""
}

func errText(v map[string]any) string {
	switch e := v["error"].(type) {
	case string:
		return e
	case nil:
		return str(v, "command") + " failed"
	default:
		return ResultText(e)
	}
}
