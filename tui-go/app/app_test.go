package app

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/agent"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/auth"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/chat"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/keymap"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/overlay"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/tree"
	"github.com/charmbracelet/x/ansi"
)

// fixture builds an app pointed entirely at temporary directories. Home and
// CWD are configuration, never lookups, so no test can read — or write — the
// developer's real ~/.pi.
func fixture(t *testing.T, w, h int) *Model {
	t.Helper()
	home := t.TempDir()
	cwd := t.TempDir()
	for _, f := range []string{"main.go", "README.md"} {
		if err := os.WriteFile(filepath.Join(cwd, f), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(cwd, "internal"), 0o755); err != nil {
		t.Fatal(err)
	}
	m := New(Config{Home: home, CWD: cwd, Dark: true, Agent: agent.Offline{Reason: "test"}})
	m.Resize(w, h)
	return m
}

// press sends one key, the way the terminal would.
func press(t *testing.T, m *Model, keystroke string) {
	t.Helper()
	var k tea.Key
	switch keystroke {
	case "esc":
		k = tea.Key{Code: tea.KeyEscape}
	case "enter":
		k = tea.Key{Code: tea.KeyEnter}
	case "up":
		k = tea.Key{Code: tea.KeyUp}
	case "down":
		k = tea.Key{Code: tea.KeyDown}
	case "tab":
		k = tea.Key{Code: tea.KeyTab}
	case "shift+tab":
		k = tea.Key{Code: tea.KeyTab, Mod: tea.ModShift}
	case "left":
		k = tea.Key{Code: tea.KeyLeft}
	case "right":
		k = tea.Key{Code: tea.KeyRight}
	case "backspace":
		k = tea.Key{Code: tea.KeyBackspace}
	default:
		if strings.HasPrefix(keystroke, "ctrl+") {
			k = tea.Key{Code: rune(keystroke[len("ctrl+")]), Mod: tea.ModCtrl}
		} else {
			r := []rune(keystroke)[0]
			k = tea.Key{Code: r, Text: string(r)}
		}
	}
	m.Update(tea.KeyPressMsg(k))
}

func typeIn(t *testing.T, m *Model, s string) {
	t.Helper()
	for _, r := range s {
		press(t, m, string(r))
	}
}

func screen(m *Model) string { return m.Render() }

// --- the shape of the screen -------------------------------------------

func TestTheScreenIsExactlyTheTerminal(t *testing.T) {
	for _, wh := range [][2]int{{40, 12}, {80, 24}, {100, 46}, {200, 60}, {20, 8}} {
		m := fixture(t, wh[0], wh[1])
		lines := strings.Split(screen(m), "\n")
		if len(lines) != wh[1] {
			t.Fatalf("%dx%d: drew %d rows", wh[0], wh[1], len(lines))
		}
		for i, l := range lines {
			if got := ansi.StringWidth(l); got > wh[0] {
				t.Fatalf("%dx%d: row %d is %d cells: %q", wh[0], wh[1], i, got, l)
			}
		}
	}
}

func TestThePromptSitsAtTheBottomEvenWithAShortTranscript(t *testing.T) {
	m := fixture(t, 80, 30)
	lines := strings.Split(screen(m), "\n")
	// The status band is always the last row; the prompt sits just above it,
	// separated by one blank row of air when the screen can afford one.
	if !strings.Contains(lines[len(lines)-1], "INSERT") {
		t.Fatalf("status band is not the last row: %q", lines[len(lines)-1])
	}
	if !strings.Contains(lines[len(lines)-3], "ask, or press") {
		t.Fatalf("prompt is not just above the status line:\n%s", strings.Join(lines[len(lines)-4:], "\n"))
	}
	if strings.TrimSpace(lines[len(lines)-2]) != "" {
		t.Fatalf("expected a blank row between the prompt and the status band, got %q", lines[len(lines)-2])
	}
}

func TestEveryRegionIsLabelled(t *testing.T) {
	m := fixture(t, 100, 30)
	if !strings.Contains(screen(m), "TRANSCRIPT") {
		t.Fatal("an unlabelled region is a region the reader has to guess at")
	}
	press(t, m, "ctrl+t")
	if !strings.Contains(screen(m), "EXPLORER") {
		t.Fatalf("the explorer column is unlabelled:\n%s", screen(m))
	}
}

// --- navigation ---------------------------------------------------------

func TestEscIsTheOnlyWayUpAndItAlwaysWorks(t *testing.T) {
	m := fixture(t, 100, 30)
	if m.Mode() != keymap.Insert {
		t.Fatal("you land in insert")
	}
	press(t, m, "esc")
	if m.Mode() != keymap.Read {
		t.Fatal("esc from insert is read mode")
	}
	press(t, m, "esc")
	if m.Mode() != keymap.Insert {
		t.Fatal("esc from read comes back")
	}
	press(t, m, "ctrl+s")
	if m.Overlay() == nil {
		t.Fatal("an overlay should be up")
	}
	press(t, m, "esc")
	if m.Overlay() != nil || m.Mode() != keymap.Insert {
		t.Fatal("esc closes an overlay and returns to the prompt")
	}
	press(t, m, "ctrl+t")
	press(t, m, "esc")
	if m.Mode() != keymap.Insert {
		t.Fatal("esc leaves the explorer too")
	}
}

func TestEverySurfaceIsOnePressFromEveryMode(t *testing.T) {
	// The navigation complaint, as a test. Global chords are dispatched
	// before any surface sees the key, so nothing can swallow ^k and strand
	// you.
	for _, enter := range []string{"", "esc", "ctrl+t"} {
		for _, chord := range []string{"ctrl+k", "ctrl+s", "ctrl+m", "ctrl+l"} {
			m := fixture(t, 100, 30)
			if enter != "" {
				press(t, m, enter)
			}
			press(t, m, chord)
			if m.Overlay() == nil {
				t.Fatalf("from %q, %s opened nothing", enter, chord)
			}
		}
	}
}

func TestOneKeyOpensEveryThinkingBlock(t *testing.T) {
	m := fixture(t, 100, 30)
	for i := 0; i < 6; i++ {
		m.Chat().Append(&chat.Block{Kind: chat.Think, Title: "thinking", Body: []string{"a", "b"}})
	}
	press(t, m, "ctrl+e")
	if open, total := m.Chat().CountOpen(chat.Think); open != total || total != 6 {
		t.Fatalf("one press left %d of %d open", open, total)
	}
	if !strings.Contains(screen(m), "opened 6 thinking blocks") {
		t.Fatalf("the status line must say what happened:\n%s", lastLine(screen(m)))
	}
	press(t, m, "ctrl+e")
	if open, _ := m.Chat().CountOpen(chat.Think); open != 0 {
		t.Fatalf("%d still open after the second press", open)
	}
}

func TestTheHeaderSaysHowMuchIsHidden(t *testing.T) {
	// A reader who cannot see that blocks are collapsed does not know there
	// is anything to open.
	m := fixture(t, 100, 30)
	for i := 0; i < 3; i++ {
		m.Chat().Append(&chat.Block{Kind: chat.Think, Title: "thinking", Body: []string{"x"}})
	}
	if !strings.Contains(strings.ToLower(screen(m)), "3 thinking hidden") {
		t.Fatalf("collapsed count missing from the rule:\n%s", strings.Split(screen(m), "\n")[1])
	}
	press(t, m, "ctrl+e")
	if strings.Contains(strings.ToLower(screen(m)), "thinking hidden") {
		t.Fatal("with everything open there is nothing to advertise")
	}
}

func TestOpeningTheExplorerAlsoFocusesIt(t *testing.T) {
	// Toggling a pane and then having to reach for it is the extra step this
	// rebuild removes.
	m := fixture(t, 100, 30)
	press(t, m, "ctrl+t")
	if !m.ExplorerOpen() {
		t.Fatal("^t opens the explorer")
	}
	if m.Mode() != keymap.Browse {
		t.Fatalf("mode = %v; opening must also focus", m.Mode())
	}
	press(t, m, "ctrl+t")
	if m.ExplorerOpen() {
		t.Fatal("^t closes it again")
	}
	if m.Mode() != keymap.Insert {
		t.Fatal("closing returns to the prompt")
	}
}

func TestAClosedExplorerCostsNoColumns(t *testing.T) {
	m := fixture(t, 100, 30)
	before := body(screen(m))
	press(t, m, "ctrl+t")
	press(t, m, "ctrl+t")
	// The status line legitimately differs: it now says "explorer closed".
	// Everything above it must be identical.
	if body(screen(m)) != before {
		t.Fatalf("opening and closing changed the screen:\n%s\n---\n%s", before, body(screen(m)))
	}
}

func TestTheExplorerRefusesToRunInATerminalTooNarrowForBoth(t *testing.T) {
	m := fixture(t, 44, 20)
	press(t, m, "ctrl+t")
	if m.ExplorerOpen() {
		t.Fatal("the transcript is the application; the explorer is a convenience and yields")
	}
	if !strings.Contains(screen(m), "too narrow") {
		t.Fatalf("it must say why nothing happened:\n%s", lastLine(screen(m)))
	}
}

func TestChoosingAFilePutsItInThePrompt(t *testing.T) {
	m := fixture(t, 120, 30)
	press(t, m, "ctrl+t")
	// walk down to a file
	for i := 0; i < 6; i++ {
		if n := m.explorer.Current(); n != nil && !n.HasChildren() {
			break
		}
		press(t, m, "down")
	}
	press(t, m, "enter")
	if m.Mode() != keymap.Insert {
		t.Fatal("choosing a file hands the keys back to the prompt")
	}
	if !strings.Contains(screen(m), ".go") && !strings.Contains(screen(m), ".md") {
		t.Fatalf("the path did not reach the prompt:\n%s", screen(m))
	}
}

// --- queue and steer -----------------------------------------------------

func TestEnterQueuesWhileBusyAndSaysSo(t *testing.T) {
	m := fixture(t, 100, 30)
	m.working = true
	typeIn(t, m, "next thing")
	press(t, m, "enter")
	if len(m.prompt.Queued()) != 1 {
		t.Fatalf("queued %d", len(m.prompt.Queued()))
	}
	s := screen(m)
	if !strings.Contains(s, "queued") {
		t.Fatalf("the two enter keys mean different things; the status line must say which:\n%s", lastLine(s))
	}
	if !strings.Contains(s, "1· next thing") {
		t.Fatalf("a queued message must be visible under the prompt:\n%s", s)
	}
}

func TestABusyStatusLineNamesBothEnterKeys(t *testing.T) {
	m := fixture(t, 120, 30)
	m.working = true
	s := lastLine(screen(m))
	if !strings.Contains(s, "alt+enter") {
		t.Fatalf("steer is not advertised while busy: %q", s)
	}
}

// --- overlays ------------------------------------------------------------

func TestOverlaysAlwaysSayWhatTheyAreFor(t *testing.T) {
	for chord, want := range map[string]string{
		"ctrl+s": "every conversation pi has stored",
		"ctrl+m": "what Mnemo has remembered",
		"ctrl+l": "every run as a call graph",
		"ctrl+k": "every command, skill and plugin",
	} {
		m := fixture(t, 100, 30)
		press(t, m, chord)
		if !strings.Contains(screen(m), want) {
			t.Fatalf("%s does not state its purpose:\n%s", chord, screen(m))
		}
	}
}

func TestEmptyOverlaysSayWhatWouldFillThem(t *testing.T) {
	m := fixture(t, 100, 30)
	press(t, m, "ctrl+s")
	s := screen(m)
	if !strings.Contains(s, "written the first time you send a message") {
		t.Fatalf("an empty session list must name what fills it:\n%s", s)
	}
	if strings.Contains(s, "(none)") || strings.Contains(s, "(no episodes") {
		t.Fatalf("empty state is a parenthetical again:\n%s", s)
	}
}

func TestThePaletteFindsAnyBindingByName(t *testing.T) {
	m := fixture(t, 100, 30)
	press(t, m, "ctrl+k")
	typeIn(t, m, "explor")
	s := screen(m)
	if !strings.Contains(s, "/explorer") {
		t.Fatalf("the palette did not filter:\n%s", s)
	}
	press(t, m, "enter")
	if !m.ExplorerOpen() {
		t.Fatal("choosing a palette row must run it")
	}
}

func TestHelpIsGeneratedFromTheSameTableTheProgramDispatchesOn(t *testing.T) {
	m := fixture(t, 100, 40)
	press(t, m, "ctrl+h")
	s := screen(m)
	for _, want := range []string{"open every thinking block", "^e", "folder explorer", "^t"} {
		if !strings.Contains(s, want) {
			t.Fatalf("help is missing %q:\n%s", want, s)
		}
	}
}

// --- agent messages ------------------------------------------------------

func TestAToolResultLandsOnItsOwnCall(t *testing.T) {
	m := fixture(t, 100, 30)
	m.Update(agent.ToolStart{ID: "1", Name: "read", Args: "main.go"})
	m.Update(agent.ToolStart{ID: "2", Name: "bash", Args: "go test"})
	m.Update(agent.ToolEnd{ID: "1", Detail: "40 ln", OK: true})
	m.Update(agent.ToolEnd{ID: "2", Detail: "exit 1", OK: false})
	blocks := m.Chat().Blocks()
	last2 := blocks[len(blocks)-2:]
	if last2[0].Detail != "40 ln" || last2[0].State != chat.OK {
		t.Fatalf("first call got %+v", last2[0])
	}
	if last2[1].Detail != "exit 1" || last2[1].State != chat.Failed {
		t.Fatalf("second call got %+v", last2[1])
	}
}

func TestAResultWithNoCallIsStillShown(t *testing.T) {
	m := fixture(t, 100, 30)
	before := m.Chat().Len()
	m.Update(agent.ToolEnd{ID: "ghost", Detail: "exit 2", OK: false})
	if m.Chat().Len() != before+1 {
		t.Fatal("dropping an orphan result is how a failure becomes invisible")
	}
}

func TestSubAgentRunsNestUnderOneBlock(t *testing.T) {
	m := fixture(t, 100, 30)
	m.Update(agent.Delegated{Label: "probe-rpc", Model: "haiku", OK: true})
	m.Update(agent.Delegated{Label: "read-jsonl", Model: "haiku", OK: false})
	last := m.Chat().Last()
	if last.Kind != chat.Delegation || len(last.Children) != 2 {
		t.Fatalf("got %+v", last)
	}
	if last.Title != "2 sub-agents" {
		t.Fatalf("title = %q", last.Title)
	}
	if last.State != chat.Failed {
		t.Fatal("one failed child makes the group a failure; hiding that is the bug")
	}
}

func TestAQueuedMessageIsSentWhenTheTurnEnds(t *testing.T) {
	m := fixture(t, 100, 30)
	m.working = true
	typeIn(t, m, "later")
	press(t, m, "enter")
	if len(m.prompt.Queued()) != 1 {
		t.Fatal("expected one queued message")
	}
	m.Update(agent.Done{})
	if len(m.prompt.Queued()) != 0 {
		t.Fatal("a queued message is a promise; the turn ending must keep it")
	}
	if !strings.Contains(screen(m), "later") {
		t.Fatal("the queued message must appear in the transcript once sent")
	}
}

func TestAFailingBackendSaysSoInsteadOfPretendingToThink(t *testing.T) {
	m := fixture(t, 100, 30)
	typeIn(t, m, "hello")
	press(t, m, "enter")
	// Offline's Send returns the failure as a command; run it.
	m.Update(agent.Failed{Err: errString("no backend")})
	if !strings.Contains(screen(m), "no backend") {
		t.Fatalf("a backend failure must be visible:\n%s", screen(m))
	}
	if m.working {
		t.Fatal("a failed turn is not still working")
	}
}

// --- the still screen ----------------------------------------------------

func TestIdleIsAStillScreen(t *testing.T) {
	m := fixture(t, 100, 30)
	a := screen(m)
	m.Update(tickMsg{})
	m.Update(tickMsg{})
	if screen(m) != a {
		t.Fatal("a TUI that animates while nothing happens is burning a battery to look busy")
	}
	m.working = true
	b := screen(m)
	m.Update(tickMsg{})
	if screen(m) == b {
		t.Fatal("a working header must travel")
	}
}

func TestCtrlCInterruptsBeforeItQuits(t *testing.T) {
	m := fixture(t, 100, 30)
	m.working = true
	press(t, m, "ctrl+c")
	if m.working {
		t.Fatal("^c stops the agent")
	}
	if m.quitting {
		t.Fatal("^c must not quit while it still has an agent to stop")
	}
}

// --- read mode -----------------------------------------------------------

func TestReadModeHidesTheCursor(t *testing.T) {
	m := fixture(t, 100, 30)
	if m.View().Cursor == nil {
		t.Fatal("insert mode shows the cursor")
	}
	press(t, m, "esc")
	if m.View().Cursor != nil {
		t.Fatal("hiding the cursor is how you know typing will not go into the prompt")
	}
}

func TestBlockNavigationMovesByBlock(t *testing.T) {
	m := fixture(t, 100, 30)
	for i := 0; i < 4; i++ {
		m.Chat().Append(&chat.Block{Kind: chat.Think, Title: "thinking", Body: []string{"x"}})
	}
	press(t, m, "esc")
	press(t, m, "J")
	if m.Chat().Focus() != m.Chat().Len()-1 {
		t.Fatalf("focus = %d", m.Chat().Focus())
	}
	press(t, m, "K")
	press(t, m, "enter")
	if open, _ := m.Chat().CountOpen(chat.Think); open != 1 {
		t.Fatalf("enter folds exactly the focused block, %d opened", open)
	}
}

// body is the screen without its status line, for comparisons where a
// transient notice is expected to differ.
func body(s string) string {
	lines := strings.Split(s, "\n")
	return strings.Join(lines[:len(lines)-1], "\n")
}

func lastLine(s string) string {
	lines := strings.Split(s, "\n")
	return lines[len(lines)-1]
}

type errString string

func (e errString) Error() string { return string(e) }

func TestATurnThatEndsLeavesNoSpinnerBehind(t *testing.T) {
	// A spinner nobody stops is a UI that looks hung.
	m := fixture(t, 100, 30)
	m.Update(agent.ToolStart{ID: "1", Name: "bash", Args: "go test"})
	m.Update(agent.Think{Text: "hmm"})
	m.Update(agent.Done{})
	for _, b := range m.Chat().Blocks() {
		if b.State == chat.Running {
			t.Fatalf("block %q is still running after the turn ended", b.Title)
		}
	}
}

func TestAToolStillOpenWhenTheTurnEndsIsMarkedFailedNotOk(t *testing.T) {
	m := fixture(t, 100, 30)
	m.Update(agent.ToolStart{ID: "1", Name: "bash", Args: "go test"})
	m.Update(agent.Done{})
	last := m.Chat().Blocks()[m.Chat().Len()-1]
	if last.State != chat.Failed || last.Detail != "no result" {
		t.Fatalf("a call that never reported back must say so, got %+v", last)
	}
}

func TestInterruptingAlsoStopsTheSpinners(t *testing.T) {
	m := fixture(t, 100, 30)
	m.working = true
	m.Update(agent.ToolStart{ID: "1", Name: "bash"})
	press(t, m, "ctrl+c")
	for _, b := range m.Chat().Blocks() {
		if b.State == chat.Running {
			t.Fatal("interrupting must settle the transcript too")
		}
	}
}

// --- slash commands ------------------------------------------------------

func TestTypingASlashOpensTheMenu(t *testing.T) {
	m := fixture(t, 100, 30)
	press(t, m, "/")
	s := screen(m)
	if !strings.Contains(s, "/sessions") {
		t.Fatalf("the slash menu did not open:\n%s", s)
	}
	if !strings.Contains(s, "↑ ↓ pick") {
		t.Fatal("an unlabelled list gives no reason to reach for the arrow keys")
	}
}

func TestTheMenuNarrowsAsYouType(t *testing.T) {
	m := fixture(t, 100, 30)
	typeIn(t, m, "/mem")
	s := screen(m)
	if !strings.Contains(s, "/memory") {
		t.Fatalf("expected /memory:\n%s", s)
	}
	if strings.Contains(s, "/sessions") {
		t.Fatalf("the menu did not narrow:\n%s", s)
	}
}

func TestArrowsPickFromTheMenuInsteadOfBrowsingHistory(t *testing.T) {
	m := fixture(t, 100, 30)
	press(t, m, "/")
	before := m.prompt.SugIndex()
	press(t, m, "down")
	if m.prompt.SugIndex() == before {
		t.Fatal("↓ must move the selection while the menu is open")
	}
	press(t, m, "up")
	if m.prompt.SugIndex() != before {
		t.Fatal("↑ must move it back")
	}
}

func TestTabCompletesAndEnterRuns(t *testing.T) {
	m := fixture(t, 100, 30)
	typeIn(t, m, "/expl")
	press(t, m, "tab")
	if got := m.prompt.Value(); got != "/explorer " {
		t.Fatalf("tab should complete the name and leave room for arguments, got %q", got)
	}
	typeIn(t, m, "/expl")
	press(t, m, "enter")
	if !m.ExplorerOpen() {
		t.Fatal("enter on a highlighted command must run it")
	}
}

func TestEscClosesTheMenuWithoutLeavingTheProrompt(t *testing.T) {
	m := fixture(t, 100, 30)
	press(t, m, "/")
	press(t, m, "esc")
	if m.prompt.MenuOpen() {
		t.Fatal("esc must close the menu")
	}
	if m.Mode() != keymap.Insert {
		t.Fatal("the first esc closes the menu; it does not also leave the prompt")
	}
}

func TestTheMenuClosesOnceArgumentsStart(t *testing.T) {
	// After the name, what follows is arguments; a menu still filtering on
	// them would be filtering on the wrong thing.
	m := fixture(t, 100, 30)
	typeIn(t, m, "/memory ")
	if m.prompt.MenuOpen() {
		t.Fatal("a space ends the name")
	}
}

func TestAnUnknownSlashCommandIsRefusedNotSentAsProse(t *testing.T) {
	m := fixture(t, 100, 30)
	typeIn(t, m, "/nosuchthing x")
	press(t, m, "enter")
	if !strings.Contains(screen(m), "no command called /nosuchthing") {
		t.Fatalf("it must say so:\n%s", lastLine(screen(m)))
	}
	if m.Chat().Len() != 1 {
		t.Fatal("an unknown command must not reach the model as a question about a slash")
	}
}

func TestASkillBecomesAPromptThatNamesItsFile(t *testing.T) {
	m := fixture(t, 120, 30)
	dir := filepath.Join(m.CWD(), ".claude", "skills", "tidy")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"),
		[]byte("---\nname: tidy\ndescription: clean up\n---\nbody\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Rebuild so the new skill is discovered the way a fresh start would.
	m2 := New(Config{Home: m.Home(), CWD: m.CWD(), Dark: true, Agent: agent.Offline{Reason: "test"}})
	m2.Resize(120, 30)
	found := false
	for _, c := range m2.Commands() {
		if c.Name == "tidy" {
			found = true
		}
	}
	if !found {
		t.Fatal("a SKILL.md in the project must be reachable as a slash command")
	}
	typeIn(t, m2, "/tidy the imports")
	press(t, m2, "enter")
	got := screen(m2)
	if !strings.Contains(got, "SKILL.md") {
		t.Fatalf("the prompt must name the file so the agent can read it:\n%s", got)
	}
	if !strings.Contains(got, "the imports") {
		t.Fatalf("arguments must survive:\n%s", got)
	}
}

// --- navigation ----------------------------------------------------------

func TestTabWalksTheThreeSurfaces(t *testing.T) {
	// One unmodified key that always moves to the next thing is what makes
	// this navigable without memorising anything.
	m := fixture(t, 120, 30)
	press(t, m, "ctrl+t") // explorer open, and focused
	press(t, m, "tab")
	if m.Mode() != keymap.Insert {
		t.Fatalf("tab from the explorer returns to the prompt, got %v", m.Mode())
	}
	press(t, m, "tab")
	if m.Mode() != keymap.Read {
		t.Fatalf("then the transcript, got %v", m.Mode())
	}
	press(t, m, "tab")
	if m.Mode() != keymap.Browse {
		t.Fatalf("then the explorer, got %v", m.Mode())
	}
	press(t, m, "shift+tab")
	if m.Mode() != keymap.Read {
		t.Fatalf("shift+tab goes the other way, got %v", m.Mode())
	}
}

func TestTabSkipsTheExplorerWhenItIsClosed(t *testing.T) {
	m := fixture(t, 120, 30)
	press(t, m, "tab")
	press(t, m, "tab")
	if m.Mode() != keymap.Insert {
		t.Fatalf("with no explorer there are two stops, got %v", m.Mode())
	}
}

func TestArrowsMeanTheSameThingEverywhere(t *testing.T) {
	// ↑ ↓ move, → opens, ← closes — in the transcript and in every tree.
	m := fixture(t, 120, 30)
	for i := 0; i < 3; i++ {
		m.Chat().Append(&chat.Block{Kind: chat.Think, Title: "thinking", Body: []string{"x"}})
	}
	press(t, m, "esc") // read mode
	press(t, m, "up")
	if m.Chat().Focus() < 0 {
		t.Fatal("↑ must move by block")
	}
	press(t, m, "right")
	if b := m.Chat().Focused(); b == nil || !b.Open {
		t.Fatal("→ must open the focused block")
	}
	press(t, m, "left")
	if b := m.Chat().Focused(); b == nil || b.Open {
		t.Fatal("← must close it")
	}
}

func TestArrowsMoveInTheExplorerToo(t *testing.T) {
	m := fixture(t, 120, 30)
	press(t, m, "ctrl+t")
	before := m.explorer.Cursor()
	press(t, m, "down")
	if m.explorer.Cursor() == before {
		t.Fatal("↓ must move in the explorer")
	}
}

// --- space ---------------------------------------------------------------

func TestTheScreenHasAMarginAndBreathingRoom(t *testing.T) {
	m := fixture(t, 100, 30)
	lines := strings.Split(screen(m), "\n")
	for i, l := range lines {
		if strings.TrimSpace(l) == "" {
			continue
		}
		if !strings.HasPrefix(l, "  ") {
			t.Fatalf("row %d starts at column 0: %q — the glyphs sit against the window frame", i, l)
		}
	}
	if strings.TrimSpace(lines[1]) != "" {
		t.Fatalf("expected a blank row under the header, got %q", lines[1])
	}
}

func TestTheMarginShrinksRatherThanEatingANarrowScreen(t *testing.T) {
	// At forty columns, two spent on each side is a tenth of the screen.
	wide := fixture(t, 100, 30)
	narrow := fixture(t, 30, 20)
	if !strings.HasPrefix(strings.Split(screen(wide), "\n")[0], "  ") {
		t.Fatal("a wide screen gets the full margin")
	}
	if strings.HasPrefix(strings.Split(screen(narrow), "\n")[0], " ") {
		t.Fatal("a narrow screen gives its columns to content")
	}
}

func TestAShortTerminalDropsTheAirBeforeTheContent(t *testing.T) {
	m := fixture(t, 100, 12)
	lines := strings.Split(screen(m), "\n")
	if strings.TrimSpace(lines[1]) == "" {
		t.Fatal("air is worth less than a line of transcript; below 18 rows it goes")
	}
	if len(lines) != 12 {
		t.Fatalf("drew %d rows", len(lines))
	}
}

func TestAStreamedMessageIsNotBrokenAtChunkBoundaries(t *testing.T) {
	// A delta is a slice of a continuous stream, so its first part always
	// continues the line in progress. Keying that off whether the chunk ends
	// in a newline broke a word wherever a boundary fell, and "**Code" and
	// " work**" arrived as two lines with the heading cut in half.
	m := fixture(t, 100, 30)
	for _, chunk := range []string{"Here is ", "**Code", " work**\n", "- one thing\n", "and ref", "actor.\n"} {
		m.Update(agent.Text{Text: chunk})
	}
	body := strings.Join(m.Chat().Last().Body, "\n")
	if !strings.Contains(body, "**Code work**") {
		t.Fatalf("a heading was cut in half:\n%q", body)
	}
	if !strings.Contains(body, "and refactor.") {
		t.Fatalf("a word was split:\n%q", body)
	}
}

func TestTheAgentsMarkdownIsRenderedOnScreen(t *testing.T) {
	m := fixture(t, 100, 30)
	m.Update(agent.Text{Text: "**Code work**\n- edit `main.go`\n"})
	got := screen(m)
	if strings.Contains(got, "**") {
		t.Fatalf("asterisks reached the screen:\n%s", got)
	}
	if !strings.Contains(got, "Code work") {
		t.Fatalf("the heading did not:\n%s", got)
	}
}

func TestAnIdleHeaderIsAHairlineNotABand(t *testing.T) {
	// A full-width block of texture at rest reads as an alert bar: the eye
	// takes a solid stripe of colour as something to attend to.
	// Wide, because the fixture's working directory is a long temp path and a
	// header with no room left renders no texture at all — correctly.
	m := fixture(t, 200, 30)
	head := strings.Split(screen(m), "\n")[0]
	if strings.Contains(head, "░") {
		t.Fatalf("the idle header is still a band: %q", head)
	}
	if !strings.Contains(head, "─") {
		t.Fatalf("the idle header lost its rule: %q", head)
	}
	m.working = true
	m.Update(tickMsg{})
	if !strings.ContainsAny(strings.Split(screen(m), "\n")[0], "░▒▓█") {
		t.Fatal("a working header must show the ramp")
	}
}

func TestFindIsRealAndNotJustABinding(t *testing.T) {
	// ^f was documented in the key map and did nothing, which is the same
	// failure as a pane called "Agents" that listed sessions: the interface
	// promising something it does not do.
	m := fixture(t, 100, 30)
	m.Chat().Append(&chat.Block{Kind: chat.Agent, Body: []string{"the parser lives in internal/pi"}})
	press(t, m, "ctrl+f")
	typeIn(t, m, "parser")
	s := lastLine(screen(m))
	if !strings.Contains(s, "/parser") {
		t.Fatalf("the query must be visible to be correctable: %q", s)
	}
	if !strings.Contains(s, "1 of 1") {
		t.Fatalf("the count is what tells you the word is in here: %q", s)
	}
}

func TestSearchSaysWhenThereIsNothing(t *testing.T) {
	m := fixture(t, 100, 30)
	press(t, m, "ctrl+f")
	typeIn(t, m, "zzzqqq")
	if !strings.Contains(lastLine(screen(m)), "no matches") {
		t.Fatalf("silence is not an answer: %q", lastLine(screen(m)))
	}
}

func TestEscapeAbandonsTheSearchAndItsMarks(t *testing.T) {
	m := fixture(t, 100, 30)
	press(t, m, "ctrl+f")
	typeIn(t, m, "ready")
	press(t, m, "esc")
	if m.Chat().Query() != "" {
		t.Fatal("esc must clear the query, or the transcript stays annotated")
	}
	if strings.Contains(lastLine(screen(m)), "/ready") {
		t.Fatalf("the search line is still up: %q", lastLine(screen(m)))
	}
}

func TestEnterKeepsTheResultsAndHandsBackNAndBigN(t *testing.T) {
	m := fixture(t, 100, 30)
	for i := 0; i < 3; i++ {
		m.Chat().Append(&chat.Block{Kind: chat.Agent, Body: []string{"needle here"}})
	}
	press(t, m, "ctrl+f")
	typeIn(t, m, "needle")
	press(t, m, "enter")
	if m.Chat().Query() != "needle" {
		t.Fatal("enter keeps the query so n and N have something to step through")
	}
	before, _ := m.Chat().SearchAt()
	press(t, m, "n")
	after, _ := m.Chat().SearchAt()
	if after == before {
		t.Fatal("n must step to the next match once the search line is dismissed")
	}
	if !strings.Contains(lastLine(screen(m)), "n · N") {
		t.Fatalf("the row must advertise the keys that are now live: %q", lastLine(screen(m)))
	}
}

func TestBackspaceOnAnEmptyQueryLeavesSearch(t *testing.T) {
	m := fixture(t, 100, 30)
	press(t, m, "ctrl+f")
	press(t, m, "backspace")
	if strings.Contains(lastLine(screen(m)), "type to search") {
		t.Fatal("backspacing past the start is how you back out without reaching for esc")
	}
}

func TestSearchOwnsPrintableKeysWhileItIsUp(t *testing.T) {
	// "n" is next-match in read mode. While the query line has the keys it
	// has to be a letter, or you cannot search for anything with an n in it.
	m := fixture(t, 100, 30)
	m.Chat().Append(&chat.Block{Kind: chat.Agent, Body: []string{"navigation"}})
	press(t, m, "ctrl+f")
	typeIn(t, m, "nav")
	if m.Chat().Query() != "nav" {
		t.Fatalf("query = %q; a movement key ate a letter", m.Chat().Query())
	}
}

func TestForgettingAMemoryAsksFirst(t *testing.T) {
	// Forgetting appends a tombstone and there is no key that puts it back.
	// It is the only irreversible thing here, so it is the only thing that
	// asks.
	m := fixture(t, 100, 30)
	m.ov = overlay.NewTree(overlay.Memory, "purpose", []*tree.Node{
		{ID: "area:semantic", Label: "semantic", Expanded: true, Children: []*tree.Node{
			{ID: "7", Label: "the parser lives in internal/pi"},
		}},
	})
	press(t, m, "down") // onto the memory itself
	press(t, m, "d")
	s := lastLine(screen(m))
	if !strings.Contains(s, "cannot be undone") {
		t.Fatalf("the question must say what is at stake: %q", s)
	}
	if !strings.Contains(s, "the parser lives") {
		t.Fatalf("it must name what it is about to remove: %q", s)
	}
}

func TestAnythingButYesIsNo(t *testing.T) {
	// A destructive action must never be reachable by a keystroke you did not
	// mean.
	for _, answer := range []string{"n", "q", "esc", "enter", "j"} {
		m := fixture(t, 100, 30)
		m.ov = overlay.NewTree(overlay.Memory, "purpose", []*tree.Node{{ID: "7", Label: "a memory"}})
		press(t, m, "d")
		if m.confirm == nil {
			t.Fatal("expected a pending question")
		}
		press(t, m, answer)
		if m.confirm != nil {
			t.Fatalf("%q left the question hanging", answer)
		}
		if !strings.Contains(lastLine(screen(m)), "left alone") {
			t.Fatalf("%q should have declined: %q", answer, lastLine(screen(m)))
		}
	}
}

func TestAPendingQuestionOwnsTheKeyboard(t *testing.T) {
	// A question that a global chord can walk past is a question that gets
	// answered by accident.
	m := fixture(t, 100, 30)
	m.ov = overlay.NewTree(overlay.Memory, "purpose", []*tree.Node{{ID: "7", Label: "a memory"}})
	press(t, m, "d")
	press(t, m, "ctrl+t") // would normally open the explorer
	if m.ExplorerOpen() {
		t.Fatal("a global chord stepped over a pending confirmation")
	}
}

func TestForgetIsRefusedOnABrainArea(t *testing.T) {
	// Areas are headings. Offering to forget one is offering to delete a
	// category that never existed as a thing.
	m := fixture(t, 100, 30)
	m.ov = overlay.NewTree(overlay.Memory, "purpose", []*tree.Node{
		{ID: "area:semantic", Label: "semantic", Children: []*tree.Node{{ID: "7", Label: "x"}}},
	})
	press(t, m, "d")
	if m.confirm != nil {
		t.Fatal("an area must not be offered for deletion")
	}
	if !strings.Contains(lastLine(screen(m)), "brain area") {
		t.Fatalf("it must say why: %q", lastLine(screen(m)))
	}
}

func TestForgetIsOnlyOfferedInMemory(t *testing.T) {
	// Binding it globally would put a destructive key one slip away in every
	// list.
	m := fixture(t, 100, 30)
	press(t, m, "ctrl+s") // sessions
	press(t, m, "d")
	if m.confirm != nil {
		t.Fatal("d is a destructive key and must not be live outside memory")
	}
}

func TestTheForgetKeyIsAdvertisedWhereItWorks(t *testing.T) {
	m := fixture(t, 120, 30)
	m.ov = overlay.NewTree(overlay.Memory, "purpose", []*tree.Node{{ID: "7", Label: "a memory"}})
	if !strings.Contains(lastLine(screen(m)), "forget") {
		t.Fatalf("a destructive key nobody is told about is one somebody eventually hits by accident: %q",
			lastLine(screen(m)))
	}
}

func TestAnOverlayFloatsOverTheTranscript(t *testing.T) {
	// An overlay that replaces the body throws away the thing you opened it
	// to act on: you pick a session while looking at a blank screen.
	m := fixture(t, 110, 30)
	m.Chat().Append(&chat.Block{Kind: chat.User, Body: []string{"unmistakable"}})
	press(t, m, "ctrl+s")
	s := screen(m)
	if !strings.Contains(s, "unmistakable") {
		t.Fatalf("the transcript vanished behind the overlay:\n%s", s)
	}
	if !strings.Contains(s, "SESSIONS") {
		t.Fatalf("the overlay is missing:\n%s", s)
	}
	if !strings.Contains(s, "╭") || !strings.Contains(s, "╰") {
		t.Fatal("a floating panel needs a border, or it reads as text spilled over text")
	}
}

func TestTheRegionRuleSurvivesAnOverlay(t *testing.T) {
	m := fixture(t, 110, 30)
	press(t, m, "ctrl+k")
	if !strings.Contains(screen(m), "TRANSCRIPT") {
		t.Fatal("the transcript is still there, so its label still applies")
	}
}

func TestOverlaysNeverOverflowAnySize(t *testing.T) {
	for _, wh := range [][2]int{{40, 12}, {60, 16}, {80, 24}, {100, 30}, {200, 60}} {
		for _, chord := range []string{"ctrl+k", "ctrl+s", "ctrl+m", "ctrl+l", "ctrl+h"} {
			m := fixture(t, wh[0], wh[1])
			press(t, m, chord)
			lines := strings.Split(screen(m), "\n")
			if len(lines) != wh[1] {
				t.Fatalf("%s at %dx%d drew %d rows", chord, wh[0], wh[1], len(lines))
			}
			for i, l := range lines {
				if got := ansi.StringWidth(l); got > wh[0] {
					t.Fatalf("%s at %dx%d: row %d is %d cells", chord, wh[0], wh[1], i, got)
				}
			}
		}
	}
}

func TestThePaletteDoesNotAnswerAShortQueryWithEverything(t *testing.T) {
	// A subsequence over a DESCRIPTION matches almost anything: "fol" found
	// skills whose prose happened to contain an f, an o and an l thirty words
	// apart, so a three-letter query returned the whole list.
	m := fixture(t, 110, 30)
	press(t, m, "ctrl+k")
	all := m.Overlay().Count()
	typeIn(t, m, "fol")
	got := m.Overlay().Count()
	if got == 0 {
		t.Fatal("the folder explorer should still be found by its description")
	}
	if got > all/4 {
		t.Fatalf("filtering to %d of %d is not filtering", got, all)
	}
}

func TestNamesStillMatchByTheirInitials(t *testing.T) {
	// The other half of the trade: a short name must stay a subsequence
	// match, or you have to type it exactly.
	m := fixture(t, 110, 30)
	press(t, m, "ctrl+k")
	typeIn(t, m, "sess")
	if _, ok := m.Overlay().Selected(); !ok {
		t.Fatal("sess should find /sessions")
	}
}

// --- accounts and models --------------------------------------------------

// stubAgent is a real backends' shape without the process: not agent.Offline,
// so first-run detection sees a live agent, and every method is the offline
// stub because nothing here talks to it.
type stubAgent struct{ agent.Offline }

var _ agent.Agent = stubAgent{}

func TestAFreshHomeSaysSetupIsMissing(t *testing.T) {
	m := fixture(t, 100, 30)
	if !strings.Contains(screen(m), "nothing is set up yet") {
		t.Fatalf("a first run must say so:\n%s", screen(m))
	}
}

func TestAConfiguredHomeDoesNotMentionSetup(t *testing.T) {
	home := t.TempDir()
	if _, err := auth.SetKey(home, "anthropic", "sk-ant-test-key-1234", "claude-x", time.Now()); err != nil {
		t.Fatal(err)
	}
	m := New(Config{Home: home, CWD: t.TempDir(), Dark: true, Agent: agent.Offline{Reason: "test"}})
	m.Resize(100, 30)
	if strings.Contains(screen(m), "nothing is set up yet") {
		t.Fatalf("a configured home is not a first run:\n%s", screen(m))
	}
}

func TestFirstRunWithALiveAgentOpensTheAccountsList(t *testing.T) {
	m := New(Config{Home: t.TempDir(), CWD: t.TempDir(), Dark: true, Agent: stubAgent{}})
	m.Resize(100, 30)
	if m.Overlay() == nil || m.Overlay().Kind != overlay.Login {
		t.Fatalf("first run with a real backend should open the accounts list, got %v", m.Overlay())
	}
	press(t, m, "esc")
	if m.Overlay() != nil {
		t.Fatal("the accounts list is an overlay like every other: esc dismisses it")
	}
	if !strings.Contains(screen(m), "/login logs in a provider") {
		t.Fatal("the hint must survive dismissal, so the way back is findable")
	}
}

func TestAnOfflineAgentNeverStealsTheFirstFrame(t *testing.T) {
	m := fixture(t, 100, 30)
	if m.Overlay() != nil {
		t.Fatalf("an offline/--dump run must not open a wizard nobody asked for: %v", m.Overlay())
	}
}

func TestLoginOverlayListsEveryProviderAndTheirState(t *testing.T) {
	m := fixture(t, 100, 30)
	press(t, m, "/")
	typeIn(t, m, "login")
	press(t, m, "enter")
	if m.Overlay() == nil || m.Overlay().Kind != overlay.Login {
		t.Fatalf("expected the login overlay, got %v", m.Overlay())
	}
	s := screen(m)
	for _, p := range []string{"anthropic", "openai", "openrouter", "opencode", "opencode-go"} {
		if !strings.Contains(s, p) {
			t.Fatalf("every provider must be listed, missing %q:\n%s", p, s)
		}
	}
	if !strings.Contains(s, "not set up") {
		t.Fatalf("a fresh home must say nothing is set up:\n%s", s)
	}
	press(t, m, "esc")
	if m.Overlay() != nil {
		t.Fatal("esc must close the login overlay")
	}
}

func TestChoosingAProviderHandsThePromptBackForTheKey(t *testing.T) {
	m := fixture(t, 100, 30)
	press(t, m, "/")
	typeIn(t, m, "login")
	press(t, m, "enter")
	press(t, m, "enter") // anthropic is first
	if m.Overlay() != nil {
		t.Fatal("choosing a provider must close the list")
	}
	if got := m.prompt.Value(); got != "/login anthropic " {
		t.Fatalf("the prompt should be armed with the login, got %q", got)
	}
	if !strings.Contains(screen(m), "paste the key after the provider") {
		t.Fatalf("it must say what to do next:\n%s", screen(m))
	}
}

func TestTypingACredentialLogsInAndWritesTheStore(t *testing.T) {
	m := fixture(t, 100, 30)
	typeIn(t, m, "/login openrouter sk-or-test-key-1234")
	press(t, m, "enter")
	if !strings.Contains(screen(m), "logged in to openrouter") {
		t.Fatalf("login must say so:\n%s", screen(m))
	}
	f := auth.Load(m.Home())
	if !f.Configured() || f.EffectiveProvider() != "openrouter" {
		t.Fatalf("the store under the temp home must hold the login, got %+v", f)
	}
	if _, err := os.Stat(filepath.Join(m.Home(), ".mnemo", "auth.json")); err != nil {
		t.Fatalf("auth.json should exist on disk: %v", err)
	}
}

func TestAShortKeyIsRefusedAndNothingIsWritten(t *testing.T) {
	m := fixture(t, 100, 30)
	typeIn(t, m, "/login openrouter short")
	press(t, m, "enter")
	if !strings.Contains(screen(m), "too short") {
		t.Fatalf("the refusal must be shown, not swallowed:\n%s", screen(m))
	}
	if auth.Load(m.Home()).Configured() {
		t.Fatal("a refused paste must not half-write the store")
	}
}

func TestLogoutWithoutAProviderNamesOne(t *testing.T) {
	m := fixture(t, 100, 30)
	typeIn(t, m, "/logout")
	press(t, m, "enter")
	if !strings.Contains(screen(m), "which provider?") {
		t.Fatalf("it must say what is missing:\n%s", screen(m))
	}
}

func TestLogoutAsksBeforeForgettingAndYRemovesTheKey(t *testing.T) {
	m := fixture(t, 100, 30)
	if _, err := auth.SetKey(m.Home(), "anthropic", "sk-ant-test-key-1234", "", time.Now()); err != nil {
		t.Fatal(err)
	}
	typeIn(t, m, "/logout anthropic")
	press(t, m, "enter")
	if !strings.Contains(screen(m), "log out of anthropic?") {
		t.Fatalf("forgetting a credential must ask first:\n%s", screen(m))
	}
	if !auth.Load(m.Home()).Configured() {
		t.Fatal("nothing may be removed before the explicit yes")
	}
	press(t, m, "y")
	if auth.Load(m.Home()).Configured() {
		t.Fatal("y must remove the key")
	}
}

func TestTheLoginListDKeyLogsOutWithConfirmation(t *testing.T) {
	m := fixture(t, 100, 30)
	if _, err := auth.SetKey(m.Home(), "openai", "sk-oa-test-key-1234", "gpt-x", time.Now()); err != nil {
		t.Fatal(err)
	}
	press(t, m, "/")
	typeIn(t, m, "login")
	press(t, m, "enter")
	press(t, m, "down") // anthropic → openai
	press(t, m, "d")
	if m.confirm == nil || !strings.Contains(screen(m), "log out of openai") {
		t.Fatalf("d on the login list must ask first:\n%s", screen(m))
	}
	if !auth.Load(m.Home()).Configured() {
		t.Fatal("the key must survive until the yes")
	}
	press(t, m, "y")
	if auth.Load(m.Home()).Configured() {
		t.Fatal("y must log it out")
	}
}

func TestModelOverlayExplainsWhenItCannotAsk(t *testing.T) {
	m := fixture(t, 100, 30)
	press(t, m, "/")
	typeIn(t, m, "model")
	press(t, m, "enter")
	if m.Overlay() == nil || m.Overlay().Kind != overlay.Models {
		t.Fatalf("expected the models overlay, got %v", m.Overlay())
	}
	m.Update(modelsMsg{err: errors.New("no repository configured — start with --repo to list models")})
	s := screen(m)
	if !strings.Contains(s, "Could not ask the agent for the catalogue.") {
		t.Fatalf("a failed question must not look like an empty account:\n%s", s)
	}
	if !strings.Contains(s, "start with --repo") {
		t.Fatalf("the concrete fix must be on screen:\n%s", s)
	}
}

func TestTheModelListArrivesAndMarksTheCurrentDefault(t *testing.T) {
	m := fixture(t, 100, 30)
	if _, err := auth.SetKey(m.Home(), "opencode-go", "sk-oc-test-key-1234", "deepseek-v4-flash", time.Now()); err != nil {
		t.Fatal(err)
	}
	press(t, m, "/")
	typeIn(t, m, "model")
	press(t, m, "enter")
	m.Update(modelsMsg{models: []auth.Model{
		{Provider: "opencode-go", Name: "deepseek-v4-flash"},
		{Provider: "opencode-go", Name: "kimi"},
	}, err: nil})
	s := screen(m)
	if !strings.Contains(s, "deepseek-v4-flash") || !strings.Contains(s, "current") {
		t.Fatalf("the row already in use must be marked:\n%s", s)
	}
}

func TestChoosingAModelWritesItAsTheProviderDefault(t *testing.T) {
	m := fixture(t, 100, 30)
	if _, err := auth.SetKey(m.Home(), "opencode-go", "sk-oc-test-key-1234", "", time.Now()); err != nil {
		t.Fatal(err)
	}
	press(t, m, "/")
	typeIn(t, m, "model")
	press(t, m, "enter")
	m.Update(modelsMsg{models: []auth.Model{
		{Provider: "opencode-go", Name: "deepseek-v4-flash"},
		{Provider: "opencode-go", Name: "kimi"},
	}, err: nil})
	press(t, m, "down") // deepseek-v4-flash → kimi
	press(t, m, "enter")
	if got := auth.Load(m.Home()).DefaultModelFor("opencode-go"); got != "kimi" {
		t.Fatalf("default model = %q, want kimi", got)
	}
	if !strings.Contains(screen(m), "picked opencode-go/kimi") {
		t.Fatalf("choosing a model must say what happened:\n%s", screen(m))
	}
}

func TestAModelCatalogueThatArrivesAfterTheOverlayClosedIsIgnored(t *testing.T) {
	m := fixture(t, 100, 30)
	press(t, m, "/")
	typeIn(t, m, "model")
	press(t, m, "enter")
	press(t, m, "esc") // moved on before the list landed
	m.Update(modelsMsg{models: []auth.Model{{Provider: "opencode-go", Name: "deepseek-v4-flash"}}})
	if m.Overlay() != nil {
		t.Fatal("a late catalogue must not yank the reader back into a list they closed")
	}
}

func TestModelOnlyMakesSenseForALoggedInProvider(t *testing.T) {
	// Greenfield: /model with nothing logged in still explains itself instead
	// of pretending there is nothing to see. The overlay's empty state names
	// the missing step.
	m := fixture(t, 100, 30)
	press(t, m, "/")
	typeIn(t, m, "model")
	press(t, m, "enter")
	m.Update(modelsMsg{models: nil, err: nil})
	if !strings.Contains(screen(m), "Log in to a provider first: /login") {
		t.Fatalf("an empty catalogue must say what fills it:\n%s", screen(m))
	}
}

// --- the login wizard: provider → key → model -----------------------------

func TestLoggingInFlowsIntoTheModelStepOfTheWizard(t *testing.T) {
	m := fixture(t, 100, 30)
	typeIn(t, m, "/login opencode-go sk-oc-test-key-1234")
	press(t, m, "enter")
	if m.Overlay() == nil || m.Overlay().Kind != overlay.Models {
		t.Fatalf("the key is in, so the model step must follow, got %v", m.Overlay())
	}
	if !strings.Contains(screen(m), "now pick its default model") {
		t.Fatalf("the notice must say what is next:\n%s", screen(m))
	}
	// The catalogue arrives; the wizard only pictures the provider just
	// logged in, because a model another provider offers cannot be served by
	// the key that was just pasted.
	m.Update(modelsMsg{provider: "opencode-go", models: []auth.Model{
		{Provider: "opencode-go", Name: "deepseek-v4-flash"},
		{Provider: "opencode-go", Name: "kimi"},
		{Provider: "anthropic", Name: "claude-x"},
	}, err: nil})
	s := screen(m)
	if !strings.Contains(s, "deepseek-v4-flash") || !strings.Contains(s, "kimi") {
		t.Fatalf("the provider's own models must be listed:\n%s", s)
	}
	if strings.Contains(s, "claude-x") {
		t.Fatalf("another provider's model must not be offered during a login:\n%s", s)
	}
	press(t, m, "enter") // deepseek-v4-flash is first
	f := auth.Load(m.Home())
	if f.DefaultProvider != "opencode-go" || f.DefaultModelFor("opencode-go") != "deepseek-v4-flash" {
		t.Fatalf("provider → key → model must land on the canonical pair, got %+v", f)
	}
	if !strings.Contains(screen(m), "default model is now deepseek-v4-flash") {
		t.Fatalf("the wizard must confirm the pick:\n%s", screen(m))
	}
}

func TestTheWizardFallsBackToTheCanonicalDefaultWithoutACatalogue(t *testing.T) {
	// No --repo means no agent to ask; first run must still finish. Enter on
	// the failed model step writes this build's canonical default.
	m := fixture(t, 100, 30)
	typeIn(t, m, "/login opencode-go sk-oc-test-key-1234")
	press(t, m, "enter")
	m.Update(modelsMsg{provider: "opencode-go", err: errors.New("no repository configured")})
	if !strings.Contains(screen(m), "Could not ask the agent for the catalogue.") {
		t.Fatalf("the failure must be named:\n%s", screen(m))
	}
	press(t, m, "enter") // nothing selected, nothing typed
	f := auth.Load(m.Home())
	if f.DefaultProvider != "opencode-go" || f.DefaultModelFor("opencode-go") != "deepseek-v4-flash" {
		t.Fatalf("enter on empty must keep the build default, got %+v", f)
	}
}

func TestTheWizardDoesNotStealAnotherProvidersDefault(t *testing.T) {
	// Picking a model while setting up a SECOND provider must not silently
	// repoint which account new sessions use — the first login already
	// earned that spot, and the key pasted now does not ask for it.
	m := fixture(t, 100, 30)
	if _, err := auth.SetKey(m.Home(), "openrouter", "sk-or-test-key-1234", "", time.Now()); err != nil {
		t.Fatal(err)
	}
	typeIn(t, m, "/login opencode-go sk-oc-test-key-1234")
	press(t, m, "enter")
	m.Update(modelsMsg{provider: "opencode-go", models: []auth.Model{
		{Provider: "opencode-go", Name: "deepseek-v4-flash"},
		{Provider: "opencode-go", Name: "kimi"},
	}, err: nil})
	press(t, m, "down")
	press(t, m, "enter") // pick kimi
	f := auth.Load(m.Home())
	if f.DefaultProvider != "openrouter" {
		t.Fatalf("the wizard must not steal the default, got %q", f.DefaultProvider)
	}
	if f.DefaultModelFor("opencode-go") != "kimi" {
		t.Fatalf("the model itself must still be remembered, got %+v", f.DefaultModelFor("opencode-go"))
	}
}

func TestAModelPickFromModelSwitchesTheAccount(t *testing.T) {
	// /model is the deliberate surface: picking a row there means "run new
	// sessions on this provider with this model", unlike the wizard.
	m := fixture(t, 100, 30)
	if _, err := auth.SetKey(m.Home(), "openrouter", "sk-or-test-key-1234", "", time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := auth.SetKey(m.Home(), "opencode-go", "sk-oc-test-key-1234", "", time.Now()); err != nil {
		t.Fatal(err)
	}
	press(t, m, "/")
	typeIn(t, m, "model")
	press(t, m, "enter")
	m.Update(modelsMsg{models: []auth.Model{
		{Provider: "openrouter", Name: "deepseek-r1"},
		{Provider: "opencode-go", Name: "deepseek-v4-flash"},
	}, err: nil})
	press(t, m, "down")
	press(t, m, "enter") // opencode-go/deepseek-v4-flash
	f := auth.Load(m.Home())
	if f.DefaultProvider != "opencode-go" {
		t.Fatalf("picking a model from /model must move the account there, got %q", f.DefaultProvider)
	}
	if !strings.Contains(screen(m), "picked opencode-go/deepseek-v4-flash") {
		t.Fatalf("the switch must be said out loud:\n%s", screen(m))
	}
}

func TestATypedModelNameWorksWhenTheCatalogueCannotBeAsked(t *testing.T) {
	// Rust parity: "type a model name — the catalog could not be read". A
	// list is still a list, and the filter query is the typed name.
	m := fixture(t, 100, 30)
	if _, err := auth.SetKey(m.Home(), "anthropic", "sk-ant-test-key-1234", "", time.Now()); err != nil {
		t.Fatal(err)
	}
	press(t, m, "/")
	typeIn(t, m, "model")
	press(t, m, "enter")
	m.Update(modelsMsg{err: errors.New("no repository configured")})
	typeIn(t, m, "claude-opus-6")
	press(t, m, "enter")
	f := auth.Load(m.Home())
	if f.DefaultProvider != "anthropic" || f.DefaultModelFor("anthropic") != "claude-opus-6" {
		t.Fatalf("the typed name must be written, got %+v", f)
	}
}

// --- the memory editor: add a fact, edit a fact --------------------------

// scriptedMemSrv stands in for memsrv: one memory under Semantic holding one
// fact, every request captured to a file so a test can assert the wire. The
// scripted replies are what a real store returns for dump, state and fact.
func scriptedMemSrv(t *testing.T, capture string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "memsrv")
	script := `#!/bin/sh
while IFS= read -r line; do
  case "$line" in *'"exit"'*) exit 0;; esac
  printf '%s\n' "$line" >> '` + capture + `'
  id=$(printf '%s' "$line" | sed 's/.*"id":\([0-9]*\).*/\1/')
  case "$line" in
    *'"method":"dump"'*) printf '{"id":%s,"ok":true,"result":{"nodes":[{"id":22,"kind":"Aspect","area":"Semantic","label":"project","facts":1,"feeders":0}]}}\n' "$id";;
    *'"method":"state"'*) printf '{"id":%s,"ok":true,"result":{"state":"- port: 8080"}}\n' "$id";;
    *'"method":"fact"'*) printf '{"id":%s,"ok":true,"result":{"fact":7}}\n' "$id";;
    *) printf '{"id":%s,"ok":true,"result":{}}\n' "$id";;
  esac
done
`
	if err := os.WriteFile(p, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

// memFixture is an app whose memory overlay talks to a scripted sidecar: the
// real one replays a journal and may want an API key; the protocol is what is
// under test.
func memFixture(t *testing.T, capture string) *Model {
	t.Helper()
	m := fixture(t, 100, 30)
	m.cfg.MemsrvBin = scriptedMemSrv(t, capture)
	m.cfg.MemJournal = filepath.Join(t.TempDir(), "journal.jsonl")
	return m
}

func TestAddingAFactWritesItThroughTheClient(t *testing.T) {
	capt := filepath.Join(t.TempDir(), "req")
	m := memFixture(t, capt)
	press(t, m, "ctrl+m")
	m.Overlay().Tree().ExpandAll()
	press(t, m, "down") // onto the memory itself
	press(t, m, "n")
	if m.editor == nil || m.editor.node != 22 || m.editor.field != 0 {
		t.Fatalf("n must open a key-first editor on the memory, got %+v", m.editor)
	}
	typeIn(t, m, "port")
	press(t, m, "tab") // to the value
	typeIn(t, m, "8080")
	if !strings.Contains(screen(m), "value: 8080▏") {
		t.Fatalf("the editor must show both fields and the live one:\n%s", screen(m))
	}
	press(t, m, "enter")
	if m.editor != nil {
		t.Fatal("saving must close the editor")
	}
	raw, _ := os.ReadFile(capt)
	for _, want := range []string{`"method":"fact"`, `"node":22`, `"key":"port"`, `"value":"8080"`} {
		if !strings.Contains(string(raw), want) {
			t.Fatalf("the fact request is missing %s:\n%s", want, raw)
		}
	}
	if !strings.Contains(screen(m), "wrote fact #7") {
		t.Fatalf("saving must say what happened:\n%s", screen(m))
	}
}

func TestEditingAFactCorrectsItsValue(t *testing.T) {
	capt := filepath.Join(t.TempDir(), "req")
	m := memFixture(t, capt)
	press(t, m, "ctrl+m")
	m.Overlay().Tree().ExpandAll()
	press(t, m, "down") // the memory
	press(t, m, "right") // load its facts
	press(t, m, "down")  // onto "port: 8080"
	press(t, m, "e")
	if m.editor == nil {
		t.Fatal("e on a fact row must open the editor")
	}
	if m.editor.key != "port" || m.editor.value != "8080" || m.editor.field != 1 {
		t.Fatalf("the editor must be prefilled with the row and land on the value: %+v", m.editor)
	}
	typeIn(t, m, "9") // 8080 → 80809
	press(t, m, "enter")
	raw, _ := os.ReadFile(capt)
	for _, want := range []string{`"method":"fact"`, `"key":"port"`, `"value":"80809"`} {
		if !strings.Contains(string(raw), want) {
			t.Fatalf("the correction is missing %s:\n%s", want, raw)
		}
	}
}

func TestTheEditorAbandonedIsAbandoned(t *testing.T) {
	capt := filepath.Join(t.TempDir(), "req")
	m := memFixture(t, capt)
	press(t, m, "ctrl+m")
	m.Overlay().Tree().ExpandAll()
	press(t, m, "down")
	press(t, m, "n")
	typeIn(t, m, "port")
	press(t, m, "esc")
	if m.editor != nil {
		t.Fatal("esc must leave the edit alone")
	}
	if raw, _ := os.ReadFile(capt); strings.Contains(string(raw), `"method":"fact"`) {
		t.Fatalf("abandoning the editor must not write anything:\n%s", raw)
	}
}

func TestAWritersKeyOnTheWrongRowSaysWhatIsMissing(t *testing.T) {
	m := memFixture(t, filepath.Join(t.TempDir(), "req"))
	press(t, m, "ctrl+m")
	m.Overlay().Tree().ExpandAll()
	press(t, m, "n") // still on the area heading
	if !strings.Contains(screen(m), "that is an area") {
		t.Fatalf("n on an area must say so:\n%s", screen(m))
	}
	press(t, m, "down") // onto the memory
	press(t, m, "e")
	if !strings.Contains(screen(m), "that is a memory") {
		t.Fatalf("e on a memory must ask for a fact row:\n%s", screen(m))
	}
}

func TestTheEditorDemandsAKey(t *testing.T) {
	m := memFixture(t, filepath.Join(t.TempDir(), "req"))
	press(t, m, "ctrl+m")
	m.Overlay().Tree().ExpandAll()
	press(t, m, "down")
	press(t, m, "n")
	press(t, m, "enter") // nothing typed
	if m.editor == nil {
		t.Fatal("a fact with no key is not a fact — the editor must stay open")
	}
	if !strings.Contains(screen(m), "a fact needs a key") {
		t.Fatalf("it must say what is wrong:\n%s", screen(m))
	}
}

func TestTheNewFactKeysAreAdvertisedWhereTheyWork(t *testing.T) {
	m := memFixture(t, filepath.Join(t.TempDir(), "req"))
	m.Resize(160, 30) // room for every advertised key
	press(t, m, "ctrl+m")
	m.Overlay().Tree().ExpandAll()
	press(t, m, "down") // onto the memory itself
	if !strings.Contains(lastLine(screen(m)), "n new fact") {
		t.Fatalf("a writer key nobody is told about is one nobody uses: %q", lastLine(screen(m)))
	}
	press(t, m, "right") // load the facts
	press(t, m, "down")  // onto the fact row
	if !strings.Contains(lastLine(screen(m)), "e edit this fact") {
		t.Fatalf("edit is only advertised where a fact is under the cursor: %q", lastLine(screen(m)))
	}
}

func TestTheWriterKeysAreSilentWithoutAClient(t *testing.T) {
	// No memsrv: the memory overlay is the error list, not a tree, and n/e
	// must not pretend to work.
	m := fixture(t, 100, 30)
	m.cfg.MemsrvBin = ""
	press(t, m, "ctrl+m")
	press(t, m, "n")
	if m.editor != nil {
		t.Fatal("with no service there is nothing to add a fact to")
	}
}
