package app

import (
	"os"
	"path/filepath"
	"strings"
	"time"

	"charm.land/bubbles/v2/key"
	tea "charm.land/bubbletea/v2"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/agent"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/chat"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/keymap"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/overlay"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/session"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/theme"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/trace"
)

// Update is the whole message switch.
//
// Key dispatch runs in one order and only one: global chords, then the
// overlay if one is up, then the focused surface. Global first is what makes
// every surface reachable in one press from anywhere — the navigation
// complaint this rebuild answers — and it means no surface can accidentally
// swallow ^k and strand you.
func (m *Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.w, m.h = msg.Width, msg.Height
		m.layout()
		return m, nil

	case tea.BackgroundColorMsg:
		m.cfg.Dark = msg.IsDark()
		m.th = theme.New(theme.PICO8, theme.Heavy, m.cfg.Dark)
		return m, nil

	case tickMsg:
		m.tick++
		if m.working {
			return m, tickCmd()
		}
		return m, nil

	case noticeMsg:
		m.notice = ""
		return m, nil

	case tea.PasteMsg:
		// Bracketed paste is its own message in v2, so a multi-line paste can
		// never fire enter halfway through. That is a real bug class in
		// hand-rolled prompts.
		m.prompt.Insert(msg.Content)
		m.layout()
		return m, nil

	case tea.KeyPressMsg:
		return m.onKey(msg)
	}
	if cmd := m.onAgent(msg); cmd != nil {
		return m, cmd
	}
	return m, nil
}

// onAgent folds backend messages into the transcript.
//
// Every branch re-arms the listener, because a backend that streams drives
// the loop by being asked for the next message rather than by holding a
// reference to the program. Forgetting to re-arm once stops the stream dead
// with no error anywhere.
func (m *Model) onAgent(msg tea.Msg) tea.Cmd {
	if cmd := m.fold(msg); cmd != nil || isAgentMsg(msg) {
		return tea.Batch(cmd, m.agent.Next())
	}
	return nil
}

func isAgentMsg(msg tea.Msg) bool {
	switch msg.(type) {
	case agent.Started, agent.Think, agent.Text, agent.ToolStart, agent.ToolEnd,
		agent.Delegated, agent.Done, agent.Failed, agent.Stats:
		return true
	}
	return false
}

func (m *Model) fold(msg tea.Msg) tea.Cmd {
	switch msg := msg.(type) {
	case agent.Started:
		m.working = true
		return tickCmd()

	case agent.Think:
		m.appendChunk(chat.Think, "thinking", msg.Text)
		return nil

	case agent.Text:
		m.appendChunk(chat.Agent, "", msg.Text)
		return nil

	case agent.ToolStart:
		b := &chat.Block{Kind: chat.Tool, Title: msg.Name + "  " + msg.Args, State: chat.Running}
		m.openTool[msg.ID] = b
		m.chat.Append(b)
		return nil

	case agent.ToolEnd:
		b := m.openTool[msg.ID]
		if b == nil {
			// A result with no call is still worth showing; dropping it is
			// how a failure becomes invisible.
			b = &chat.Block{Kind: chat.Tool, Title: "result"}
			m.chat.Append(b)
		}
		delete(m.openTool, msg.ID)
		b.Detail = msg.Detail
		b.State = chat.OK
		if !msg.OK {
			b.State = chat.Failed
		}
		return nil

	case agent.Delegated:
		st := chat.OK
		if !msg.OK {
			st = chat.Failed
		}
		last := m.chat.Last()
		if last == nil || last.Kind != chat.Delegation {
			last = &chat.Block{Kind: chat.Delegation, Title: "sub-agents", State: st}
			m.chat.Append(last)
		}
		last.Children = append(last.Children, &chat.Block{
			Kind: chat.Agent, Title: msg.Label, Detail: msg.Model, State: st,
			Body: []string{msg.Detail},
		})
		last.Title = plural(len(last.Children), "sub-agent")
		if !msg.OK {
			last.State = chat.Failed
		}
		return nil

	case agent.Done:
		m.working = false
		// A queued message is a promise; keep it.
		if next, ok := m.prompt.PopQueue(); ok {
			m.layout()
			return m.send(next)
		}
		return nil

	case agent.Failed:
		m.working = false
		m.chat.Append(&chat.Block{Kind: chat.Notice, Body: []string{msg.Err.Error()}})
		return nil

	case agent.Stats:
		m.stats = msg.TurnStats
		return nil
	}
	return nil
}

// appendChunk streams text into the open block of a kind, or starts one.
func (m *Model) appendChunk(k chat.Kind, title, text string) {
	last := m.chat.Last()
	if last == nil || last.Kind != k {
		b := &chat.Block{Kind: k, Title: title}
		if k == chat.Think {
			b.Body = []string{}
		}
		m.chat.Append(b)
		last = b
	}
	lines := strings.Split(text, "\n")
	if n := len(last.Body); n > 0 && !strings.HasSuffix(text, "\n") {
		last.Body[n-1] += lines[0]
		lines = lines[1:]
	}
	last.Body = append(last.Body, lines...)
}

func (m *Model) onKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	// 1. Global chords, always, in every mode.
	if cmd, handled := m.global(msg); handled {
		return m, cmd
	}
	// 2. Whatever has the screen.
	if m.ov != nil {
		return m, m.overlayKey(msg)
	}
	if m.explorerFocus {
		return m, m.explorerKey(msg)
	}
	switch m.mode {
	case keymap.Read:
		return m, m.readKey(msg)
	default:
		return m, m.insertKey(msg)
	}
}

func (m *Model) global(msg tea.KeyPressMsg) (tea.Cmd, bool) {
	k := m.keys
	switch {
	case key.Matches(msg, k.Quit):
		if m.ov == nil && m.prompt.Empty() {
			m.quitting = true
			return tea.Quit, true
		}
		return nil, false

	case key.Matches(msg, k.Interrupt):
		if m.working {
			m.working = false
			m.lastInterrupt = time.Now()
			return tea.Batch(m.agent.Interrupt(), m.notify("interrupted")), true
		}
		// Twice within two seconds quits. Once does not, because ^c is also
		// how you stop the agent, and quitting on the first press means one
		// mistyped chord throws away the session.
		if time.Since(m.lastInterrupt) < 2*time.Second {
			m.quitting = true
			return tea.Quit, true
		}
		m.lastInterrupt = time.Now()
		return m.notify("^c again to quit"), true

	case key.Matches(msg, k.Palette):
		return m.openPalette(), true

	case key.Matches(msg, k.Sessions):
		return m.openSessions(), true

	case key.Matches(msg, k.Memory):
		return m.openMemory(), true

	case key.Matches(msg, k.Logs):
		return m.openLogs(), true

	case key.Matches(msg, k.KeysHelp):
		return m.openHelp(), true

	case key.Matches(msg, k.Explorer):
		return m.toggleExplorer(), true

	case key.Matches(msg, k.AllThink):
		return m.toggleAll(chat.Think, "thinking"), true

	case key.Matches(msg, k.AllTools):
		return m.toggleAll(chat.Tool, "tool"), true

	case key.Matches(msg, k.AllBlocks):
		opened := m.chat.ToggleEverything()
		return m.notify(openedWord(opened) + " every block"), true

	case key.Matches(msg, k.MouseOff):
		m.mouse = !m.mouse
		if m.mouse {
			return m.notify("mouse on — clicks fold blocks"), true
		}
		return m.notify("mouse off — drag-select is the terminal's again"), true
	}
	return nil, false
}

// toggleAll is the key the whole rebuild is organised around: one press,
// whole transcript. Reading a long turn used to mean opening eight blocks one
// at a time, which is eight keystrokes to answer one question.
func (m *Model) toggleAll(k chat.Kind, name string) tea.Cmd {
	_, total := m.chat.CountOpen(k)
	if total == 0 {
		return m.notify("no " + name + " blocks in this transcript")
	}
	opened := m.chat.ToggleAll(k)
	return m.notify(openedWord(opened) + " " + itoa(total) + " " + name + " block" + s(total))
}

func openedWord(opened bool) string {
	if opened {
		return "opened"
	}
	return "closed"
}

func (m *Model) insertKey(msg tea.KeyPressMsg) tea.Cmd {
	k := m.keys
	switch {
	case key.Matches(msg, k.Back):
		m.mode = keymap.Read
		m.prompt.Blur()
		return m.notify("read mode · J K move by block · i to come back")

	case key.Matches(msg, k.Steer):
		text := m.prompt.Take()
		if text == "" {
			return nil
		}
		m.layout()
		m.chat.Append(&chat.Block{Kind: chat.User, Body: strings.Split(text, "\n")})
		return tea.Batch(m.agent.Steer(text), m.notify("steering"))

	case key.Matches(msg, k.Send):
		text := m.prompt.Take()
		if text == "" {
			return nil
		}
		m.layout()
		if m.working {
			m.prompt.Queue(text)
			m.layout()
			return m.notify("queued — it goes when this turn ends · alt+enter steers instead")
		}
		return m.send(text)

	case key.Matches(msg, k.HistPrev):
		if m.prompt.HistoryPrev() {
			m.layout()
			return nil
		}

	case key.Matches(msg, k.HistNext):
		if m.prompt.HistoryNext() {
			m.layout()
			return nil
		}
	}
	cmd := m.prompt.Update(msg)
	m.layout()
	return cmd
}

func (m *Model) send(text string) tea.Cmd {
	m.chat.Append(&chat.Block{Kind: chat.User, Body: strings.Split(text, "\n")})
	m.working = true
	return tea.Batch(m.agent.Send(text), tickCmd())
}

func (m *Model) readKey(msg tea.KeyPressMsg) tea.Cmd {
	k := m.keys
	switch {
	case key.Matches(msg, k.Insert), key.Matches(msg, k.Back):
		m.mode = keymap.Insert
		m.chat.ClearFocus()
		return m.prompt.Focus()
	case key.Matches(msg, k.Down):
		m.chat.Scroll(1)
	case key.Matches(msg, k.Up):
		m.chat.Scroll(-1)
	case key.Matches(msg, k.HalfDown):
		m.chat.Scroll(m.h / 2)
	case key.Matches(msg, k.HalfUp):
		m.chat.Scroll(-m.h / 2)
	case key.Matches(msg, k.Top):
		m.chat.Top()
	case key.Matches(msg, k.Bottom):
		m.chat.Bottom()
	case key.Matches(msg, k.NextBlk):
		m.chat.FocusNext()
	case key.Matches(msg, k.PrevBlk):
		m.chat.FocusPrev()
	case key.Matches(msg, k.Toggle):
		if !m.chat.ToggleFocused() {
			return m.notify("nothing folded here — J and K step between blocks")
		}
	case key.Matches(msg, k.Yank):
		return m.copy(m.chat.YankFocused(), "block")
	case key.Matches(msg, k.YankAll):
		m.chat.ClearFocus()
		return m.copy(m.chat.YankFocused(), "transcript")
	}
	return nil
}

// copy goes out over OSC 52, which crosses SSH — unlike shelling out to
// pbcopy, which only works where the terminal itself is.
func (m *Model) copy(text, what string) tea.Cmd {
	if strings.TrimSpace(text) == "" {
		return m.notify("nothing to copy")
	}
	return tea.Batch(tea.SetClipboard(text), m.notify("copied the "+what))
}

func (m *Model) explorerKey(msg tea.KeyPressMsg) tea.Cmd {
	k := m.keys
	switch {
	case key.Matches(msg, k.Back):
		m.explorerFocus = false
		m.mode = keymap.Insert
		return m.prompt.Focus()
	case key.Matches(msg, k.Down):
		m.explorer.Move(1)
	case key.Matches(msg, k.Up):
		m.explorer.Move(-1)
	case key.Matches(msg, k.Open):
		m.explorer.Open()
	case key.Matches(msg, k.Close):
		m.explorer.Close()
	case key.Matches(msg, k.ExpandAll):
		m.explorer.ExpandAll()
		return m.notify("expanded the whole tree")
	case key.Matches(msg, k.CollapseAll):
		m.explorer.CollapseAll()
		return m.notify("collapsed the whole tree")
	case key.Matches(msg, k.Top):
		m.explorer.Top()
	case key.Matches(msg, k.Bottom):
		m.explorer.Bottom()
	case key.Matches(msg, k.Choose):
		n := m.explorer.Current()
		if n == nil {
			return nil
		}
		if n.HasChildren() {
			m.explorer.Open()
			return nil
		}
		// A file's whole point here is to end up in what you are about to
		// ask. Relative, because that is what you would have typed.
		rel := n.ID
		if r, err := filepath.Rel(m.cfg.CWD, n.ID); err == nil {
			rel = r
		}
		m.explorerFocus = false
		m.mode = keymap.Insert
		m.prompt.Insert(rel + " ")
		m.layout()
		return tea.Batch(m.prompt.Focus(), m.notify("added "+rel+" to the prompt"))
	}
	return nil
}

func (m *Model) overlayKey(msg tea.KeyPressMsg) tea.Cmd {
	k := m.keys
	ov := m.ov

	if key.Matches(msg, k.Back) {
		m.ov = nil
		m.mode = keymap.Insert
		return m.prompt.Focus()
	}
	if key.Matches(msg, k.Choose) {
		return m.chooseOverlay()
	}

	// A tree overlay keeps its movement keys until `/` is pressed; a flat one
	// filters as you type, because a palette you have to arm is a palette
	// with an extra keystroke in front of every use.
	if ov.IsTree() && !ov.Typing() {
		switch {
		case key.Matches(msg, k.Down):
			ov.Tree().Move(1)
			return nil
		case key.Matches(msg, k.Up):
			ov.Tree().Move(-1)
			return nil
		case key.Matches(msg, k.Open):
			ov.Tree().Open()
			return nil
		case key.Matches(msg, k.Close):
			ov.Tree().Close()
			return nil
		case key.Matches(msg, k.ExpandAll):
			ov.Tree().ExpandAll()
			return nil
		case key.Matches(msg, k.CollapseAll):
			ov.Tree().CollapseAll()
			return nil
		case key.Matches(msg, k.Filter):
			ov.StartTyping()
			return nil
		}
	}

	switch msg.String() {
	case "up":
		ov.Move(-1)
	case "down":
		ov.Move(1)
	case "backspace":
		ov.Backspace()
	default:
		if r := msg.Key().Text; r != "" {
			for _, c := range r {
				ov.Rune(c)
			}
		}
	}
	return nil
}

func (m *Model) chooseOverlay() tea.Cmd {
	ov := m.ov
	id, ok := ov.Selected()
	if !ok {
		return nil
	}
	switch ov.Kind {
	case overlay.Palette:
		m.ov = nil
		m.mode = keymap.Insert
		return tea.Batch(m.prompt.Focus(), m.runCommand(id))
	case overlay.Sessions:
		if ov.Tree() != nil && ov.Tree().Current().HasChildren() {
			ov.Tree().Open()
			return nil
		}
		m.ov = nil
		m.mode = keymap.Insert
		return tea.Batch(m.prompt.Focus(), m.resume(id))
	default:
		m.ov = nil
		m.mode = keymap.Insert
		return m.prompt.Focus()
	}
}

// resume replays a stored session into the transcript.
func (m *Model) resume(file string) tea.Cmd {
	s, ok := session.Read(file)
	if !ok {
		return m.notify("could not read that session")
	}
	m.chat.Clear()
	m.chat.Append(&chat.Block{Kind: chat.Agent, Body: []string{
		"resumed · " + s.Title, "  " + s.Model + " · " + itoa(s.Messages) + " messages",
	}})
	return m.notify("resumed " + filepath.Base(file))
}

func (m *Model) toggleExplorer() tea.Cmd {
	m.explorerOpen = !m.explorerOpen
	m.layout()
	if !m.explorerOpen {
		m.explorerFocus = false
		m.mode = keymap.Insert
		return tea.Batch(m.prompt.Focus(), m.notify("explorer closed"))
	}
	if m.explorerWidth() == 0 {
		m.explorerOpen = false
		return m.notify("terminal too narrow for the explorer")
	}
	// Opening it also focuses it. Toggling a pane and then having to reach
	// for it is the extra step this rebuild is removing.
	m.explorerFocus = true
	m.mode = keymap.Browse
	m.prompt.Blur()
	return m.notify("explorer · enter puts a path in the prompt · esc back")
}

func (m *Model) openHelp() tea.Cmd {
	items := make([]overlay.Item, 0, 40)
	for _, e := range m.keys.Help() {
		items = append(items, overlay.Item{Label: e.Desc, Detail: e.Key, Group: e.Mode.String(), ID: ""})
	}
	m.ov = overlay.NewList(overlay.Help, "every key, generated from the same table the program dispatches on", items)
	m.armOverlay()
	return nil
}

// action is one runnable thing: an id, what it says, the chord that also does
// it, and the code.
//
// This is the palette's only source. Building it from key bindings AND from a
// separate command list produced rows that looked runnable and were not,
// because a row derived from a help string has no handler behind it. One
// table, every row wired.
type action struct {
	id, label, chord string
	run              func(*Model) tea.Cmd
}

func (m *Model) actions() []action {
	k := m.keys
	return []action{
		{"explorer", k.Explorer.Help().Desc, k.Explorer.Help().Key, (*Model).toggleExplorer},
		{"think", k.AllThink.Help().Desc, k.AllThink.Help().Key,
			func(m *Model) tea.Cmd { return m.toggleAll(chat.Think, "thinking") }},
		{"tools", k.AllTools.Help().Desc, k.AllTools.Help().Key,
			func(m *Model) tea.Cmd { return m.toggleAll(chat.Tool, "tool") }},
		{"blocks", k.AllBlocks.Help().Desc, k.AllBlocks.Help().Key,
			func(m *Model) tea.Cmd {
				return m.notify(openedWord(m.chat.ToggleEverything()) + " every block")
			}},
		{"sessions", k.Sessions.Help().Desc, k.Sessions.Help().Key, (*Model).openSessions},
		{"memory", k.Memory.Help().Desc, k.Memory.Help().Key, (*Model).openMemory},
		{"logs", k.Logs.Help().Desc, k.Logs.Help().Key, (*Model).openLogs},
		{"keys", k.KeysHelp.Help().Desc, k.KeysHelp.Help().Key, (*Model).openHelp},
		{"mouse", k.MouseOff.Help().Desc, k.MouseOff.Help().Key,
			func(m *Model) tea.Cmd {
				m.mouse = !m.mouse
				return m.notify("mouse " + onOff(m.mouse))
			}},
		{"copy", "copy the whole transcript", k.YankAll.Help().Key,
			func(m *Model) tea.Cmd {
				m.chat.ClearFocus()
				return m.copy(m.chat.YankFocused(), "transcript")
			}},
		{"new", "start a new session", "",
			func(m *Model) tea.Cmd {
				m.chat.Clear()
				m.welcome()
				return m.notify("new session")
			}},
	}
}

func (m *Model) openPalette() tea.Cmd {
	acts := m.actions()
	items := make([]overlay.Item, 0, len(acts))
	for _, a := range acts {
		items = append(items, overlay.Item{Label: a.label, Detail: a.chord, ID: a.id})
	}
	m.ov = overlay.NewList(overlay.Palette, "run anything by name — this is the whole surface area", items)
	m.armOverlay()
	return nil
}

func (m *Model) runCommand(id string) tea.Cmd {
	for _, a := range m.actions() {
		if a.id == id {
			return a.run(m)
		}
	}
	return nil
}

func (m *Model) openSessions() tea.Cmd {
	nodes := session.Nodes(session.Load(m.cfg.Home), m.cfg.CWD)
	m.ov = overlay.NewTree(overlay.Sessions,
		"every conversation pi has stored, and the sub-agents under each one",
		nodes,
		"No sessions yet.",
		"One is written the first time you send a message.",
		"A sub-agent appears nested under the session that spawned it.",
	)
	m.armOverlay()
	return nil
}

func (m *Model) openMemory() tea.Cmd {
	m.ov = overlay.NewList(overlay.Memory,
		"what Mnemo has remembered, most useful first",
		nil,
		"Nothing remembered yet.",
		"Mnemo writes a memory when something is worth carrying between",
		"sessions — a decision, a constraint, a correction you made.",
	)
	m.armOverlay()
	return nil
}

// openLogs shows the span log as the tree it already is.
//
// Every span carries a parent, so the log is the call graph of a run rather
// than a flat scroll. That is the difference between "what happened" and
// "what happened inside what" — and it is the only view where a slow turn
// shows you which call was slow.
func (m *Model) openLogs() tea.Cmd {
	nodes := trace.Nodes(trace.Read(m.cfg.Home))
	m.ov = overlay.NewTree(overlay.Logs,
		"every run as a call graph — durations, tokens, and where it failed",
		nodes,
		"No traces yet.",
		"Each run writes one, under ~/.mnemo/logs, and it appears here",
		"as a tree: the session, the model round trips inside it, and any",
		"sub-agents underneath those. Branches containing a failure open",
		"themselves.",
	)
	m.armOverlay()
	return nil
}

func (m *Model) armOverlay() {
	m.prompt.Blur()
	m.layout()
}

// Files exposes the explorer root path, for tests.
func (m *Model) Files() string { return m.cfg.CWD }

func onOff(b bool) string {
	if b {
		return "on"
	}
	return "off"
}

func s(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

func plural(n int, unit string) string { return itoa(n) + " " + unit + s(n) }

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}

var _ = os.Getenv
