// Package chat is the transcript: a list of blocks, some of which fold.
//
// The transcript is the application. Everything else in this interface is an
// overlay over it, which is why this package owns folding, focus and
// wrapping rather than delegating them to a generic list.
package chat

import (
	"strings"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/markdown"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/theme"
	"github.com/charmbracelet/x/ansi"
)

// Kind is who is speaking, which decides the gutter and its colour.
type Kind int

const (
	User Kind = iota
	Agent
	Think
	Tool
	Delegation // one or more sub-agent runs, nested
	Notice     // errors and system lines
)

// State is how a tool call or a sub-agent run ended.
type State int

const (
	None State = iota
	Running
	OK
	Failed
)

// Block is one entry in the transcript.
//
// Title is the collapsed one-liner and Body is what opening it reveals. A
// block is worth opening only when its summary is honest, so Detail always
// carries the RESULT ("213 ok", "exit 1") and not just the invocation —
// "▸ 213 ok" is what tells you not to bother.
type Block struct {
	Kind   Kind
	Title  string
	Detail string
	Body   []string
	State  State
	Open   bool

	// Children are sub-agent runs. A delegation is an event in the
	// conversation, so it lives here rather than in a pane of its own.
	Children []*Block

	// Rendered markdown, cached. Rendering runs a parser and a syntax
	// highlighter, which is not something to do to every block on every
	// frame — and a transcript redraws on every keystroke.
	rendered  []string
	renderedW int
	renderedN int
}

// Invalidate drops the cached rendering. Anything streaming into Body has to
// call it; nothing else can know the text changed.
func (b *Block) Invalidate() { b.rendered = nil }

// Foldable reports whether the block has anything hidden behind its summary.
func (b *Block) Foldable() bool { return len(b.Body) > 0 || len(b.Children) > 0 }

// Model is the transcript.
type Model struct {
	blocks []*Block
	width  int
	height int

	focus  int // index into blocks; -1 when nothing is focused
	scroll int
	follow bool // pinned to the bottom, which is the normal state
	tick   int  // animation frame, for blocks that are still running
	md     *markdown.Renderer

	query    string
	hits     []int
	hit      int
	counting bool
}

// SetMarkdown gives the transcript a renderer. Without one it draws the text
// as typed, which is what the layout tests want and what a terminal with no
// colour gets anyway.
func (m *Model) SetMarkdown(r *markdown.Renderer) { m.md = r }

// New returns an empty transcript pinned to the bottom.
func New() *Model { return &Model{width: 80, height: 20, focus: -1, follow: true} }

// SetSize sets the drawing area. Width matters more than height: everything
// is wrapped to it before any slicing happens.
func (m *Model) SetSize(w, h int) {
	if w < 8 {
		w = 8
	}
	if h < 1 {
		h = 1
	}
	m.width, m.height = w, h
	m.clamp()
}

// SetTick advances the animation used by blocks that are still running.
//
// A tool call that has been sent and not answered draws a spinner in its
// gutter, and a thinking block draws the dither wave. A static dot on a call
// that is still out looks exactly like a call that finished, which is the
// difference between waiting and being stuck.
func (m *Model) SetTick(t int) { m.tick = t }

// Append adds a block and, if the view was pinned to the bottom, keeps it there.
func (m *Model) Append(b *Block) {
	m.blocks = append(m.blocks, b)
	if m.follow {
		m.scroll = 1 << 30
	}
	m.clamp()
}

// Last is the most recent block, or nil.
func (m *Model) Last() *Block {
	if len(m.blocks) == 0 {
		return nil
	}
	return m.blocks[len(m.blocks)-1]
}

// Blocks exposes the list for callers that stream into the open block.
func (m *Model) Blocks() []*Block { return m.blocks }

// TruncateAt drops every block from i onwards — what undo needs. The
// transcript is the present the reader sees; cutting a finished exchange from
// it neither touches the backend nor rewrites the session file, so it is
// asked first and said out loud.
func (m *Model) TruncateAt(i int) {
	if i < 0 || i >= len(m.blocks) {
		return
	}
	m.blocks = m.blocks[:i]
	m.ClearFocus()
	if m.follow {
		m.Bottom()
	}
}

// Len is the number of blocks.
func (m *Model) Len() int { return len(m.blocks) }

// Clear empties the transcript, for a session switch.
func (m *Model) Clear() {	m.blocks = nil
	m.focus, m.scroll = -1, 0
	m.follow = true
}

// CountOpen reports how many blocks of a kind are open, and how many exist.
// The caller uses this to decide whether one keypress should open all or
// close all, and to say which in the status line.
func (m *Model) CountOpen(k Kind) (open, total int) {
	for _, b := range m.blocks {
		if b.Kind != k || !b.Foldable() {
			continue
		}
		total++
		if b.Open {
			open++
		}
	}
	return
}

// ToggleAll opens every foldable block of a kind, or closes them all if they
// are already all open.
//
// This is the single most useful key in the interface. Reading a long turn
// means opening eight thinking blocks; doing that one at a time is eight
// keystrokes to answer one question ("what was it thinking?"). One key, whole
// transcript.
func (m *Model) ToggleAll(k Kind) bool {
	open, total := m.CountOpen(k)
	if total == 0 {
		return false
	}
	want := open < total
	for _, b := range m.blocks {
		if b.Kind == k && b.Foldable() {
			b.Open = want
		}
	}
	m.clamp()
	return want
}

// ToggleEverything opens or closes every foldable block regardless of kind.
func (m *Model) ToggleEverything() bool {
	var open, total int
	for _, b := range m.blocks {
		if !b.Foldable() {
			continue
		}
		total++
		if b.Open {
			open++
		}
	}
	if total == 0 {
		return false
	}
	want := open < total
	for _, b := range m.blocks {
		if b.Foldable() {
			b.Open = want
		}
	}
	m.clamp()
	return want
}

// FocusNext and FocusPrev step between blocks, which is the movement that
// matters: a transcript is a list of blocks, not a list of lines.
func (m *Model) FocusNext() { m.moveFocus(1) }
func (m *Model) FocusPrev() { m.moveFocus(-1) }

func (m *Model) moveFocus(d int) {
	if len(m.blocks) == 0 {
		return
	}
	if m.focus < 0 {
		// Entering block navigation starts at the newest block, because that
		// is what you were just reading.
		m.focus = len(m.blocks) - 1
	} else {
		m.focus += d
	}
	if m.focus < 0 {
		m.focus = 0
	}
	if m.focus >= len(m.blocks) {
		m.focus = len(m.blocks) - 1
	}
	m.follow = false
	m.scrollToFocus()
}

// Focus is the focused block index, or -1.
func (m *Model) Focus() int { return m.focus }

// Focused is the focused block, or nil.
func (m *Model) Focused() *Block {
	if m.focus < 0 || m.focus >= len(m.blocks) {
		return nil
	}
	return m.blocks[m.focus]
}

// ClearFocus drops block focus, which is what leaving read mode does.
func (m *Model) ClearFocus() { m.focus = -1 }

// ToggleFocused folds or unfolds the focused block.
func (m *Model) ToggleFocused() bool {
	b := m.Focused()
	if b == nil || !b.Foldable() {
		return false
	}
	b.Open = !b.Open
	m.clamp()
	m.scrollToFocus()
	return true
}

// YankFocused returns the focused block as plain text, for the clipboard.
// Falls back to the whole transcript when nothing is focused.
func (m *Model) YankFocused() string {
	if b := m.Focused(); b != nil {
		return plain(b)
	}
	var sb strings.Builder
	for _, b := range m.blocks {
		sb.WriteString(plain(b))
		sb.WriteString("\n")
	}
	return sb.String()
}

func plain(b *Block) string {
	var sb strings.Builder
	if b.Title != "" {
		sb.WriteString(b.Title)
		if b.Detail != "" {
			sb.WriteString("  " + b.Detail)
		}
		sb.WriteString("\n")
	}
	for _, l := range b.Body {
		sb.WriteString(l + "\n")
	}
	for _, c := range b.Children {
		sb.WriteString(plain(c))
	}
	return strings.TrimRight(sb.String(), "\n")
}

// Scroll moves the viewport by n lines and unpins it from the bottom.
func (m *Model) Scroll(n int) {
	m.scroll += n
	m.follow = false
	m.clamp()
}

// Top and Bottom jump the viewport. Bottom re-pins it.
func (m *Model) Top() { m.scroll = 0; m.follow = false; m.clamp() }
func (m *Model) Bottom() {
	m.scroll = 1 << 30
	m.follow = true
	m.clamp()
}

// Following reports whether the view is pinned to the newest output.
func (m *Model) Following() bool { return m.follow }

func (m *Model) clamp() {
	n := len(m.render(nil))
	max := n - m.height
	if max < 0 {
		max = 0
	}
	if m.scroll > max {
		m.scroll = max
	}
	if m.scroll < 0 {
		m.scroll = 0
	}
}

func (m *Model) scrollToFocus() {
	// Find the first rendered row belonging to the focused block and put it on
	// screen, preferring to show the block's head rather than its middle.
	rows := m.render(nil)
	for i, r := range rows {
		if r.block == m.focus {
			if i < m.scroll || i >= m.scroll+m.height {
				m.scroll = i - 1
			}
			break
		}
	}
	m.clamp()
}

// row is one rendered line plus which block produced it, so focus scrolling
// can map a screen row back to a block.
type row struct {
	text  string
	block int
}

// Lines returns the fully rendered, fully wrapped transcript.
//
// WRAP BEFORE YOU SLICE. The viewport takes the last N rows; if a logical
// line silently becomes three rows at render time, the two newest rows fall
// off the bottom of the screen. This shipped once. Everything is wrapped to
// the final width here, before any slicing happens anywhere.
func (m *Model) Lines(t *theme.Theme) []string {
	rows := m.render(t)
	out := make([]string, len(rows))
	for i, r := range rows {
		out[i] = r.text
	}
	return out
}

// View returns the visible window.
func (m *Model) View(t *theme.Theme) string {
	rows := m.render(t)
	if len(rows) == 0 {
		return ""
	}
	start := m.scroll
	if m.follow || start > len(rows)-m.height {
		start = len(rows) - m.height
	}
	if start < 0 {
		start = 0
	}
	end := start + m.height
	if end > len(rows) {
		end = len(rows)
	}
	out := make([]string, 0, end-start)
	for _, r := range rows[start:end] {
		out = append(out, r.text)
	}
	return strings.Join(out, "\n")
}

// render is the single place a block becomes lines. A nil theme renders
// unstyled, which is what the layout maths and the tests use.
func (m *Model) render(t *theme.Theme) []row {
	if t == nil {
		t = plainTheme
	}
	var out []row
	for i, b := range m.blocks {
		if i > 0 {
			out = append(out, row{text: "", block: -1})
		}
		out = append(out, m.renderBlock(t, b, i, 0)...)
	}
	if m.query != "" && !m.counting {
		// The hit list is indexed by row, so highlighting has to happen after
		// every row exists — and recount() renders too, so it says so and
		// this does not recurse.
		cur := -1
		if m.hit < len(m.hits) {
			cur = m.hits[m.hit]
		}
		for i := range out {
			out[i].text = highlight(t, out[i].text, m.query, i == cur)
		}
	}
	return out
}

// gutterWidth is two cells: a marker and a space. Continuation lines keep it
// as blank space — a wrapped line that starts at column 0 reads as a new
// speaker.
const gutterWidth = 2

func (m *Model) renderBlock(t *theme.Theme, b *Block, idx, depth int) []row {
	indent := strings.Repeat("  ", depth)
	avail := m.width - gutterWidth - len(indent)
	if avail < 8 {
		avail = 8
	}

	mark, style := m.gutterFor(t, b)
	markStyle := style
	if b.Kind == User {
		markStyle = t.Accent // the bar is yours; the words sit on their own ground
	}
	if b.Kind == Agent {
		style = t.Ink // the coat colours the gutter, not the prose
	}
	focused := idx == m.focus && depth == 0
	if focused {
		mark = t.G.Seg
		markStyle = t.Accent
	}
	lead := indent + markStyle.Render(mark) + " "
	cont := indent + strings.Repeat(" ", gutterWidth)

	var out []row
	add := func(s string) { out = append(out, row{text: s, block: idx}) }

	if b.Foldable() && b.Title != "" {
		add(lead + m.summary(t, b, avail))
		if !b.Open {
			return out
		}
		for _, l := range m.body(t, b, b.Body, avail) {
			add(cont + t.Muted.Render(l))
		}
		for _, c := range b.Children {
			out = append(out, m.renderBlock(t, c, idx, depth+1)...)
		}
		return out
	}

	body := b.Body
	if b.Title != "" {
		body = append([]string{b.Title}, body...)
	}
	lines := m.body(t, b, body, avail)
	pad := func(l string) string {
		// A background only reads as a band if it runs to the margin; a
		// ragged right edge looks like a highlight that failed.
		if b.Kind != User {
			return l
		}
		if n := avail - ansi.StringWidth(l); n > 0 {
			return l + strings.Repeat(" ", n)
		}
		return l
	}
	styled := m.md != nil && prose(b.Kind)
	for i, l := range lines {
		text := style.Render(pad(l))
		if styled {
			// Markdown already coloured this. Painting over it would flatten
			// every bold heading and every path back to one shade.
			text = l
		}
		if i == 0 {
			add(lead + text)
		} else {
			add(cont + text)
		}
	}
	if len(lines) == 0 {
		add(lead)
	}
	return out
}

// summary is the collapsed one-liner: marker, title, and the result pushed to
// the right margin.
func (m *Model) summary(t *theme.Theme, b *Block, avail int) string {
	fold := t.G.Closed
	if b.Open {
		fold = t.G.Open
	}
	title := b.Title
	if b.State == Running && b.Kind == Think {
		// A thinking block that is still filling shows the ramp rather than a
		// word: density travelling left to right reads as work in progress,
		// where a spinner reads as loading.
		title = title + "  " + theme.Wave(m.tick, 8)
	}
	head := t.Muted.Render(fold) + " " + stateStyle(t, b).Render(title)
	if b.Detail == "" {
		return ansi.Truncate(head, avail, "…")
	}
	room := avail - ansi.StringWidth(head) - ansi.StringWidth(b.Detail)
	if room < 1 {
		return ansi.Truncate(head, avail, "…")
	}
	return head + strings.Repeat(" ", room) + t.Faint.Render(b.Detail)
}

func (m *Model) gutterFor(t *theme.Theme, b *Block) (string, styler) {
	if b.State == Running {
		return theme.Spinner[m.tick%len(theme.Spinner)], t.Accent
	}
	return gutter(t, b)
}

// gutter is the two cells that say who is speaking.
//
// Mnemo answers in the mascot's own colour. That is not decoration: before
// this the agent's gutter was drawn a shade above the background, so the two
// speakers were told apart only by a glyph nobody could see.
func gutter(t *theme.Theme, b *Block) (string, styler) {
	switch b.Kind {
	case User:
		return t.G.User, t.Said
	case Think:
		return t.G.Think, t.Thinking
	case Tool, Delegation:
		return t.G.Tool, stateStyle(t, b)
	case Notice:
		return t.G.Tool, t.Fail
	default:
		return t.G.Agent, t.Coat
	}
}

func stateStyle(t *theme.Theme, b *Block) styler {
	switch b.State {
	case Running:
		return t.Accent
	case Failed:
		return t.Fail
	case OK:
		return t.OK
	}
	if b.Kind == Think {
		return t.Thinking
	}
	return t.Ink
}

type styler interface{ Render(...string) string }

// body renders a block's text: markdown for prose, verbatim for tool output.
//
// A tool's output is a diff, a log or a stack trace. Running it through a
// markdown parser turns an underscore in an identifier into italics and eats
// the asterisks out of a glob — the one place formatting must not be applied
// is the place the text is already exact.
func (m *Model) body(t *theme.Theme, b *Block, lines []string, avail int) []string {
	if m.md == nil || !prose(b.Kind) {
		return wrap(lines, avail)
	}
	if b.rendered != nil && b.renderedW == avail && b.renderedN == len(lines) {
		return b.rendered
	}
	out := m.md.Render(strings.Join(lines, "\n"), avail)
	b.rendered, b.renderedW, b.renderedN = out, avail, len(lines)
	return out
}

func prose(k Kind) bool { return k == Agent || k == Think || k == Notice }

// wrap breaks each logical line to width, preferring word boundaries and
// cutting anything that has none — a path with no spaces must be cut, not
// allowed to overflow.
func wrap(lines []string, width int) []string {
	var out []string
	for _, l := range lines {
		if l == "" {
			out = append(out, "")
			continue
		}
		w := ansi.Wordwrap(l, width, " -/_.,")
		for _, piece := range strings.Split(w, "\n") {
			if ansi.StringWidth(piece) <= width {
				out = append(out, piece)
				continue
			}
			for ansi.StringWidth(piece) > width {
				out = append(out, ansi.Truncate(piece, width, ""))
				piece = ansi.TruncateLeft(piece, width, "")
			}
			if piece != "" {
				out = append(out, piece)
			}
		}
	}
	return out
}

// plainTheme renders without colour, for layout maths and tests.
var plainTheme = theme.New(theme.PICO8, theme.Heavy, true)
