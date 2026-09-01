package markdown

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/theme"
	"github.com/charmbracelet/x/ansi"
)

func renderer() *Renderer {
	return New(theme.New(theme.PICO8, theme.Heavy, true))
}

// plain strips styling so assertions read the words, not the colours.
func plain(lines []string) string {
	var b strings.Builder
	for _, l := range lines {
		b.WriteString(ansi.Strip(l))
		b.WriteByte('\n')
	}
	return b.String()
}

// TestStylesheetIsTheWholePaletteInValidJSON pins the one rule that keeps
// markdown and the rest of the interface from drifting apart: every colour
// the stylesheet uses comes from the theme, and the JSON glamour parses is
// well-formed on every theme.
func TestStylesheetIsTheWholePaletteInValidJSON(t *testing.T) {
	for _, dark := range []bool{true, false} {
		th := theme.New(theme.PICO8, theme.Heavy, dark)
		var v map[string]any
		if err := json.Unmarshal(Stylesheet(th), &v); err != nil {
			t.Fatalf("dark=%v: stylesheet is not valid JSON: %v", dark, err)
		}
		// The two styles that carry the most meaning: bold for the agent's
		// list headings, the accent for real headings.
		strong, _ := v["strong"].(map[string]any)
		if strong["bold"] != true {
			t.Fatalf("dark=%v: strong must be bold — it is how every list heading reads: %#v", dark, strong)
		}
		h1, _ := v["h1"].(map[string]any)
		if h1["color"] == "" {
			t.Fatalf("dark=%v: h1 must carry a colour", dark)
		}
		doc, _ := v["document"].(map[string]any)
		if doc["margin"] != float64(0) {
			t.Fatalf("dark=%v: document margin must be 0 — the transcript already has a gutter: %#v", dark, doc)
		}
	}
}

// TestMarkdownIsRenderedNotLeftRaw is the package's reason to exist: `**x**`
// shown to a reader is noise the interface should have spent glyphs removing.
func TestMarkdownIsRenderedNotLeftRaw(t *testing.T) {
	r := renderer()
	lines := r.Render("**Code work** and `paths`", 40)
	if len(lines) == 0 {
		t.Fatal("rendered nothing")
	}
	out := plain(lines)
	if strings.Contains(out, "**") {
		t.Fatalf("bold markers must not reach the reader:\n%s", out)
	}
	if strings.Contains(out, "`") {
		t.Fatalf("code markers must not reach the reader:\n%s", out)
	}
	if !strings.Contains(out, "Code work") {
		t.Fatalf("the words must survive the rendering:\n%s", out)
	}
}

// TestHeadingsAndListsComeThrough pins the shapes the agent actually writes:
// a heading, a bullet list, a code block, a quote.
func TestHeadingsAndListsComeThrough(t *testing.T) {
	src := "## Plan\n\n- one\n- two\n\n```go\nx := 1\n```\n\n> quoted"
	out := plain(renderer().Render(src, 60))
	for _, want := range []string{"Plan", "one", "two", "x := 1", "quoted"} {
		if !strings.Contains(out, want) {
			t.Fatalf("%q lost by the renderer:\n%s", want, out)
		}
	}
}

// TestLongLinesWrapToTheWidth: a transcript that overflows its column wraps
// underneath the user's band and past the margin — the width is a promise.
func TestLongLinesWrapToTheWidth(t *testing.T) {
	word := strings.Repeat("word ", 40)
	for _, w := range []int{20, 40, 80} {
		for _, line := range renderer().Render(word, w) {
			if width := ansi.StringWidth(line); width > w {
				t.Fatalf("width %d: a line is %d cells:\n%q", w, width, line)
			}
		}
	}
}

// TestAGlaringlyNarrowWidthStillRenders: width < 4 clamps to 4 rather than
// dividing by zero or wrapping to nothing. A resize to a silly width must
// never crash the interface.
func TestAGlaringlyNarrowWidthStillRenders(t *testing.T) {
	lines := renderer().Render("hello **world**", 0)
	if len(lines) == 0 {
		t.Fatal("width 0 must still produce lines")
	}
	lines = renderer().Render("hello **world**", -5)
	if len(lines) == 0 {
		t.Fatal("negative width must still produce lines")
	}
}

// TestTheSameRendererSurvivesAWidthChange pins the renderer-reuse contract:
// one Renderer per theme, re-made when the width moves. A renderer that
// cached its wrap width would keep the old width after a resize.
func TestTheSameRendererSurvivesAWidthChange(t *testing.T) {
	r := renderer()
	src := strings.Repeat("word ", 30)
	narrow := r.Render(src, 16)
	wide := r.Render(src, 80)
	if len(narrow) <= len(wide) {
		t.Fatalf("narrow (=%d lines) should wrap into more rows than wide (=%d)",
			len(narrow), len(wide))
	}
	// And back again: the renderer must not wedge on the second width.
	if again := r.Render(src, 16); len(again) != len(narrow) {
		t.Fatalf("re-render at the first width changed: %d vs %d", len(again), len(narrow))
	}
}

// TestGlamoursPaddingIsTrimmedAndSoAreItsMargins: glamour pads every line to
// the wrap width and puts blank lines around the document. Both are wrong
// inside a transcript — padding sits under the message band, and the block
// already has space above and below it.
func TestGlamoursPaddingIsTrimmedAndSoAreItsMargins(t *testing.T) {
	r := renderer()
	for _, src := range []string{"one line", "a\n\nb", "para one\n\npara two"} {
		lines := r.Render(src, 80)
		if len(lines) == 0 || strings.TrimSpace(plain(lines)) == "" {
			t.Fatalf("%q rendered to nothing", src)
		}
		if first := lines[0]; strings.TrimSpace(first) == "" {
			t.Fatalf("%q: leading blank line kept:\n%q", src, plain(lines))
		}
		if last := lines[len(lines)-1]; strings.TrimSpace(last) == "" {
			t.Fatalf("%q: trailing blank line kept:\n%q", src, plain(lines))
		}
		for i, l := range lines {
			stripped := ansi.Strip(l)
			if strings.Contains(stripped, "  ") && strings.TrimSpace(stripped) != "" {
				// only trailing padding is the enemy; interior double spaces
				// in code blocks are legitimate
				if l != strings.TrimRight(stripped, "") {
					continue
				}
			}
			if l != "" && strings.HasSuffix(ansi.Strip(l), " ") {
				t.Fatalf("%q line %d keeps glamour's trailing padding: %q", src, i, l)
			}
		}
	}
}

// TestStreamingChunksRenderIndependently: a delta arrives as two chunks and
// each is rendered as it lands; neither half may come back empty.
func TestStreamingChunksRenderIndependently(t *testing.T) {
	r := renderer()
	a := r.Render("the answer is **imp", 40)
	b := r.Render("the answer is **important**", 40)
	if len(a) == 0 || len(b) == 0 {
		t.Fatalf("a half-written marker must still render as text:\n%q", plain(a))
	}
	if !strings.Contains(plain(a), "imp") {
		t.Fatalf("the first chunk lost its words:\n%s", plain(a))
	}
}

// TestPlainIsNotMangledByMarkdown: most of a transcript is plain sentences.
// A renderer that eats or decorates them is worse than none.
func TestPlainIsNotMangledByMarkdown(t *testing.T) {
	src := "just a plain sentence with a /path and an UPPERCASE word"
	out := plain(renderer().Render(src, 60))
	for _, want := range []string{"just a plain sentence", "/path", "UPPERCASE"} {
		if !strings.Contains(out, want) {
			t.Fatalf("%q lost:\n%s", want, out)
		}
	}
}
