// Package logging is the interface's own structured log: charm.land/log/v2
// with a level and key=value fields, written to a file under ~/.mnemo/logs.
//
// Two rules matter more than the API, and both of them are scars:
//
//  1. It never writes to stdout or stderr. The TUI owns the screen, and one
//     line printed underneath a running frame corrupts it — the frame is
//     repainted from a buffer, so a stray write shifts every cell after it.
//     A logger's only sink is a file, opened O_APPEND; a logger that cannot
//     open one is [Disabled] (io.Discard) rather than falling back to the
//     terminal; and charm log's own Fatal methods are never called, because
//     they write to os.Stderr and then exit the process. [Configure] goes one
//     step further and installs this log as charm log's process default, so a
//     call that reaches for the package-level function — `log.Info(...)`,
//     which is os.Stderr by charm log's own default — lands in the same file
//     instead of under the frame.
//
//  2. It is cheap enough to call from the interface's own goroutines. charm
//     log checks an atomic discard flag and the level before it formats
//     anything; [Logger.Enabled] lets a hot path skip even building its
//     key=value pairs; the file is opened once, on the first record that
//     survives the level; and rotation happens at that same moment, because a
//     stat per record is a syscall per log line.
//
// Opening on the first write is also what keeps the log out of the way of
// everything else: a logger that is never written to holds no file handle, so
// a reader that only ever looks ([Read], the logs pane) creates nothing, and
// on Windows — where an open handle stops a directory being removed — a
// process that logs nothing leaves nothing locked behind it.
//
// Records are written in charm log's text format — `2026-09-17T12:04:05.123+05:30
// INFO agent.spawn pid=4242` — with every colour stripped. A log file is read
// by a human with `tail` and by the logs pane with [Read], and neither of them
// wants a terminal's palette in a text file. That the writer and the reader
// agree is not assumed: the round trip is a test.
//
// The level comes from MNEMO_LOG_LEVEL (default [DefaultLevel], and `off`
// silences the log entirely) and the file from MNEMO_LOG_FILE (default
// `mnemo.log` beside the span log, see [Dir]).
package logging

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"charm.land/lipgloss/v2"
	charmlog "charm.land/log/v2"
)

const (
	// EnvLevel is the level switch: off, debug, info, warn, error or fatal.
	// An unreadable word is not an error — the default applies, because an
	// interface that refuses to start over a misspelled log level is a worse
	// failure than a noisy one.
	EnvLevel = "MNEMO_LOG_LEVEL"
	// EnvFile moves the log off ~/.mnemo. It exists for the reason
	// MNEMO_LIMITS_FILE does: a run whose log should go somewhere else should
	// not have to be a different build. Both the writer and [Read] honour it,
	// so the pane shows what was actually written.
	EnvFile = "MNEMO_LOG_FILE"

	// FileName is the current file, beside the span logs.
	FileName = "mnemo.log"

	// MaxBytes caps the file. The cap is enforced when the file is opened, not
	// per write: the file grows by one process's own records, so a size check
	// on every call would be a syscall on a path the interface calls from its
	// own goroutines, and the thing it protects against — a log nobody ever
	// reads — is not urgent by a single line.
	MaxBytes = 1 << 20

	// rotatedSuffix names the one kept generation. One, not a numbered set: a
	// log older than the previous run has already answered the question it
	// was kept for.
	rotatedSuffix = ".1"

	// levelWidth is the padded width of the level field in the file, so the
	// columns after it line up when a human tails the log.
	levelWidth = 5

	// timeFormat is the record's timestamp. RFC3339 with milliseconds: one
	// token, sortable as text, unambiguous about the offset — a local time
	// with no offset is the one thing a log from someone else's machine
	// cannot be read against.
	timeFormat = "2006-01-02T15:04:05.000Z07:00"
)

// Level is a record's severity, ordered the way filtering needs it.
//
// Off is below Debug rather than above Fatal because it is not a severity: it
// is the logger switched off altogether, and nothing is ever logged at it.
type Level int8

const (
	Off   Level = -1
	Debug Level = 0
	Info  Level = 1
	Warn  Level = 2
	Error Level = 3
	Fatal Level = 4
)

// DefaultLevel is the level when MNEMO_LOG_LEVEL says nothing.
//
// Info, not Warn: the call sites this log has are a handful per run — a spawn,
// an exit, a question asked and answered, a decision — and the logs pane is
// the reason the file exists at all. A log that is off until asked for is a
// pane that is always empty until the reader already knows to turn it on.
// `MNEMO_LOG_LEVEL=off` is how you say no.
const DefaultLevel = Info

// String is the name the level is written under, and read back from.
func (l Level) String() string {
	switch l {
	case Off:
		return "off"
	case Debug:
		return "debug"
	case Info:
		return "info"
	case Warn:
		return "warn"
	case Error:
		return "error"
	case Fatal:
		return "fatal"
	}
	return "?"
}

// ParseLevel reads a level by name. The second result is false for a word this
// package does not know — including "" — and the caller keeps its default; a
// typo must not be able to silence the log, or to start it.
func ParseLevel(s string) (Level, bool) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "off", "none", "no", "silent", "disabled":
		return Off, true
	case "debug":
		return Debug, true
	case "info":
		return Info, true
	case "warn", "warning":
		return Warn, true
	case "error", "err":
		return Error, true
	case "fatal":
		return Fatal, true
	}
	return DefaultLevel, false
}

// Dir is where both logs live: the interface's own and the span log.
//
// It is spelled once, here, and internal/trace's Dir delegates to it — two
// spellings of a directory is how the log a pane reads stops being the log the
// writer writes. Home is a parameter, never a lookup: a test that reads the
// real ~/.mnemo passes for the wrong reason.
func Dir(home string) string { return filepath.Join(home, ".mnemo", "logs") }

// Path is the file the log is written to: MNEMO_LOG_FILE when it is set,
// otherwise mnemo.log under [Dir].
//
// An empty home with no MNEMO_LOG_FILE is no path at all. filepath.Join("",
// ".mnemo", "logs") is a relative path — a log dropped into whatever
// directory the process happens to be in, which is not where a log belongs.
func Path(home string) string {
	if p := strings.TrimSpace(os.Getenv(EnvFile)); p != "" {
		return p
	}
	if home == "" {
		return ""
	}
	return filepath.Join(Dir(home), FileName)
}

// Files lists the log files for a home, oldest first: the kept generation and
// then the current one, and only the ones that exist.
//
// An empty list is not an error. A log that has never been written is the
// normal state of a fresh install, not a failure of the thing that reads it.
func Files(home string) []string {
	p := Path(home)
	if p == "" {
		return nil
	}
	var out []string
	for _, f := range []string{p + rotatedSuffix, p} {
		if _, err := os.Stat(f); err == nil {
			out = append(out, f)
		}
	}
	return out
}

// Logger is a structured log writing to one file.
//
// Build one with [Open], [At] or [Disabled] — never by hand. A nil *Logger is
// usable and silent, deliberately: every method checks for it, so a call site
// that never got a logger logs nothing instead of panicking.
type Logger struct {
	path  string
	level Level

	// charm is built eagerly and pointed at io.Discard until the file opens,
	// so [Configure] can install it as the process default before anything has
	// been written and a stray package-level call is still captured rather
	// than lost to stderr.
	charm *charmlog.Logger

	once   sync.Once
	mu     sync.Mutex // guards file and the output swap, never the write path
	file   *os.File
	reason atomic.Pointer[string] // why it is silent, when it is
}

// Disabled is the logger that writes nothing: no file, no terminal, no work.
//
// It is one shared instance, so the fallback a hot path takes when nothing is
// configured costs a pointer and nothing else. It is what every failure to
// open a log degrades to, and what this package hands out before anything has
// been configured: a test that never writes a record creates no file at all.
func Disabled() *Logger {
	disabledOnce.Do(func() { disabled = &Logger{level: Off, charm: discard()} })
	return disabled
}

var (
	disabledOnce sync.Once
	disabled     *Logger

	discardOnce sync.Once
	discardLog  *charmlog.Logger
)

// Open resolves the log for a home: the level from MNEMO_LOG_LEVEL and the
// file from MNEMO_LOG_FILE, both documented on [EnvLevel] and [EnvFile].
//
// It cannot fail. No home to put a log in, MNEMO_LOG_LEVEL=off, a path that
// turns out to be unwritable — all of them come back a logger that writes
// nothing, and none of them comes back an error, because an interface that
// will not start over its log is a worse failure than an interface with no
// log at all.
func Open(home string) *Logger {
	l := build(home)
	remember(l)
	return l
}

// build constructs a logger and registers nothing, so callers that already
// hold the registry lock — [At] — can use it without deadlocking on
// themselves.
func build(home string) *Logger {
	lv, ok := ParseLevel(os.Getenv(EnvLevel))
	if !ok {
		lv = DefaultLevel
	}
	if lv == Off {
		return Disabled()
	}
	p := Path(home)
	if p == "" {
		return Disabled()
	}
	return &Logger{path: p, level: lv, charm: newCharm(io.Discard)}
}

// remember makes a logger [Close]'s business. Every logger that could hold a
// file open is registered: a file handle nobody closed is a temporary
// directory that cannot be removed on Windows, and that failure lands nowhere
// near the logger that caused it.
func remember(l *Logger) {
	openedMu.Lock()
	defer openedMu.Unlock()
	registerLocked(l)
}

// registerLocked is remember for a caller that already holds the registry
// lock — [At] — which cannot take it twice.
func registerLocked(l *Logger) {
	if l == nil || l.Disabled() {
		return
	}
	built = append(built, l)
}

// newCharm is charm log configured the way this package wants it: no colour,
// a padded level word, and RFC3339 timestamps. Nothing here touches os.Stderr,
// and the writer it is given is the log's own file or io.Discard.
func newCharm(w io.Writer) *charmlog.Logger {
	cl := charmlog.NewWithOptions(w, charmlog.Options{
		Level:           charmlog.DebugLevel, // filtering is this package's job; see Enabled
		ReportTimestamp: true,
		TimeFormat:      timeFormat,
	})
	cl.SetStyles(logStyles())
	return cl
}

// open is the first write's other half: it opens the file and points the
// logger at it. Everything that can fail happens here, once, and a failure
// leaves the output on io.Discard — silence, never a terminal.
func (l *Logger) open() {
	l.mu.Lock()
	defer l.mu.Unlock()
	f, err := openCapped(l.path)
	if err != nil {
		// Kept for [Logger.Err] so a reader can find out why the pane is
		// empty; nothing in the interface branches on it.
		msg := err.Error()
		l.reason.Store(&msg)
		return
	}
	l.file = f
	l.charm.SetOutput(f)
}

// openCapped opens the log for appending, rolling the previous generation
// aside first when the file has outgrown [MaxBytes].
//
// The roll is a rename, and only at open, so the write path is one append and
// nothing else. A failed rename is not a failed log: the file it could not
// move is still a file to append to.
func openCapped(path string) (*os.File, error) {
	if fi, err := os.Stat(path); err == nil && fi.Size() > MaxBytes {
		rolled := path + rotatedSuffix
		if err := os.Rename(path, rolled); err != nil {
			// Windows will not rename onto a file that exists, and the
			// previous generation is disposable. Remove it and try once more;
			// if that fails too, keep appending to what is there.
			if os.Remove(rolled) == nil {
				_ = os.Rename(path, rolled)
			}
		}
	}
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		_ = os.MkdirAll(dir, 0o755)
	}
	return os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
}

// logStyles is charm log's text formatter with every colour removed.
//
// The file is read by `tail` and by the pane, so it holds no escape sequences
// at all — and it keeps holding none whatever the terminal, the color profile
// or CLICOLOR_FORCE say, because nothing here has a colour to strip. The
// levels map is filled in completely on purpose: the formatter writes the
// level field only for a level it has a style for, so a sparse map would
// produce records with no level in them.
func logStyles() *charmlog.Styles {
	plain := lipgloss.NewStyle()
	padded := func(name string) lipgloss.Style {
		return lipgloss.NewStyle().SetString(name).Width(levelWidth)
	}
	return &charmlog.Styles{
		Timestamp: plain,
		Caller:    plain,
		Prefix:    plain,
		Message:   plain,
		Key:       plain,
		Value:     plain,
		Separator: plain,
		Levels: map[charmlog.Level]lipgloss.Style{
			charmlog.DebugLevel: padded("DEBUG"),
			charmlog.InfoLevel:  padded("INFO"),
			charmlog.WarnLevel:  padded("WARN"),
			charmlog.ErrorLevel: padded("ERROR"),
			charmlog.FatalLevel: padded("FATAL"),
		},
		Keys:   map[string]lipgloss.Style{},
		Values: map[string]lipgloss.Style{},
	}
}

// charmLevel maps this package's levels onto the library's.
//
// Fatal is mapped, and used, but never through charm log's Fatal method: that
// one calls os.Exit, and a log line must not be able to end the interface.
// Logging at FatalLevel through Log writes a record whose level reads FATAL
// and nothing else happens.
func charmLevel(l Level) charmlog.Level {
	switch l {
	case Debug:
		return charmlog.DebugLevel
	case Warn:
		return charmlog.WarnLevel
	case Error:
		return charmlog.ErrorLevel
	case Fatal:
		return charmlog.FatalLevel
	}
	return charmlog.InfoLevel
}

// Enabled reports whether a level would be written, so a hot path can skip
// building the key=value pairs it would throw away.
func (l *Logger) Enabled(lv Level) bool {
	return l != nil && l.charm != nil && l.level > Off && lv >= l.level
}

// Log writes one record at a level. Nothing happens below the logger's level,
// and nothing happens at all for a disabled or nil logger.
func (l *Logger) Log(lv Level, msg string, kv ...any) {
	if !l.Enabled(lv) {
		return
	}
	l.once.Do(l.open)
	l.charm.Log(charmLevel(lv), msg, kv...)
}

// Debug is Log at [Debug]. It is for the chatter that answers a question
// nobody is asking yet — an event the interface dropped, a stray line from the
// agent — which is why it is off at [DefaultLevel] and can be turned on
// without a rebuild.
func (l *Logger) Debug(msg string, kv ...any) { l.Log(Debug, msg, kv...) }

// Info is Log at [Info]: something the interface did that a reader would want
// to see happened.
func (l *Logger) Info(msg string, kv ...any) { l.Log(Info, msg, kv...) }

// Warn is Log at [Warn]: lost data, a degraded path, a decision taken by
// default.
func (l *Logger) Warn(msg string, kv ...any) { l.Log(Warn, msg, kv...) }

// Error is Log at [Error]: something failed.
func (l *Logger) Error(msg string, kv ...any) { l.Log(Error, msg, kv...) }

// Level is the level this logger writes at, [Off] when it is disabled.
func (l *Logger) Level() Level {
	if l == nil {
		return Off
	}
	return l.level
}

// Path is where this logger writes — "" when it is disabled. It is the path
// whether or not the file has been created yet: a logger that has written
// nothing has still been pointed somewhere, and a test or a diagnostic that
// wants to know where should not have to write a record to find out.
func (l *Logger) Path() string {
	if l == nil {
		return ""
	}
	return l.path
}

// Disabled reports whether this logger drops everything.
func (l *Logger) Disabled() bool { return l.Level() == Off }

// Err is why this logger has written nothing, or "" when it is working.
//
// For tests and diagnostics only: nothing in the interface branches on it,
// because a log that cannot open is silence, not a failure to handle.
func (l *Logger) Err() string {
	if l == nil || l.reason.Load() == nil {
		return ""
	}
	return *l.reason.Load()
}

// Close closes the file and stops the logger. The interface calls it on the
// way out; a logger left open until the process dies costs nothing, so nothing
// else has to.
func (l *Logger) Close() error {
	if l == nil || l.charm == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.charm.SetOutput(io.Discard)
	if l.file == nil {
		return nil
	}
	err := l.file.Close()
	l.file = nil
	return err
}

// charmLogger is the underlying library logger, for installing as the process
// default.
func (l *Logger) charmLogger() *charmlog.Logger {
	if l == nil || l.charm == nil {
		return discard()
	}
	return l.charm
}

// discard is the library logger that writes nowhere: the sink behind
// [Disabled], and what charm log's process default is set to when this package
// has nothing open.
func discard() *charmlog.Logger {
	discardOnce.Do(func() { discardLog = newCharm(io.Discard) })
	return discardLog
}

var (
	openedMu sync.Mutex
	opened   = map[string]*Logger{}
	built    []*Logger

	defaultLogger atomic.Pointer[Logger]
)

// At returns the logger for a home, building it the first time it is asked for
// and reusing it after.
//
// Home is a parameter for the same reason trace.Dir's is: a call site that has
// the home in hand says so, and a call site that does not uses [Default]. The
// cache is what makes this cheap enough to call from anywhere — one map lookup
// behind a mutex, no filesystem work — and it is what keeps two call sites in
// one process writing to one file rather than racing to open two.
func At(home string) *Logger {
	openedMu.Lock()
	defer openedMu.Unlock()
	if l, ok := opened[home]; ok {
		return l
	}
	l := build(home)
	registerLocked(l)
	opened[home] = l
	return l
}

// Default is the process's logger: what [Configure] opened, or a disabled one
// when nothing configured it.
//
// It exists for the call sites that have no home to hand — an agent session,
// whose spawn signature belongs to its caller — and its silence before
// Configure is the point: a package that is merely tested writes nothing.
func Default() *Logger {
	if l := defaultLogger.Load(); l != nil {
		return l
	}
	return Disabled()
}

// Configure names the home the whole process logs under, and makes this logger
// charm log's process default.
//
// Called once, from the composition root, where the home is decided. The
// second half matters as much as the first: charm log's package-level
// functions — `log.Info`, `log.Warn`, anything a future caller reaches for out
// of habit — write to os.Stderr on a logger nobody configured, and stderr is
// the one stream a running TUI cannot share. Installing this one means that
// mistake lands in the file with everything else instead of under the frame
// being repainted.
func Configure(home string) *Logger {
	l := At(home)
	charmlog.SetDefault(l.charmLogger())
	defaultLogger.Store(l)
	return l
}

// Close closes every logger this package built — the cached ones and any
// [Open] returned to a caller — and forgets them, so a later [At] opens a
// fresh file.
//
// It is one call that ends all logging in the process, which is what the
// interface wants on its way out and what a test wants at the end of a case: a
// file handle nobody closed is a temporary directory that cannot be removed on
// Windows, and the failure lands in the test's cleanup with no mention of the
// log.
func Close() error {
	openedMu.Lock()
	defer openedMu.Unlock()
	var first error
	for _, l := range built {
		if err := l.Close(); err != nil && first == nil {
			first = err
		}
	}
	built = nil
	for home := range opened {
		delete(opened, home)
	}
	defaultLogger.Store(nil)
	charmlog.SetDefault(discard())
	return first
}

// --- reading it back ---------------------------------------------------------

// Field is one key=value pair of a record.
type Field struct {
	Key   string
	Value string
}

// Record is one log line, read back.
//
// Time, Level and Msg are the record's own columns; Fields is what the call
// site said about it. The order of Fields is the order they were written,
// because "spans=3 lines=0" and "lines=0 spans=3" are the same data and only
// one of them is what the file says.
type Record struct {
	Time   time.Time
	Level  Level
	Msg    string
	Fields []Field
}

// Text is the fields as they were written: "key=value key=value".
func (r Record) Text() string {
	if len(r.Fields) == 0 {
		return ""
	}
	var b strings.Builder
	for i, f := range r.Fields {
		if i > 0 {
			b.WriteString(" ")
		}
		b.WriteString(f.Key)
		b.WriteString("=")
		b.WriteString(f.Value)
	}
	return b.String()
}

// Read parses every log file for a home, oldest file first, in the order the
// records were written.
//
// A missing directory, a missing file, a line this reader cannot make sense of
// — none of them is an error. The log is a convenience, and a pane that
// refuses to open because one line was torn by a kill -9 is a pane that has
// turned a convenience into a liability.
func Read(home string) []Record {
	var out []Record
	for _, p := range Files(home) {
		data, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(data), "\n") {
			if r, ok := Parse(line); ok {
				out = append(out, r)
			}
		}
	}
	return out
}

// Tail is the last n records, oldest first — what a pane wants, since reading
// a whole megabyte of history into a modal to show twelve rows is work nobody
// asked for. n <= 0 means all of them.
func Tail(home string, n int) []Record {
	recs := Read(home)
	if n > 0 && len(recs) > n {
		recs = recs[len(recs)-n:]
	}
	return recs
}

// Parse turns one written line back into a Record, and reports false for
// anything it cannot read.
//
// It is deliberately forgiving about the shape: a line written by an older
// build, a torn write from a process that was killed, a note someone appended
// by hand, a message with more words in it than this build's call sites use.
// What it will not do is invent a record, because a pane showing a line that
// was never written is worse than a pane one line short.
func Parse(line string) (Record, bool) {
	line = strings.TrimSpace(stripANSI(line))
	if line == "" {
		return Record{}, false
	}
	ts, rest, ok := cut(line)
	if !ok {
		return Record{}, false
	}
	when, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		// A timestamp nothing can read is a line that is not ours.
		return Record{}, false
	}
	lvName, rest, ok := cut(rest)
	if !ok {
		return Record{}, false
	}
	lv, known := ParseLevel(lvName)
	if !known || lv == Off {
		return Record{}, false
	}
	msg, pairs := splitFields(rest)
	return Record{Time: when, Level: lv, Msg: msg, Fields: pairs}, true
}

// cut takes the first space-separated word, and reports whether there was one.
func cut(s string) (word, rest string, ok bool) {
	i := strings.IndexByte(s, ' ')
	if i < 0 {
		return "", "", false
	}
	return strings.TrimSpace(s[:i]), strings.TrimLeft(s[i+1:], " "), true
}

// splitFields splits "message key=value key=value" at the first thing that
// reads as a field.
//
// The message is the part that is not key=value, which is how charm log writes
// it: quoted values are followed through, so a value containing a space — or a
// message that happens to contain an "=" — does not move the boundary. A
// message with spaces in it stays whole, which is why the boundary is decided
// by the shape of a field name rather than by counting words.
func splitFields(s string) (string, []Field) {
	q := false
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '"':
			q = !q
		case '=':
			if q {
				continue
			}
			start := strings.LastIndexByte(s[:i], ' ') + 1
			if start < i && isFieldName(s[start:i]) {
				return strings.TrimSpace(s[:start]), parsePairs(s[start:])
			}
		}
	}
	return strings.TrimSpace(s), nil
}

// isFieldName is what a key looks like: the identifiers the call sites use,
// and nothing else. Without it a message that happens to contain "a = b" would
// be split into a message and a field nobody wrote.
func isFieldName(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '_', r == '.', r == '-':
		default:
			return false
		}
	}
	return true
}

// parsePairs reads the key=value tail, keeping quoted values in one piece.
func parsePairs(s string) []Field {
	var out []Field
	for i := 0; i < len(s); {
		for i < len(s) && s[i] == ' ' {
			i++
		}
		if i >= len(s) {
			break
		}
		eq := strings.IndexByte(s[i:], '=')
		if eq < 0 {
			break
		}
		key := s[i : i+eq]
		val, n := cutValue(s[i+eq+1:])
		if isFieldName(key) {
			out = append(out, Field{Key: key, Value: val})
		}
		i += eq + 1 + n
	}
	return out
}

// cutValue takes one value, unquoting it when it is quoted, and reports how
// many bytes of the input that consumed so the caller can move on. A quoted
// value that is never closed runs to the end of the line, which is the honest
// reading of a torn write.
func cutValue(s string) (string, int) {
	if s == "" {
		return "", 0
	}
	if s[0] != '"' {
		i := strings.IndexByte(s, ' ')
		if i < 0 {
			return s, len(s)
		}
		return s[:i], i
	}
	for i := 1; i < len(s); i++ {
		switch s[i] {
		case '\\':
			i++
		case '"':
			body := s[1:i]
			return strings.NewReplacer(`\"`, `"`, `\\`, `\`, `\n`, "\n", `\t`, "\t").Replace(body), i + 1
		}
	}
	return s[1:], len(s)
}

// stripANSI removes escape sequences, so a line written by a build that had
// colours in its styles — or a log someone pasted a coloured line into — is
// still readable. The parser is a text parser; it should not have to trust
// that nothing upstream ever emitted an escape.
func stripANSI(s string) string {
	if !strings.ContainsRune(s, 0x1b) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); {
		if s[i] != 0x1b {
			b.WriteByte(s[i])
			i++
			continue
		}
		i++
		if i < len(s) && s[i] == '[' {
			i++
			for i < len(s) && (s[i] < '@' || s[i] > '~') {
				i++
			}
			if i < len(s) {
				i++ // the final byte of the sequence
			}
		}
	}
	return b.String()
}
