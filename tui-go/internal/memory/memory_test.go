package memory

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/tree"
)

// fakeSrv writes a stand-in memsrv into the test's own temp directory. The
// real one replays a journal and may want an API key; the protocol is what is
// under test, and the protocol is a line of JSON in and a line of JSON out.
func fakeSrv(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "memsrv")
	script := "#!/bin/sh\n" + body + "\n"
	if err := os.WriteFile(p, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

// echoSrv replies to every request with the same result, echoing the id back.
func echoSrv(t *testing.T, result string) string {
	t.Helper()
	return fakeSrv(t, `while IFS= read -r line; do
  case "$line" in *'"exit"'*) exit 0;; esac
  id=$(printf '%s' "$line" | sed 's/.*"id":\([0-9]*\).*/\1/')
  printf '{"id":%s,"ok":true,"result":%s}\n' "$id" '`+result+`'
done`)
}

func open(t *testing.T, bin string) *Client {
	t.Helper()
	c, err := Open(bin, filepath.Join(t.TempDir(), "journal.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func TestDumpParsesTheStore(t *testing.T) {
	c := open(t, echoSrv(t, `{"nodes":[{"id":22,"kind":"Aspect","area":"Semantic","label":"project","facts":1,"feeders":2}]}`))
	got, err := c.Dump()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != 22 || got[0].Label != "project" || got[0].Facts != 1 || got[0].Feeders != 2 {
		t.Fatalf("got %#v", got)
	}
}

func TestAnErrorReplyIsAnError(t *testing.T) {
	c := open(t, fakeSrv(t, `while IFS= read -r line; do
  case "$line" in *'"exit"'*) exit 0;; esac
  printf '{"id":1,"ok":false,"error":"no such node"}\n'
done`))
	if _, err := c.Dump(); err == nil || !strings.Contains(err.Error(), "no such node") {
		t.Fatalf("err = %v", err)
	}
}

func TestStrayOutputIsNotAProtocolFailure(t *testing.T) {
	c := open(t, fakeSrv(t, `while IFS= read -r line; do
  case "$line" in *'"exit"'*) exit 0;; esac
  printf 'loading journal...\n'
  printf '{"id":1,"ok":true,"result":{"nodes":[]}}\n'
done`))
	if _, err := c.Dump(); err != nil {
		t.Fatalf("a non-JSON line must be skipped, not fail the call: %v", err)
	}
}

func TestASidecarThatDiesIsReportedNotHungOn(t *testing.T) {
	c := open(t, fakeSrv(t, `exit 1`))
	if _, err := c.Dump(); err == nil {
		t.Fatal("a dead sidecar must be an error, or the overlay just never opens")
	}
}

func TestCloseIsIdempotentAndBlocksFurtherCalls(t *testing.T) {
	c := open(t, echoSrv(t, `{"nodes":[]}`))
	if err := c.Close(); err != nil {
		t.Fatal(err)
	}
	if err := c.Close(); err != nil {
		t.Fatalf("closing twice must be safe: %v", err)
	}
	if _, err := c.Dump(); err == nil {
		t.Fatal("a call after close must fail rather than write to a dead pipe")
	}
}

func TestFactsRenderEveryShape(t *testing.T) {
	for _, c := range []struct {
		state string
		want  string
	}{
		{`"one\ntwo"`, "one"},
		{`["a","b"]`, "a"},
		{`{"facts":["x"]}`, "facts: x"},
		{`12`, "12"},
	} {
		cl := open(t, echoSrv(t, `{"state":`+c.state+`}`))
		got := cl.Facts(1)
		if len(got) == 0 || got[0] != c.want {
			t.Fatalf("state %s rendered %#v, want first line %q", c.state, got, c.want)
		}
	}
}

func TestAFailedStateCallStillSaysSomething(t *testing.T) {
	// A memory that renders blank is indistinguishable from one that is empty.
	c := open(t, fakeSrv(t, `while IFS= read -r line; do
  case "$line" in *'"exit"'*) exit 0;; esac
  printf '{"id":1,"ok":false,"error":"gone"}\n'
done`))
	got := c.Facts(9)
	if len(got) == 0 || !strings.Contains(got[0], "gone") {
		t.Fatalf("got %#v", got)
	}
}

// --- the grouping, which is the part that made the old pane useless ------

func nodes() []Node {
	return []Node{
		{ID: 3, Area: "Episodic", Kind: "TaskEpisode", Label: "pi session 2026-08-24", Facts: 0},
		{ID: 51, Area: "Episodic", Kind: "TaskEpisode", Label: "pi session 2026-08-30", Facts: 0},
		{ID: 22, Area: "Semantic", Kind: "Aspect", Label: "project", Facts: 1},
		{ID: 7, Area: "Semantic", Kind: "Aspect", Label: "ops", Facts: 4},
	}
}

func TestMemoriesSortByWhatTheyKnowNotByID(t *testing.T) {
	// By id, thirty empty episodes bury every memory that knows something.
	// That is exactly what made the old memory pane useless.
	got := Nodes(nodes(), nil)
	var semantic *tree.Node
	for _, a := range got {
		if a.Label == "Semantic" {
			semantic = a
		}
	}
	if semantic == nil {
		t.Fatal("no Semantic area")
	}
	if semantic.Children[0].Label != "ops" {
		t.Fatalf("the memory with four facts must come first, got %q", semantic.Children[0].Label)
	}
}

func TestAnAreaThatKnowsSomethingOpensItself(t *testing.T) {
	got := Nodes(nodes(), nil)
	for _, a := range got {
		switch a.Label {
		case "Semantic":
			if !a.Expanded {
				t.Fatal("the area you came to read must open itself")
			}
		case "Episodic":
			if a.Expanded {
				t.Fatal("forty-seven empty episodes must not be the first thing on screen")
			}
		}
	}
	if got[0].Label != "Semantic" {
		t.Fatalf("areas that hold knowledge come first, got %q", got[0].Label)
	}
}

func TestFactsLoadOnlyWhenAMemoryIsOpened(t *testing.T) {
	calls := 0
	got := Nodes(nodes(), func(int) []string { calls++; return []string{"a fact"} })
	if calls != 0 {
		t.Fatal("building the tree must not query every memory")
	}
	m := tree.New(got...)
	m.ExpandAll()
	if calls == 0 {
		t.Fatal("opening must load")
	}
	var found bool
	for _, r := range m.Rows() {
		if r.Node.Label == "a fact" {
			found = true
		}
	}
	if !found {
		t.Fatal("the facts did not reach the tree")
	}
}

func TestAMemoryWithNoFactsHasNothingToOpen(t *testing.T) {
	got := Nodes([]Node{{ID: 1, Area: "Episodic", Label: "empty", Facts: 0}}, func(int) []string {
		t.Fatal("an empty memory must never be queried")
		return nil
	})
	if got[0].Children[0].HasChildren() {
		t.Fatal("a memory with no facts must not render as openable")
	}
}

func TestCountsReadAsEnglish(t *testing.T) {
	// "1 facts" in a column you are scanning reads as a rendering bug, and a
	// reader who distrusts one number distrusts the rest.
	got := Nodes([]Node{{ID: 1, Area: "S", Label: "x", Facts: 1}}, nil)
	if !strings.HasPrefix(got[0].Children[0].Detail, "1 fact") || strings.Contains(got[0].Children[0].Detail, "1 facts") {
		t.Fatalf("detail = %q", got[0].Children[0].Detail)
	}
	if !strings.HasPrefix(got[0].Detail, "1 memory ") {
		t.Fatalf("area detail = %q", got[0].Detail)
	}
	two := Nodes([]Node{{ID: 1, Area: "S", Label: "x", Facts: 2}, {ID: 2, Area: "S", Label: "y"}}, nil)
	if !strings.Contains(two[0].Detail, "2 memories") {
		t.Fatalf("area detail = %q", two[0].Detail)
	}
}

func TestAnAreaWithNoNameIsFiledNotDropped(t *testing.T) {
	got := Nodes([]Node{{ID: 1, Label: "loose", Facts: 1}}, nil)
	if len(got) != 1 || got[0].Label != "unfiled" {
		t.Fatalf("got %#v", got)
	}
}
