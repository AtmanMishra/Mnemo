// Package keymap is the single source of truth for every binding.
//
// The help overlay and the command palette both render FROM this struct, so a
// binding cannot exist without being documented and the help can never drift
// from the code. Adding a key means adding it here; there is nowhere else to
// put one.
package keymap

import "charm.land/bubbles/v2/key"

// Mode is which key table is live. There are three, and one rule for leaving
// them: esc always goes up a level.
type Mode int

const (
	// Insert is where you land. Typing goes to the prompt.
	Insert Mode = iota
	// Read is esc from Insert: the cursor disappears, and the transcript
	// takes single-letter keys.
	Read
	// Browse is a tree with focus — the explorer or the session overlay.
	Browse
)

func (m Mode) String() string {
	switch m {
	case Read:
		return "READ"
	case Browse:
		return "BROWSE"
	}
	return "INSERT"
}

// Map is every binding in the program.
type Map struct {
	// Global — live in every mode, so no surface is ever more than one
	// chord away.
	Palette   key.Binding
	Explorer  key.Binding
	Sessions  key.Binding
	Memory    key.Binding
	Logs      key.Binding
	Schedules key.Binding
	AllThink  key.Binding
	AllTools  key.Binding
	AllBlocks key.Binding
	Find      key.Binding
	Cycle     key.Binding
	CycleBack key.Binding
	KeysHelp  key.Binding
	Interrupt key.Binding
	Quit      key.Binding
	Back      key.Binding

	// Insert.
	Send     key.Binding
	Steer    key.Binding
	Newline  key.Binding
	Complete key.Binding
	HistPrev key.Binding
	HistNext key.Binding
	QueueUp  key.Binding
	QueueDn  key.Binding

	// Read.
	Down     key.Binding
	Up       key.Binding
	HalfDown key.Binding
	HalfUp   key.Binding
	Top      key.Binding
	Bottom   key.Binding
	NextBlk  key.Binding
	PrevBlk  key.Binding
	Toggle   key.Binding
	Yank     key.Binding
	YankAll  key.Binding
	NextHit  key.Binding
	PrevHit  key.Binding
	Undo     key.Binding
	Insert   key.Binding

	// Browse — a tree with focus.
	Next        key.Binding
	Prev        key.Binding
	Open        key.Binding
	Close       key.Binding
	ExpandAll   key.Binding
	CollapseAll key.Binding
	Choose      key.Binding
	Forget      key.Binding
	Add         key.Binding
	Edit        key.Binding
	Filter      key.Binding
}

// New builds the shipping key map.
//
// The chords are chosen so that every surface is reachable in one press from
// anywhere: ^k palette, ^t explorer, ^s sessions, ^m memory, ^l logs,
// ^o schedules. The two that matter most for reading are ^e and ^r — one
// press opens every thinking block, or every tool block, across the whole
// transcript. (^j is taken by newline in the prompt, which is why schedules
// gets ^o instead.)
func New() Map {
	b := func(help, desc string, keys ...string) key.Binding {
		return key.NewBinding(key.WithKeys(keys...), key.WithHelp(help, desc))
	}
	return Map{
		Palette:   b("^k", "command palette", "ctrl+k"),
		Explorer:  b("^t", "folder explorer", "ctrl+t"),
		Sessions:  b("^s", "sessions and sub-agents", "ctrl+s"),
		Memory:    b("^m", "memory", "ctrl+m"),
		Logs:      b("^l", "logs", "ctrl+l"),
		Schedules: b("^o", "schedules and triggers", "ctrl+o"),
		AllThink:  b("^e", "open every thinking block", "ctrl+e"),
		AllTools:  b("^r", "open every tool block", "ctrl+r"),
		AllBlocks: b("^a", "open everything", "ctrl+a"),
		Find:      b("^f", "find in transcript", "ctrl+f"),
		Cycle:     b("tab", "prompt · transcript · explorer", "tab"),
		CycleBack: b("shift+tab", "the other way", "shift+tab"),
		KeysHelp:  b("^h", "keys", "ctrl+h", "f1"),
		Interrupt: b("^c", "interrupt, twice to quit", "ctrl+c"),
		Quit:      b("^d", "quit", "ctrl+d"),
		Back:      b("esc", "up one level", "esc"),

		Send:     b("enter", "send, or queue while busy", "enter"),
		Steer:    b("alt+enter", "steer: interrupt with this now", "alt+enter"),
		Newline:  b("^j", "newline", "ctrl+j", "shift+enter"),
		Complete: b("tab", "complete", "tab"),
		HistPrev: b("up", "previous prompt", "up"),
		HistNext: b("down", "next prompt", "down"),
		QueueUp:  b("alt+up", "pull the last queued message back to edit it", "alt+up"),
		QueueDn:  b("alt+down", "queue the draft first, so it goes next", "alt+down"),

		Down:     b("j", "scroll down a line", "j"),
		Up:       b("k", "scroll up a line", "k"),
		HalfDown: b("^d", "half page down", "ctrl+d"),
		HalfUp:   b("^u", "half page up", "ctrl+u"),
		Top:      b("g", "top", "g", "home"),
		Bottom:   b("G", "bottom", "G", "end"),
		// The arrows move by BLOCK, not by line. A transcript is a list of
		// blocks, and the unit you actually want to step through is the one
		// the arrow keys should give you without a modifier.
		NextBlk: b("↓", "next block", "down", "J"),
		PrevBlk: b("↑", "previous block", "up", "K"),
		Toggle:  b("enter", "fold or unfold", "enter", " "),
		Yank:    b("y", "copy this block", "y"),
		YankAll: b("Y", "copy the transcript", "Y"),
		NextHit: b("n", "next match", "n"),
		PrevHit: b("N", "previous match", "N"),
		Undo:    b("u", "undo the last exchange", "u"),
		Insert:  b("i", "back to the prompt", "i", "a"),

		Next:        b("↓", "down", "down", "j"),
		Prev:        b("↑", "up", "up", "k"),
		Open:        b("→", "open, then go deeper", "right", "l"),
		Close:       b("←", "close, or jump to the parent", "left", "h"),
		ExpandAll:   b("E", "expand everything", "E"),
		CollapseAll: b("C", "collapse everything", "C"),
		Choose:      b("enter", "use this", "enter"),
		Forget:      b("d", "forget this memory", "d"),
		Add:         b("n", "new fact", "n"),
		Edit:        b("e", "edit this fact", "e"),
		Filter:      b("/", "filter", "/"),
	}
}

// Entry is one row of help: the mode it belongs to, the key, and what it does.
type Entry struct {
	Mode Mode
	Key  string
	Desc string
}

// Help returns every binding, grouped by mode, in the order they should be
// shown. Both the help overlay and the palette read this — there is no second
// list to keep in step.
func (m Map) Help() []Entry {
	group := func(mode Mode, bs ...key.Binding) []Entry {
		out := make([]Entry, 0, len(bs))
		for _, b := range bs {
			h := b.Help()
			out = append(out, Entry{Mode: mode, Key: h.Key, Desc: h.Desc})
		}
		return out
	}
	var out []Entry
	// Global first: these are the ones that remove the most keystrokes.
	out = append(out, group(Insert, m.Palette, m.Explorer, m.Sessions, m.Memory, m.Logs, m.Schedules,
		m.AllThink, m.AllTools, m.AllBlocks, m.Find, m.Cycle, m.CycleBack,
		m.KeysHelp, m.Interrupt, m.Quit, m.Back)...)
	out = append(out, group(Insert, m.Send, m.Steer, m.Newline, m.Complete, m.HistPrev, m.HistNext)...)
	out = append(out, group(Read, m.Down, m.Up, m.HalfDown, m.HalfUp, m.Top, m.Bottom,
		m.NextBlk, m.PrevBlk, m.Toggle, m.Yank, m.YankAll, m.NextHit, m.PrevHit, m.Insert)...)
	out = append(out, group(Browse, m.Next, m.Prev, m.Open, m.Close, m.ExpandAll, m.CollapseAll, m.Choose, m.Forget, m.Filter)...)
	return out
}

// OverlayHints are the keys live while a modal is up. A flat list filters as
// you type and has no hierarchy, so advertising h/l there names keys that do
// nothing — which is how a status line stops being believed.
func (m Map) OverlayHints(isTree bool) []Entry {
	e := func(b key.Binding) Entry {
		h := b.Help()
		return Entry{Mode: Browse, Key: h.Key, Desc: h.Desc}
	}
	if isTree {
		return []Entry{e(m.Next), e(m.Open), e(m.Choose), e(m.Back)}
	}
	return []Entry{{Mode: Browse, Key: "type", Desc: "filter"}, e(m.Choose), e(m.Back)}
}

// Hints are the few keys worth naming in the status line for a mode. Four is
// the limit: a status bar listing twelve keys is a status bar nobody reads.
func (m Map) Hints(mode Mode, busy bool) []Entry {
	e := func(b key.Binding) Entry {
		h := b.Help()
		return Entry{Mode: mode, Key: h.Key, Desc: h.Desc}
	}
	switch mode {
	case Read:
		return []Entry{e(m.NextBlk), e(m.Open), e(m.Yank), e(m.Insert)}
	case Browse:
		return []Entry{e(m.Next), e(m.Open), e(m.Choose), e(m.Back)}
	default:
		if busy {
			// While the agent is working the two enter keys mean different
			// things, and guessing wrong is expensive. Say so.
			return []Entry{e(m.Send), e(m.Steer), e(m.Interrupt), e(m.Palette)}
		}
		return []Entry{e(m.Send), e(m.Cycle), e(m.Back), e(m.Palette)}
	}
}
