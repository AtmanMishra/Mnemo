// Package limits owns the interface's tunable numbers: how long the interface
// waits, how long a notice stays, and how much it shows at once.
//
// They used to be constants compiled into the packages that used them
// (auth.ListTimeout, memory.Timeout, app.NoticeFor, prompt.MenuRows,
// auth.MinKeyLen), so an operator on a slow machine — or a fast one — had to
// rebuild to move one. Here they come from one documented file,
// ~/.mnemo/limits.json, resolved with the precedence this program uses
// elsewhere: flag, then environment, then file, then the built-in default.
//
// Nothing in here can stop the interface starting. A missing file, a truncated
// one, a key with the wrong type, an unknown key and a value outside its range
// all mean the same thing: that key was not configured, and the next layer
// answers for it — the same way ~/.mnemo/theme.json falls back to the built-in
// palette (app/theme.go). A preference is not worth an error dialog.
package limits

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/auth"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/memory"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/prompt"
)

// The file's name and keys. The keys are the file's spelling: an operator
// edits this file by hand, so the names here are the contract, and README.md
// documents them one by one.
const (
	FileName = "limits.json"

	KeyListTimeout   = "list_timeout"
	KeyMemoryTimeout = "memory_timeout"
	KeyNoticeFor     = "notice_for"
	KeyMenuRows      = "menu_rows"
	KeyMinKeyLen     = "min_key_len"
)

// The environment's spelling, one variable per key. An environment variable
// overrides the file because it is a property of this terminal rather than of
// this machine's saved preferences — the same reason MNEMO_MOUSE is not in a
// file.
const (
	EnvFile          = "MNEMO_LIMITS_FILE"
	EnvListTimeout   = "MNEMO_LIST_TIMEOUT"
	EnvMemoryTimeout = "MNEMO_MEMORY_TIMEOUT"
	EnvNoticeFor     = "MNEMO_NOTICE_FOR"
	EnvMenuRows      = "MNEMO_MENU_ROWS"
	EnvMinKeyLen     = "MNEMO_MIN_KEY_LEN"
)

// The bounds a value has to sit inside to be usable. They are not taste: a zero
// timeout is a call that never waits, a menu of no rows is a menu that shows
// nothing, and a minimum key length of zero accepts an empty key. Anything
// outside is a typo or a misunderstanding, and the default answers instead.
const (
	minTimeout = time.Millisecond
	maxTimeout = 24 * time.Hour

	minMenuRows, maxMenuRows = 1, 100

	minKeyLenFloor, maxKeyLenCeiling = 1, 256
)

// Limits is what a layer said, per key. The zero value means "nothing was
// said" for every key, which is what Apply needs: a key nobody configured must
// leave the package that owns it alone, so the built-in default — declared
// there, in one place, with the behaviour it governs — still answers.
type Limits struct {
	// ListTimeout bounds the model-catalogue call. Built-in default 20s
	// (internal/auth/models.go:38); a provider that hangs used to hang the
	// whole interface with it, so this is the number that decides how long
	// /model can look stuck before it says the listing timed out.
	ListTimeout time.Duration

	// MemoryTimeout bounds every memsrv request. Built-in default 10s
	// (internal/memory/memory.go:34). memsrv replays a journal at start up,
	// so the first call can be slow — this is how long the Memory pane
	// waits before it reports the sidecar as unresponsive.
	MemoryTimeout time.Duration

	// NoticeFor is how long a one-off message stays in the status line.
	// Built-in default 5s (app/model.go:72). Long enough to read a result,
	// short enough that a stale notice is not mistaken for a current one.
	NoticeFor time.Duration

	// MenuRows is the most slash-menu suggestions shown at once. Built-in
	// default 8 (internal/prompt/prompt.go:34): tall enough to pick from,
	// short enough that the menu never swallows the transcript.
	MenuRows int

	// MinKeyLen is the shortest thing Mnemo will accept or count as an API
	// key. Built-in default 8 (internal/auth/auth.go:90). It is a paste
	// check, not a policy, and lowering it is how a reader with a short
	// key tests their own setup.
	MinKeyLen int
}

// Overrides is what the command line said, before anything has been read.
//
// Everything is a string, and the empty string means "this flag was not
// given": the values are durations and counts with their own grammar, and a
// typed flag is a question about that grammar, not about Go's flag package's
// idea of a default.
type Overrides struct {
	ListTimeout   string
	MemoryTimeout string
	NoticeFor     string
	MenuRows      string
	MinKeyLen     string
}

// Path is where the file lives for a home: beside auth.json and theme.json, so
// one directory holds every preference this program has. An empty home has no
// file — a path built from nothing would look for .mnemo/limits.json relative
// to whatever directory the process happens to be standing in.
func Path(home string) string {
	if home == "" {
		return ""
	}
	return filepath.Join(home, ".mnemo", FileName)
}

// FromFile reads what the file configured, and nothing else.
//
// Every way of failing to read it — no file, no directory, not JSON, JSON that
// is not an object, a key of the wrong type, a value outside its range — ends
// in the zero value for that key. Each key is decoded on its own so one
// unreadable line cannot take the four good ones with it.
func FromFile(path string) Limits {
	var l Limits
	raw, err := os.ReadFile(path)
	if err != nil {
		return l
	}
	var obj map[string]json.RawMessage
	if json.Unmarshal(raw, &obj) != nil {
		return l
	}
	// Unknown keys are simply not looked for. A file written for a newer
	// build, or with a key someone invented, is still read for the keys
	// that exist.
	if d, ok := durationJSON(obj[KeyListTimeout]); ok {
		l.ListTimeout = d
	}
	if d, ok := durationJSON(obj[KeyMemoryTimeout]); ok {
		l.MemoryTimeout = d
	}
	if d, ok := durationJSON(obj[KeyNoticeFor]); ok {
		l.NoticeFor = d
	}
	if n, ok := intJSON(obj[KeyMenuRows], minMenuRows, maxMenuRows); ok {
		l.MenuRows = n
	}
	if n, ok := intJSON(obj[KeyMinKeyLen], minKeyLenFloor, maxKeyLenCeiling); ok {
		l.MinKeyLen = n
	}
	return l
}

// Resolve answers with the value each key should run with: the flag when it is
// usable, else the environment, else the file, else the zero value — which
// Apply reads as "leave the built-in default alone".
//
// getenv is a parameter, not os.Getenv, for the same reason home is a
// parameter elsewhere in this tree: a function that finds its own environment
// is one that, in a test, finds the developer's.
func Resolve(path string, over Overrides, getenv func(string) string) Limits {
	fromFile := FromFile(path)
	var l Limits
	l.ListTimeout = firstUsable(over.ListTimeout, getenv, EnvListTimeout, fromFile.ListTimeout, parseDuration)
	l.MemoryTimeout = firstUsable(over.MemoryTimeout, getenv, EnvMemoryTimeout, fromFile.MemoryTimeout, parseDuration)
	l.NoticeFor = firstUsable(over.NoticeFor, getenv, EnvNoticeFor, fromFile.NoticeFor, parseDuration)
	l.MenuRows = firstUsable(over.MenuRows, getenv, EnvMenuRows, fromFile.MenuRows, parseMenuRows)
	l.MinKeyLen = firstUsable(over.MinKeyLen, getenv, EnvMinKeyLen, fromFile.MinKeyLen, parseMinKeyLen)
	return l
}

// Apply hands a resolved set to the packages that own the behaviour: the
// number lives where it is used, so this is the only place that has to know
// who owns which one.
//
// A zero field is "not configured" and leaves its owner untouched, which is
// what keeps the defaults unchanged out of the box.
func Apply(l Limits) {
	if l.ListTimeout > 0 {
		auth.ListTimeout = l.ListTimeout
	}
	if l.MemoryTimeout > 0 {
		memory.Timeout = l.MemoryTimeout
	}
	if l.MenuRows > 0 {
		prompt.MenuRows = l.MenuRows
	}
	if l.MinKeyLen > 0 {
		auth.MinKeyLen = l.MinKeyLen
	}
	if l.NoticeFor > 0 {
		NoticeFor = l.NoticeFor
	}
}

// NoticeFor is the resolved window a notice stays on the status line.
//
// The interface's own value is the constant at app/model.go:72, and app/** is
// not this change's to edit. So the resolved answer is carried here, and the
// app package takes it as its variable when its owner makes that one-line
// change; until then the key is parsed, validated and tested rather than
// silently dropped, and the interface keeps the five seconds it shipped with.
var NoticeFor time.Duration

// firstUsable answers with the first layer that said something usable: the
// flag, the environment, the file.
//
// A layer that cannot be read is skipped rather than fatal, so a typo in the
// environment does not throw away a whole file. Nothing usable anywhere leaves
// the zero value, and the built-in default — declared next to the behaviour it
// governs — answers.
func firstUsable[T any](flagValue string, getenv func(string) string, env string, fromFile T, parse func(string) (T, bool)) T {
	if v, ok := parse(flagValue); ok {
		return v
	}
	if getenv != nil {
		if v, ok := parse(getenv(env)); ok {
			return v
		}
	}
	return fromFile
}

// parseDuration reads a duration as time.ParseDuration writes one ("20s",
// "1m30s") or as a bare number of seconds ("20", 20), which is how a person
// writes a timeout by hand. Anything else — including a duration outside the
// bounds, so that "0s" and "-1m" are not a way to switch a bound off — is
// unusable.
func parseDuration(s string) (time.Duration, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	if n, err := strconv.ParseFloat(s, 64); err == nil {
		return usableDuration(time.Duration(n * float64(time.Second)))
	}
	d, err := time.ParseDuration(s)
	if err != nil {
		return 0, false
	}
	return usableDuration(d)
}

func usableDuration(d time.Duration) (time.Duration, bool) {
	if d < minTimeout || d > maxTimeout {
		return 0, false
	}
	return d, true
}

// parseMenuRows and parseMinKeyLen read a whole number and hold it inside its
// bounds. Below the floor the value does not mean what it says (no rows shown,
// or a key of no characters accepted), and above the ceiling it is not a
// preference, it is a typo.
func parseMenuRows(s string) (int, bool) {
	n, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil {
		return 0, false
	}
	return clampInt(n, minMenuRows, maxMenuRows)
}

func parseMinKeyLen(s string) (int, bool) {
	n, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil {
		return 0, false
	}
	return clampInt(n, minKeyLenFloor, maxKeyLenCeiling)
}

func clampInt(n, lo, hi int) (int, bool) {
	if n < lo || n > hi {
		return 0, false
	}
	return n, true
}

// durationJSON reads a duration from the file: a string as ParseDuration wants
// it, or a number, which is seconds.
func durationJSON(raw json.RawMessage) (time.Duration, bool) {
	if len(raw) == 0 {
		return 0, false
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return parseDuration(s)
	}
	var n float64
	if json.Unmarshal(raw, &n) == nil {
		return usableDuration(time.Duration(n * float64(time.Second)))
	}
	return 0, false
}

// intJSON reads a whole number from the file. A string is not a number here:
// "eight" and "8" both mean the value was not understood, and the default
// answers — which is the difference between a file that is read leniently and
// a file whose mistakes are guessed at.
func intJSON(raw json.RawMessage, lo, hi int) (int, bool) {
	if len(raw) == 0 {
		return 0, false
	}
	var n int
	if json.Unmarshal(raw, &n) != nil {
		return 0, false
	}
	return clampInt(n, lo, hi)
}
