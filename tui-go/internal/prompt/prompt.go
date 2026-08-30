// Package prompt is the input line, the send/queue/steer distinction, and the
// history behind it.
//
// The distinction is the feature. The agent is usually mid-turn when you
// think of the next thing, and there are two different intentions there:
// "when you're done, do this next" and "stop and take this into account now".
// Anything that silently picks one is wrong half the time.
package prompt

import (
	"strings"

	"charm.land/bubbles/v2/textarea"
	tea "charm.land/bubbletea/v2"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/command"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/theme"
	"github.com/charmbracelet/x/ansi"
)

// MinRows and MaxRows bound the input. It grows with what you type and then
// scrolls; a prompt that grows without limit eats the transcript you are
// replying to.
const (
	MinRows = 1
	MaxRows = 6
)

// MenuRows is the most suggestions shown at once. Eight is enough to pick
// from and short enough that the menu never swallows the transcript.
const MenuRows = 8

// Model is the prompt, its queue, and the slash menu.
type Model struct {
	ta      textarea.Model
	queue   []string
	history []string
	histAt  int // len(history) means "not browsing"
	width   int

	sug    []command.Command
	sugSel int
}

// New builds a focused prompt.
func New(isDark bool) *Model {
	ta := textarea.New()
	ta.Prompt = ""
	ta.Placeholder = "ask, or press ^k"
	ta.ShowLineNumbers = false
	ta.DynamicHeight = true
	ta.MinHeight = MinRows
	ta.MaxHeight = MaxRows
	ta.SetHeight(MinRows)
	ta.SetStyles(textarea.DefaultStyles(isDark))
	// The textarea's own newline binding must go: enter is send here, and a
	// widget that also inserts a newline on enter would do both.
	ta.KeyMap.InsertNewline.SetKeys("ctrl+j")
	// The real terminal cursor, not a drawn block: the view declares where it
	// sits, and hiding it is how read mode announces itself.
	ta.SetVirtualCursor(false)
	ta.Focus()
	m := &Model{ta: ta, width: 80}
	m.histAt = 0
	return m
}

// SetWidth resizes the input.
func (m *Model) SetWidth(w int) {
	if w < 4 {
		w = 4
	}
	m.width = w
	m.ta.SetWidth(w)
}

// Update feeds a message to the textarea.
func (m *Model) Update(msg tea.Msg) tea.Cmd {
	var cmd tea.Cmd
	m.ta, cmd = m.ta.Update(msg)
	return cmd
}

// Value is the current text.
func (m *Model) Value() string { return m.ta.Value() }

// Empty reports whether there is nothing to send.
func (m *Model) Empty() bool { return strings.TrimSpace(m.ta.Value()) == "" }

// Suggest replaces the slash menu. Passing nothing closes it.
func (m *Model) Suggest(cs []command.Command) {
	m.sug = cs
	if m.sugSel >= len(cs) {
		m.sugSel = len(cs) - 1
	}
	if m.sugSel < 0 {
		m.sugSel = 0
	}
}

// Suggestions is what the menu is showing.
func (m *Model) Suggestions() []command.Command { return m.sug }

// MenuOpen reports whether the slash menu has the arrow keys.
func (m *Model) MenuOpen() bool { return len(m.sug) > 0 }

// SugMove walks the menu, wrapping — a menu you can fall off the end of makes
// you look at it to use it.
func (m *Model) SugMove(d int) {
	if len(m.sug) == 0 {
		return
	}
	m.sugSel = (m.sugSel + d + len(m.sug)) % len(m.sug)
}

// SugSelected is the highlighted command.
func (m *Model) SugSelected() (command.Command, bool) {
	if m.sugSel < 0 || m.sugSel >= len(m.sug) {
		return command.Command{}, false
	}
	return m.sug[m.sugSel], true
}

// SugIndex is the highlighted row, for tests.
func (m *Model) SugIndex() int { return m.sugSel }

// Complete writes the highlighted command's name into the prompt, leaving the
// cursor after it so arguments can follow.
func (m *Model) Complete() bool {
	c, ok := m.SugSelected()
	if !ok {
		return false
	}
	m.SetValue("/" + c.Name + " ")
	m.sug = nil
	return true
}

// menuHeight is how many rows the menu occupies: the rows themselves plus
// the line that says the arrows work. That line earns its row — an unlabelled
// list gives no reason to reach for the arrow keys.
func (m *Model) menuHeight() int {
	if len(m.sug) == 0 {
		return 0
	}
	n := len(m.sug)
	if n > MenuRows {
		n = MenuRows
	}
	return n + 1
}

// Rows is how many rows the input currently occupies.
func (m *Model) Rows() int {
	h := m.ta.Height()
	if h < MinRows {
		h = MinRows
	}
	if h > MaxRows {
		h = MaxRows
	}
	return h + m.menuHeight()
}

// InputRows is the text area alone, without the menu — the cursor sits inside
// this part.
func (m *Model) InputRows() int {
	h := m.ta.Height()
	if h < MinRows {
		h = MinRows
	}
	if h > MaxRows {
		h = MaxRows
	}
	return h
}

// MenuTopOffset is how far below the prompt's first row the input starts. The
// menu is drawn ABOVE the input, because a menu below it would be under the
// status line, off the bottom of the screen.
func (m *Model) MenuTopOffset() int { return m.menuHeight() }

// Cursor is where the terminal cursor should sit, or nil when the prompt does
// not have it. Hiding the cursor is how the reader knows, without reading
// anything, that typing will not go into the prompt.
func (m *Model) Cursor() *tea.Cursor { return m.ta.Cursor() }

// Focus and Blur move the cursor in and out of the prompt.
func (m *Model) Focus() tea.Cmd { return m.ta.Focus() }
func (m *Model) Blur()          { m.ta.Blur() }

// Take clears the prompt and returns what was in it, recording it in history.
// Returns "" when the prompt is blank, so callers can ignore a stray enter.
func (m *Model) Take() string {
	s := strings.TrimRight(m.ta.Value(), " \t\n")
	if strings.TrimSpace(s) == "" {
		return ""
	}
	m.ta.Reset()
	m.ta.SetHeight(MinRows)
	if n := len(m.history); n == 0 || m.history[n-1] != s {
		m.history = append(m.history, s)
	}
	m.histAt = len(m.history)
	return s
}

// SetValue replaces the text, for completions and for the palette.
func (m *Model) SetValue(s string) {
	m.ta.SetValue(s)
	m.ta.MoveToEnd()
}

// Insert puts text at the cursor — how the explorer hands a path over.
func (m *Model) Insert(s string) { m.ta.InsertString(s) }

// Queue adds a message to be sent when the current turn ends.
func (m *Model) Queue(s string) { m.queue = append(m.queue, s) }

// Queued is the pending list.
func (m *Model) Queued() []string { return m.queue }

// PopQueue removes and returns the next queued message.
func (m *Model) PopQueue() (string, bool) {
	if len(m.queue) == 0 {
		return "", false
	}
	s := m.queue[0]
	m.queue = m.queue[1:]
	return s, true
}

// DropLastQueued removes the most recently queued message.
func (m *Model) DropLastQueued() bool {
	if len(m.queue) == 0 {
		return false
	}
	m.queue = m.queue[:len(m.queue)-1]
	return true
}

// HistoryPrev and HistoryNext step through what you have already sent.
// They only fire on a single-line prompt, so the arrow keys keep working for
// editing a multi-line draft.
func (m *Model) HistoryPrev() bool {
	if m.ta.LineCount() > 1 || len(m.history) == 0 || m.histAt == 0 {
		return false
	}
	m.histAt--
	m.SetValue(m.history[m.histAt])
	return true
}

func (m *Model) HistoryNext() bool {
	if m.ta.LineCount() > 1 || m.histAt >= len(m.history) {
		return false
	}
	m.histAt++
	if m.histAt == len(m.history) {
		m.SetValue("")
		return true
	}
	m.SetValue(m.history[m.histAt])
	return true
}

// View renders the prompt with its accent bar, and the queue beneath it.
//
// The queue is drawn dim and numbered because it is a promise about the
// future, not part of the conversation: it must be visible enough to notice
// and quiet enough not to be mistaken for something already said.
func (m *Model) View(t *theme.Theme, focused bool) string {
	bar := t.Faint.Render(t.G.User)
	if focused {
		bar = t.Accent.Render(t.G.User)
	}
	body := m.ta.View()
	lines := strings.Split(body, "\n")
	for i, l := range lines {
		if i == 0 {
			lines[i] = bar + " " + l
		} else {
			lines[i] = "  " + l
		}
	}
	out := strings.Join(lines, "\n")
	if menu := m.menuView(t); menu != "" {
		out = menu + "\n" + out
	}
	for i, q := range m.queue {
		out += "\n" + t.Faint.Render(ansi.Truncate(
			"  "+itoa(i+1)+"· "+strings.ReplaceAll(q, "\n", " "), m.width, "…"))
	}
	return out
}

// menuView draws the slash menu: name, kind, description.
//
// The kind is shown because "/review" from a plugin and "/review" from this
// project are different things, and which one you are about to run is not
// guessable from the name.
func (m *Model) menuView(t *theme.Theme) string {
	if len(m.sug) == 0 {
		return ""
	}
	start := 0
	if m.sugSel >= MenuRows {
		start = m.sugSel - MenuRows + 1
	}
	end := start + MenuRows
	if end > len(m.sug) {
		end = len(m.sug)
	}
	// One column width for every name on screen, so the descriptions line up
	// and the menu can be read down rather than across. Without it the eye
	// has to find the start of each description separately.
	nameCol := 0
	for i := start; i < end; i++ {
		if n := len(m.sug[i].Name) + 1; n > nameCol {
			nameCol = n
		}
	}
	if nameCol > 26 {
		nameCol = 26
	}

	rows := make([]string, 0, end-start+1)
	rows = append(rows, t.Faint.Render(strings.Repeat(" ", 2)+
		itoa(len(m.sug))+" matching · ↑ ↓ pick · tab completes · enter runs"))

	for i := start; i < end; i++ {
		c := m.sug[i]
		name := ansi.Truncate("/"+c.Name, nameCol, "…")
		mark, nameStyle := "  ", t.Ink
		if i == m.sugSel {
			mark, nameStyle = t.Accent.Render(t.G.Seg)+" ", t.Accent
		}
		line := mark + nameStyle.Render(name) +
			strings.Repeat(" ", nameCol-ansi.StringWidth(name)+2)
		tag := c.Kind.String()
		if c.Chord != "" {
			tag = c.Chord
		}
		line += t.Faint.Render(pad(tag, 9))
		if c.Desc != "" {
			room := m.width - ansi.StringWidth(line) - 1
			if room > 8 {
				line += t.Muted.Render(ansi.Truncate(c.Desc, room, "…"))
			}
		}
		rows = append(rows, ansi.Truncate(line, m.width, "…"))
	}
	return strings.Join(rows, "\n")
}

// pad right-fills to a column width.
func pad(s string, w int) string {
	if n := w - ansi.StringWidth(s); n > 0 {
		return s + strings.Repeat(" ", n)
	}
	return s
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [8]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
