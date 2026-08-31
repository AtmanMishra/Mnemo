package chat

import (
	"strings"
	"testing"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/markdown"
	"github.com/charmbracelet/x/ansi"
)

func searchable() *Model {
	m := New()
	m.SetSize(60, 8)
	m.Append(&Block{Kind: User, Body: []string{"where does the parser live"}})
	m.Append(&Block{Kind: Agent, Body: []string{"the parser is in internal/pi"}})
	m.Append(&Block{Kind: Tool, Title: "read", Detail: "40 ln",
		Body: []string{"func parse(b []byte) error {", "  return nil", "}"}})
	m.Append(&Block{Kind: Agent, Body: []string{"nothing to see"}})
	return m
}

func TestSearchFindsRenderedRowsNotSourceLines(t *testing.T) {
	m := searchable()
	if n := m.Search("parse"); n < 2 {
		t.Fatalf("found %d rows for %q, want at least the two prose lines", n, "parse")
	}
	if cur, total := m.SearchAt(); cur != 1 || total < 2 {
		t.Fatalf("SearchAt = %d of %d", cur, total)
	}
}

func TestSearchOpensACollapsedBlockThatHidesAMatch(t *testing.T) {
	// A search that reports seven matches and shows a folded summary has not
	// found anything.
	m := searchable()
	tool := m.Blocks()[2]
	if tool.Open {
		t.Fatal("the fixture's tool block starts collapsed")
	}
	m.Search("return nil")
	if !tool.Open {
		t.Fatal("a block hiding a match must open")
	}
	if !strings.Contains(ansi.Strip(strings.Join(m.Lines(th()), "\n")), "return nil") {
		t.Fatal("the matching line must be on screen")
	}
}

func TestAnEmptyQueryClearsEverything(t *testing.T) {
	m := searchable()
	m.Search("parser")
	if m.Search("") != 0 {
		t.Fatal("an empty query matches nothing")
	}
	if m.Query() != "" {
		t.Fatalf("Query = %q", m.Query())
	}
	if cur, total := m.SearchAt(); cur != 0 || total != 0 {
		t.Fatalf("SearchAt = %d of %d after clearing", cur, total)
	}
	// And the highlights must be gone, or the transcript stays annotated.
	if strings.Contains(strings.Join(m.Lines(th()), "\n"), "48;2;255;236;39") {
		t.Fatal("a cleared search must leave no highlight behind")
	}
}

func TestMatchesAreHighlightedInPlace(t *testing.T) {
	m := searchable()
	m.Search("parser")
	joined := strings.Join(m.Lines(th()), "\n")
	if !strings.Contains(joined, "48;2;") {
		t.Fatal("a match must be painted, not merely counted")
	}
	// Painting must not damage the text underneath it.
	if !strings.Contains(ansi.Strip(joined), "the parser is in internal/pi") {
		t.Fatalf("splicing the highlight broke the line:\n%s", ansi.Strip(joined))
	}
}

func TestHighlightSurvivesMarkdownStyling(t *testing.T) {
	// The row is already styled, so the match is spliced by CELL offset. Byte
	// offsets would cut an escape sequence in half and corrupt the rest.
	m := New()
	m.SetMarkdown(markdown.New(th()))
	m.SetSize(70, 20)
	m.Append(&Block{Kind: Agent, Body: []string{"**bold** then parser then `code`"}})
	m.Search("parser")
	joined := strings.Join(m.Lines(th()), "\n")
	plain := ansi.Strip(joined)
	if !strings.Contains(plain, "bold then parser then code") {
		t.Fatalf("styling or splicing lost text:\n%q", plain)
	}
	if strings.Contains(plain, "\x1b") {
		t.Fatal("an escape sequence survived stripping — one was cut in half")
	}
}

func TestNextAndPrevWrapAround(t *testing.T) {
	// You are looking for a line, not auditing a list. Being told "no more
	// matches" when six sit behind you is bookkeeping pushed onto the reader.
	m := searchable()
	total := m.Search("parse")
	if total < 2 {
		t.Skip("need at least two matches")
	}
	m.FirstHit()
	for i := 0; i < total-1; i++ {
		m.NextHit()
	}
	if cur, _ := m.SearchAt(); cur != total {
		t.Fatalf("walked to %d of %d", cur, total)
	}
	m.NextHit()
	if cur, _ := m.SearchAt(); cur != 1 {
		t.Fatalf("next past the end went to %d, want 1", cur)
	}
	m.PrevHit()
	if cur, _ := m.SearchAt(); cur != total {
		t.Fatalf("previous past the start went to %d, want %d", cur, total)
	}
}

func TestSearchingWithNoMatchesIsNotAnError(t *testing.T) {
	m := searchable()
	if n := m.Search("zzzznope"); n != 0 {
		t.Fatalf("found %d", n)
	}
	if m.NextHit() || m.PrevHit() || m.FirstHit() {
		t.Fatal("moving through an empty result set must report that it did nothing")
	}
}

func TestSearchIsCaseInsensitive(t *testing.T) {
	m := searchable()
	if m.Search("PARSER") == 0 {
		t.Fatal("you do not remember the case of a line you skimmed")
	}
}

func TestAMatchScrollsIntoViewWithRoomAbove(t *testing.T) {
	m := New()
	m.SetSize(60, 6)
	for i := 0; i < 40; i++ {
		m.Append(&Block{Kind: Agent, Body: []string{"filler"}})
	}
	m.Append(&Block{Kind: Agent, Body: []string{"the needle"}})
	for i := 0; i < 40; i++ {
		m.Append(&Block{Kind: Agent, Body: []string{"filler"}})
	}
	m.Search("needle")
	m.FirstHit()
	if !strings.Contains(ansi.Strip(m.View(th())), "needle") {
		t.Fatalf("the match is not on screen:\n%s", ansi.Strip(m.View(th())))
	}
	if m.Following() {
		t.Fatal("jumping to a match must unpin the view from the bottom")
	}
}
