// Package memory talks to memsrv, the memory layer's sidecar: line-delimited
// JSON-RPC over stdio, one request per line.
//
// memsrv is the single integration surface for the store — every mutation
// goes through its locked journal — so this reads through it rather than
// parsing the journal directly. A second reader of a write-ahead log is a
// second implementation of replay, and the two drift.
package memory

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/tree"
)

// Timeout bounds every request. memsrv loads and replays a journal at start
// up, so the first call can be slow; a hung sidecar must not hang the
// interface.
//
// A variable rather than a constant because an operator sets it: the value
// here is the built-in default, and ~/.mnemo/limits.json ("memory_timeout")
// changes it without a rebuild (internal/limits). Open reads it, so the value
// in force when the client starts is the one every call waits on.
var Timeout = 10 * time.Second

// Node is one memory: what it is about, which brain area it lives in, and how
// much it actually knows.
type Node struct {
	ID      int
	Kind    string
	Area    string
	Label   string
	Facts   int
	Feeders int
}

// reply is one answered request: the result object, or why there isn't one.
type reply struct {
	v   map[string]any
	err error
}

// Client is one long-lived memsrv process.
type Client struct {
	cmd    *exec.Cmd
	in     io.WriteCloser
	out    *bufio.Reader
	mu     sync.Mutex // serialises requests: one write, one wait, at a time
	nextID int
	closed bool

	// wmu guards the waiter table shared with readLoop. It is its own lock
	// because a Call holds mu for its whole 10-second wait — a reader that
	// needed mu to deliver an answer would deadlock against the very call
	// it is answering.
	wmu     sync.Mutex
	waiters map[int]chan reply
	readErr error // set once, when the sidecar's output ended

	// callTimeout bounds each request; Timeout is the default, and Open
	// snapshots it. A field (not the package variable) so a test can time
	// out in milliseconds, not seconds.
	callTimeout time.Duration
}

// Open starts memsrv against a journal.
//
// Both paths are parameters. Nothing here may guess at a location: a client
// that finds its own journal is a client that, in a test, finds the real one.
func Open(bin, journal string) (*Client, error) {
	cmd := exec.Command(bin, journal)
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	// memsrv writes its banner and warnings to stderr; they are not protocol.
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	c := &Client{
		cmd: cmd, in: in, out: bufio.NewReaderSize(out, 1<<20),
		nextID: 1, waiters: map[int]chan reply{}, callTimeout: Timeout,
	}
	// ONE reader for the life of the client. A reader spawned per Call and
	// abandoned on timeout stays alive past the call that made it, and two
	// readers on one bufio.Reader race: the abandoned one can consume the
	// line that answers the NEXT call and discard it on an id mismatch. A
	// late reply here just finds no waiter and is dropped.
	go c.readLoop()
	return c, nil
}

// Call makes one request and returns its result object.
func (c *Client) Call(method string, params map[string]any) (map[string]any, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil, errors.New("memsrv is closed")
	}
	c.wmu.Lock()
	if c.readErr != nil {
		// The sidecar's output already ended; say so now instead of writing
		// into a dead pipe and waiting out the timeout for nothing.
		err := c.readErr
		c.wmu.Unlock()
		return nil, err
	}
	id := c.nextID
	c.nextID++
	ch := make(chan reply, 1) // buffered: readLoop never blocks on a caller that gave up
	c.waiters[id] = ch
	c.wmu.Unlock()
	// Whether this call is answered, times out or fails, its waiter entry
	// must go: a stale entry is how a future call's reply gets delivered to
	// nobody, and a late reply to a dead entry is dropped by the reader.
	defer func() {
		c.wmu.Lock()
		delete(c.waiters, id)
		c.wmu.Unlock()
	}()

	if params == nil {
		params = map[string]any{}
	}
	req, err := json.Marshal(map[string]any{"id": id, "method": method, "params": params})
	if err != nil {
		return nil, err
	}
	if _, err := c.in.Write(append(req, '\n')); err != nil {
		return nil, fmt.Errorf("memsrv write failed: %w", err)
	}

	select {
	case r := <-ch:
		if r.err != nil {
			return nil, r.err
		}
		if ok, _ := r.v["ok"].(bool); !ok {
			return nil, fmt.Errorf("memsrv: %v", r.v["error"])
		}
		res, _ := r.v["result"].(map[string]any)
		return res, nil
	case <-time.After(c.callTimeout):
		return nil, errors.New("memory query timed out")
	}
}

// readLoop owns c.out for the whole life of the client: every reply line is
// read exactly once and handed to the call waiting on its id — or dropped,
// when the call that asked has already timed out. Dropping is the point: the
// reply nobody wants must not sit in front of one somebody does.
func (c *Client) readLoop() {
	for {
		line, err := c.out.ReadString('\n')
		if err != nil {
			c.failAll(errors.New("memsrv closed the connection"))
			return
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var v map[string]any
		if json.Unmarshal([]byte(line), &v) != nil {
			continue // stray output is not a protocol failure
		}
		n, ok := v["id"].(float64)
		if !ok {
			continue
		}
		c.wmu.Lock()
		ch, waiting := c.waiters[int(n)]
		if waiting {
			delete(c.waiters, int(n))
		}
		c.wmu.Unlock()
		if waiting {
			ch <- reply{v: v}
		}
		// A reply with no waiter is a late answer to a call that timed out:
		// dropped, never eaten.
	}
}

// failAll answers every waiting call with err and marks the client unreadable.
func (c *Client) failAll(err error) {
	c.wmu.Lock()
	c.readErr = err
	for id, ch := range c.waiters {
		ch <- reply{err: err}
		delete(c.waiters, id)
	}
	c.wmu.Unlock()
}

// Dump lists every memory in the store.
func (c *Client) Dump() ([]Node, error) {
	res, err := c.Call("dump", nil)
	if err != nil {
		return nil, err
	}
	raw, _ := res["nodes"].([]any)
	out := make([]Node, 0, len(raw))
	for _, r := range raw {
		m, _ := r.(map[string]any)
		if m == nil {
			continue
		}
		out = append(out, Node{
			ID:      num(m, "id"),
			Kind:    str(m, "kind"),
			Area:    str(m, "area"),
			Label:   str(m, "label"),
			Facts:   num(m, "facts"),
			Feeders: num(m, "feeders"),
		})
	}
	return out, nil
}

// Facts returns one memory's current state, as lines.
func (c *Client) Facts(id int) []string {
	res, err := c.Call("state", map[string]any{"node": id})
	if err != nil {
		return []string{err.Error()}
	}
	return flatten(res["state"])
}

// flatten renders whatever shape a state came back as into readable lines.
// An unrecognised shape is shown as its JSON rather than dropped: a memory
// that renders blank is indistinguishable from one that is empty.
func flatten(v any) []string {
	switch t := v.(type) {
	case nil:
		return nil
	case string:
		return strings.Split(t, "\n")
	case []any:
		var out []string
		for _, e := range t {
			out = append(out, flatten(e)...)
		}
		return out
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		var out []string
		for _, k := range keys {
			for _, l := range flatten(t[k]) {
				out = append(out, k+": "+l)
			}
		}
		return out
	default:
		b, _ := json.Marshal(v)
		return []string{string(b)}
	}
}

// Close stops the sidecar.
func (c *Client) Close() error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	c.mu.Unlock()
	_, _ = c.in.Write([]byte(`{"id":0,"method":"exit"}` + "\n"))
	_ = c.in.Close()
	done := make(chan struct{})
	go func() { _ = c.cmd.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		if c.cmd.Process != nil {
			_ = c.cmd.Process.Kill()
		}
	}
	return nil
}

// Nodes groups memories into brain areas, most useful first.
//
// Sorting by fact count rather than by id is the whole point: by id, thirty
// empty "pi session …" episodes bury every memory that actually knows
// something, which is what made the memory pane useless.
func Nodes(nodes []Node, facts func(int) []string) []*tree.Node {
	byArea := map[string][]Node{}
	for _, n := range nodes {
		area := n.Area
		if area == "" {
			area = "unfiled"
		}
		byArea[area] = append(byArea[area], n)
	}
	areas := make([]string, 0, len(byArea))
	for a := range byArea {
		areas = append(areas, a)
	}
	sort.Strings(areas)

	out := make([]*tree.Node, 0, len(areas))
	for _, area := range areas {
		ns := byArea[area]
		sort.SliceStable(ns, func(i, j int) bool {
			if ns[i].Facts != ns[j].Facts {
				return ns[i].Facts > ns[j].Facts
			}
			return ns[i].ID > ns[j].ID
		})
		total := 0
		an := &tree.Node{
			ID: "area:" + area, Label: area, Kind: tree.Dir,
		}
		for _, n := range ns {
			total += n.Facts
			id := n.ID
			node := &tree.Node{
				ID:     fmt.Sprint(id),
				Label:  n.Label,
				Detail: detail(n),
				Kind:   tree.Memory,
			}
			if n.Facts > 0 && facts != nil {
				node.Load = func() []*tree.Node {
					var kids []*tree.Node
					for _, f := range facts(id) {
						if strings.TrimSpace(f) == "" {
							continue
						}
						kids = append(kids, &tree.Node{ID: fmt.Sprint(id) + ":" + f, Label: f, Kind: tree.Plain})
					}
					return kids
				}
			}
			an.Children = append(an.Children, node)
		}
		an.Detail = plural(len(ns), "memory") + " · " + plural(total, "fact")
		// An area that knows nothing starts closed; the one you will read
		// opens itself.
		an.Expanded = total > 0
		out = append(out, an)
	}
	// Areas that hold knowledge come first.
	sort.SliceStable(out, func(i, j int) bool { return out[i].Expanded && !out[j].Expanded })
	return out
}

func detail(n Node) string {
	parts := []string{plural(n.Facts, "fact")}
	if n.Feeders > 0 {
		parts = append(parts, fmt.Sprintf("%d in", n.Feeders))
	}
	if n.Kind != "" {
		parts = append(parts, strings.ToLower(n.Kind))
	}
	return strings.Join(parts, " · ")
}

// plural keeps the counts readable. "1 facts" in a column you are scanning
// reads as a rendering bug, and a reader who distrusts one number distrusts
// the rest.
func plural(n int, unit string) string {
	if n == 1 {
		return "1 " + unit
	}
	if strings.HasSuffix(unit, "y") {
		return fmt.Sprintf("%d %sies", n, strings.TrimSuffix(unit, "y"))
	}
	return fmt.Sprintf("%d %ss", n, unit)
}

func str(m map[string]any, k string) string {
	s, _ := m[k].(string)
	return s
}

func num(m map[string]any, k string) int {
	f, _ := m[k].(float64)
	return int(f)
}

// NodeID reads a memory's id back out of a tree node id.
//
// Areas are headings ("area:semantic") and fact rows carry a suffix
// ("12:some fact"); only a bare number is a memory you can act on. Returning
// false for the others is what stops "forget" being offered on a category
// that never existed as a thing.
func NodeID(id string) (int, bool) {
	if id == "" || strings.Contains(id, ":") {
		return 0, false
	}
	n, err := strconv.Atoi(id)
	if err != nil {
		return 0, false
	}
	return n, true
}

// FactRow reads a fact row's pieces back out of its tree node id.
//
// Rows are built as "<node>: <state line>" and a state line is "  - key:
// value". Values may contain colons, so the key/value split is on the FIRST
// one after the dash. false means the row is not a fact at all — an area,
// or a memory — which is what keeps "edit" off things that have no value.
func FactRow(id string) (node int, key, value string, ok bool) {
	prefix, line, found := strings.Cut(id, ":")
	if !found {
		return 0, "", "", false
	}
	n, err := strconv.Atoi(prefix)
	if err != nil {
		return 0, "", "", false
	}
	line = strings.TrimPrefix(strings.TrimSpace(line), "-")
	line = strings.TrimSpace(line)
	k, v, found := strings.Cut(line, ":")
	if !found {
		return 0, "", "", false
	}
	return n, strings.TrimSpace(k), strings.TrimSpace(v), true
}

// Forget removes a memory from the store and returns what it was called.
//
// The journal is append-only and replay must be exact, so this appends a
// tombstone rather than rewriting history: the listing is the present, the
// journal is the record of how it got there. Nothing is recoverable through
// this interface afterwards, which is why the caller confirms first.
func (c *Client) Forget(id int) (string, error) {
	res, err := c.Call("forget", map[string]any{"node": id})
	if err != nil {
		return "", err
	}
	return str(res, "label"), nil
}

// --- writes -------------------------------------------------------------

// AddFact writes one fact to a memory and returns its id (HANDOFF §5).
//
// The journal is append-only and nothing here rewrites history, but the write
// path does supersede: a fact written under a key that already has a current
// value on that node REPLACES it — one value answers a later read, and the
// replaced value keeps its text and gains `superseded_by` rather than
// disappearing (readable through the sidecar's `history` op). Steer's fix is
// the same supersede, reached from a failure that names the fact to correct.
func (c *Client) AddFact(node int, key, value string) (int, error) {
	res, err := c.Call("fact", map[string]any{"node": node, "key": key, "value": value})
	if err != nil {
		return 0, err
	}
	return num(res, "fact"), nil
}

// SetArea moves a memory between brain areas and returns the area it landed
// in. Reversible, so the interface does not need to confirm it.
func (c *Client) SetArea(node int, area string) (string, error) {
	res, err := c.Call("set_area", map[string]any{"node": node, "area": area})
	if err != nil {
		return "", err
	}
	return str(res, "area"), nil
}

// CreateNode adds a memory. kind is one of aspect, entity, harness, outcome;
// anything else is stored as an aspect. Returns the new node's id and area.
func (c *Client) CreateNode(kind, label, area string) (int, string, error) {
	params := map[string]any{"kind": kind, "label": label}
	if area != "" {
		params["area"] = area
	}
	res, err := c.Call("create_node", params)
	if err != nil {
		return 0, "", err
	}
	return num(res, "node"), str(res, "area"), nil
}

// Good marks an episode as having gone well, reinforcing its context.
func (c *Client) Good(episode int, detail string) error {
	_, err := c.Call("good", map[string]any{"episode": episode, "detail": detail})
	return err
}

// Correction names a wrong fact and the truth that supersedes it.
type Correction struct {
	Node     int
	OldFact  int64
	NewKey   string
	NewValue string
}

// Steer records a failure against an episode and — when fix is given —
// supersedes the stale fact that caused it.
//
// Supersede is the store's only way to REPLACE a fact: the old one is marked
// superseded and the new one becomes active. It rides on the steer frame
// (HANDOFF §5 fix{node,fact,new_key,new_value}), which is why the interface's
// "edit a fact" goes through here rather than through fact; the fact id to
// pass calls home to what AddFact returned when the line was written.
func (c *Client) Steer(episode int, failure string, fix *Correction) error {
	params := map[string]any{"episode": episode, "failure": failure}
	if fix != nil {
		params["fix"] = map[string]any{
			"node": fix.Node, "fact": fix.OldFact,
			"new_key": fix.NewKey, "new_value": fix.NewValue,
		}
	}
	_, err := c.Call("steer", params)
	return err
}
