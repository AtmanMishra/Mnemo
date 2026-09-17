// Command mnemo is the Mnemo terminal interface.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/app"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/agent"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/limits"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/logging"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/pi"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/session"
)

// options is everything the flags say. Parsed apart from running so the run
// path is testable without owning the process's argument list.
type options struct {
	home, cwd, keys, repo, session, memsrv, journal, bundles string
	dump                                                     bool
	version                                                  bool
	cols, rows                                               int

	// The interface's timings and limits, as the reader typed them. Strings,
	// because "" then means "this flag was not given" and each number has its
	// own grammar (a duration may be "20s" or 20) — parsing is
	// internal/limits' job, and its answer is that a value nobody could use
	// falls back instead of failing the run.
	limitsFile, listTimeout, memoryTimeout, noticeFor, menuRows, minKeyLen string
}

// version is the build's identity. The release workflow sets it with
// -ldflags "-X main.version=<tag>"; anything built by hand says "dev", so a
// bug report against a tag cannot come from a binary that was never that tag.
var version = "dev"

// versionLine is what --version prints. The pre-alpha marker is deliberate:
// this is a build for testers, and the first line of a bug report should say
// which one it is.
func versionLine() string {
	return "mnemo " + version + " (pre-alpha)"
}

// memsrvName is the sidecar's file name on this platform. Cargo appends .exe
// on Windows, so a derived path that says "memsrv" finds nothing there — and
// the symptom is not an error about a missing file, it is a memory pane that
// quietly goes offline on the one platform where the path is derived rather
// than passed in by hand.
func memsrvName() string {
	if runtime.GOOS == "windows" {
		return "memsrv.exe"
	}
	return "memsrv"
}

func parseFlags(args []string) options {
	fs := flag.NewFlagSet("mnemo", flag.ContinueOnError)
	var o options
	fs.BoolVar(&o.version, "version", false, "print the version and exit")
	fs.StringVar(&o.home, "home", "", "override the home directory sessions are read from")
	fs.StringVar(&o.cwd, "cwd", "", "override the working directory")
	fs.BoolVar(&o.dump, "dump", false, "render one frame to stdout and exit (for scripts and screenshots)")
	fs.IntVar(&o.cols, "cols", 100, "width for --dump")
	fs.IntVar(&o.rows, "rows", 32, "height for --dump")
	fs.StringVar(&o.keys, "keys", "", "comma-separated keys to press before --dump, e.g. ctrl+t,down,down")
	fs.StringVar(&o.repo, "repo", "", "repository root holding agent/bin/mnemo.ts; enables the live agent")
	fs.StringVar(&o.session, "session", "", "resume this pi session file")
	fs.StringVar(&o.memsrv, "memsrv", "", "path to the built memsrv binary")
	fs.StringVar(&o.journal, "journal", "", "path to the memory journal memsrv should open")
	fs.StringVar(&o.bundles, "bundles", "", "directory of harness tool bundles")
	// The interface's timings and limits. The file they come from is
	// documented in README.md; every one of these beats it, and an
	// unreadable value falls through to it rather than failing the run.
	fs.StringVar(&o.limitsFile, "limits", "", "path to the tunables file (default ~/.mnemo/limits.json)")
	fs.StringVar(&o.listTimeout, "list-timeout", "", "how long to wait for the model catalogue, e.g. 20s")
	fs.StringVar(&o.memoryTimeout, "memory-timeout", "", "how long a memory query may wait, e.g. 10s")
	fs.StringVar(&o.noticeFor, "notice-for", "", "how long a status-line notice stays, e.g. 5s")
	fs.StringVar(&o.menuRows, "menu-rows", "", "how many slash-menu rows to show at once, e.g. 8")
	fs.StringVar(&o.minKeyLen, "min-key-len", "", "the shortest API key to accept, e.g. 8")
	// A flag error is a usage question, not a crash; ContinueOnError hands
	// it back instead of taking the process down.
	_ = fs.Parse(args)
	return o
}

func main() {
	o := parseFlags(os.Args[1:])
	// A version question is answered and forgotten — no config, no spawn, no
	// terminal. It has to work on a machine where none of the rest does.
	if o.version {
		fmt.Println(versionLine())
		return
	}
	// os.Exit lives HERE and only here. run() holds every defer — the agent
	// stream, the model — and an os.Exit inside run on a p.Run failure used
	// to skip them all, orphaning a spawned pi process on the way out.
	if err := run(o); err != nil {
		fmt.Fprintln(os.Stderr, "mnemo:", err)
		os.Exit(1)
	}
}

// mouseEnv is the switch that turns mouse reporting on. An environment
// variable rather than a flag because it is a preference about this terminal
// rather than an argument about this run — the same reason `TERM` is not a flag.
const mouseEnv = "MNEMO_MOUSE"

// mouseEnabled reads that switch.
//
// Mouse reporting is off unless it is asked for, in so many words: 1, true, yes
// or on, in any case. Everything else — unset, empty, "0", a typo — leaves it
// off, and the failure mode of a typo is the feature a reader already knows
// (the terminal's own selection) rather than one they did not ask for.
func mouseEnabled(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// home is the user's home directory: the flag when given, the OS answer
// otherwise. Shared, because the trust decision and the memory journal both
// look things up under it — two spellings of "home" is how a decision
// recorded for one path becomes invisible to the reader of the other.
func home(override string) string {
	if override != "" {
		return override
	}
	h, _ := os.UserHomeDir()
	return h
}

// defaultMemorySidecar fills empty --memsrv/--journal from the repo and home
// dirs so a live run's Memory pane works without the caller learning the
// sidecar layout. Explicit flags always win; no repo means no derivation
// (offline/--dump stays exactly as configured).
func defaultMemorySidecar(o *options) {
	if o.memsrv == "" && o.repo != "" {
		o.memsrv = filepath.Join(o.repo, "memory-layer", "target", "debug", memsrvName())
	}
	if o.journal == "" && (o.memsrv != "" || o.repo != "") {
		if h := home(o.home); h != "" {
			o.journal = filepath.Join(h, ".mnemo", "journal.jsonl")
		}
	}
}

// spawnPlan is everything a live spawn needs decided before pi starts: the
// working directory (absolute, because the agent forks its session by it), the
// session directory the browser will read back (session.SpawnDir — "" when
// pi's own default is already the answer, because passing the default back
// would change how pi lays sessions out), and the project-trust decision that
// goes on the command line. Split from run so the decision is testable without
// starting a node process.
func spawnPlan(o options) (string, string, pi.Trust) {
	cwd := firstNonEmpty(o.cwd, ".")
	// Absolute, because project trust is recorded by directory: a relative
	// "." would look up a different key from the one a decision was written
	// under, and would spawn the child in a directory whose resources pi
	// then refuses to load.
	if abs, err := filepath.Abs(cwd); err == nil {
		cwd = abs
	}
	// Both resolved against the SAME home, so the sessions the browser lists
	// and the sessions the agent writes are the same directory.
	trust := pi.ResolveTrust(home(o.home), cwd)
	// Yolo means the operator has said "do not ask me": the consent gate stops
	// prompting, and pi is told to trust the project, so its own settings,
	// extensions and skills load instead of being ignored. Both halves matter —
	// without the flag, "full privileges" would still silently drop the
	// project's own extensions, which is the half a person notices last.
	if pi.Yolo(cwd, home(o.home)) {
		trust.Approve = true
	}
	return cwd, session.SpawnDir(home(o.home)), trust
}

// limitsEnv names the tunables file when the flag is silent — the same shape
// as MNEMO_MOUSE: a preference about this terminal, said once in the
// environment rather than passed on every run.
const limitsEnv = "MNEMO_LIMITS_FILE"

// limitsPath is the tunables file for this run: the flag, then the
// environment, then ~/.mnemo/limits.json, beside auth.json and theme.json.
// All three levels can be silent; the answer is then no file, which is the
// same as a file that says nothing.
func limitsPath(o options) string {
	if o.limitsFile != "" {
		return o.limitsFile
	}
	if p := strings.TrimSpace(os.Getenv(limitsEnv)); p != "" {
		return p
	}
	return limits.Path(home(o.home))
}

// tunables resolves the interface's timings and limits: flag, then
// environment, then file, then the built-in default that lives next to the
// behaviour it governs. It cannot fail — a file that is missing, truncated or
// wrong is "not configured", not an error — so no preference, however badly
// written, can keep the interface from starting.
func tunables(o options) limits.Limits {
	return limits.Resolve(limitsPath(o), limits.Overrides{
		ListTimeout:   o.listTimeout,
		MemoryTimeout: o.memoryTimeout,
		NoticeFor:     o.noticeFor,
		MenuRows:      o.menuRows,
		MinKeyLen:     o.minKeyLen,
	}, os.Getenv)
}

func run(o options) error {
	// The interface's own log, opened once, here, where the home is decided —
	// and beside the span log, so the logs pane reads one directory. Logging
	// is configured before anything can want to log about it, and this call is
	// the only one in the program: every call site takes the logger from there
	// rather than deciding where a log goes on its own.
	//
	// A home that cannot be resolved, a level set to off, an unwritable file:
	// Configure answers with a logger that writes nothing, and the interface
	// runs. That is the trade this makes on purpose — a log is a convenience,
	// and a TUI that will not start without one has made it a dependency.
	logging.Configure(home(o.home))
	defer logging.Close()
	defaultMemorySidecar(&o)
	// Applied before anything reads one of them: the prompt's menu height,
	// the catalogue's bound and the memory client's snapshot are all taken
	// from these values at the moment they are first used.
	lim := tunables(o)
	limits.Apply(lim)
	// NoticeFor is the one tunable the interface owns rather than a package
	// under it: app cannot import limits without the import going both ways,
	// so the value is pushed in here, at the same moment and for the same
	// reason as the rest.
	app.NoticeFor = lim.NoticeFor
	cfg := app.Config{Home: o.home, CWD: o.cwd, Dark: true, Mouse: mouseEnabled(os.Getenv(mouseEnv)),
		MemsrvBin: o.memsrv, MemJournal: o.journal, HarnessDir: o.bundles, Repo: o.repo}

	// The live backend is opt-in by path rather than discovered, so running
	// the interface never silently spawns a node process somebody did not ask
	// for. Without it, sending fails loudly instead of pretending to think.
	if o.repo != "" && !o.dump {
		cwd, sessionDir, trust := spawnPlan(o)
		s, err := pi.Spawn(o.repo, cwd, o.session, sessionDir, trust)
		if err != nil {
			return fmt.Errorf("could not start the agent: %w", err)
		}
		// Runs even when p.Run fails below: that is the whole reason run
		// returns errors instead of exiting mid-flight.
		defer s.Close()
		cfg.Agent = s
		cfg.TrustNote = trust.Note()
	} else {
		cfg.Agent = agent.Offline{Reason: "no agent backend: run with --repo <path to this repository> to start one"}
	}

	m := app.New(cfg)

	// --dump exists because a TUI cannot be screenshotted from a script, and
	// "it looked right when I ran it" is not a check anyone else can repeat.
	if o.dump {
		m.Resize(o.cols, o.rows)
		for _, k := range strings.Split(o.keys, ",") {
			if k = strings.TrimSpace(k); k != "" {
				m.Press(k)
			}
		}
		fmt.Println(m.Render())
		return nil
	}

	defer m.Close()
	p := tea.NewProgram(m)
	_, err := p.Run()
	return err
}

func firstNonEmpty(ss ...string) string {
	for _, s := range ss {
		if s != "" {
			return s
		}
	}
	return ""
}
