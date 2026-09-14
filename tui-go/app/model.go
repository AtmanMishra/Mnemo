// Package app wires the pieces together: one root model, three modes, and a
// single screen with overlays over it.
//
// There is no pane rail. Six co-equal panes cycled with tab was the old
// shape, and it failed twice over — a rail of nouns is a menu of guesses, and
// the panes were never co-equal anyway, since the transcript is what you are
// reading almost all of the time. Here the transcript is the application and
// everything else is one chord away.
package app

import (
	"os"
	"path/filepath"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/agent"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/auth"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/chat"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/command"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/filetree"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/keymap"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/markdown"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/memory"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/overlay"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/prompt"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/theme"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/tree"
)

// Config is everything the application needs from the outside. Home and CWD
// are fields rather than lookups so a test can point the whole program at a
// temporary directory — a forgotten home parameter has caused real bugs here.
type Config struct {
	Home  string
	CWD   string
	Agent agent.Agent
	Dark  bool

	// MemsrvBin and MemJournal point at the memory sidecar and its journal.
	// Both are configuration: a client that finds its own journal is a client
	// that, in a test, finds the real one.
	MemsrvBin  string
	MemJournal string

	// HarnessDir holds tool bundles. A parameter for the same reason.
	HarnessDir string

	// Repo is the repository root holding agent/bin/mnemo.ts. It is what
	// makes the model catalogue askable; without it /model can say why
	// instead of showing an empty list.
	Repo string
}

// NoticeFor is how long a one-off message stays in the status line.
//
// Without this, a command's result is overwritten by the next frame and every
// chord looks like it did nothing.
const NoticeFor = 5 * time.Second

// Model is the whole application.
type Model struct {
	cfg  Config
	th   *theme.Theme
	keys keymap.Map
	mode keymap.Mode

	w, h int

	chat     *chat.Model
	prompt   *prompt.Model
	explorer *tree.Model
	ov       *overlay.Model

	explorerOpen  bool
	explorerFocus bool

	agent   agent.Agent
	stats   agent.TurnStats
	working bool
	tick    int

	notice  string
	noticed time.Time

	// confirm is a pending destructive action: what it will do, in the
	// reader's words, and the function that does it. Nothing irreversible
	// happens without one.
	confirm *confirmation

	// searching is true while ^f has the keys: every printable character goes
	// into the query rather than to a mode.
	searching bool

	lastInterrupt time.Time
	quitting      bool

	// openTool maps a running tool call id to its block, so a result lands on
	// the call it belongs to rather than being appended as a new line.
	openTool map[string]*chat.Block

	// wizard names the provider the login flow is setting up. Non-empty only
	// while the model step of that wizard is on screen; the /model surface
	// sets it to the empty string. It decides both what a late catalogue is
	// scoped to and whether picking a model also repoints the default
	// provider.
	wizard string

	// editor is the memory overlay's open fact editor, or nil when the list
	// is just a list. While it is non-nil its keys own the overlay.
	editor *memEditor

	// mention is true while the @-file menu is up: tab and enter insert a
	// path instead of completing a command or sending the line.
	mention bool

	// files is the working tree's relative file list, for @-mentions,
	// scanned once and never guessed at.
	files []string
	mem *memory.Client

	// schedSeen remembers which job results have already been toasted on the
	// status line, so a finished schedule chips exactly once per run.
	schedSeen map[string]string

	// cmds is every slash command: built-ins, skills, plugins, bundles, and
	// the ones the agent answers with when a live session starts. It is the
	// only list — the palette, the slash menu and help all read this one.
	cmds []command.Command
}

// New builds the application.
func New(cfg Config) *Model {
	if cfg.Home == "" {
		cfg.Home, _ = os.UserHomeDir()
	}
	if cfg.CWD == "" {
		cfg.CWD, _ = os.Getwd()
	}
	if cfg.Agent == nil {
		cfg.Agent = agent.Offline{Reason: "no agent backend configured — run with --agent, or see mnemo --help"}
	}
	th := theme.New(theme.PICO8, theme.Heavy, cfg.Dark)
	m := &Model{
		cfg:       cfg,
		th:        th,
		keys:      keymap.New(),
		mode:      keymap.Insert,
		w:         80,
		h:         24,
		chat:      chat.New(),
		prompt:    prompt.New(cfg.Dark),
		explorer:  tree.New(filetree.Root(cfg.CWD)),
		agent:     cfg.Agent,
		openTool:  map[string]*chat.Block{},
		schedSeen: map[string]string{},
	}
	m.chat.SetMarkdown(markdown.New(th))
	m.cmds = command.Load(cfg.CWD, cfg.Home, cfg.HarnessDir)
	// First run, with a real backend: the accounts list takes the screen,
	// the way the Rust wizard's provider step did. Nothing works until one
	// provider is logged in, and a list that says which are set up is the
	// shortest route there. Dismissible, like every overlay — the welcome
	// keeps the /login hint either way.
	if !auth.Load(cfg.Home).Configured() && m.liveAgent() {
		m.openLogin()
	}
	m.welcome()
	m.layout()
	return m
}

// Commands is every slash command, for tests.
func (m *Model) Commands() []command.Command { return m.cmds }

// welcome is what an empty transcript says.
//
// Not a logo and a blank screen: the first thing on screen names the three
// keys that remove the most work, because the complaint this rebuild answers
// was that nothing told you what anything did.
func (m *Model) welcome() {
	body := []string{
		"**ready.**",
		"",
	}
	// First run is detected here, not once at startup: logging out and
	// clearing can turn a configured home back into a first run, and the
	// hint at the top is what makes a yes/no of it.
	if !auth.Load(m.cfg.Home).Configured() {
		body = append(body,
			"- nothing is set up yet — `/login` logs in a provider, `/model` picks the default",
			"")
	}
	body = append(body,
		"- `/` — commands, skills and plugins. Start typing; pick with ↑ ↓",
		"- `^k` — the same list, as a palette",
		"- `^e` — open every thinking block at once",
		"- `^t` — the folder explorer, on the right",
		"- `^s` — sessions, and the sub-agents under them",
		"",
		"`tab` moves between the prompt, the transcript and the explorer.",
		"`esc` goes up one level, from anywhere. That is the whole model.",
		"In the transcript and in any tree: ↑ ↓ move, → opens, ← closes.",
	)
	m.chat.Append(&chat.Block{Kind: chat.Agent, Body: body})
}

// liveAgent reports whether a real backend is attached. An Offline agent is
// a mock — dumps, tests, or a deliberate no-backend run — and no mock should
// ever hijack the first frame with an accounts list nobody asked it for.
func (m *Model) liveAgent() bool {
	_, off := m.cfg.Agent.(agent.Offline)
	return !off
}

// Init starts the program.
func (m *Model) Init() tea.Cmd {
	return tea.Batch(
		m.prompt.Focus(),
		tea.RequestBackgroundColor,
		m.agent.Next(),
	)
}

// tickMsg drives the dither band and the spinner. It only fires while the
// agent is working: an idle Mnemo is a still screen, and a TUI that animates
// while nothing is happening is burning a battery to look busy.
type tickMsg time.Time

func tickCmd() tea.Cmd {
	return tea.Tick(theme.SpinnerIntervalMS*time.Millisecond, func(t time.Time) tea.Msg {
		return tickMsg(t)
	})
}

// noticeMsg clears an expired status-line message.
type noticeMsg struct{}

func (m *Model) notify(s string) tea.Cmd {
	m.notice = s
	m.noticed = time.Now()
	return tea.Tick(NoticeFor, func(time.Time) tea.Msg { return noticeMsg{} })
}

// layout recomputes every region's size. Called on resize and whenever the
// prompt grows.
func (m *Model) layout() {
	if m.w < 20 {
		m.w = 20
	}
	if m.h < 8 {
		m.h = 8
	}
	body := m.bodyHeight()

	right := m.explorerWidth()
	left := m.inner()
	if right > 0 {
		left = m.leftWidth()
	}

	m.chat.SetSize(left, body)
	m.prompt.SetWidth(m.inner() - 2)
	if right > 0 {
		m.explorer.SetSize(right, body)
	}
	if m.ov != nil {
		m.ov.SetSize(m.inner(), body+1)
	}
}

// explorerWidth is a third of the screen, clamped. Zero when it is closed —
// a closed explorer must cost nothing, not a column of blank.
func (m *Model) explorerWidth() int {
	if !m.explorerOpen {
		return 0
	}
	w := m.inner() / 3
	if w > 40 {
		w = 40
	}
	if w < 20 {
		w = 20
	}
	if m.inner()-w < 30 {
		// Too narrow to hold both. The transcript wins: it is the
		// application, and the explorer is a convenience.
		return 0
	}
	return w
}

// Home and CWD expose the configured paths, for tests.
func (m *Model) Home() string { return m.cfg.Home }
func (m *Model) CWD() string  { return m.cfg.CWD }

// Mode is the live key table, for tests and the status line.
func (m *Model) Mode() keymap.Mode { return m.mode }

// Chat exposes the transcript, for tests.
func (m *Model) Chat() *chat.Model { return m.chat }

// Overlay exposes the open overlay, or nil.
func (m *Model) Overlay() *overlay.Model { return m.ov }

// ExplorerOpen reports whether the folder pane is showing.
func (m *Model) ExplorerOpen() bool { return m.explorerOpen }

// Notice is the transient status-line message.
func (m *Model) Notice() string {
	if m.notice == "" || time.Since(m.noticed) > NoticeFor {
		return ""
	}
	return m.notice
}

// relCWD is the working directory as a human writes it.
func (m *Model) relCWD() string {
	if m.cfg.Home != "" {
		if r, err := filepath.Rel(m.cfg.Home, m.cfg.CWD); err == nil && len(r) > 0 && r[0] != '.' {
			return "~/" + r
		}
	}
	return m.cfg.CWD
}

// Resize sets the screen size directly. Used by --dump and by tests, which
// have no terminal to ask.
func (m *Model) Resize(w, h int) {
	m.w, m.h = w, h
	m.layout()
}

// Press feeds one keystroke by name. It exists because a TUI cannot be
// screenshotted from a script, and "it looked right when I ran it" is not a
// check anybody else can repeat.
func (m *Model) Press(keystroke string) {
	m.Update(tea.KeyPressMsg(parseKey(keystroke)))
}

func parseKey(s string) tea.Key {
	switch s {
	case "esc":
		return tea.Key{Code: tea.KeyEscape}
	case "enter":
		return tea.Key{Code: tea.KeyEnter}
	case "up":
		return tea.Key{Code: tea.KeyUp}
	case "down":
		return tea.Key{Code: tea.KeyDown}
	case "left":
		return tea.Key{Code: tea.KeyLeft}
	case "right":
		return tea.Key{Code: tea.KeyRight}
	case "tab":
		return tea.Key{Code: tea.KeyTab}
	case "shift+tab":
		return tea.Key{Code: tea.KeyTab, Mod: tea.ModShift}
	case "backspace":
		return tea.Key{Code: tea.KeyBackspace}
	case "space":
		return tea.Key{Code: ' ', Text: " "}
	}
	if strings.HasPrefix(s, "ctrl+") && len(s) == len("ctrl+")+1 {
		return tea.Key{Code: rune(s[len("ctrl+")]), Mod: tea.ModCtrl}
	}
	if strings.HasPrefix(s, "alt+") {
		switch strings.TrimPrefix(s, "alt+") {
		case "enter":
			return tea.Key{Code: tea.KeyEnter, Mod: tea.ModAlt}
		case "up":
			return tea.Key{Code: tea.KeyUp, Mod: tea.ModAlt}
		case "down":
			return tea.Key{Code: tea.KeyDown, Mod: tea.ModAlt}
		}
	}
	r := []rune(s)
	if len(r) == 0 {
		return tea.Key{}
	}
	return tea.Key{Code: r[0], Text: string(r[0])}
}

// Close releases the backend and the memory sidecar.
func (m *Model) Close() {
	if m.mem != nil {
		_ = m.mem.Close()
		m.mem = nil
	}
	if m.agent != nil {
		_ = m.agent.Close()
	}
}
