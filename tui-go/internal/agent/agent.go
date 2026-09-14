// Package agent is the boundary between the interface and whatever actually
// runs the conversation.
//
// The interface is four methods and a handful of messages. Everything the TUI
// knows about the agent is in this file, which is what lets the backend be
// replaced — a live pi RPC process, a replayed session file, a scripted demo
// — without the transcript, the keys or the layout knowing.
package agent

import (
	"time"

	tea "charm.land/bubbletea/v2"
)

// Started says a turn has begun. The interface uses it to start animating.
type Started struct{}

// Think is a chunk of reasoning.
type Think struct{ Text string }

// Text is a chunk of the answer.
type Text struct{ Text string }

// ToolStart and ToolEnd bracket one tool call. They are separate messages
// because a call that is still running must be visible as running — a spinner
// that only appears after the result is a spinner nobody sees.
type ToolStart struct {
	ID   string
	Name string
	Args string
}

type ToolEnd struct {
	ID     string
	Detail string
	OK     bool

	// Out is the tool's full result, verbatim. Detail is the one-line
	// summary a collapsed block shows; Out is what opening it reveals — the
	// diff, the log, the stack trace, unshortened until the interface
	// decides how much of it is worth rendering.
	Out string
}

// Delegated reports a sub-agent run finishing under the current turn.
type Delegated struct {
	Label  string
	Model  string
	Detail string
	OK     bool
}

// Done ends the turn.
type Done struct{}

// Failed ends the turn badly.
type Failed struct{ Err error }

// Commands is the backend's own command list — the extension commands, prompt
// templates and skills it implements — in answer to a question the interface
// asked when the session started.
//
// It is the one part of the command surface a client cannot discover for
// itself: the files are on disk, but which of them pi will actually run, and
// under what name, is pi's answer to give.
type Commands struct{ List []CommandInfo }

// CommandInfo is one command as the backend describes it: the protocol's
// fields, not the interface's. Mapping them onto the interface's own list is
// the interface's job, because only it knows what a Kind or a Scope is.
type CommandInfo struct {
	Name        string
	Description string
	Source      string // "extension" | "prompt" | "skill"
	Location    string // where it came from: "user" | "project" | "path" (an inline extension says "temporary")
	Path        string // what it came from: a file, or pi's "<inline:…>" marker
}

// TurnStats is what a model round trip cost.
type TurnStats struct {
	Provider  string
	Model     string
	TokensIn  int
	TokensOut int
	Cost      float64
}

// Stats reports a completed round trip.
type Stats struct{ TurnStats }

// UIDialog is a question an extension asked through pi's extension UI
// protocol and is blocked on until it is answered — or until Timeout expires
// and pi resolves it with the default on its own.
//
// It is a question from INSIDE the agent process, which is why it needs a
// message of its own: the answer has to go back over the same pipe the turn
// is streaming on, keyed by ID, and a client that cannot answer it does not
// merely lose a notification — the extension parks forever (pi's `editor`
// has no timeout at all) and the turn with it.
type UIDialog struct {
	ID     string
	Method string // "select" | "confirm" | "input" | "editor"

	Title       string
	Message     string   // confirm: the sentence under the title
	Placeholder string   // input: a hint, never a value
	Prefill     string   // editor: the text to start from
	Options     []string // select: the choices, in pi's order

	// Timeout is how long pi will wait before resolving with the default.
	// Zero means it waits forever (every `editor` does).
	Timeout time.Duration
}

// UINotify is a fire-and-forget notification an extension sent. Kind is
// pi's notifyType: "info", "warning" or "error" (empty reads as info).
type UINotify struct {
	Message string
	Kind    string
}

// UIStatus sets or clears one named status entry an extension owns. Text is
// "" when the extension cleared its entry: the key stays, the text goes.
type UIStatus struct {
	Key  string
	Text string
}

// UIAnswer is the reader's response to a UIDialog.
//
// Exactly one of the three shapes is sent, decided by the dialog's method:
// confirm carries Confirmed, select/input/editor carry Value, and Cancelled
// is the dismissal for any of them. A dismissed confirm is `false` to the
// extension, a dismissed text ask is `undefined` — not the same thing, which
// is why Cancelled is separate from an answered "no"/"".
type UIAnswer struct {
	Value     string
	Confirmed bool
	Cancelled bool
}

// Compaction reports the context window being rewritten — the single most
// context-altering thing a session does, and until now the quietest.
type Compaction struct {
	Started   bool
	Reason    string // "manual" | "threshold" | "overflow"
	Aborted   bool
	WillRetry bool
	Err       string

	// TokensBefore and TokensAfter are zero when the payload had no result
	// (aborted or failed compactions have none).
	TokensBefore int
	TokensAfter  int
}

// Retry phases, as pi emits them.
const (
	RetryStart     = "start"     // auto_retry_start: a turn is being retried
	RetryEnd       = "end"       // auto_retry_end: it succeeded or gave up
	RetryScheduled = "scheduled" // summarization_retry_scheduled
	RetryAttempt   = "attempt"   // summarization_retry_attempt_start
	RetryFinished  = "finished"  // summarization_retry_finished
)

// Retry kinds, so "why is it sitting there" has an answer rather than three
// different phrasings of silence. RetrySummary is the one kind the wire does
// not name: summarization_retry_scheduled arrives before anything says
// whether it is a compaction or a branch summary, and guessing "compaction"
// for a branch summary would be a wrong answer to the only question the
// event exists to answer.
const (
	RetryTurn    = "turn"
	RetryComp    = "compaction"
	RetryBranch  = "branchSummary"
	RetrySummary = "summarization"
)

// Retry reports a transient failure being retried. It exists so that a
// provider hiccup does not look like a hang: the interface draws it on the
// status line (where the spinner would otherwise just keep turning) and says
// in the transcript what it was waiting on and how it ended.
type Retry struct {
	Phase       string // one of the Retry* phase constants
	Kind        string // one of the Retry* kind constants
	Attempt     int
	MaxAttempts int
	Delay       time.Duration
	Err         string

	OK    bool   // RetryEnd: the retry succeeded
	Final string // RetryEnd: the error it gave up with
}

// ExtensionError is the only signal this side gets that an extension threw.
// Without it an extension that dies takes its feature down silently, and the
// symptom is a command that does nothing.
type ExtensionError struct {
	Path  string
	Event string
	Err   string
}

// SessionMoved acknowledges switch_session or new_session. Cancelled means an
// extension vetoed it (pi answers success with cancelled: true): the session
// did NOT move, and saying so is the difference between a working resume and
// a transcript that quietly disagrees with the model's context.
type SessionMoved struct {
	Command   string // "switch_session" | "new_session"
	Cancelled bool
}

// Agent runs turns.
type Agent interface {
	// Send starts a turn. The returned command must emit Started first and
	// exactly one of Done or Failed last.
	Send(prompt string) tea.Cmd

	// Steer interrupts the running turn and delivers text to it.
	Steer(prompt string) tea.Cmd

	// Interrupt stops the running turn without sending anything.
	Interrupt() tea.Cmd

	// SwitchSession loads a stored session into the running conversation,
	// so the next prompt continues that one instead of whichever session
	// the process was launched with.
	SwitchSession(path string) tea.Cmd

	// NewSession starts a fresh conversation on the backend.
	NewSession() tea.Cmd

	// Answer responds to a dialog the backend is waiting on, keyed by the
	// dialog's ID. A late answer is harmless — pi has already resolved it.
	Answer(d UIDialog, a UIAnswer) tea.Cmd

	// Next blocks until the backend has something to say, and returns it as
	// a message. The caller re-issues it after every agent message, which is
	// how a streaming backend drives the loop without holding a reference to
	// the program.
	Next() tea.Cmd

	// Model names the model in use, for the header.
	Model() string

	// Close releases whatever the backend holds.
	Close() error
}
