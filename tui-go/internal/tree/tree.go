// Package tree is one hierarchical list, used three times: the session and
// sub-agent browser, and the folder explorer on the right.
//
// Writing it once is the point. Sessions, agents and directories are all the
// same shape — a node with children, some of which are worth loading only
// when opened — so they get one model, one set of keys, and one renderer. A
// fourth hierarchy costs a Node slice and nothing else.
package tree

import (
	"strings"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/theme"
	"github.com/charmbracelet/x/ansi"
)

// Kind decides a row's colour. It is deliberately about what the thing IS,
// not about how to draw it: the theme owns the mapping.
type Kind int

const (
	Plain Kind = iota
	Dir
	File
	Session
	Agent
	Turn
	Memory
)

// State is the other half of a row's colour: whether the thing worked.
type State int

const (
	None State = iota
	Running
	OK
	Failed
)

// Node is one row and its subtree.
//
// Load exists because a directory with ten thousand files must not be walked
// to draw its parent, and a session's turns must not be parsed to list the
// session. Children are pulled the first time the node opens.
type Node struct {
	ID     string
	Label  string
	Detail string // right-aligned, dim: counts, sizes, timestamps
	Kind   Kind
	State  State

	Children []*Node
	Expanded bool

	// Load supplies children lazily. Nil means Children is already complete.
	Load func() []*Node

	loaded bool
}

// HasChildren reports whether the node can open. A lazy node counts as
// openable before it has ever been loaded — otherwise an unvisited directory
// would render as a leaf and there would be no way to enter it.
func (n *Node) HasChildren() bool { return len(n.Children) > 0 || (n.Load != nil && !n.loaded) }

func (n *Node) ensure() {
	if n.Load != nil && !n.loaded {
		n.Children = n.Load()
		n.loaded = true
	}
}

// Row is one visible line: a node plus how deep it sits and how to draw its
// trunk. Trunk is precomputed because whether an ancestor was the last of its
// siblings is not knowable from the node itself.
type Row struct {
	Node  *Node
	Depth int
	Trunk []bool // for each ancestor level: was that ancestor the last child?
	Last  bool
}

// Model is a scrollable, collapsible tree.
type Model struct {
	roots  []*Node
	rows   []Row
	cursor int
	offset int
	width  int
	height int
	filter string
}

// New builds a tree over the given roots.
func New(roots ...*Node) *Model {
	m := &Model{roots: roots, height: 10, width: 40}
	m.reflow()
	return m
}

// SetRoots replaces the contents, keeping the cursor in range.
func (m *Model) SetRoots(roots []*Node) {
	m.roots = roots
	m.reflow()
}

// SetSize sets the drawing area.
func (m *Model) SetSize(w, h int) {
	m.width, m.height = w, h
	m.scrollIntoView()
}

// Rows is the flattened visible list. Exported for tests and for callers that
// want to know what is on screen without rendering it.
func (m *Model) Rows() []Row { return m.rows }

// Cursor is the index of the focused row.
func (m *Model) Cursor() int { return m.cursor }

// Current is the focused node, or nil when the tree is empty.
func (m *Model) Current() *Node {
	if m.cursor < 0 || m.cursor >= len(m.rows) {
		return nil
	}
	return m.rows[m.cursor].Node
}

// Filter narrows the tree to nodes whose label matches, keeping their
// ancestors so the hierarchy still reads. Empty string clears it.
func (m *Model) Filter(s string) {
	m.filter = strings.ToLower(s)
	m.reflow()
}

// FilterText is the current filter.
func (m *Model) FilterText() string { return m.filter }

func (m *Model) reflow() {
	m.rows = m.rows[:0]
	for i, r := range m.roots {
		m.flatten(r, 0, nil, i == len(m.roots)-1)
	}
	if m.cursor >= len(m.rows) {
		m.cursor = len(m.rows) - 1
	}
	if m.cursor < 0 {
		m.cursor = 0
	}
	m.scrollIntoView()
}

func (m *Model) flatten(n *Node, depth int, trunk []bool, last bool) {
	if !m.matches(n) {
		return
	}
	own := append(append([]bool{}, trunk...), last)
	m.rows = append(m.rows, Row{Node: n, Depth: depth, Trunk: append([]bool{}, trunk...), Last: last})
	// A filter opens the tree on its own: hiding a match inside a collapsed
	// parent would make the search look broken.
	if !n.Expanded && m.filter == "" {
		return
	}
	n.ensure()
	kids := make([]*Node, 0, len(n.Children))
	for _, c := range n.Children {
		if m.matches(c) {
			kids = append(kids, c)
		}
	}
	for i, c := range kids {
		m.flatten(c, depth+1, own, i == len(kids)-1)
	}
}

// matches is true when the node, or anything under it, matches the filter.
func (m *Model) matches(n *Node) bool {
	if m.filter == "" {
		return true
	}
	if strings.Contains(strings.ToLower(n.Label), m.filter) {
		return true
	}
	n.ensure()
	for _, c := range n.Children {
		if m.matches(c) {
			return true
		}
	}
	return false
}

// Move shifts the cursor by delta rows.
func (m *Model) Move(delta int) {
	m.cursor += delta
	if m.cursor < 0 {
		m.cursor = 0
	}
	if m.cursor >= len(m.rows) {
		m.cursor = len(m.rows) - 1
	}
	if m.cursor < 0 {
		m.cursor = 0
	}
	m.scrollIntoView()
}

// Top and Bottom jump the cursor to the ends.
func (m *Model) Top()    { m.cursor = 0; m.scrollIntoView() }
func (m *Model) Bottom() { m.cursor = len(m.rows) - 1; m.Move(0) }

// Toggle opens or closes the focused node. Returns false when the node is a
// leaf, so the caller can treat Enter on a leaf as "activate this".
func (m *Model) Toggle() bool {
	n := m.Current()
	if n == nil || !n.HasChildren() {
		return false
	}
	n.Expanded = !n.Expanded
	m.reflow()
	return true
}

// Open expands the focused node, or moves onto its first child when it is
// already open — one key that always goes deeper.
func (m *Model) Open() {
	n := m.Current()
	if n == nil || !n.HasChildren() {
		return
	}
	if !n.Expanded {
		n.Expanded = true
		m.reflow()
		return
	}
	m.Move(1)
}

// Descend opens the focused node and steps onto its first child, in one
// press. Returns false on a leaf, so the caller can treat that as "use this".
//
// Open() deliberately does one thing per press, which is right for l/h
// browsing. For enter it is wrong: expanding and then having to press again
// to get inside means resuming the newest session costs three presses instead
// of two, and the extra press does nothing the reader asked for.
func (m *Model) Descend() bool {
	n := m.Current()
	if n == nil || !n.HasChildren() {
		return false
	}
	if !n.Expanded {
		n.Expanded = true
		m.reflow()
	}
	if m.cursor+1 < len(m.rows) && m.rows[m.cursor+1].Depth > m.rows[m.cursor].Depth {
		m.Move(1)
	}
	return true
}

// Close collapses the focused node, or jumps to its parent when it is already
// closed. This is the move that saves the most keystrokes in a deep tree:
// leaving a subtree is one press, not "up, up, up, left".
func (m *Model) Close() {
	n := m.Current()
	if n == nil {
		return
	}
	if n.HasChildren() && n.Expanded {
		n.Expanded = false
		m.reflow()
		return
	}
	depth := m.rows[m.cursor].Depth
	for i := m.cursor - 1; i >= 0; i-- {
		if m.rows[i].Depth < depth {
			m.cursor = i
			m.scrollIntoView()
			return
		}
	}
}

// ExpandAll and CollapseAll are the whole-tree versions. One key, whole tree:
// walking a session's structure open node by node is the navigation cost this
// package exists to remove.
func (m *Model) ExpandAll()   { m.setAll(true) }
func (m *Model) CollapseAll() { m.setAll(false) }

func (m *Model) setAll(v bool) {
	// Keep whatever the cursor is on under the cursor across the reflow;
	// otherwise expanding a big tree teleports you somewhere arbitrary.
	var focus *Node
	if n := m.Current(); n != nil {
		focus = n
	}
	var walk func(n *Node)
	walk = func(n *Node) {
		if !n.HasChildren() {
			return
		}
		if v {
			n.ensure()
		}
		n.Expanded = v
		for _, c := range n.Children {
			walk(c)
		}
	}
	for _, r := range m.roots {
		walk(r)
	}
	if !v {
		// Roots stay open on a collapse-all: closing them too leaves a screen
		// that says nothing about what is in the tree.
		for _, r := range m.roots {
			if r.HasChildren() {
				r.Expanded = true
			}
		}
	}
	m.reflow()
	if focus != nil {
		for i, r := range m.rows {
			if r.Node == focus {
				m.cursor = i
				break
			}
		}
		m.scrollIntoView()
	}
}

// Expanded reports how many nodes are currently open. Used by callers that
// show "all open" / "all closed" in a status line, and by tests.
func (m *Model) Expanded() int {
	n := 0
	var walk func(*Node)
	walk = func(x *Node) {
		if x.Expanded {
			n++
		}
		for _, c := range x.Children {
			walk(c)
		}
	}
	for _, r := range m.roots {
		walk(r)
	}
	return n
}

func (m *Model) scrollIntoView() {
	if m.height < 1 {
		m.height = 1
	}
	if m.cursor < m.offset {
		m.offset = m.cursor
	}
	if m.cursor >= m.offset+m.height {
		m.offset = m.cursor - m.height + 1
	}
	if max := len(m.rows) - m.height; m.offset > max {
		m.offset = max
	}
	if m.offset < 0 {
		m.offset = 0
	}
}

// View renders the visible window. Callers supply the theme, so the tree owns
// no colours of its own.
func (m *Model) View(t *theme.Theme, focused bool) string {
	if len(m.rows) == 0 {
		return ""
	}
	end := m.offset + m.height
	if end > len(m.rows) {
		end = len(m.rows)
	}
	out := make([]string, 0, end-m.offset)
	for i := m.offset; i < end; i++ {
		out = append(out, m.line(t, i, focused && i == m.cursor))
	}
	return strings.Join(out, "\n")
}

func (m *Model) line(t *theme.Theme, i int, sel bool) string {
	r := m.rows[i]
	var b strings.Builder

	// The trunk: a pipe for every ancestor that still has siblings below it,
	// blank for the ones that do not. This is what makes depth readable
	// without counting indentation.
	for _, ancestorWasLast := range r.Trunk {
		if ancestorWasLast {
			b.WriteString(t.G.Gap)
		} else {
			b.WriteString(t.G.Pipe)
		}
	}
	if r.Depth > 0 {
		if r.Last {
			b.WriteString(t.G.Last)
		} else {
			b.WriteString(t.G.Branch)
		}
	}
	trunk := t.Faint.Render(b.String())

	marker := " "
	if r.Node.HasChildren() {
		marker = t.G.Closed
		if r.Node.Expanded {
			marker = t.G.Open
		}
	}

	label := m.style(t, r.Node).Render(r.Node.Label)
	head := trunk + t.Muted.Render(marker) + " " + label

	// One column is spent on the selection marker, so everything else has
	// width-1 to live in. Forgetting that is how the right-hand detail loses
	// its last character.
	avail := m.width - 1
	if avail < 1 {
		avail = 1
	}

	// Detail is right-aligned and dropped rather than wrapped: a tree that
	// wraps stops being scannable, which is the only reason to use a tree.
	if r.Node.Detail != "" {
		room := avail - ansi.StringWidth(head) - ansi.StringWidth(r.Node.Detail)
		if room >= 1 {
			head += strings.Repeat(" ", room) + t.Faint.Render(r.Node.Detail)
		}
	}
	if ansi.StringWidth(head) > avail {
		head = ansi.Truncate(head, avail, "…")
	}
	if sel {
		return t.Accent.Render(t.G.Seg) + head
	}
	return " " + head
}

func (m *Model) style(t *theme.Theme, n *Node) interface{ Render(...string) string } {
	switch n.State {
	case Running:
		return t.Accent
	case Failed:
		return t.Fail
	case OK:
		if n.Kind == Turn || n.Kind == Agent {
			return t.Ink
		}
	}
	switch n.Kind {
	case Dir:
		return t.Coat
	case File:
		return t.Ink
	case Session:
		return t.Ink
	case Agent:
		return t.Thinking
	case Memory:
		return t.Rosette
	case Turn:
		return t.Muted
	}
	return t.Ink
}
