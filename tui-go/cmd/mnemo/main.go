// Command mnemo is the Mnemo terminal interface.
package main

import (
	"flag"
	"fmt"
	"os"
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/app"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/agent"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/pi"
)

func main() {
	var (
		home = flag.String("home", "", "override the home directory sessions are read from")
		cwd  = flag.String("cwd", "", "override the working directory")
		dump = flag.Bool("dump", false, "render one frame to stdout and exit (for scripts and screenshots)")
		cols = flag.Int("cols", 100, "width for --dump")
		rows = flag.Int("rows", 32, "height for --dump")
		keys = flag.String("keys", "", "comma-separated keys to press before --dump, e.g. ctrl+t,down,down")
		repo = flag.String("repo", "", "repository root holding agent/bin/mnemo.ts; enables the live agent")
		sess = flag.String("session", "", "resume this pi session file")
		msrv = flag.String("memsrv", "", "path to the built memsrv binary")
		jrnl = flag.String("journal", "", "path to the memory journal memsrv should open")
		hdir = flag.String("bundles", "", "directory of harness tool bundles")
	)
	flag.Parse()

	cfg := app.Config{Home: *home, CWD: *cwd, Dark: true, MemsrvBin: *msrv, MemJournal: *jrnl, HarnessDir: *hdir, Repo: *repo}

	// The live backend is opt-in by path rather than discovered, so running
	// the interface never silently spawns a node process somebody did not ask
	// for. Without it, sending fails loudly instead of pretending to think.
	if *repo != "" && !*dump {
		s, err := pi.Spawn(*repo, firstNonEmpty(*cwd, "."), *sess)
		if err != nil {
			fmt.Fprintln(os.Stderr, "mnemo: could not start the agent:", err)
			os.Exit(1)
		}
		defer s.Close()
		cfg.Agent = s
	} else {
		cfg.Agent = agent.Offline{Reason: "no agent backend: run with --repo <path to this repository> to start one"}
	}

	m := app.New(cfg)

	// --dump exists because a TUI cannot be screenshotted from a script, and
	// "it looked right when I ran it" is not a check anyone else can repeat.
	if *dump {
		m.Resize(*cols, *rows)
		for _, k := range strings.Split(*keys, ",") {
			if k = strings.TrimSpace(k); k != "" {
				m.Press(k)
			}
		}
		fmt.Println(m.Render())
		return
	}

	defer m.Close()
	p := tea.NewProgram(m)
	if _, err := p.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "mnemo:", err)
		os.Exit(1)
	}
}

func firstNonEmpty(ss ...string) string {
	for _, s := range ss {
		if s != "" {
			return s
		}
	}
	return ""
}
