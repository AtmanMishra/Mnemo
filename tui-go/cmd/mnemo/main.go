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
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/pi"
)

// options is everything the flags say. Parsed apart from running so the run
// path is testable without owning the process's argument list.
type options struct {
	home, cwd, keys, repo, session, memsrv, journal, bundles string
	dump                                                     bool
	version                                                  bool
	cols, rows                                               int
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

// defaultMemorySidecar fills empty --memsrv/--journal from the repo and home
// dirs so a live run's Memory pane works without the caller learning the
// sidecar layout. Explicit flags always win; no repo means no derivation
// (offline/--dump stays exactly as configured).
func defaultMemorySidecar(o *options) {
	if o.memsrv == "" && o.repo != "" {
		o.memsrv = filepath.Join(o.repo, "memory-layer", "target", "debug", memsrvName())
	}
	if o.journal == "" && (o.memsrv != "" || o.repo != "") {
		home := o.home
		if home == "" {
			if h, err := os.UserHomeDir(); err == nil {
				home = h
			}
		}
		if home != "" {
			o.journal = filepath.Join(home, ".mnemo", "journal.jsonl")
		}
	}
}

func run(o options) error {
	defaultMemorySidecar(&o)
	cfg := app.Config{Home: o.home, CWD: o.cwd, Dark: true,
		MemsrvBin: o.memsrv, MemJournal: o.journal, HarnessDir: o.bundles, Repo: o.repo}

	// The live backend is opt-in by path rather than discovered, so running
	// the interface never silently spawns a node process somebody did not ask
	// for. Without it, sending fails loudly instead of pretending to think.
	if o.repo != "" && !o.dump {
		s, err := pi.Spawn(o.repo, firstNonEmpty(o.cwd, "."), o.session)
		if err != nil {
			return fmt.Errorf("could not start the agent: %w", err)
		}
		// Runs even when p.Run fails below: that is the whole reason run
		// returns errors instead of exiting mid-flight.
		defer s.Close()
		cfg.Agent = s
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
