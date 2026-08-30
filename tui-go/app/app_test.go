package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/agent"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/chat"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/keymap"
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
	// second to last row is the prompt; last is the status band
	if !strings.Contains(lines[len(lines)-2], "ask, or press") {
		t.Fatalf("prompt is not above the status line:\n%s", strings.Join(lines[len(lines)-3:], "\n"))
	}
	if !strings.Contains(lines[len(lines)-1], "INSERT") {
		t.Fatalf("status band is not the last row: %q", lines[len(lines)-1])
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
		"ctrl+l": "what the agent and its tools actually did",
		"ctrl+k": "run anything by name",
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
	typeIn(t, m, "folder")
	s := screen(m)
	if !strings.Contains(s, "folder explorer") {
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
