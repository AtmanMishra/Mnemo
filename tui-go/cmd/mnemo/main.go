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
)

func main() {
	var (
		home = flag.String("home", "", "override the home directory sessions are read from")
		cwd  = flag.String("cwd", "", "override the working directory")
		dump = flag.Bool("dump", false, "render one frame to stdout and exit (for scripts and screenshots)")
		cols = flag.Int("cols", 100, "width for --dump")
		rows = flag.Int("rows", 32, "height for --dump")
		keys = flag.String("keys", "", "comma-separated keys to press before --dump, e.g. ctrl+t,down,down")
	)
	flag.Parse()

	cfg := app.Config{
		Home: *home,
		CWD:  *cwd,
		Dark: true,
		Agent: agent.Offline{Reason: "no agent backend is wired up yet — " +
			"the interface runs, but sending will fail until pi RPC is connected"},
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

	p := tea.NewProgram(m)
	if _, err := p.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "mnemo:", err)
		os.Exit(1)
	}
}
