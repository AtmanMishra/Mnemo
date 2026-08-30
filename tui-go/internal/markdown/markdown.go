// Package markdown renders a message the way it was written.
//
// The agent writes markdown. Showing it raw — `**Code work**`, backticks
// around every path — makes the reader do the parsing, and asterisks in the
// middle of a sentence are exactly the noise a terminal interface should be
// spending its glyphs to remove.
//
// Glamour does the rendering; this package owns the stylesheet, which is
// generated from the palette rather than hand-written, so markdown and the
// rest of the interface cannot end up two different colour schemes.
package markdown

import (
	"encoding/json"
	"fmt"
	"image/color"
	"strings"
	"sync"

	"charm.land/glamour/v2"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/theme"
	"github.com/charmbracelet/x/ansi"
)

// hex renders a palette colour as the "#rrggbb" glamour expects.
func hex(c color.Color) string {
	r, g, b, _ := c.RGBA()
	return fmt.Sprintf("#%02X%02X%02X", r>>8, g>>8, b>>8)
}

// Stylesheet builds glamour's JSON style from a theme.
//
// Margins and indents are zero throughout: this renders INTO a transcript
// that already has a gutter and a page margin, and glamour's own two-column
// indent on top of those would push every message a third of the way across
// the screen.
func Stylesheet(t *theme.Theme) []byte {
	p := t.P
	s := map[string]any{
		"document":  map[string]any{"margin": 0, "color": hex(p.Ink)},
		"paragraph": map[string]any{},
		"text":      map[string]any{},

		// Bold is the one that matters most: it is what the agent uses for
		// the heading of every list it writes.
		"strong":        map[string]any{"bold": true, "color": hex(p.Ink)},
		"emph":          map[string]any{"italic": true},
		"strikethrough": map[string]any{"crossed_out": true},

		"heading": map[string]any{"color": hex(p.Accent), "bold": true, "block_suffix": "\n"},
		"h1":      map[string]any{"prefix": "", "suffix": "", "color": hex(p.Accent), "bold": true},
		"h2":      map[string]any{"prefix": "", "color": hex(p.Accent), "bold": true},
		"h3":      map[string]any{"prefix": "", "color": hex(p.Coat), "bold": true},
		"h4":      map[string]any{"prefix": "", "color": hex(p.Coat)},
		"h5":      map[string]any{"prefix": "", "color": hex(p.Muted)},
		"h6":      map[string]any{"prefix": "", "color": hex(p.Muted)},

		"list": map[string]any{"level_indent": 2},
		// A round bullet in the accent: the list marker is chrome, so it is
		// drawn as chrome rather than competing with the words beside it.
		"item":        map[string]any{"block_prefix": "· "},
		"enumeration": map[string]any{"block_prefix": ". "},
		"task":        map[string]any{"ticked": "[x] ", "unticked": "[ ] "},

		"block_quote": map[string]any{"indent": 1, "indent_token": "│ ", "color": hex(p.Muted)},
		"hr":          map[string]any{"color": hex(p.Faint), "format": "\n────────\n"},

		"link":      map[string]any{"color": hex(p.Link), "underline": true},
		"link_text": map[string]any{"color": hex(p.Link)},
		"image":     map[string]any{"color": hex(p.Link), "underline": true},

		// Inline code is a path or an identifier. It gets the link colour and
		// no background: a background on a word inside a sentence chops the
		// line into pieces.
		"code": map[string]any{"color": hex(p.Link)},

		"code_block": map[string]any{
			"margin": 0,
			"color":  hex(p.Ink),
			"chroma": chroma(p),
		},

		"table":           map[string]any{"center_separator": "┼", "column_separator": "│", "row_separator": "─"},
		"definition_list": map[string]any{},
	}
	b, _ := json.Marshal(s)
	return b
}

// chroma maps syntax highlighting onto the same fourteen colours.
//
// A code block lit in a scheme of its own is the fastest way to make an
// interface look like two programs stitched together.
func chroma(p theme.Palette) map[string]any {
	c := func(x color.Color) map[string]any { return map[string]any{"color": hex(x)} }
	return map[string]any{
		"text":              c(p.Ink),
		"error":             map[string]any{"color": hex(p.Fail)},
		"comment":           c(p.Muted),
		"comment_preproc":   c(p.Rosette),
		"keyword":           map[string]any{"color": hex(p.Accent), "bold": true},
		"keyword_reserved":  c(p.Accent),
		"keyword_namespace": c(p.Rosette),
		"keyword_type":      c(p.Coat),
		"operator":          c(p.Muted),
		"punctuation":       c(p.Muted),
		"name":              c(p.Ink),
		"name_builtin":      c(p.Coat),
		"name_tag":          c(p.Thinking),
		"name_attribute":    c(p.Thinking),
		"name_class":        c(p.Coat),
		"name_function":     c(p.Link),
		"name_constant":     c(p.Coat),
		"literal":           c(p.OK),
		"literal_number":    c(p.OK),
		"literal_string":    c(p.OK),
		"background":        map[string]any{"color": hex(p.Ink)},
	}
}

// Renderer renders markdown at a fixed width.
//
// One per (theme, width). Building a glamour renderer parses a stylesheet, so
// it is not something to do inside a draw loop.
type Renderer struct {
	mu    sync.Mutex
	width int
	style []byte
	tr    *glamour.TermRenderer
}

// New returns a renderer for a theme.
func New(t *theme.Theme) *Renderer {
	return &Renderer{style: Stylesheet(t), width: -1}
}

// Render turns markdown into styled lines wrapped to width.
//
// On any failure it returns the input split into lines, unstyled. Markdown
// that will not parse is still text somebody needs to read; swallowing it
// would turn a formatting problem into a missing message.
func (r *Renderer) Render(src string, width int) []string {
	if width < 4 {
		width = 4
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.tr == nil || r.width != width {
		tr, err := glamour.NewTermRenderer(
			glamour.WithStylesFromJSONBytes(r.style),
			glamour.WithWordWrap(width),
			glamour.WithPreservedNewLines(),
		)
		if err != nil {
			return strings.Split(src, "\n")
		}
		r.tr, r.width = tr, width
	}

	out, err := r.tr.Render(src)
	if err != nil {
		return strings.Split(src, "\n")
	}
	lines := trim(strings.Split(strings.ReplaceAll(out, "\r\n", "\n"), "\n"))
	for i, l := range lines {
		lines[i] = trimRight(l)
	}
	return lines
}

// trimRight removes the styled trailing spaces glamour pads every line with.
//
// It word-wraps by padding to the full width, which is right for a document
// on its own and wrong inside a transcript: the padding is invisible but it
// is still cells, and it lands underneath the user's message band and past
// the right margin.
func trimRight(line string) string {
	w := ansi.StringWidth(strings.TrimRight(ansi.Strip(line), " \t"))
	if w == 0 {
		return ""
	}
	return ansi.Truncate(line, w, "")
}

// trim removes the blank lines glamour puts around a document. They are
// correct for a standalone page and wrong inside a transcript, where the
// block already has space above and below it.
func trim(lines []string) []string {
	start, end := 0, len(lines)
	for start < end && strings.TrimSpace(lines[start]) == "" {
		start++
	}
	for end > start && strings.TrimSpace(lines[end-1]) == "" {
		end--
	}
	return lines[start:end]
}
