// Package overlay is every modal surface: the command palette, the session
// browser, memory, logs and help.
//
// There is one implementation because there is one contract. Every overlay
// states its purpose in a line, filters by typing with no mode change, is
// dismissed by esc, and — when empty — says what will appear here and the
// concrete thing that causes it. "(no episodes)" answers neither, and that
// was the bug that made two whole panes meaningless.
package overlay

import (
	"strings"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/theme"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/tree"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/ui"
	"github.com/charmbracelet/x/ansi"
)

// Kind names which overlay is up. None means the transcript has the screen.
type Kind int

const (
	None Kind = iota
	Palette
	Sessions
	Memory
	Logs
	Help
	Models
	Login
	Schedules
	// Themes is the palette picker: a flat list of values, where picking one
	// applies it and leaves the list up so the choice can be tried rather
	// than guessed at.
	Themes
	// Dialog is a question the agent is blocked on — an extension's
	// select/confirm, routed here because a list of choices is exactly what
	// this package already draws. It is the one overlay whose rows are an
	// answer rather than an action.
	Dialog
	// Fork is the branch picker: the messages a fork can start from, newest
	// first. Its rows are actions like the palette's — enter branches at the
	// row — and it is the one list whose esc decides something, because
	// leaving it forks nothing. Appended rather than slotted in beside Themes
	// so every Kind already in the wild keeps its number.
	Fork
)

func (k Kind) String() string {
	switch k {
	case Palette:
		return "palette"
	case Sessions:
		return "sessions"
	case Memory:
		return "memory"
	case Logs:
		return "logs"
	case Help:
		return "keys"
	case Models:
		return "model"
	case Login:
		return "login"
	case Schedules:
		return "schedules"
	case Themes:
		return "theme"
	case Dialog:
		return "dialog"
	case Fork:
		return "fork"
	}
	return ""
}

// Item is one row of a flat overlay: what it says, what it does, and an
// optional group heading it sits under.
type Item struct {
	Label  string
	Detail string
	Group  string
	ID     string
}

// Model is one overlay. It is either flat (Items) or hierarchical (Tree);
// the difference is what the data is, not how it behaves.
type Model struct {
	Kind    Kind
	Purpose string
	Empty   []string

	items    []Item
	filtered []int
	sel      int
	offset   int

	tree *tree.Model

	query  string
	width  int
	height int
	typing bool // a flat overlay filters as you type; a tree waits for /
	footer string
}

// NewList builds a flat overlay that filters as you type.
func NewList(k Kind, purpose string, items []Item, empty ...string) *Model {
	m := &Model{Kind: k, Purpose: purpose, items: items, Empty: empty,
		width: 60, height: 12, typing: true}
	m.refilter()
	return m
}

// SetItems replaces a flat overlay's rows (the schedules pause/resume path
// re-renders the list in place so the surface never closes mid-action).
func (m *Model) SetItems(items []Item) {
	if m.tree != nil {
		return
	}
	m.items = items
	m.refilter()
}

// NewTree builds a hierarchical overlay. Typing is inert until `/` is
// pressed, so j/k/h/l stay available for movement.
func NewTree(k Kind, purpose string, roots []*tree.Node, empty ...string) *Model {
	m := &Model{Kind: k, Purpose: purpose, Empty: empty, width: 60, height: 12}
	m.tree = tree.New(roots...)
	return m
}

// IsTree reports which flavour this is.
func (m *Model) IsTree() bool { return m.tree != nil }

// Tree exposes the hierarchy, for callers that drive it with tree keys.
func (m *Model) Tree() *tree.Model { return m.tree }

// SetSize sets the drawing area. Two rows go to the purpose line and its rule.
func (m *Model) SetSize(w, h int) {
	if w < 20 {
		w = 20
	}
	if h < 4 {
		h = 4
	}
	m.width, m.height = w, h
	// A footer (the memory editor's line) costs the tree its last row, or
	// the panel is one row taller than the box that floats it.
	treeH := h - 3
	if m.footer != "" {
		treeH = h - 4
	}
	if m.tree != nil {
		m.tree.SetSize(w-2, treeH)
	}
	m.scrollIntoView()
}

// Query is the current filter text.
func (m *Model) Query() string { return m.query }

// Typing reports whether keystrokes go to the filter.
func (m *Model) Typing() bool { return m.typing }

// StartTyping switches a tree overlay into filter mode.
func (m *Model) StartTyping() { m.typing = true }

// SetQuery replaces the filter.
func (m *Model) SetQuery(s string) {
	m.query = s
	if m.tree != nil {
		m.tree.Filter(s)
		return
	}
	m.refilter()
}

// SetFooter gives the overlay a last line of its own — the memory editor's
// field line. Clear it by setting "".
func (m *Model) SetFooter(s string) {
	m.footer = s
}

// Footer is the current footer, for tests.
func (m *Model) Footer() string { return m.footer }

// Backspace removes one character, and leaves tree filter mode when the query
// empties — so esc is not the only way back to movement keys.
func (m *Model) Backspace() {
	if m.query == "" {
		if m.tree != nil {
			m.typing = false
		}
		return
	}
	r := []rune(m.query)
	m.SetQuery(string(r[:len(r)-1]))
	if m.query == "" && m.tree != nil {
		m.typing = false
	}
}

// Rune appends to the filter.
func (m *Model) Rune(r rune) { m.SetQuery(m.query + string(r)) }

func (m *Model) refilter() {
	m.filtered = m.filtered[:0]
	q := strings.ToLower(m.query)
	for i, it := range m.items {
		if q == "" || matches(it, q) {
			m.filtered = append(m.filtered, i)
		}
	}
	if m.sel >= len(m.filtered) {
		m.sel = len(m.filtered) - 1
	}
	if m.sel < 0 {
		m.sel = 0
	}
	m.scrollIntoView()
}

// matches tests the query against each field SEPARATELY.
//
// Running it over the fields joined together looks equivalent and is not: a
// query then matches by taking one letter from the label and the next from
// the keybinding, and the palette starts returning rows for no reason the
// reader can see. Per-field is stricter and predictable.
func matches(it Item, q string) bool {
	return nameMatch(it.Label, q) || nameMatch(it.Group, q) || proseMatch(it.Detail, q)
}

// proseLen is where a field stops being a name and starts being a sentence.
const proseLen = 32

// nameMatch is a subsequence: every character of the query, in order.
//
// Right for a NAME, where you are typing the letters you remember out of a
// short string — "sess" finds /sessions, "hevd" finds /high-end-visual-design.
func nameMatch(field, q string) bool {
	f := strings.ToLower(field)
	if len(f) > proseLen {
		return proseMatch(field, q)
	}
	return subsequence(f, q)
}

// proseMatch is a substring.
//
// A subsequence over a SENTENCE matches almost everything: "fol" found a skill
// whose description happened to contain an f, then an o, then an l, thirty
// words apart. The palette then answers a three-letter query with the entire
// list, which is the same as not filtering at all.
func proseMatch(field, q string) bool {
	return q != "" && strings.Contains(strings.ToLower(field), q)
}

// subsequence is the whole matcher: every character of the query appears in
// order. It is not scored or ranked — for a list this size, typing three
// letters already narrows it to one, and a ranking function is a thing that
// surprises you.
func subsequence(hay, needle string) bool {
	i := 0
	for _, r := range hay {
		if i < len(needle) && rune(needle[i]) == r {
			i++
		}
	}
	return i == len(needle)
}

// Move shifts the selection.
func (m *Model) Move(d int) {
	if m.tree != nil {
		m.tree.Move(d)
		return
	}
	m.sel += d
	if m.sel < 0 {
		m.sel = 0
	}
	if m.sel >= len(m.filtered) {
		m.sel = len(m.filtered) - 1
	}
	if m.sel < 0 {
		m.sel = 0
	}
	m.scrollIntoView()
}

// Selected returns the chosen item's ID, and false when there is nothing to
// choose.
func (m *Model) Selected() (string, bool) {
	if m.tree != nil {
		if n := m.tree.Current(); n != nil {
			return n.ID, true
		}
		return "", false
	}
	if m.sel < 0 || m.sel >= len(m.filtered) {
		return "", false
	}
	return m.items[m.filtered[m.sel]].ID, true
}

// SelectedItem returns the chosen row.
func (m *Model) SelectedItem() (Item, bool) {
	if m.tree != nil || m.sel < 0 || m.sel >= len(m.filtered) {
		return Item{}, false
	}
	return m.items[m.filtered[m.sel]], true
}

// Count is how many rows are currently showing.
func (m *Model) Count() int {
	if m.tree != nil {
		return len(m.tree.Rows())
	}
	return len(m.filtered)
}

func (m *Model) body() int { return m.height - 3 }

func (m *Model) scrollIntoView() {
	h := m.body()
	if h < 1 {
		h = 1
	}
	if m.sel < m.offset {
		m.offset = m.sel
	}
	if m.sel >= m.offset+h {
		m.offset = m.sel - h + 1
	}
	if max := len(m.filtered) - h; m.offset > max {
		m.offset = max
	}
	if m.offset < 0 {
		m.offset = 0
	}
}

// View renders the overlay.
func (m *Model) View(t *theme.Theme) string {
	var b strings.Builder
	b.WriteString(ui.Rule(t, m.width, m.Kind.String()))
	b.WriteString("\n")

	// The purpose line, always. A rail of nouns is a menu of guesses; one
	// sentence in the reader's own words is the fix, and it costs one row.
	head := t.Muted.Render(ansi.Truncate(m.Purpose, m.width, "…"))
	if m.query != "" {
		head = t.Muted.Render("/") + t.Ink.Render(m.query) + t.Accent.Render("▏")
	}
	b.WriteString(head + "\n")

	if m.Count() == 0 {
		b.WriteString(m.emptyView(t))
	} else if m.tree != nil {
		b.WriteString(m.tree.View(t, true))
	} else {
		h := m.body()
		end := m.offset + h
		if end > len(m.filtered) {
			end = len(m.filtered)
		}
		var lastGroup string
		rows := make([]string, 0, h)
		for i := m.offset; i < end; i++ {
			it := m.items[m.filtered[i]]
			if it.Group != "" && it.Group != lastGroup {
				lastGroup = it.Group
				rows = append(rows, t.Faint.Render(strings.ToUpper(it.Group)))
				if len(rows) >= h {
					break
				}
			}
			rows = append(rows, m.row(t, it, i == m.sel))
		}
		b.WriteString(strings.Join(rows, "\n"))
	}
	if m.footer != "" {
		b.WriteString("\n" + t.Accent.Render(ansi.Truncate(m.footer, m.width, "…")))
	}
	return b.String()
}

func (m *Model) row(t *theme.Theme, it Item, sel bool) string {
	mark := " "
	label := t.Ink.Render(it.Label)
	if sel {
		mark = t.Accent.Render(t.G.Seg)
		label = t.Accent.Render(it.Label)
	}
	line := mark + " " + label
	if it.Detail != "" {
		room := m.width - ansi.StringWidth(line) - ansi.StringWidth(it.Detail) - 1
		if room > 0 {
			line += strings.Repeat(" ", room) + t.Faint.Render(it.Detail)
		}
	}
	return ansi.Truncate(line, m.width, "…")
}

// emptyView is the part that matters most. It says what appears here and what
// makes it appear — never "(none)".
func (m *Model) emptyView(t *theme.Theme) string {
	if len(m.Empty) == 0 {
		return t.Muted.Render("nothing matches " + m.query)
	}
	lines := make([]string, 0, len(m.Empty))
	for i, l := range m.Empty {
		st := t.Muted
		if i == 0 {
			st = t.Ink
		}
		lines = append(lines, st.Render(ansi.Truncate(l, m.width, "…")))
	}
	return strings.Join(lines, "\n")
}
