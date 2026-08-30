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
func (o Offline) Model() string        { return "offline" }
func (o Offline) Close() error         { return nil }
