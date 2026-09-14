package app

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"charm.land/bubbles/v2/key"
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
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/pi"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/session"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/schedule"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/theme"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/trace"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/tree"
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
		m.chat.SetMarkdown(markdown.New(m.th))
		for _, b := range m.chat.Blocks() {
			b.Invalidate() // the palette moved; every cached render is stale
		}
		return m, nil

	case tickMsg:
		m.tick++
		m.chat.SetTick(m.tick)
		if m.working {
			m.schedPoll()
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

	case modelsMsg:
		return m, m.onModels(msg)

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
		agent.Delegated, agent.Done, agent.Failed, agent.Stats, agent.Commands:
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
		if b := m.chat.Last(); b != nil && b.Kind == chat.Think {
			b.State = chat.Running
		}
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
		b.Body = toolLines(msg.Out)
		b.Detail = msg.Detail
		b.State = chat.OK
		if !msg.OK {
			b.State = chat.Failed
		}
		return nil

	case agent.Delegated:		st := chat.OK
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
		m.settle()
		// A queued message is a promise; keep it.
		if next, ok := m.prompt.PopQueue(); ok {
			m.layout()
			return tea.Batch(m.send(next), m.schedPoll())
		}
		return m.schedPoll()

	case agent.Failed:
		m.working = false
		m.settle()
		m.chat.Append(&chat.Block{Kind: chat.Notice, Body: []string{msg.Err.Error()}})
		return m.schedPoll()

	case agent.Stats:
		m.stats = msg.TurnStats
		return nil

	case agent.Commands:
		// The agent's own list, folded into the one the palette, the slash
		// menu and ^h read. Nothing else has to learn about it: there is
		// still exactly one list.
		m.cmds = command.Merge(m.cmds, agentCommands(msg.List))
		return nil
	}
	return nil
}

// agentCommands maps the backend's records onto this list's shape.
//
// The two vocabularies differ on purpose — the backend says where a command
// came from (source, location), the interface says how to run it and how to
// head its group (kind, scope) — and this is the one place they meet.
func agentCommands(list []agent.CommandInfo) []command.Command {
	out := make([]command.Command, 0, len(list))
	for _, c := range list {
		if c.Name == "" {
			continue
		}
		scope := c.Source
		if c.Location != "" {
			if scope == "" {
				scope = c.Location
			} else {
				scope += " · " + c.Location
			}
		}
		out = append(out, command.Command{
			Name: c.Name, Desc: c.Description, Kind: command.Agent,
			Scope: scope, Path: c.Path,
		})
	}
	return out
}

// settle clears every Running marker. A turn that ended must not leave a
// spinner on screen: a spinner nobody stops is a UI that looks hung.
func (m *Model) settle() {
	for _, b := range m.chat.Blocks() {
		if b.State != chat.Running {
			continue
		}
		if b.Kind == chat.Think {
			b.State = chat.None
			continue
		}
		// A tool call still open when the turn ended never reported back.
		b.State = chat.Failed
		if b.Detail == "" {
			b.Detail = "no result"
		}
	}
	m.openTool = map[string]*chat.Block{}
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
	// A delta is a slice of a continuous stream, so its first part ALWAYS
	// continues the line already in progress. Keying that off whether this
	// chunk happens to end in a newline broke a word wherever a chunk
	// boundary fell — "**Code" and " work**" arrived as two lines, and the
	// reader saw a heading cut in half.
	lines := strings.Split(text, "\n")
	if n := len(last.Body); n > 0 {
		last.Body[n-1] += lines[0]
		lines = lines[1:]
	}
	last.Body = append(last.Body, lines...)
	last.Invalidate()
}

func (m *Model) onKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	// 1. A pending confirmation, before ANY other key — global chords
	// included. A question a chord can walk past is a question that gets
	// answered by accident, and this one is the only irreversible thing here.
	// Anything that is not an explicit yes counts as no, so no key is
	// dangerous while it is up.
	if m.confirm != nil {
		return m, m.confirmKey(msg)
	}
	// 2. Global chords, always, in every other mode.
	if cmd, handled := m.global(msg); handled {
		return m, cmd
	}
	// 3. The search line, when it is up: it owns every printable key, so it
	// has to be asked before a mode gets a chance to read "n" as a movement.
	if m.searching {
		return m, m.searchKey(msg)
	}
	// 4. Whatever has the screen.
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
	// An open memory editor owns every key the way a confirmation does: tab
	// is its field-flip, not a surface cycle, and a global chord walking past
	// the editor would leave it half-edited and unnoticed.
	if m.editor != nil {
		return nil, false
	}
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
			m.settle()
			m.lastInterrupt = time.Now()
			return tea.Batch(m.agent.Interrupt(), m.notify("interrupted")), true
		}
		// First, the draft — pi's ctrl+c clears the editor before it quits
		// anything. A wrong draft is the everyday case; quitting is the
		// deliberate one, and getting to it must not mean losing the draft
		// to a keystroke you did not mean.
		if !m.prompt.Empty() {
			m.prompt.SetValue("")
			m.lastInterrupt = time.Now() // the quit window starts here, like pi
			return m.notify("cleared the draft · ^c again to quit"), true
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

	case key.Matches(msg, k.Schedules):
		return m.openSchedules(), true

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

	case key.Matches(msg, k.Find):
		if m.ov != nil {
			return nil, false // an overlay has its own filter; ^f there would be two
		}
		m.searching = true
		m.mode = keymap.Read
		m.prompt.Blur()
		m.chat.Search("")
		return nil, true

	case key.Matches(msg, k.Cycle):
		if m.prompt.MenuOpen() {
			return nil, false // tab completes the highlighted command instead
		}
		return m.cycleFocus(1), true

	case key.Matches(msg, k.CycleBack):
		return m.cycleFocus(-1), true

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

// cycleFocus moves between the prompt, the transcript and the explorer.
//
// One unmodified key that always moves to the next thing is what makes the
// interface navigable without memorising anything: you press tab until you
// are where you meant to be. Chords are for jumping straight there.
func (m *Model) cycleFocus(d int) tea.Cmd {
	if m.ov != nil {
		return nil // a modal has the screen; tab inside it belongs to the modal
	}
	stops := []keymap.Mode{keymap.Insert, keymap.Read}
	if m.explorerOpen {
		stops = append(stops, keymap.Browse)
	}
	cur := 0
	switch {
	case m.explorerFocus:
		cur = len(stops) - 1
	case m.mode == keymap.Read:
		cur = 1
	}
	next := stops[(cur+d+len(stops))%len(stops)]
	switch next {
	case keymap.Read:
		m.mode, m.explorerFocus = keymap.Read, false
		m.prompt.Blur()
		return m.notify("transcript · ↑ ↓ move by block · → opens · esc back")
	case keymap.Browse:
		m.mode, m.explorerFocus = keymap.Browse, true
		m.prompt.Blur()
		return m.notify("explorer · ↑ ↓ move · → opens · enter puts a path in the prompt")
	default:
		m.mode, m.explorerFocus = keymap.Insert, false
		m.chat.ClearFocus()
		return tea.Batch(m.prompt.Focus(), m.notify("prompt"))
	}
}

func (m *Model) insertKey(msg tea.KeyPressMsg) tea.Cmd {
	k := m.keys

	// The slash menu (or the @-file menu) owns the arrows and tab while it is
	// open. It closes on esc or as soon as the text stops looking like one,
	// so it can never hold a key hostage.
	if m.prompt.MenuOpen() {
		switch {
		case key.Matches(msg, k.Back):
			m.prompt.Suggest(nil)
			m.mention = false
			m.layout()
			return nil
		case key.Matches(msg, k.HistPrev):
			m.prompt.SugMove(-1)
			return nil
		case key.Matches(msg, k.HistNext):
			m.prompt.SugMove(1)
			return nil
		case key.Matches(msg, k.Complete):
			if m.mention {
				m.completeMention()
			} else {
				m.prompt.Complete()
				m.suggest()
				m.layout()
			}
			return nil
		case key.Matches(msg, k.Send):
			if m.mention {
				// A picked file is a reference, not a message: it goes into
				// the prompt, and the prompt stays yours.
				m.completeMention()
				return nil
			}
			if c, ok := m.prompt.SugSelected(); ok {
				m.prompt.Suggest(nil)
				rest := argsAfter(m.prompt.Take())
				m.layout()
				return m.runSlash(c, rest)
			}
		}
	}

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
		if strings.HasPrefix(text, "/") {
			return m.slash(text)
		}
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

	case key.Matches(msg, k.QueueUp):
		return m.queuePull()

	case key.Matches(msg, k.QueueDn):
		return m.queueDraft()
	}
	cmd := m.prompt.Update(msg)
	m.suggest()
	m.layout()
	return cmd
}

// suggest recomputes whichever menu belongs to the prompt: slash commands
// when the line starts with a slash, @-file references when an @ is in the
// text, and nothing at all otherwise. A slash followed by arguments closes
// the command menu — after the name, what follows is arguments, and a menu
// still filtering on them would be filtering on the wrong thing.
func (m *Model) suggest() {
	v := m.prompt.Value()
	m.mention = false
	if strings.HasPrefix(v, "/") {
		if strings.ContainsAny(v, " \n") {
			m.prompt.Suggest(nil)
			return
		}
		m.prompt.Suggest(command.Match(m.cmds, v))
		return
	}
	if at := strings.LastIndex(v, "@"); at >= 0 {
		q := strings.ToLower(v[at+1:])
		if i := strings.IndexAny(q, " \t\n"); i >= 0 {
			q = q[:i]
		}
		rows := m.mentionFiles(q)
		if len(rows) == 0 {
			// No match is a closed menu, not a stuck one: a menu with no rows
			// cannot be dismissed, and a mention flag with no menu behind it
			// starts swallowing tab and enter.
			m.prompt.Suggest(nil)
			return
		}
		m.mention = true
		m.prompt.Suggest(rows)
		return
	}
	m.prompt.Suggest(nil)
}

// completeMention puts the highlighted file reference into the prompt, in
// place of the @word that asked for it, and keeps editing.
func (m *Model) completeMention() {
	c, ok := m.prompt.SugSelected()
	if !ok {
		return
	}
	v := m.prompt.Value()
	at := strings.LastIndex(v, "@")
	if at < 0 {
		m.prompt.Insert(c.Name + " ")
	} else {
		// Replace "@word" with "path", keeping whatever came after the word.
		rest := v[at+1:]
		cut := 0
		for cut < len(rest) && !strings.ContainsRune(" \t\n", rune(rest[cut])) {
			cut++
		}
		tail := rest[cut:]
		insert := c.Name
		if tail == "" {
			insert += " "
		}
		m.prompt.SetValue(v[:at] + insert + tail)
	}
	m.prompt.Suggest(nil)
	m.mention = false
	m.layout()
}

// mentionRows is the @ menu: the project's files, matched by subsequence on
// their relative path the way command names are — "pi" finds internal/pi,
// and "pkg/main" finds cmd/mnemo/main.go without you typing every letter.
// Capped, because a menu that lists four thousand rows is not a menu.
func (m *Model) mentionFiles(q string) []command.Command {
	if q == "" {
		q = " " // an empty query matches everything below; don't
	}
	var out []command.Command
	for _, f := range m.projectFiles() {
		if !subseq(q, f) {
			continue
		}
		out = append(out, command.Command{Name: f, Kind: command.File})
		if len(out) >= 30 {
			break
		}
	}
	return out
}

// projectFiles lists the working tree's files, relative, once.
func (m *Model) projectFiles() []string {
	if m.files != nil {
		return m.files
	}
	var out []string
	_ = filepath.WalkDir(m.cfg.CWD, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if p != m.cfg.CWD && (filetree.Skip[d.Name()] || strings.HasPrefix(d.Name(), ".") && d.Name() != ".claude") {
				return filepath.SkipDir
			}
			return nil
		}
		out = append(out, strings.TrimPrefix(p, m.cfg.CWD+string(filepath.Separator)))
		return nil
	})
	if out == nil {
		out = []string{}
	}
	m.files = out
	return out
}

// subseq reports whether every rune of needle appears in hay, in order — the
// same matching rule the command names use, so "@pi" behaves like "/pi".
func subseq(needle, hay string) bool {
	needle = strings.ToLower(strings.TrimSpace(needle))
	hay = strings.ToLower(hay)
	i := 0
	for _, r := range needle {
		found := false
		for ; i < len(hay); i++ {
			if hay[i] == byte(r) {
				found = true
				i++
				break
			}
		}
		if !found {
			return false
		}
	}
	return len(needle) > 0
}

// queuePull brings the most recently queued message back into the editor, so
// it can be corrected before it ever goes out — pi's alt+up.
func (m *Model) queuePull() tea.Cmd {
	q := m.prompt.Queued()
	if len(q) == 0 {
		return m.notify("nothing queued — enter while a turn is running queues a message")
	}
	last := q[len(q)-1]
	m.prompt.DropLastQueued()
	m.prompt.SetValue(last)
	m.layout()
	return m.notify("back in the editor — edit it, then enter to send")
}

// queueDraft queues the draft ahead of the rest, so it goes next — alt+down.
func (m *Model) queueDraft() tea.Cmd {
	if m.prompt.Empty() {
		return m.notify("the editor is empty — write what to queue first")
	}
	text := m.prompt.Take()
	m.prompt.QueueFront(text)
	m.layout()
	return m.notify("queued first — it goes when this turn ends")
}

// argsAfter is everything after the command name on the line.
func argsAfter(line string) string {
	if i := strings.IndexAny(line, " \n"); i >= 0 {
		return strings.TrimSpace(line[i+1:])
	}
	return ""
}

// slash runs a typed command line.
//
// The interface's own list is the first table a router consults, not a gate.
// A name it does not know is not therefore unknown: pi implements extension
// commands, prompt templates and /skill:name that no client can enumerate from
// disk, and sending the line is how they are reached. With no backend attached
// there is nothing to route to, and the refusal stands — that case is real
// (offline runs, --dump) and it is the only one where refusing is honest.
func (m *Model) slash(line string) tea.Cmd {
	name := strings.TrimPrefix(line, "/")
	if i := strings.IndexAny(name, " \n"); i >= 0 {
		name = name[:i]
	}
	if c, ok := command.Find(m.cmds, name); ok {
		return m.runSlash(c, argsAfter(line))
	}
	if name == "" || !m.liveAgent() {
		return m.notify("no command called /" + name + " · ^k lists them all")
	}
	return m.route(line, name)
}

// route hands a line the agent might implement to the backend.
//
// While a turn is running the line is queued rather than sent, the way typed
// text is: pi executes an extension command mid-stream but rejects a prompt
// template or skill command while streaming, and one path that is right for
// all three beats a rule that depends on which kind you happened to type.
func (m *Model) route(line, name string) tea.Cmd {
	if m.working {
		m.prompt.Queue(line)
		m.layout()
		return m.notify("queued /" + name)
	}
	return tea.Batch(m.send(line), m.notify("sent /"+name+" to the agent"))
}

// runSlash executes one command. Built-ins are handled here; a skill, plugin
// or bundle becomes a prompt that names it and its file, so the agent can
// read the instructions rather than guess at them.
func (m *Model) runSlash(c command.Command, args string) tea.Cmd {
	if c.Kind == command.Agent {
		// The agent's own command. pi is what executes an extension command
		// and what expands a prompt template, so the line has to arrive the
		// way its own editor would have sent it — rewritten into a "use the
		// X skill" prompt it would stop being a command and become a
		// sentence about one.
		line := "/" + c.Name
		if args != "" {
			line += " " + args
		}
		return m.route(line, c.Name)
	}
	if c.Kind != command.Builtin {
		if m.working {
			m.prompt.Queue(c.Prompt(args))
			m.layout()
			return m.notify("queued /" + c.Name)
		}
		return tea.Batch(m.send(c.Prompt(args)), m.notify("running /"+c.Name))
	}
	switch c.Name {
	case "help":
		return m.openHelp()
	case "explorer":
		return m.toggleExplorer()
	case "sessions":
		return m.openSessions()
	case "memory":
		return m.openMemory()
	case "logs":
		return m.openLogs()
	case "schedules":
		return m.openSchedules()
	case "thinking":
		return m.toggleAll(chat.Think, "thinking")
	case "tools":
		return m.toggleAll(chat.Tool, "tool")
	case "expand", "collapse":
		return m.notify(openedWord(m.chat.ToggleEverything()) + " every block")
	case "copy":
		m.chat.ClearFocus()
		return m.copy(m.chat.YankFocused(), "transcript")
	case "clear":
		m.chat.Clear()
		m.welcome()
		return m.notify("new session")
	case "quit":
		m.quitting = true
		return tea.Quit
	case "login":
		return m.login(args)
	case "model":
		return m.openModels()
	case "logout":
		return m.logout(args)
	}
	return nil
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
	case key.Matches(msg, k.Open):
		// → and ← mean the same thing everywhere: open, close. A transcript
		// block folds the way a tree node does.
		if b := m.chat.Focused(); b != nil && b.Foldable() && !b.Open {
			m.chat.ToggleFocused()
		} else {
			m.chat.FocusNext()
		}
	case key.Matches(msg, k.Close):
		if b := m.chat.Focused(); b != nil && b.Foldable() && b.Open {
			m.chat.ToggleFocused()
		} else {
			m.chat.FocusPrev()
		}
	case key.Matches(msg, k.Toggle):
		if !m.chat.ToggleFocused() {
			return m.notify("nothing folded here — J and K step between blocks")
		}
	case key.Matches(msg, k.NextHit):
		if !m.chat.NextHit() {
			return m.notify("no matches — ^f searches the transcript")
		}
	case key.Matches(msg, k.PrevHit):
		if !m.chat.PrevHit() {
			return m.notify("no matches — ^f searches the transcript")
		}
	case key.Matches(msg, k.Yank):
		return m.copy(m.chat.YankFocused(), "block")
	case key.Matches(msg, k.YankAll):
		m.chat.ClearFocus()
		return m.copy(m.chat.YankFocused(), "transcript")

	case key.Matches(msg, k.Undo):
		return m.undoLastExchange()
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

// undoLastExchange removes the last finished exchange from the transcript:
// the most recent user message and everything the agent did in answer.
//
// It is honest about what it is not: the agent already ran that turn, so the
// undo is a view-level correction, never a rewrite of the backend or the
// session file — said out loud, or a reader expects the model to have
// forgotten the question, and it has not.
func (m *Model) undoLastExchange() tea.Cmd {
	if m.working {
		return m.notify("wait for the turn to end before undoing it")
	}
	blocks := m.chat.Blocks()
	last := -1
	for i, b := range blocks {
		if b.Kind == chat.User {
			last = i
		}
	}
	if last < 0 {
		return m.notify("nothing to undo yet — no exchange has finished")
	}
	label := ""
	if len(blocks[last].Body) > 0 {
		label = blocks[last].Body[0]
	}
	m.chat.TruncateAt(last)
	m.chat.ClearFocus()
	return m.notify("undid: “" + label + "” — the agent still remembers the turn")
}

func (m *Model) explorerKey(msg tea.KeyPressMsg) tea.Cmd {
	k := m.keys
	switch {
	case key.Matches(msg, k.Back):
		m.explorerFocus = false
		m.mode = keymap.Insert
		return m.prompt.Focus()
	case key.Matches(msg, k.Next):
		m.explorer.Move(1)
	case key.Matches(msg, k.Prev):
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

	// An open editor owns the overlay outright: its keystrokes are field
	// text, not navigation, and it answers before the tree gets a chance to
	// read n or e as movement.
	if m.editor != nil {
		return m.memEditorKey(msg)
	}

	if key.Matches(msg, k.Back) {
		if m.ov.Kind == overlay.Models {
			m.wizard = "" // skipping the wizard's model step is a choice, not a stuck flag
		}
		m.ov = nil
		m.mode = keymap.Insert
		return m.prompt.Focus()
	}
	if key.Matches(msg, k.Choose) {
		return m.chooseOverlay()
	}
	// Forget is offered only where it means something. Binding it globally
	// would put a destructive key one slip away in every list.
	if ov.Kind == overlay.Memory && key.Matches(msg, k.Forget) && !ov.Typing() {
		return m.forgetSelected()
	}
	// Schedules' action keys reuse the list-wide Add/Edit bindings where they
	// mean something (Login+Forget is the precedent: a key that is inert in
	// other lists never fires by surprise). n = fire this job now.
	if ov.Kind == overlay.Schedules && key.Matches(msg, k.Add) {
		if id, ok := ov.Selected(); ok {
			return m.scheduleFireNow(id)
		}
		return nil
	}
	// The same key, the same shape: d removes the thing under the cursor,
	// wherever removing is a thing this list can do. The login list is a FLAT
	// list, so it is always "typing" — unlike the memory tree, and the guard
	// from there would make this branch unreachable, which is not a d-key.
	if ov.Kind == overlay.Login && key.Matches(msg, k.Forget) {
		if id, ok := ov.Selected(); ok {
			return m.logout(strings.TrimPrefix(id, "login:"))
		}
	}

	// The memory tree's writers: n opens a fresh fact, e edits the row under
	// the cursor. Offered only where they mean something, like d — a binding
	// that fires in every list is a key nobody can trust.
	if ov.Kind == overlay.Memory && ov.Tree() != nil && !ov.Typing() {
		switch {
		case key.Matches(msg, k.Add):
			return m.memNewFact()
		case key.Matches(msg, k.Edit):
			return m.memEditFact()
		}
	}

	// A tree overlay keeps its movement keys until `/` is pressed; a flat one
	// filters as you type, because a palette you have to arm is a palette
	// with an extra keystroke in front of every use.
	if ov.IsTree() && !ov.Typing() {
		switch {
		case key.Matches(msg, k.Next):
			ov.Tree().Move(1)
			return nil
		case key.Matches(msg, k.Prev):
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
	// The models list gets its enter BEFORE anything about a selection:
	// enter on empty is a question — "write it anyway" — answered by
	// whatever the filter query holds: a typed model name, or the build's
	// default when the wizard cannot produce a catalogue at all.
	if ov.Kind == overlay.Models {
		m.ov = nil
		m.mode = keymap.Insert
		wizard := m.wizard
		m.wizard = ""
		if id, ok := ov.Selected(); ok {
			return tea.Batch(m.prompt.Focus(), m.chooseModel(id, wizard))
		}
		return tea.Batch(m.prompt.Focus(), m.chooseTypedModel(wizard, ov.Query()))
	}
	id, ok := ov.Selected()
	if !ok {
		return nil
	}
	switch ov.Kind {
	case overlay.Palette:
		m.ov = nil
		m.mode = keymap.Insert
		return tea.Batch(m.prompt.Focus(), m.runCommand(id))
	case overlay.Help:
		// Most rows here are keys, and a key is not something to run — it is
		// something to read. A command row is the exception, and it runs the
		// same way the palette's does.
		m.ov = nil
		m.mode = keymap.Insert
		if strings.HasPrefix(id, "cmd:") {
			return tea.Batch(m.prompt.Focus(), m.runCommand(id))
		}
		return m.prompt.Focus()
	case overlay.Sessions:
		if ov.Tree() != nil && ov.Tree().Descend() {
			return nil
		}
		m.ov = nil
		m.mode = keymap.Insert
		return tea.Batch(m.prompt.Focus(), m.resume(id))
	case overlay.Login:
		m.ov = nil
		m.mode = keymap.Insert
		return tea.Batch(m.prompt.Focus(), m.login(strings.TrimPrefix(id, "login:")))
	case overlay.Schedules:
		// Pausing/resuming stays in the surface: the row you toggled is
		// still there, already re-rendered, so a sweep of the list never
		// means opening and closing it job by job.
		return m.scheduleToggle(id)
	default:
		m.ov = nil
		m.mode = keymap.Insert
		return m.prompt.Focus()
	}
}

// resume replays a stored session into the transcript.
//
// The whole conversation, rendered through the same blocks a live turn uses.
// A summary card would be quicker and would make resuming feel like opening a
// receipt rather than picking a conversation back up.
func (m *Model) resume(file string) tea.Cmd {
	s, ok := session.Read(file)
	if !ok {
		return m.notify("could not read that session")
	}
	m.chat.Clear()
	m.chat.Append(&chat.Block{Kind: chat.Notice, Body: []string{
		"resumed · " + s.Title + " · " + s.Model,
	}})
	for _, e := range session.Transcript(file, pi.SummariseArgs) {
		m.chat.Append(entryBlock(e))
	}
	return m.notify("resumed " + itoa(s.Messages) + " messages from " + filepath.Base(file))
}

func entryBlock(e session.Entry) *chat.Block {
	switch e.Role {
	case "user":
		return &chat.Block{Kind: chat.User, Body: strings.Split(e.Text, "\n")}
	case "thinking":
		return &chat.Block{Kind: chat.Think, Title: "thinking", Body: strings.Split(e.Text, "\n")}
	case "tool":
		b := &chat.Block{Kind: chat.Tool, Title: e.Name + "  " + e.Detail}
		switch {
		case e.OK == nil:
			// The session file ends before the result arrived. Saying "ok"
			// would be inventing one.
			b.Detail = "no result recorded"
			b.State = chat.Running
		case *e.OK:
			b.Detail, b.State = "ok", chat.OK
		default:
			b.Detail, b.State = "failed", chat.Failed
		}
		return b
	default:
		return &chat.Block{Kind: chat.Agent, Body: strings.Split(e.Text, "\n")}
	}
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
	items := make([]overlay.Item, 0, 40+len(m.cmds))
	for _, e := range m.keys.Help() {
		items = append(items, overlay.Item{Label: e.Desc, Detail: e.Key, Group: e.Mode.String(), ID: ""})
	}
	// The commands follow the keys, because the built-in promises "every key
	// and command" and an agent's own commands are exactly the ones no other
	// surface would show. They are the same rows the palette draws, built the
	// same way, so the two lists cannot disagree.
	for _, c := range m.cmds {
		items = append(items, commandItem(c))
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
		{"schedules", k.Schedules.Help().Desc, k.Schedules.Help().Key, (*Model).openSchedules},
		{"keys", k.KeysHelp.Help().Desc, k.KeysHelp.Help().Key, (*Model).openHelp},
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

// commandItem is one command as an overlay row.
//
// One builder, because two surfaces now draw these rows — the palette and the
// help list — and a row that looks runnable in one and differs in the other is
// how a list stops being the list.
func commandItem(c command.Command) overlay.Item {
	// The group heading already says what kind it is; the row should spend its
	// width on what the thing DOES.
	detail := c.Desc
	if c.Chord != "" {
		detail = c.Chord + "  " + c.Desc
	}
	return overlay.Item{Label: "/" + c.Name, Detail: detail, Group: c.Kind.String(), ID: "cmd:" + c.Name}
}

// openPalette lists everything: the built-in actions and every skill, plugin
// and bundle on disk, plus whatever the agent says it implements. One surface,
// so there is nowhere a command can hide.
func (m *Model) openPalette() tea.Cmd {
	items := make([]overlay.Item, 0, len(m.cmds))
	for _, c := range m.cmds {
		items = append(items, commandItem(c))
	}
	m.ov = overlay.NewList(overlay.Palette,
		"every command, skill and plugin — type to filter, enter to run", items)
	m.armOverlay()
	return nil
}

func (m *Model) runCommand(id string) tea.Cmd {
	if name, ok := strings.CutPrefix(id, "cmd:"); ok {
		if c, found := command.Find(m.cmds, name); found {
			return m.runSlash(c, "")
		}
		return nil
	}
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

// openMemory shows the store as brain area → memory → facts.
//
// Sorted by fact count, never by id. By id, thirty empty "pi session …"
// episodes bury every memory that actually knows something, which is exactly
// what made the old memory pane useless.
func (m *Model) openMemory() tea.Cmd {
	nodes, err := m.memory()
	if err != nil {
		m.ov = overlay.NewList(overlay.Memory,
			"what Mnemo has remembered, most useful first", nil,
			"The memory service is not answering.",
			err.Error(),
			"Start it by pointing --memsrv at the built binary and",
			"--journal at its journal file.",
		)
		m.armOverlay()
		return nil
	}
	m.ov = overlay.NewTree(overlay.Memory,
		"what Mnemo remembers, by brain area — open one to read its facts",
		nodes,
		"Nothing remembered yet.",
		"Mnemo writes a memory when something is worth carrying between",
		"sessions — a decision, a constraint, a correction you made.",
	)
	m.armOverlay()
	return nil
}

// memory opens the sidecar on first use and keeps it. Starting it replays a
// journal, so paying that once is the difference between an overlay that
// opens and one that stalls every time.
func (m *Model) memory() ([]*tree.Node, error) {
	if m.cfg.MemsrvBin == "" || m.cfg.MemJournal == "" {
		return nil, errors.New("no memory service configured")
	}
	if m.mem == nil {
		c, err := memory.Open(m.cfg.MemsrvBin, m.cfg.MemJournal)
		if err != nil {
			return nil, err
		}
		m.mem = c
	}
	nodes, err := m.mem.Dump()
	if err != nil {
		_ = m.mem.Close()
		m.mem = nil
		return nil, err
	}
	return memory.Nodes(nodes, m.mem.Facts), nil
}

// openLogs shows the span log as the tree it already is.
//
// Every span carries a parent, so the log is the call graph of a run rather
// than a flat scroll. That is the difference between "what happened" and
// "what happened inside what" — and it is the only view where a slow turn
// shows you which call was slow.
// openSchedules floats the job store (10.5). Flat, like the palette: type to
// filter, enter pauses/resumes the selected job, n fires it now (the agent's
// /now command), esc back. Adding is deliberately out of reach here — a
// scheduler editor is a place for mistakes; `mnemo schedule add` and
// /schedule add are the honest surface for creating one.
func (m *Model) openSchedules() tea.Cmd {
	jobs, err := schedule.Load(m.cfg.Home)
	if err != nil {
		m.ov = overlay.NewList(overlay.Schedules,
			"all schedules and triggers — enter pauses, n fires now", nil,
			"Could not read the schedules file.",
			err.Error(),
			"Fix ~/.mnemo/schedules.json, then ^o again.",
		)
		m.armOverlay()
		return nil
	}
	items := make([]overlay.Item, 0, len(jobs))
	for _, j := range jobs {
		items = append(items, scheduleItem(j))
	}
	m.ov = overlay.NewList(overlay.Schedules,
		"all schedules and triggers — enter pauses, n fires now", items,
		"No schedules yet.",
		"One is written when you run",
		"mnemo schedule add --cron \"0 9 * * *\" --prompt \"…\"",
		"or /schedule add inside a session.",
	)
	m.ov.SetFooter(m.schedulesFooter())
	m.armOverlay()
	return m.schedPoll()
}

// scheduleItem is one job row: name, what it runs, and where it stands.
func scheduleItem(j schedule.Job) overlay.Item {
	mark := "runs — " + schedule.Describe(j)
	group := "schedule"
	if j.Trigger != nil {
		group = "trigger"
	}
	if !j.Enabled {
		group = "paused"
		mark = "paused — " + schedule.Describe(j)
	}
	detail := mark
	if j.LastRun != nil {
		when := time.UnixMilli(*j.LastRun).Format("01-02 15:04")
		if j.Result != nil {
			detail = "last " + when + " " + runWord(j.Result) + " · " + mark
		} else {
			detail = "last " + when + " · " + mark
		}
	} else {
		detail = mark + " · never run"
	}
	return overlay.Item{Label: j.Name, Detail: detail, Group: group, ID: j.ID}
}

func runWord(r *schedule.JobResult) string {
	if r.OK {
		return "ok"
	}
	if r.Detail != "" {
		return "failed · " + r.Detail
	}
	return "failed"
}

// schedulesFooter is the overlay's one action line. It says what the keys do
// and where new jobs come from, because a surface that hides its own add
// path is a surface that reads like it is broken.
func (m *Model) schedulesFooter() string {
	return "enter pause/resume · n fires now · esc back · add via mnemo schedule add"
}

// scheduleToggle flips one job's enabled flag in the shared store and
// re-renders the list in place, so pausing several jobs never closes the
// surface you are standing in.
func (m *Model) scheduleToggle(id string) tea.Cmd {
	jobs, err := schedule.Load(m.cfg.Home)
	if err != nil {
		return m.notify("schedules file unreadable — " + err.Error())
	}
	name, ok := schedule.Find(jobs, id)
	if !ok {
		return m.notify("no job " + id)
	}
	enabled, ok := schedule.ToggleEnabled(jobs, id)
	if !ok {
		return m.notify("no job " + id)
	}
	if err := schedule.Save(m.cfg.Home, jobs); err != nil {
		return m.notify("could not save — " + err.Error())
	}
	items := make([]overlay.Item, 0, len(jobs))
	for _, j := range jobs {
		items = append(items, scheduleItem(j))
	}
	m.ov.SetItems(items)
	word := "paused"
	if enabled {
		word = "resumed"
	}
	return m.notify(word + " " + name.Name + " — " + schedule.Describe(FindJob(jobs, id)))
}

// scheduleFireNow sends the agent its /now command, the same universal test
// button the CLI and the in-session ticker share (10.4).
func (m *Model) scheduleFireNow(id string) tea.Cmd {
	jobs, err := schedule.Load(m.cfg.Home)
	if err != nil {
		return m.notify("schedules file unreadable — " + err.Error())
	}
	name, ok := schedule.Find(jobs, id)
	if !ok {
		return m.notify("no job " + id)
	}
	return tea.Batch(
		m.send("/now "+id),
		m.notify("firing "+name.Name+" now"),
	)
}

// schedPoll toasts each finished job once, as a status-line chip, like the
// hooks reports and the memory notices already do. Polling the 200-byte
// store at the points the app already wakes up (start, each turn end, each
// spinner tick, opening the overlay) is the honest cheap channel — a push
// event from the daemon into the TUI would mean growing the agent protocol
// just for this.
func (m *Model) schedPoll() tea.Cmd {
	jobs, err := schedule.Load(m.cfg.Home)
	if err != nil {
		return nil
	}
	now := time.Now().UnixMilli()
	for _, j := range jobs {
		if j.Result == nil {
			continue
		}
		sig := itoa64(j.Result.At) + ":" + boolWord(j.Result.OK) + ":" + itoa64(j.Result.DurationMs)
		if m.schedSeen[j.ID] == sig {
			continue
		}
		m.schedSeen[j.ID] = sig
		if !schedule.Recent(j, now, 5*60_000) {
			continue
		}
		word := "ok"
		if !j.Result.OK {
			word = "failed"
		}
		return m.notify("⏱ " + j.Name + ": " + word + " · " + itoa64(j.Result.DurationMs/1000) + "s")
	}
	return nil
}

func itoa64(n int64) string {
	return itoa(int(n))
}

func boolWord(b bool) string {
	if b {
		return "ok"
	}
	return "no"
}

// FindJob is the app-local lookup used by the pause notice.
func FindJob(jobs []schedule.Job, id string) schedule.Job {
	j, _ := schedule.Find(jobs, id)
	return j
}

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

// searchKey drives the ^f query line.
//
// It searches on every keystroke rather than waiting for enter. A search box
// that does nothing until you commit makes you type the whole word before it
// tells you the word is not there.
func (m *Model) searchKey(msg tea.KeyPressMsg) tea.Cmd {
	q := m.chat.Query()
	switch {
	case key.Matches(msg, m.keys.Back):
		// esc abandons the search AND its highlights. Leaving the marks up
		// after you have left would make the transcript look permanently
		// annotated.
		m.searching = false
		m.chat.Search("")
		return nil

	case key.Matches(msg, m.keys.Choose):
		// enter keeps the query and the highlights, and hands the keys back
		// so n and N step through what was found.
		m.searching = false
		if !m.chat.FirstHit() {
			return m.notify("no match for " + q)
		}
		return nil

	case msg.String() == "backspace":
		if q == "" {
			m.searching = false
			return nil
		}
		r := []rune(q)
		m.chat.Search(string(r[:len(r)-1]))
		return nil

	case key.Matches(msg, m.keys.NextHit) && msg.Mod != 0:
		m.chat.NextHit()
		return nil
	}

	if txt := msg.Key().Text; txt != "" {
		m.chat.Search(q + txt)
		m.chat.FirstHit()
	}
	return nil
}

// confirmation is a pending destructive action.
//
// Exactly one thing in this interface cannot be undone — forgetting a memory
// appends a tombstone, and there is no key that puts it back. So it is the
// one thing that asks first. Everything else is reversible and asking would
// be noise.
type confirmation struct {
	prompt string
	run    func(*Model) tea.Cmd
}

// ask puts a yes/no question in the status line.
func (m *Model) ask(prompt string, run func(*Model) tea.Cmd) tea.Cmd {
	m.confirm = &confirmation{prompt: prompt, run: run}
	return nil
}

// confirmKey answers a pending question. Anything that is not an explicit
// yes is a no: a destructive action must never be reachable by a keystroke
// you did not mean.
func (m *Model) confirmKey(msg tea.KeyPressMsg) tea.Cmd {
	c := m.confirm
	m.confirm = nil
	if msg.String() == "y" || msg.String() == "Y" {
		return c.run(m)
	}
	return m.notify("left alone")
}

// forgetSelected removes the memory under the cursor.
func (m *Model) forgetSelected() tea.Cmd {
	if m.ov == nil || m.ov.Kind != overlay.Memory || m.ov.Tree() == nil {
		return nil
	}
	n := m.ov.Tree().Current()
	if n == nil {
		return nil
	}
	// Areas are headings, not memories. Offering to forget one would be
	// offering to delete a category that never existed as a thing.
	id, ok := memory.NodeID(n.ID)
	if !ok {
		return m.notify("that is a brain area, not a memory — open it and pick one")
	}
	label := n.Label
	return m.ask("forget "+label+"? this cannot be undone — y / n", func(m *Model) tea.Cmd {
		if m.mem == nil {
			// The overlay is open, so a client was made to fill it; if it has
			// gone away since, say so rather than silently doing nothing.
			return m.notify("the memory service is not connected")
		}
		if _, err := m.mem.Forget(id); err != nil {
			return m.notify("could not forget: " + err.Error())
		}
		m.openMemory() // reload, so the row is actually gone
		return m.notify("forgot " + label)
	})
}

// --- memory editor: add a fact, edit a fact -------------------------------

// memEditor is the smallest thing that can write a fact: a node to write to
// and two fields. One struct, one line on screen, keys of its own — the
// overlay stays the one surface, and the editor is a mode of the list it
// already is.
type memEditor struct {
	node  int
	label string
	key   string
	value string
	field int // 0 = key, 1 = value
}

// memNewFact opens a fresh two-field editor on the memory under the cursor.
func (m *Model) memNewFact() tea.Cmd {
	if m.ov == nil || m.ov.Tree() == nil {
		return nil
	}
	n := m.ov.Tree().Current()
	if n == nil {
		return nil
	}
	id, ok := memory.NodeID(n.ID)
	if !ok {
		return m.notify("that is an area — step into it and pick a memory")
	}
	if m.mem == nil {
		return m.notify("the memory service is not connected")
	}
	m.editor = &memEditor{node: id, label: n.Label}
	return m.notify("type the key, tab to the value, enter saves")
}

// memEditFact opens the editor prefilled from the fact row under the cursor.
// The value is what you came to fix, so the cursor lands there.
func (m *Model) memEditFact() tea.Cmd {
	if m.ov == nil || m.ov.Tree() == nil {
		return nil
	}
	n := m.ov.Tree().Current()
	if n == nil {
		return nil
	}
	node, key, value, ok := memory.FactRow(n.ID)
	if !ok {
		return m.notify("that is a memory — open it and pick one fact to edit")
	}
	if m.mem == nil {
		return m.notify("the memory service is not connected")
	}
	m.editor = &memEditor{node: node, label: n.Label, key: key, value: value, field: 1}
	return m.notify("edit the value, enter saves · esc leaves it alone")
}

// memEditorKey feeds one keystroke to the open editor.
func (m *Model) memEditorKey(msg tea.KeyPressMsg) tea.Cmd {
	k := m.keys
	e := m.editor
	switch {
	case key.Matches(msg, k.Back):
		m.editor = nil
		return m.notify("left the edit alone")
	case key.Matches(msg, k.Send) || msg.String() == "ctrl+j":
		return m.memEditorSave()
	case key.Matches(msg, k.Cycle):
		e.field = 1 - e.field
		return nil
	case msg.String() == "backspace":
		s := []rune(e.fieldValue())
		if len(s) > 0 {
			e.setField(string(s[:len(s)-1]))
		}
		return nil
	default:
		if r := msg.Key().Text; r != "" {
			for _, c := range r {
				e.setField(e.fieldValue() + string(c))
			}
		}
		return nil
	}
}

// toolLines is a tool result as block text: verbatim, trailing blank lines
// gone, and bounded — a build log a megabyte long is the worst thing to
// render in the app's own terminal. The one-line summary ("84 ln") stays
// honest because the cap says, in its own line, that it skipped some.
//
// The quoted-as-text habit this replaces was the two-step: read the summary,
// wonder what is behind it, open it, read a paraphrase. Native output is the
// block's whole point.
func toolLines(out string) []string {
	lines := strings.Split(out, "\n")
	for len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) == "" {
		lines = lines[:len(lines)-1]
	}
	const max = 1000
	if len(lines) > max {
		// Keep the first line (usually the invocation's echo) and the last
		// max-1 lines. A summary that says "84 ln" while showing 84 lines
		// would be lying, so the skipped count is said out loud.
		skipped := len(lines) - max + 1
		lines = append([]string{lines[0], "… " + itoa(skipped) + " lines skipped in the middle"}, lines[skipped:]...)
	}
	return lines
}

func (e *memEditor) fieldValue() string {
	if e.field == 0 {
		return e.key
	}
	return e.value
}

func (e *memEditor) setField(s string) {
	if e.field == 0 {
		e.key = s
	} else {
		e.value = s
	}
}

// memEditorSave writes the fact and hands the list back.
func (m *Model) memEditorSave() tea.Cmd {
	e := m.editor
	e.key = strings.TrimSpace(e.key)
	if e.key == "" {
		return m.notify("a fact needs a key")
	}
	// Value is allowed to be empty: a bare "flag: " is a real fact.
	var id int
	var err error
	if m.mem != nil {
		id, err = m.mem.AddFact(e.node, e.key, e.value)
	}
	if err != nil {
		return m.notify("could not write: " + err.Error())
	}
	m.editor = nil
	label := e.value
	if label == "" {
		label = "(no value)"
	}
	// The journal is append-only: this lands as a new fact, and a corrected
	// re-statement keeps the old line beneath it, the way a tombstone keeps
	// the record. Said out loud, or a reader counts two facts and wonders
	// why typing an edit made the memory bigger.
	return tea.Batch(
		m.notify("wrote fact #"+itoa(id)+" to “"+e.label+"” · "+e.key+": "+label),
		m.openMemory(),
	)
}

// --- accounts and models -------------------------------------------------

// openLogin lists the providers and says which are already set up.
//
// It does not ask for a key here. A key is a long opaque string that has to
// be pasted, and pasting it into a list is not a thing a list can do — so
// choosing a provider hands the prompt back with `/login <provider> ` already
// typed, and the paste goes where every other paste goes.
func (m *Model) openLogin() tea.Cmd {
	f := auth.Load(m.cfg.Home)
	items := make([]overlay.Item, 0, len(auth.Providers))
	for _, p := range auth.Providers {
		detail := "not set up"
		if a, ok := f.Providers[p]; ok && len(a.Key) >= auth.MinKeyLen {
			detail = "logged in"
			if a.DefaultModel != "" {
				detail += " · " + a.DefaultModel
			}
			if p == f.DefaultProvider {
				detail += " · default"
			}
		}
		items = append(items, overlay.Item{
			Label: p, Detail: detail, Group: "provider", ID: "login:" + p,
		})
	}
	m.ov = overlay.NewList(overlay.Login,
		"which account the agent runs on — enter starts a login, "+string(m.keys.Forget.Keys()[0])+" logs one out",
		items)
	m.armOverlay()
	return nil
}

// openModels lists what the logged-in providers actually offer.
//
// Asking the agent takes about half a second, which is too long to do inside
// a keystroke, so the list arrives as a message and the overlay opens
// immediately saying it is loading. An interface that freezes while it thinks
// is one people stop pressing.
func (m *Model) openModels() tea.Cmd {
	return m.openModelsFor("")
}

// openModelsFor is the same list, scoped to one provider — the wizard's
// model step. During a login you can only pick that provider's models, else
// the stored key you just pasted cannot serve what you picked.
func (m *Model) openModelsFor(provider string) tea.Cmd {
	m.wizard = provider
	purpose := "every model your logged-in providers offer — enter makes it the default"
	if provider != "" {
		purpose = "pick " + provider + "'s default model — enter makes it the default, enter on empty keeps the build default"
	}
	m.ov = overlay.NewList(overlay.Models,
		purpose,
		nil,
		"Asking the agent for the catalogue…",
		"This takes about half a second.",
	)
	m.armOverlay()
	repo := m.cfg.Repo
	return func() tea.Msg {
		models, err := auth.Fetch(repo)
		return modelsMsg{models: models, err: err, provider: provider}
	}
}

// modelsMsg carries the catalogue back from the goroutine that asked for it.
// provider is non-empty when the wizard asked for one provider's models.
type modelsMsg struct {
	models   []auth.Model
	err      error
	provider string
}

func (m *Model) onModels(msg modelsMsg) tea.Cmd {
	if m.ov == nil || m.ov.Kind != overlay.Models {
		return nil // the reader moved on; do not yank them back
	}
	// The wizard only ever pictures one provider; a login must not end up
	// offering a model the key it just stored cannot run.
	if msg.provider != "" {
		var scoped []auth.Model
		for _, mo := range msg.models {
			if mo.Provider == msg.provider {
				scoped = append(scoped, mo)
			}
		}
		msg.models = scoped
	}
	if msg.err != nil {
		m.ov = overlay.NewList(overlay.Models,
			"every model your logged-in providers offer — enter makes it the default", nil,
			"Could not ask the agent for the catalogue.",
			msg.err.Error(),
			"An empty list and a failed question are different things —",
			"this is the second. Type a model name to pick one anyway,",
			"or enter on empty to keep the provider's default.",
		)
		m.armOverlay()
		return nil
	}
	f := auth.Load(m.cfg.Home)
	items := make([]overlay.Item, 0, len(msg.models))
	for _, mo := range msg.models {
		detail := ""
		if f.DefaultModelFor(mo.Provider) == mo.Name {
			detail = "current"
		}
		items = append(items, overlay.Item{
			Label: mo.Name, Detail: detail, Group: mo.Provider, ID: "model:" + mo.String(),
		})
	}
	if msg.provider != "" {
		m.ov = overlay.NewList(overlay.Models,
			"pick "+msg.provider+"'s default model — type to filter, enter to pick",
			items,
			"Nothing listed for "+msg.provider+".",
			"Type a model name and enter anyway, or enter on empty",
			"to keep the build's default.",
		)
	} else {
		m.ov = overlay.NewList(overlay.Models,
			"every model your logged-in providers offer — enter makes it the default",
			items,
			"No models available.",
			"Log in to a provider first: /login",
		)
	}
	m.armOverlay()
	return nil
}

// chooseModel records a chosen row as its provider's default. wizard is
// non-empty when the pick came out of the login flow.
func (m *Model) chooseModel(id, wizard string) tea.Cmd {
	provider, name, ok := strings.Cut(strings.TrimPrefix(id, "model:"), "/")
	if !ok {
		return nil
	}
	return m.applyModel(provider, name, wizard == "")
}

// chooseTypedModel is the catalogue-less fallback: enter with no row picked
// uses what was typed as the model name. An empty typed name on the wizard
// step keeps the canonical default of the build — deepseek-v4-flash under
// opencode-go — so first run works even when the agent cannot be asked.
func (m *Model) chooseTypedModel(wizard, query string) tea.Cmd {
	query = strings.TrimSpace(query)
	provider := wizard
	if provider == "" {
		provider = auth.Load(m.cfg.Home).EffectiveProvider()
		if provider == "" {
			return m.notify("log in a provider first: /login")
		}
	}
	if query == "" {
		if provider == "opencode-go" {
			query = "deepseek-v4-flash"
		} else {
			return m.notify("type a model name, or pick one from the list")
		}
	}
	return m.applyModel(provider, query, wizard == "")
}

// applyModel writes the choice. repoint says whether picking also switches
// which account new sessions use: yes from /model — that is what the surface
// is for — and never from the login wizard, where the provider was decided by
// the key you just pasted, and repointing would silently steal the default
// from one account while setting up another.
func (m *Model) applyModel(provider, name string, repoint bool) tea.Cmd {
	if _, err := auth.SetDefaultModel(m.cfg.Home, provider, name); err != nil {
		return m.notify(err.Error())
	}
	if repoint {
		if _, err := auth.SetDefaultProvider(m.cfg.Home, provider); err != nil {
			return m.notify(err.Error())
		}
		// The running agent keeps the model it started with. Saying so is
		// the difference between "nothing happened" and "it applies next
		// time".
		return m.notify("picked " + provider + "/" + name + " — new sessions run on it")
	}
	return m.notify("default model is now " + name + " · new sessions use it")
}

// login and logout, from the prompt.
func (m *Model) login(args string) tea.Cmd {
	provider, key, _ := strings.Cut(strings.TrimSpace(args), " ")
	if provider == "" {
		return m.openLogin()
	}
	if strings.TrimSpace(key) == "" {
		m.prompt.SetValue("/login " + provider + " ")
		return m.notify("paste the key after the provider, then enter")
	}
	if _, err := auth.SetKey(m.cfg.Home, provider, key, "", time.Now()); err != nil {
		return m.notify(err.Error())
	}
	// The wizard's third step: the key is in, so the model list follows —
	// Rust's Provider → Key → Model → Done, without the reader having to
	// guess the next command.
	return tea.Batch(m.notify("logged in to "+provider+" — now pick its default model"), m.openModelsFor(provider))
}

func (m *Model) logout(args string) tea.Cmd {
	provider := strings.TrimSpace(args)
	if provider == "" {
		return m.notify("which provider? /logout <provider> · /login lists them")
	}
	return m.ask("log out of "+provider+"? — y / n", func(m *Model) tea.Cmd {
		if _, err := auth.Logout(m.cfg.Home, provider); err != nil {
			return m.notify(err.Error())
		}
		return m.notify("logged out of " + provider)
	})
}
