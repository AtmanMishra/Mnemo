package logging

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	charmlog "charm.land/log/v2"
)

// These fixtures are pure Go: temporary directories, files written by hand,
// and the environment switches. Nothing here starts a process of any kind — a
// fixture that spawned a shell would not run on Windows, where this suite is
// part of CI, and would be testing the shell rather than the log.

// dir is a temporary directory that this test's loggers are closed before
// removal, and it is used instead of t.TempDir everywhere for that reason.
//
// Windows will not remove a directory that still has an open file inside it,
// and cleanups run last-in-first-out, so the close has to be registered AFTER
// the directory it applies to. Doing that the other way round fails in
// t.TempDir's cleanup — the loudest possible place to discover that a log
// holds its file open, and with nothing in the message to say so.
func dir(t *testing.T) string {
	t.Helper()
	d := t.TempDir()
	t.Cleanup(func() { _ = Close() })
	return d
}

// capture points the process's stdout and stderr at files, and returns a
// function that reports everything written to either of them.
//
// This is what makes the first rule testable: os.Stdout and os.Stderr are the
// variables every writer in this process reaches for — charm log's own default
// logger included — so a logger that falls back to the terminal is caught
// here. It catches writes through those variables, which is the failure mode
// this package exists to prevent, and its answer is "" when nothing was said.
func capture(t *testing.T) func() string {
	t.Helper()
	base := dir(t)
	outPath := filepath.Join(base, "stdout")
	errPath := filepath.Join(base, "stderr")
	outFile, err := os.Create(outPath)
	if err != nil {
		t.Fatal(err)
	}
	errFile, err := os.Create(errPath)
	if err != nil {
		t.Fatal(err)
	}
	oldOut, oldErr := os.Stdout, os.Stderr
	os.Stdout, os.Stderr = outFile, errFile
	t.Cleanup(func() {
		os.Stdout, os.Stderr = oldOut, oldErr
		_ = outFile.Close()
		_ = errFile.Close()
	})
	return func() string {
		if err := outFile.Sync(); err != nil {
			t.Fatal(err)
		}
		out, err := os.ReadFile(outPath)
		if err != nil {
			t.Fatal(err)
		}
		stderr, err := os.ReadFile(errPath)
		if err != nil {
			t.Fatal(err)
		}
		return string(out) + string(stderr)
	}
}

// --- rule one: it never touches the terminal ---------------------------------

func TestTheLogNeverWritesToTheProcessTerminal(t *testing.T) {
	home := dir(t)
	t.Setenv(EnvLevel, "debug")
	t.Setenv(EnvFile, "")
	said := capture(t)

	lg := Configure(home)
	for _, lv := range []Level{Debug, Info, Warn, Error, Fatal} {
		lg.Log(lv, "probe."+lv.String(), "level", lv.String())
	}
	// The mistake this rule exists to survive: a call that reaches for charm
	// log's package-level function, which is os.Stderr on the library's own
	// default logger. Configure points that default at this log instead.
	charmlog.Info("a stray package-level call", "pid", 7)

	if got := said(); got != "" {
		t.Fatalf("the log wrote %q to the process's stdout or stderr", got)
	}
	recs := Read(home)
	if len(recs) != 6 {
		t.Fatalf("wrote %d records into the log, want 6 (%v)", len(recs), recs)
	}
	if recs[5].Msg != "a stray package-level call" {
		t.Fatalf("the stray call did not land in the log: %+v", recs[5])
	}
}

func TestARecordIsWrittenWithNoEscapeSequences(t *testing.T) {
	home := dir(t)
	t.Setenv(EnvLevel, "")
	t.Setenv(EnvFile, "")
	Open(home).Info("agent.spawn", "cwd", "C:/a b")

	data, err := os.ReadFile(Path(home))
	if err != nil {
		t.Fatal(err)
	}
	if strings.ContainsRune(string(data), 0x1b) {
		t.Fatalf("the log file holds an escape sequence: %q", data)
	}
	if !strings.Contains(string(data), `cwd="C:/a b"`) {
		t.Fatalf("a value with a space in it was not written the way it is read back: %q", data)
	}
	if !strings.Contains(string(data), " INFO  agent.spawn") {
		t.Fatalf("the level column is not the padded word the reader expects: %q", data)
	}
}

// --- rule two: cheap, and honest about failing -------------------------------

func TestEnabledIsTheGuardAHotPathCanUse(t *testing.T) {
	home := dir(t)
	t.Setenv(EnvLevel, "warn")
	t.Setenv(EnvFile, "")
	lg := At(home)

	if lg.Enabled(Debug) || lg.Enabled(Info) {
		t.Fatal("a logger at warn says it would write debug or info")
	}
	if !lg.Enabled(Warn) || !lg.Enabled(Error) || !lg.Enabled(Fatal) {
		t.Fatal("a logger at warn refuses warn, error or fatal")
	}
	if Disabled().Enabled(Fatal) {
		t.Fatal("a disabled logger says it would write something")
	}
}

func TestANilLoggerIsSilentRatherThanFatal(t *testing.T) {
	var lg *Logger
	lg.Debug("debug", "k", "v")
	lg.Info("info")
	lg.Warn("warn")
	lg.Error("error")
	if lg.Enabled(Error) {
		t.Fatal("a nil logger claims it would write")
	}
	if lg.Path() != "" || lg.Level() != Off || !lg.Disabled() || lg.Err() != "" {
		t.Fatal("a nil logger does not answer like a disabled one")
	}
	if err := lg.Close(); err != nil {
		t.Fatalf("closing a nil logger: %v", err)
	}
}

func TestTheLevelDecidesWhatIsWritten(t *testing.T) {
	for _, tc := range []struct {
		env  string
		want []string
	}{
		{"", []string{"info", "warn", "error", "fatal"}}, // unset: the default, not silence
		{"warn", []string{"warn", "error", "fatal"}},     // a narrower log
		{"debug", []string{"debug", "info", "warn", "error", "fatal"}},
		{"Loudish", []string{"info", "warn", "error", "fatal"}}, // a typo keeps the default
		{"off", nil}, // the one word that silences it
	} {
		t.Run("level "+tc.env, func(t *testing.T) {
			home := dir(t)
			t.Setenv(EnvLevel, tc.env)
			t.Setenv(EnvFile, "")
			lg := At(home)
			for _, lv := range []Level{Debug, Info, Warn, Error, Fatal} {
				lg.Log(lv, "probe."+lv.String())
			}
			var got []string
			for _, r := range Read(home) {
				got = append(got, r.Level.String())
			}
			if strings.Join(got, ",") != strings.Join(tc.want, ",") {
				t.Fatalf("MNEMO_LOG_LEVEL=%q wrote %v, want %v", tc.env, got, tc.want)
			}
			if tc.env == "off" && !lg.Disabled() {
				t.Fatal("off did not disable the logger")
			}
		})
	}
}

func TestAnUnwritableLogIsSilenceNotACrash(t *testing.T) {
	for _, tc := range []struct {
		name    string
		prepare func(t *testing.T, home string) string
		noHome  bool
	}{
		{
			// A parent path that is a file: opening anything underneath it
			// fails on every platform.
			name: "under a file",
			prepare: func(t *testing.T, home string) string {
				blocker := filepath.Join(home, "blocker")
				if err := os.WriteFile(blocker, []byte("x"), 0o644); err != nil {
					t.Fatal(err)
				}
				return filepath.Join(blocker, "mnemo.log")
			},
		},
		{
			// The path is a directory.
			name:    "a directory",
			prepare: func(t *testing.T, home string) string { return home },
		},
		{
			// No file, and no home to derive one from: Path("") is no path at
			// all, because filepath.Join("", ".mnemo", "logs") is a log
			// dropped into the working directory.
			name:    "no path at all",
			prepare: func(t *testing.T, home string) string { return "" },
			noHome:  true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			home := dir(t)
			t.Setenv(EnvLevel, "")
			t.Setenv(EnvFile, tc.prepare(t, home))
			if tc.noHome {
				home = ""
			}
			said := capture(t)

			lg := Open(home)
			lg.Info("agent.spawn", "pid", 1)
			lg.Error("agent.exit", "ok", false)

			if got := said(); got != "" {
				t.Fatalf("a log that cannot open wrote %q to the terminal", got)
			}
			if recs := Read(home); len(recs) != 0 {
				t.Fatalf("a log that cannot open produced %v", recs)
			}
			if tc.noHome {
				if !lg.Disabled() {
					t.Fatal("no path should be a disabled logger")
				}
				return
			}
			// A logger with a path that would not open says why, and stays
			// silent: the pane shows nothing, and the reason is answerable.
			if lg.Err() == "" {
				t.Fatal("a log that could not be opened does not say why")
			}
		})
	}
}

func TestReadingTheLogDoesNotCreateIt(t *testing.T) {
	home := dir(t)
	t.Setenv(EnvFile, "")
	if recs := Read(home); len(recs) != 0 {
		t.Fatalf("a home with no log read as %v", recs)
	}
	if _, err := os.Stat(Path(home)); err == nil {
		t.Fatal("reading the log created it — the file is opened on the first record, not on sight")
	}
	if _, err := os.Stat(Dir(home)); err == nil {
		t.Fatal("reading the log created the directory it lives in")
	}
}

// --- the file it writes ------------------------------------------------------

func TestTheLogIsWrittenBesideTheSpanLog(t *testing.T) {
	home := dir(t)
	t.Setenv(EnvFile, "")
	if got, want := Path(home), filepath.Join(home, ".mnemo", "logs", "mnemo.log"); got != want {
		t.Fatalf("Path(%q) = %q, want %q", home, got, want)
	}
	if got, want := Dir(home), filepath.Join(home, ".mnemo", "logs"); got != want {
		t.Fatalf("Dir(%q) = %q, want %q", home, got, want)
	}
	if got, want := Files(home), []string(nil); len(got) != len(want) {
		t.Fatalf("Files(%q) = %v, want nothing yet", home, got)
	}
}

func TestMNEMOLOGFILEMovesTheLogAndTheReader(t *testing.T) {
	home := dir(t)
	target := filepath.Join(dir(t), "elsewhere", "mnemo.log")
	t.Setenv(EnvFile, target)
	t.Setenv(EnvLevel, "")
	Open(home).Info("agent.spawn")

	if got := Path(home); got != target {
		t.Fatalf("Path = %q, want the environment's %q", got, target)
	}
	if files := Files(home); len(files) != 1 || files[0] != target {
		t.Fatalf("Files = %v, want just %q", files, target)
	}
	if recs := Read(home); len(recs) != 1 || recs[0].Msg != "agent.spawn" {
		t.Fatalf("the reader did not follow the writer: %v", recs)
	}
	if _, err := os.Stat(Dir(home)); err == nil {
		t.Fatal("a log told to go elsewhere also created ~/.mnemo/logs")
	}
}

func TestTheFileIsCappedAndOneGenerationIsKept(t *testing.T) {
	home := dir(t)
	t.Setenv(EnvFile, filepath.Join(dir(t), "mnemo.log"))
	t.Setenv(EnvLevel, "")
	p := Path(home)

	// The file the previous run left, over the cap. Written by hand: the point
	// is the cap, not the writing.
	if err := os.WriteFile(p, []byte(strings.Repeat("x", MaxBytes+1)), 0o644); err != nil {
		t.Fatal(err)
	}
	// A stale generation, so the roll has to cope with one already being there
	// — which is where a rename fails on Windows and needs the second try.
	if err := os.WriteFile(p+rotatedSuffix, []byte("older\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	Open(home).Info("after the cap")

	files := Files(home)
	if len(files) != 2 || files[0] != p+rotatedSuffix || files[1] != p {
		t.Fatalf("Files = %v, want the kept generation then the current file", files)
	}
	fi, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Size() > MaxBytes {
		t.Fatalf("the current file is %d bytes, over the %d cap", fi.Size(), MaxBytes)
	}
	recs := Read(home)
	if len(recs) != 1 || recs[0].Msg != "after the cap" {
		t.Fatalf("the reader found %v, want just the record written after the roll", recs)
	}
}

func TestAtBuildsOneLoggerPerHome(t *testing.T) {
	t.Setenv(EnvFile, "")
	if At("/a") != At("/a") {
		t.Fatal("two calls for one home built two loggers")
	}
	if At("/a") == At("/b") {
		t.Fatal("two homes share a logger")
	}
}

// --- reading it back ---------------------------------------------------------

func TestReadParsesWhatCharmWrote(t *testing.T) {
	home := dir(t)
	t.Setenv(EnvLevel, "debug")
	t.Setenv(EnvFile, "")
	lg := Open(home)
	lg.Info("agent.spawn", "pid", 4242, "cwd", "C:/a b", "trust", true)
	lg.Warn("dialog.answered", "method", "confirm")

	recs := Read(home)
	if len(recs) != 2 {
		t.Fatalf("read %d records, want 2: %v", len(recs), recs)
	}
	first := recs[0]
	if first.Level != Info || first.Msg != "agent.spawn" {
		t.Fatalf("first record = %+v", first)
	}
	if first.Time.IsZero() {
		t.Fatal("the record has no timestamp")
	}
	if got, want := first.Text(), "pid=4242 cwd=C:/a b trust=true"; got != want {
		t.Fatalf("fields read back as %q, want %q", got, want)
	}
	if recs[1].Level != Warn || recs[1].Msg != "dialog.answered" {
		t.Fatalf("second record = %+v", recs[1])
	}
	if recs[1].Time.Before(first.Time) {
		t.Fatal("records came back out of order")
	}
}

func TestMessagesWithSpacesAndUnknownLines(t *testing.T) {
	home := dir(t)
	t.Setenv(EnvFile, "")
	p := Path(home)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	body := strings.Join([]string{
		"2026-09-17T12:04:05.123+05:30 INFO  agent exited with a message like this key=1",
		"",
		"not a log line at all",
		"2026-09-17T12:04:06.000+05:30 LOUD  a level nothing writes",
		"2026-09-17T12:04:07.000+05:30 WARN  torn write, no newline",
		"2026-09-17T12:04:08.000+05:30 ERROR dialog.answered key=\"a b\" open=false",
	}, "\n")
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}

	recs := Read(home)
	if len(recs) != 3 {
		t.Fatalf("read %d records, want 3: %v", len(recs), recs)
	}
	if recs[0].Msg != "agent exited with a message like this" || recs[0].Text() != "key=1" {
		t.Fatalf("a message with spaces was split: %+v", recs[0])
	}
	if recs[2].Level != Error || recs[2].Text() != `key=a b open=false` {
		t.Fatalf("a quoted value did not survive: %+v", recs[2])
	}
}

func TestTailKeepsTheNewestRecords(t *testing.T) {
	home := dir(t)
	t.Setenv(EnvFile, "")
	t.Setenv(EnvLevel, "")
	lg := Open(home)
	for _, msg := range []string{"one", "two", "three", "four"} {
		lg.Info(msg)
	}
	recs := Tail(home, 2)
	if len(recs) != 2 || recs[0].Msg != "three" || recs[1].Msg != "four" {
		t.Fatalf("Tail(2) = %v, want the last two in the order they were written", recs)
	}
	if all := Tail(home, 0); len(all) != 4 {
		t.Fatalf("Tail(0) = %d records, want all four", len(all))
	}
}

func TestParseLevelReadsTheNamesTheEnvironmentUses(t *testing.T) {
	for _, tc := range []struct {
		in    string
		want  Level
		known bool
	}{
		{"off", Off, true},
		{"NONE", Off, true},
		{" debug ", Debug, true},
		{"Info", Info, true},
		{"warning", Warn, true},
		{"ERR", Error, true},
		{"fatal", Fatal, true},
		{"", DefaultLevel, false},
		{"verbose", DefaultLevel, false},
	} {
		got, known := ParseLevel(tc.in)
		if got != tc.want || known != tc.known {
			t.Fatalf("ParseLevel(%q) = (%v, %v), want (%v, %v)", tc.in, got, known, tc.want, tc.known)
		}
	}
}

// --- what "cheap enough" means, measured -------------------------------------

// The disabled call is the one a hot path makes when nothing is configured: it
// must be a nil check and a comparison, and it is the reason the interface can
// leave a debug line in the tick that drops frames.
func BenchmarkADisabledCall(b *testing.B) {
	lg := Disabled()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		lg.Info("agent.tick", "n", i)
	}
}

// A record that is written costs a level check, a format and one append.
func BenchmarkOneRecordWritten(b *testing.B) {
	home := b.TempDir()
	b.Setenv(EnvFile, "")
	lg := Open(home)
	defer func() { _ = lg.Close() }()
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		lg.Info("agent.tick", "n", i)
	}
}

// The guard a hot path uses instead of building key=value pairs it would throw
// away.
func BenchmarkTheEnabledGuard(b *testing.B) {
	lg := Disabled()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if lg.Enabled(Debug) {
			lg.Debug("agent.tick", "n", i)
		}
	}
}
