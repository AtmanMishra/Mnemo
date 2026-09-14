package app

import (
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/agent"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/keymap"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/overlay"
)

// --- questions from an extension ------------------------------------------
//
// pi's extension UI protocol lets an extension in the agent process ask the
// person at this end something and block on the answer. Nothing here answered
// it, so every request was dropped: our own /hook, /schedule, /trigger and
// /now commands answer through ui.notify and looked like no-ops, and a
// dialog — which pi parks until a response arrives, forever in `editor`'s
// case — hung the extension and the turn with it.
//
// The mapping is: a choice is a list, so select and confirm are the overlay
// package's own shape; text is the prompt's, and input and editor go there
// because the prompt is this interface's one text editor (multi-line, prefilled
// and all). notify and setStatus never reach this file — they are fire and
// forget, and the status line is where they land.

const (
	dialogYes = "yes"
	dialogNo  = "no"
)

// dialogWaiting reports whether an extension is blocked on this interface.
//
// Used by the key dispatcher, not by the dialog code: while a question is up
// it owns the keyboard, so a global chord cannot take the question off the
// screen while pi waits on the answer.
func (m *Model) dialogWaiting() bool { return m.dialog != nil }

// answeringText reports whether the question on screen is a text one, i.e.
// whether the prompt — not an overlay — is holding it.
func (m *Model) answeringText() bool {
	if m.dialog == nil {
		return false
	}
	return m.dialog.Method == "input" || m.dialog.Method == "editor"
}

// askDialog puts a question from an extension on screen.
//
// One at a time and queued behind each other: a second question that replaced
// the first would leave the first extension parked with nothing on screen to
// answer it.
func (m *Model) askDialog(d agent.UIDialog) tea.Cmd {
	if m.dialogWaiting() {
		m.queue = append(m.queue, d)
		return nil
	}
	return m.showDialog(d)
}

// showDialog renders one question with the machinery that already exists for
// its shape, and returns whatever focusing that needs.
func (m *Model) showDialog(d agent.UIDialog) tea.Cmd {
	m.dialog = &d
	if d.Method == "select" || d.Method == "confirm" {
		m.ov = dialogOverlay(d)
		m.armOverlay()
		return nil
	}
	// input and editor: the prompt is the editor. Whatever the reader was
	// writing is put aside first — answering a question must not eat a
	// half-written message — and the prefill of an editor goes in.
	if v := m.prompt.Value(); strings.TrimSpace(v) != "" {
		m.draft = v
		m.prompt.SetValue("")
	}
	m.prompt.SetValue(d.Prefill) // no-op for input; the starting text for editor
	m.prompt.Suggest(nil)        // a menu left over from the draft is not this question's
	m.mention = false
	m.ov = nil // a modal over the question is the question unseen
	m.mode = keymap.Insert
	m.layout()
	return m.prompt.Focus()
}

// dialogOverlay renders a select or confirm as the list of choices it is.
//
// The rows' IDs are the answers themselves, because that is what goes back on
// the wire: a select option verbatim, or yes/no for a confirm.
func dialogOverlay(d agent.UIDialog) *overlay.Model {
	var items []overlay.Item
	if d.Method == "confirm" {
		items = []overlay.Item{
			{Label: dialogYes, ID: dialogYes},
			{Label: dialogNo, ID: dialogNo},
		}
	} else {
		items = make([]overlay.Item, 0, len(d.Options))
		for _, o := range d.Options {
			items = append(items, overlay.Item{Label: o, ID: o})
		}
	}
	ov := overlay.NewList(overlay.Dialog, dialogPurpose(d), items,
		"The agent asked a select with no options in it.",
		"Answering without a choice cancels it — enter does that.",
	)
	ov.SetFooter(dialogFooter(d))
	return ov
}

// dialogPurpose is the question itself: the title, the message an extension
// sent under it, and the deadline if there is one. The deadline is shown
// because pi auto-resolves a timed dialog with the default and this side
// cannot see that happen — saying "auto-resolves in 10s" is the difference
// between a dialog that vanished and a dialog that was ignored.
func dialogPurpose(d agent.UIDialog) string {
	what := d.Title
	if what == "" {
		what = "the agent is asking"
	}
	if d.Message != "" {
		what += " · " + d.Message
	}
	if d.Timeout > 0 {
		secs := int(d.Timeout / time.Second)
		if secs < 1 {
			secs = 1
		}
		what += " · auto-resolves in " + itoa(secs) + "s"
	}
	return what
}

func dialogFooter(d agent.UIDialog) string {
	if d.Method == "confirm" {
		return "enter answers the highlighted row · ↑ ↓ move · esc cancels"
	}
	return "enter picks the highlighted option · ↑ ↓ move · esc cancels"
}

// chooseDialog answers a select or confirm with the row under the cursor.
func (m *Model) chooseDialog() tea.Cmd {
	d := m.dialog
	if d == nil || m.ov == nil {
		return nil
	}
	id, ok := m.ov.Selected()
	if !ok {
		return nil
	}
	if d.Method == "confirm" {
		return m.finishDialog(d, agent.UIAnswer{Confirmed: id == dialogYes})
	}
	return m.finishDialog(d, agent.UIAnswer{Value: id})
}

// answerInput sends what is in the prompt back as the answer to a text
// question. The value is taken verbatim: an empty answer is an answer.
func (m *Model) answerInput() tea.Cmd {
	d := m.dialog
	if d == nil {
		return nil
	}
	// Trailing newlines only: an editor's inner blank lines are its value.
	value := strings.TrimRight(m.prompt.Value(), "\n")
	return m.finishDialog(d, agent.UIAnswer{Value: value})
}

// cancelDialog answers the question on screen with pi's cancelled:true — the
// one response that means "dismissed", as opposed to an answered "no" or "".
func (m *Model) cancelDialog() tea.Cmd {
	if m.dialog == nil {
		return nil
	}
	return m.finishDialog(m.dialog, agent.UIAnswer{Cancelled: true})
}

// finishDialog sends an answer, clears the question, and shows the next one.
//
// It is the one exit, so no path can leave a question on screen that has
// already been answered — or clear the question without answering it.
func (m *Model) finishDialog(d *agent.UIDialog, a agent.UIAnswer) tea.Cmd {
	if d == nil {
		return nil
	}
	text := m.answeringText()
	m.dialog = nil
	if m.ov != nil && m.ov.Kind == overlay.Dialog {
		m.ov = nil
	}
	if text {
		// The prompt was the answer box; put back what it displaced.
		m.prompt.SetValue(m.draft)
		m.draft = ""
		m.mode = keymap.Insert
	}
	m.layout()
	return tea.Batch(m.agent.Answer(*d, a), m.notify(answerWord(*d, a)), m.nextDialog())
}

// abandonDialogs drops every question on the interface without answering it.
//
// It exists for the abort path and only for it: pi resolves a waiting dialog
// with the default when the turn is aborted, so a question left on screen
// after an interrupt is one nobody is waiting for. Sending a response then
// would be answering a promise that no longer exists.
func (m *Model) abandonDialogs() {
	text := m.answeringText()
	m.dialog, m.queue = nil, nil
	if m.ov != nil && m.ov.Kind == overlay.Dialog {
		m.ov = nil
	}
	if text {
		m.prompt.SetValue(m.draft)
	}
	m.draft = ""
	m.layout()
}

// nextDialog shows the next question, if one is waiting.
func (m *Model) nextDialog() tea.Cmd {
	if len(m.queue) == 0 {
		return nil
	}
	d := m.queue[0]
	m.queue = m.queue[1:]
	return m.showDialog(d)
}

// answerLine is the question's line on the status band while the prompt holds
// it. A question whose title is nowhere on screen is a question the reader
// answers by guessing.
func (m *Model) answerLine() string {
	d := m.dialog
	if d == nil {
		return ""
	}
	what := d.Title
	if what == "" {
		what = "the agent is asking"
	}
	if d.Placeholder != "" {
		what += " (" + d.Placeholder + ")"
	}
	hint := "enter answers · esc cancels"
	if d.Method == "editor" && strings.Contains(d.Prefill, "\n") {
		// The prefill is multi-line and the prompt can hold it, but enter
		// is the answer key, so new lines go in by pasting.
		hint = "enter answers · paste for new lines · esc cancels"
	}
	return "the agent asks: " + what + " · " + hint
}

// answerWord is the one-line receipt that goes on the status band when a
// question is resolved. A dialog that closes silently is indistinguishable
// from one that was ignored.
func answerWord(d agent.UIDialog, a agent.UIAnswer) string {
	switch {
	case a.Cancelled:
		return "answered " + d.Method + ": cancelled"
	case d.Method == "confirm":
		if a.Confirmed {
			return "answered confirm: yes"
		}
		return "answered confirm: no"
	}
	if a.Value == "" {
		return "answered " + d.Method + ": (empty)"
	}
	return "answered " + d.Method + ": " + oneLine(a.Value)
}
