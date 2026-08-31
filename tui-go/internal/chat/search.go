package chat

import (
	"strings"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/theme"
	"github.com/charmbracelet/x/ansi"
)

// Search over the transcript.
//
// It matches on RENDERED rows, not on the source text, which is the whole
// point: what you are looking for is a line you remember seeing, and after
// wrapping and markdown a source line and a screen line are not the same
// thing. Searching the source would jump you to a row that does not contain
// the words you typed.
//
// A collapsed block is opened when it contains a hit. A search that reports
// seven matches and shows you a folded summary has not found anything.

// Search sets the query and returns how many rows match. An empty query
// clears it.
func (m *Model) Search(q string) int {
	m.query = strings.ToLower(q)
	if m.query == "" {
		m.hits, m.hit = nil, 0
		return 0
	}
	// Open anything that hides a match, before the rows are counted — a block
	// opened afterwards would shift every row index under the hits.
	for _, b := range m.blocks {
		if !b.Open && b.Foldable() && blockMatches(b, m.query) {
			b.Open = true
		}
	}
	m.recount()
	return len(m.hits)
}

func blockMatches(b *Block, q string) bool {
	if strings.Contains(strings.ToLower(b.Title+" "+b.Detail), q) {
		return true
	}
	for _, l := range b.Body {
		if strings.Contains(strings.ToLower(l), q) {
			return true
		}
	}
	for _, c := range b.Children {
		if blockMatches(c, q) {
			return true
		}
	}
	return false
}

// recount finds the matching rows at the current width and folding.
func (m *Model) recount() {
	m.hits = m.hits[:0]
	if m.query == "" {
		return
	}
	m.counting = true
	defer func() { m.counting = false }()
	for i, r := range m.render(nil) {
		if strings.Contains(strings.ToLower(ansi.Strip(r.text)), m.query) {
			m.hits = append(m.hits, i)
		}
	}
	if m.hit >= len(m.hits) {
		m.hit = 0
	}
}

// Query is the live search, for the status line.
func (m *Model) Query() string { return m.query }

// SearchAt reports which hit is current and how many there are, counting from
// one because that is how the reader counts.
func (m *Model) SearchAt() (int, int) {
	if len(m.hits) == 0 {
		return 0, 0
	}
	return m.hit + 1, len(m.hits)
}

// NextHit and PrevHit move between matches, wrapping around.
//
// Wrapping rather than stopping at the end: you are looking for a line, not
// auditing the list, and being told "no more matches" when there are six
// behind you is an interface making you do the bookkeeping.
func (m *Model) NextHit() bool { return m.jump(1) }
func (m *Model) PrevHit() bool { return m.jump(-1) }

func (m *Model) jump(d int) bool {
	m.recount()
	if len(m.hits) == 0 {
		return false
	}
	m.hit = (m.hit + d + len(m.hits)) % len(m.hits)
	m.showRow(m.hits[m.hit])
	return true
}

// FirstHit puts the view on the first match at or after the current position,
// which is what pressing enter on a query should do.
func (m *Model) FirstHit() bool {
	m.recount()
	if len(m.hits) == 0 {
		return false
	}
	m.hit = 0
	m.showRow(m.hits[0])
	return true
}

// showRow scrolls a row into view with a little room above it, so a match at
// the top of the screen still has the line before it for context.
func (m *Model) showRow(i int) {
	m.follow = false
	if i < m.scroll || i >= m.scroll+m.height {
		m.scroll = i - m.height/3
	}
	m.clamp()
	if b := m.blockAt(i); b >= 0 {
		m.focus = b
	}
}

func (m *Model) blockAt(i int) int {
	m.counting = true
	defer func() { m.counting = false }()
	rows := m.render(nil)
	if i < 0 || i >= len(rows) {
		return -1
	}
	return rows[i].block
}

// highlight marks every occurrence of the query in a rendered row.
//
// The row is already styled — markdown, gutters, tool state — so the match is
// spliced in by cell offset rather than by string index: everything before it
// keeps its styling, the match itself is repainted, and everything after it
// keeps its styling too. The match loses its original colour for the length
// of the match, which is the correct trade: you are looking for it.
func highlight(t *theme.Theme, line, q string, current bool) string {
	if q == "" {
		return line
	}
	plain := ansi.Strip(line)
	lower := strings.ToLower(plain)
	if !strings.Contains(lower, q) {
		return line
	}
	style := t.Match
	if current {
		style = t.MatchNow
	}

	var out strings.Builder
	rest, cut := line, 0
	for {
		bare := ansi.Strip(rest)
		at := strings.Index(strings.ToLower(bare), q)
		if at < 0 {
			out.WriteString(rest)
			return out.String()
		}
		// strings.Index gives a BYTE offset; ansi.Truncate counts CELLS. They
		// agree only for ASCII, and the gutter glyph is three bytes and one
		// cell — so slicing on the byte offset put every highlight two
		// columns to the right of the word it was marking.
		col := ansi.StringWidth(bare[:at])
		w := ansi.StringWidth(bare[at : at+len(q)])

		out.WriteString(ansi.Truncate(rest, col, ""))
		out.WriteString(style.Render(bare[at : at+len(q)]))
		rest = ansi.TruncateLeft(rest, col+w, "")
		if cut++; cut > 64 {
			out.WriteString(rest) // a pathological line is not worth a hang
			return out.String()
		}
	}
}
