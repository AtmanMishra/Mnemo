package memory

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/tree"
)

// fakeSrv and echoSrv live in fakesrv_test.go: the stand-in sidecar is this
// test binary re-executed, because a `#!/bin/sh` fixture is not something
// Windows can run.

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
	c := open(t, fakeSrv(t, fakeSpec{Error: "no such node"}))
	if _, err := c.Dump(); err == nil || !strings.Contains(err.Error(), "no such node") {
		t.Fatalf("err = %v", err)
	}
}

func TestStrayOutputIsNotAProtocolFailure(t *testing.T) {
	c := open(t, fakeSrv(t, fakeSpec{Result: `{"nodes":[]}`, Stray: true}))
	if _, err := c.Dump(); err != nil {
		t.Fatalf("a non-JSON line must be skipped, not fail the call: %v", err)
	}
}

func TestASidecarThatDiesIsReportedNotHungOn(t *testing.T) {
	c := open(t, fakeSrv(t, fakeSpec{Die: true}))
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
	c := open(t, fakeSrv(t, fakeSpec{Error: "gone"}))
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

// TestATimedOutCallDoesNotEatTheNextReply is the regression for the leaked
// reader: the old Call spawned a reader goroutine per request and left it
// alive on timeout, so when that reader finally woke it kept racing the next
// call's reader on the same bufio.Reader — and could consume the line that
// answered the NEXT call, discarding it on an id mismatch. The single
// readLoop drops the late reply instead: nobody wants it, nobody loses theirs.
func TestATimedOutCallDoesNotEatTheNextReply(t *testing.T) {
	// The first request takes a second to answer; every other one answers
	// immediately. The first reply is therefore late — the caller that asked
	// for it has already timed out and gone home.
	c := open(t, fakeSrv(t, fakeSpec{Result: `{"nodes":[]}`, DelayOnce: 1000}))
	c.callTimeout = 50 * time.Millisecond

	if _, err := c.Dump(); err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("the first call must time out, got: %v", err)
	}
	// Let the sidecar finish sleeping and flush the late reply for id 1.
	// The reader must drop it, not hand it to — or steal from — anyone.
	time.Sleep(1100 * time.Millisecond)

	// A generous timeout for the second call: it is answered immediately, so
	// any failure here is the late reply having eaten it, not slowness.
	c.callTimeout = 5 * time.Second
	if _, err := c.Dump(); err != nil {
		t.Fatalf("a late reply to a timed-out call must not eat the next one: %v", err)
	}
}

// TestACallAfterTheSidecarDiedFailsFast pins the readErr path: once the
// connection is known dead, waiting out a full timeout for a reply that can
// never come is just a hung overlay with a clock.
func TestACallAfterTheSidecarDiedFailsFast(t *testing.T) {
	// Answers its one request, then dies: the reply proves the protocol
	// worked, so the failure that follows is the death, not a bug.
	c := open(t, fakeSrv(t, fakeSpec{Result: `{"nodes":[]}`, Once: true}))
	// Generous for the setup: the sidecar's round trip can take hundreds of
	// milliseconds on a loaded machine; the fast-fail claim is only about the
	// call AFTER the death is known.
	if _, err := c.Dump(); err != nil {
		t.Fatalf("setup: the first call should be answered, got: %v", err)
	}
	// The death is noticed asynchronously (EOF rides on the child exiting);
	// wait for the client to know it — bounded, because a hang here is a
	// bug, not a pass.
	deadline := time.Now().Add(2 * time.Second)
	for {
		c.wmu.Lock()
		re := c.readErr
		c.wmu.Unlock()
		if re != nil || time.Now().After(deadline) {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	// A tight bound for the assertion: the readErr check returns before any
	// waiting begins, so anything near a timeout here is the slow path.
	c.callTimeout = 50 * time.Millisecond
	start := time.Now()
	_, err := c.Dump()
	if err == nil || !strings.Contains(err.Error(), "closed the connection") {
		t.Fatalf("a call on a dead sidecar must say the connection is gone, got: %v", err)
	}
	if elapsed := time.Since(start); elapsed >= c.callTimeout {
		t.Fatalf("a known-dead connection must fail fast, took the whole timeout: %v", elapsed)
	}
}
