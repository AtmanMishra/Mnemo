// Package agent is the boundary between the interface and whatever actually
// runs the conversation.
//
// The interface is four methods and a handful of messages. Everything the TUI
// knows about the agent is in this file, which is what lets the backend be
// replaced — a live pi RPC process, a replayed session file, a scripted demo
// — without the transcript, the keys or the layout knowing.
package agent

import tea "charm.land/bubbletea/v2"

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

// Agent runs turns.
type Agent interface {
	// Send starts a turn. The returned command must emit Started first and
	// exactly one of Done or Failed last.
	Send(prompt string) tea.Cmd

	// Steer interrupts the running turn and delivers text to it.
	Steer(prompt string) tea.Cmd

	// Interrupt stops the running turn without sending anything.
	Interrupt() tea.Cmd

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
