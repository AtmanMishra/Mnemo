// Package ui is the chrome: rules, bands, chips and the brand header.
//
// It draws structure and nothing else — no state lives here. Everything takes
// a *theme.Theme, so the entire look changes by passing a different one.
package ui

import (
	"strings"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/theme"
	"github.com/charmbracelet/x/ansi"
)

// Seg is one cell of a status band: text plus how to paint it.
type Seg struct {
	Text  string
	Style interface{ Render(...string) string }
}

// Rule draws a horizontal rule with a label notched into it:
//
//	━━╾ TRANSCRIPT ╼━━━━━━━━━━━━━━━━━━━━━━━━
//
// A label inside the rule costs no extra row, which is the whole reason the
// interface can afford to name every region. An unlabelled region is a region
// the reader has to guess at, and guessing is what the six-pane rail was.
func Rule(t *theme.Theme, width int, label string) string {
	if width < 4 {
		return t.Rule.Render(strings.Repeat(t.G.H, max(width, 0)))
	}
	if label == "" {
		return t.Rule.Render(strings.Repeat(t.G.H, width))
	}
	label = strings.ToUpper(label)
	// ━━╾ LABEL ╼ + filler
	head := t.Rule.Render(strings.Repeat(t.G.H, 2)+t.G.Nub+" ") +
		t.Label.Render(label) +
		t.Rule.Render(" "+reverse(t.G.Nub))
	used := 2 + 1 + 1 + ansi.StringWidth(label) + 1 + 1
	if used >= width {
		return ansi.Truncate(head, width, "")
	}
	return head + t.Rule.Render(strings.Repeat(t.G.H, width-used))
}

// reverse turns ╾ into ╼ so the notch closes the other way. Kept as a lookup
// rather than arithmetic because the box-drawing block is not laid out in
// mirrored pairs.
func reverse(s string) string {
	switch s {
	case "╾":
		return "╼"
	case "╼":
		return "╾"
	}
	return s
}

// Band lays out a status line: left segments, then filler, then right
// segments. Segments are separated by ▌, which reads as a divider without
// spending a column on whitespace either side.
//
// When the two sides do not fit, the RIGHT side wins and the left is
// truncated: the right carries counts, and a count that silently disappears
// is worse than a hint that does.
func Band(t *theme.Theme, width int, left, right []Seg) string {
	l := join(t, left)
	r := join(t, right)
	lw, rw := ansi.StringWidth(l), ansi.StringWidth(r)
	if rw >= width {
		return ansi.Truncate(r, width, "")
	}
	if lw+1+rw > width {
		l = ansi.Truncate(l, width-rw-1, "…")
		lw = ansi.StringWidth(l)
	}
	return l + strings.Repeat(" ", max(width-lw-rw, 0)) + r
}

func join(t *theme.Theme, segs []Seg) string {
	parts := make([]string, 0, len(segs))
	for _, s := range segs {
		if s.Text == "" {
			continue
		}
		st := s.Style
		if st == nil {
			st = t.Muted
		}
		parts = append(parts, st.Render(s.Text))
	}
	return strings.Join(parts, t.Faint.Render(" "+t.G.Seg+" "))
}

// Chip is a short reversed label — the mode indicator. Reversed rather than
// merely coloured because the mode is the one thing you must be able to read
// without looking for it.
func Chip(t *theme.Theme, text string) string {
	return t.Selected.Render(" " + strings.ToUpper(text) + " ")
}

// Header is the brand band: the mark, then a dither texture, then facts.
//
// The texture is the thinking animation's own ramp. When the agent is idle
// the band is still; when it is working, the band travels. That is the
// largest motion cue on screen and it costs no row of its own — "motion is
// progress", spent where it is impossible to miss.
func Header(t *theme.Theme, width, phase int, working bool, facts []Seg) string {
	if width < 8 {
		return ""
	}
	mark := t.Coat.Render(t.G.Tick + " MNEMO")
	right := join(t, facts)
	used := ansi.StringWidth(mark) + ansi.StringWidth(right) + 2
	fill := width - used
	if fill < 1 {
		return ansi.Truncate(mark+" "+right, width, "")
	}
	var tex string
	if working {
		tex = t.Thinking.Render(theme.Wave(phase, fill))
	} else {
		// Idle: the lightest step of the same ramp, so the band is present
		// but silent. A still screen is what "nothing is happening" looks
		// like here.
		tex = t.Faint.Render(strings.Repeat(string(theme.Dither[1]), fill))
	}
	return mark + " " + tex + " " + right
}

// Pane frames a body in a labelled region: a rule with the label notched in,
// then the body, padded to height.
func Pane(t *theme.Theme, width, height int, label, body string) string {
	if height < 1 {
		return ""
	}
	out := make([]string, 0, height)
	out = append(out, Rule(t, width, label))
	lines := strings.Split(body, "\n")
	for i := 0; i < height-1; i++ {
		if i < len(lines) {
			out = append(out, ansi.Truncate(lines[i], width, ""))
		} else {
			out = append(out, "")
		}
	}
	return strings.Join(out, "\n")
}

// SideBySide joins two columns with a vertical rule between them, padding
// both to height so the rule is unbroken.
func SideBySide(t *theme.Theme, height int, left string, right string) string {
	if right == "" {
		return left
	}
	l, r := strings.Split(left, "\n"), strings.Split(right, "\n")
	bar := t.Rule.Render(t.G.V)
	out := make([]string, 0, height)
	for i := 0; i < height; i++ {
		var a, b string
		if i < len(l) {
			a = l[i]
		}
		if i < len(r) {
			b = r[i]
		}
		out = append(out, a+bar+b)
	}
	return strings.Join(out, "\n")
}

// Pad makes every line exactly width cells wide, so columns line up when they
// are joined. Lines longer than width are cut.
func Pad(s string, width int) string {
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		w := ansi.StringWidth(l)
		switch {
		case w > width:
			lines[i] = ansi.Truncate(l, width, "")
		case w < width:
			lines[i] = l + strings.Repeat(" ", width-w)
		}
	}
	return strings.Join(lines, "\n")
}

// PadTo makes a block exactly `rows` rows tall, adding blank lines or cutting
// extra ones. Without it a short transcript leaves the prompt floating in the
// middle of the screen instead of sitting at the bottom where it belongs.
func PadTo(s string, rows int) string {
	if rows < 1 {
		return ""
	}
	lines := strings.Split(s, "\n")
	for len(lines) < rows {
		lines = append(lines, "")
	}
	return strings.Join(lines[:rows], "\n")
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
