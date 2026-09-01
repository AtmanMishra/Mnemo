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
		// A command acknowledgement is only interesting when it failed.
		if ok, is := v["success"].(bool); is && !ok {
			return agent.Failed{Err: errors.New(errText(v))}
		}
		return nil

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
func Spawn(repoRoot, cwd, sessionFile string) (*Session, error) {
	entry := filepath.Join(repoRoot, "agent", "bin", "mnemo.ts")
	if _, err := os.Stat(entry); err != nil {
		return nil, fmt.Errorf("no agent script at %s (--repo must point at the repository root, not a subdirectory)", entry)
	}
	args := []string{entry, "--mode", "rpc", "--no-builtin-tools"}
	if sessionFile != "" {
		args = append(args, "--session", sessionFile)
	}
	// SAFETY: args is a slice (never a shell string) and entry is a file path
	// resolved under the operator-provided --repo root; exec.Command passes
	// argv verbatim with no shell interpretation, so a hostile repo path
	// cannot execute extra commands.
	cmd := exec.Command("node", args...)
	cmd.Dir = cwd
	return Start(cmd)
}

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
