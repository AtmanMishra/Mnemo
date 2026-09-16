package agent

import (
	"errors"

	tea "charm.land/bubbletea/v2"
)

// Offline is the agent used when no backend is configured.
//
// It fails loudly and specifically rather than pretending to think. An
// interface that silently does nothing when its backend is missing is an
// interface that wastes the first ten minutes of everyone who tries it.
type Offline struct{ Reason string }

func (o Offline) Send(string) tea.Cmd {
	reason := o.Reason
	if reason == "" {
		reason = "no agent backend is configured"
	}
	return func() tea.Msg { return Failed{Err: errors.New(reason)} }
}

func (o Offline) Steer(string) tea.Cmd { return o.Send("") }
func (o Offline) Interrupt() tea.Cmd   { return nil }
func (o Offline) Next() tea.Cmd        { return nil }
func (o Offline) Model() string        { return "offline" }
func (o Offline) Close() error         { return nil }

// The session/UI/catalogue methods are no-ops offline on purpose. There is no
// process to switch, no conversation to start over, no extension to answer and
// no agent to ask which commands it implements: a Failed here would only tell
// the reader that the thing they just did on a backend-less dump failed, which
// they already know. The interface is still allowed to say what it did to its
// own view — and the disk scan is the command catalogue in this case, which is
// why an empty answer is the right one.
func (o Offline) SwitchSession(string) tea.Cmd      { return nil }
func (o Offline) NewSession() tea.Cmd               { return nil }
func (o Offline) ListCommands() tea.Cmd             { return nil }
func (o Offline) Compact(string) tea.Cmd            { return nil }
func (o Offline) ForkPoints() tea.Cmd               { return nil }
func (o Offline) Fork(string) tea.Cmd               { return nil }
func (o Offline) Answer(UIDialog, UIAnswer) tea.Cmd { return nil }
