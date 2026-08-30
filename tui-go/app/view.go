package app

import (
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/brand"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/chat"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/keymap"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/theme"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/ui"
	"github.com/charmbracelet/x/ansi"
)

// View composes the screen: header, body, prompt, status.
//
// Everything the terminal needs to know — alt screen, mouse mode, window
// title, where the cursor is — is DECLARED here rather than commanded from
// Update. Hiding the cursor in read mode is one field, and it is how the
// reader knows without looking that typing will not go into the prompt.
func (m *Model) View() tea.View {
	v := tea.NewView(m.compose())
	v.AltScreen = true
	v.WindowTitle = "mnemo · " + m.relCWD()
	if m.mouse {
		v.MouseMode = tea.MouseModeCellMotion
	} else {
		v.MouseMode = tea.MouseModeNone
	}
	if m.mode == keymap.Insert && m.ov == nil && !m.explorerFocus {
		v.Cursor = m.promptCursor()
	}
	return v
}

// promptCursor places the terminal cursor inside the prompt. The prompt's own
// cursor is relative to its box, so it is offset by where the box sits.
func (m *Model) promptCursor() *tea.Cursor {
	c := m.prompt.Cursor()
	if c == nil {
		return nil
	}
	c.Position.X += m.margin() + 2 // past the margin, the accent bar and its space
	c.Position.Y += m.promptTop()
	return c
}

func (m *Model) promptTop() int {
	top := m.h - 1 - m.prompt.Rows() - len(m.prompt.Queued())
	if m.spacious() {
		top-- // the blank row above the status band
	}
	return top + m.prompt.MenuTopOffset()
}

// margin is the air down each side of the screen.
//
// A terminal interface that starts at column 0 and ends at the last cell
// reads as cramped no matter what is in it — the glyphs sit against the
// window frame with nothing between them. Two columns fixes that. It shrinks
// on a narrow terminal, because at forty columns two spent on each side is
// a tenth of the screen given to air.
func (m *Model) margin() int {
	switch {
	case m.w >= 60:
		return 2
	case m.w >= 34:
		return 1
	default:
		return 0
	}
}

// spacious reports whether the screen is tall enough to afford blank rows
// between the regions. Below that they are the first thing to go: air is
// worth less than a line of transcript.
func (m *Model) spacious() bool { return m.h >= 18 }

func (m *Model) compose() string {
	rows := make([]string, 0, m.h)
	rows = append(rows, m.header())
	if m.spacious() {
		rows = append(rows, "")
	}
	// An overlay draws its own labelled rule, so the region rule would be a
	// blank row above it. A wasted row is a row of transcript.
	if m.ov == nil {
		rows = append(rows, m.bodyRule())
	}
	rows = append(rows, strings.Split(m.body(), "\n")...)
	if m.spacious() {
		rows = append(rows, "")
	}
	rows = append(rows, strings.Split(m.prompt.View(m.th, m.mode == keymap.Insert && m.ov == nil && !m.explorerFocus), "\n")...)
	if m.spacious() {
		rows = append(rows, "")
	}
	rows = append(rows, m.status())

	// The screen is exactly h rows, and the status band is always the last
	// one. Padding after it pushes it off the bottom, which is exactly how a
	// working status line becomes an invisible one.
	if len(rows) > m.h {
		rows = append(rows[:m.h-1], rows[len(rows)-1])
	}
	for len(rows) < m.h {
		rows = append(rows[:len(rows)-1], "", rows[len(rows)-1])
	}
	// The margin goes on last, so every region is laid out at the inner width
	// and none of them has to know about it.
	pad := strings.Repeat(" ", m.margin())
	for i, r := range rows {
		rows[i] = pad + r
	}
	return strings.Join(rows, "\n")
}

// inner is the drawable width once the margins are taken out.
func (m *Model) inner() int {
	w := m.w - m.margin()*2
	if w < 8 {
		w = 8
	}
	return w
}

func (m *Model) header() string {
	facts := []ui.Seg{
		{Text: m.relCWD(), Style: m.th.Ink},
		{Text: m.agent.Model(), Style: m.th.Muted},
	}
	if !m.mouse {
		facts = append(facts, ui.Seg{Text: "mouse off", Style: m.th.Warn})
	}
	return ui.Header(m.th, m.inner(), m.tick, m.working, facts)
}

// bodyRule labels the regions. Two labels when the explorer is open, so
// neither column is ever an unlabelled block of text.
func (m *Model) bodyRule() string {
	right := m.explorerWidth()
	if right == 0 {
		return ui.Rule(m.th, m.inner(), m.transcriptLabel())
	}
	left := m.inner() - right - 3
	return ui.Pad(ui.Rule(m.th, left, m.transcriptLabel()), left) +
		"  " + m.th.Rule.Render(m.th.G.V) + " " +
		ui.Rule(m.th, right, "explorer")
}

// transcriptLabel says what you are looking at AND what is hidden. A reader
// who cannot see that eight thinking blocks are collapsed does not know there
// is anything to open.
func (m *Model) transcriptLabel() string {
	open, total := m.chat.CountOpen(chat.Think)
	if total == 0 || open == total {
		return "transcript"
	}
	return "transcript · " + itoa(total-open) + " thinking hidden · ^e"
}

func (m *Model) body() string {
	h := m.bodyHeight()
	if m.ov != nil {
		m.ov.SetSize(m.inner(), h+1)
		return ui.Pad(ui.PadTo(m.ov.View(m.th), h), m.inner())
	}
	left := m.chatOrWelcome(h)
	right := m.explorerWidth()
	if right == 0 {
		return ui.Pad(ui.PadTo(left, h), m.inner())
	}
	// Pad to height FIRST, then to width: padding to width first leaves the
	// rows added afterwards empty, and the divider then runs down a ragged
	// edge of nothing. The divider gets a column of air either side, so the
	// two columns read as two columns rather than as one wall of text.
	lw := m.inner() - right - 3
	return ui.SideBySide(m.th, h,
		ui.Pad(ui.PadTo(left, h), lw)+" ",
		" "+ui.Pad(ui.PadTo(m.explorer.View(m.th, m.explorerFocus), h), right))
}

// bodyHeight is whatever is left after the rows that are never negotiable —
// header, status band, the region rule when there is one — and the prompt.
//
// It is computed in exactly one place. When it was computed twice, the two
// disagreed by one and compose() padded past the status line, so the bottom
// row of the screen was blank and every command looked like it did nothing.
func (m *Model) bodyHeight() int {
	chrome := 3
	if m.ov != nil {
		chrome = 2
	}
	if m.spacious() {
		chrome += 3 // a blank row under the header, over the prompt, over the status
	}
	h := m.h - chrome - m.prompt.Rows() - len(m.prompt.Queued())
	if h < 3 {
		h = 3
	}
	return h
}

// chatOrWelcome shows Nyx when there is nothing to read yet. She is the only
// thing on this screen that exists to be looked at rather than used, and she
// is gone the moment there is a conversation.
func (m *Model) chatOrWelcome(h int) string {
	body := m.chat.View(m.th)
	if m.chat.Len() > 1 || m.w < brand.MinWalkCols || h < 14 {
		return body
	}
	art := brand.Paint(m.th, brand.CatFor(m.w-4), brand.ScaleMascot)
	if len(art)+len(strings.Split(body, "\n")) > h {
		return body
	}
	var rows []string
	for _, l := range art {
		rows = append(rows, "  "+l)
	}
	rows = append(rows, "  "+m.th.Muted.Render(brand.Tagline), "")
	rows = append(rows, strings.Split(body, "\n")...)
	return strings.Join(rows, "\n")
}

// status is the one line that answers "where am I, what can I press, and what
// is in this session". The counts on the right are why the pane badges are
// gone: they belong on one always-visible line, not scattered across six tabs
// you must visit to read.
func (m *Model) status() string {
	left := []ui.Seg{{Text: ui.Chip(m.th, m.modeName())}}
	if n := m.Notice(); n != "" {
		// A notice answers "why did nothing happen", so for its five seconds
		// it outranks the counts. Sharing the row means a narrow terminal
		// truncates the answer to "terminal …", which is worse than silence.
		left = append(left, ui.Seg{Text: n, Style: m.th.Accent})
		return ui.Band(m.th, m.inner(), left, nil)
	}
	{
		hints := m.keys.Hints(m.hintMode(), m.working)
		if m.ov != nil {
			hints = m.keys.OverlayHints(m.ov.IsTree())
		}
		for _, e := range hints {
			left = append(left, ui.Seg{Text: e.Key + " " + e.Desc, Style: m.th.Muted})
		}
	}

	right := []ui.Seg{}
	if m.working {
		right = append(right, ui.Seg{
			Text:  theme.Spinner[m.tick%len(theme.Spinner)] + " working",
			Style: m.th.Accent,
		})
	}
	if q := len(m.prompt.Queued()); q > 0 {
		right = append(right, ui.Seg{Text: plural(q, "queued"), Style: m.th.Warn})
	}
	// A zero is shown, not hidden: "nothing here yet" is information.
	openT, totalT := m.chat.CountOpen(chat.Think)
	right = append(right,
		ui.Seg{Text: itoa(openT) + "/" + itoa(totalT) + " thinking", Style: m.th.Thinking},
		ui.Seg{Text: plural(m.chat.Len(), "block"), Style: m.th.Muted},
	)
	if n := m.stats.TokensIn + m.stats.TokensOut; n > 0 {
		right = append(right, ui.Seg{Text: short(n) + " tok", Style: m.th.Muted})
	}
	return ui.Band(m.th, m.inner(), left, right)
}

// hintMode is which key table the status line should advertise. An overlay
// and the explorer are both trees under the hand, whatever mode the
// transcript is in — telling the reader about "enter send" while a palette is
// open is telling them about a key that is not live.
func (m *Model) hintMode() keymap.Mode {
	if m.ov != nil || m.explorerFocus {
		return keymap.Browse
	}
	return m.mode
}

func (m *Model) modeName() string {
	if m.ov != nil {
		return m.ov.Kind.String()
	}
	if m.explorerFocus {
		return "explorer"
	}
	return m.mode.String()
}

// short renders a token count in three characters or so. The exact number is
// never the question; the order of magnitude is.
func short(n int) string {
	switch {
	case n < 1000:
		return itoa(n)
	case n < 100000:
		return itoa(n/1000) + "." + itoa((n%1000)/100) + "k"
	default:
		return itoa(n/1000) + "k"
	}
}

// Render returns the composed screen as plain text. Tests read this rather
// than driving a terminal.
func (m *Model) Render() string { return ansi.Strip(m.compose()) }
