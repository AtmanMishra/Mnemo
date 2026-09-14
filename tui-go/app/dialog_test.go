package app

import (
	"strings"
	"testing"
	"time"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/agent"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/overlay"
	"github.com/charmbracelet/x/ansi"
)

// The other half of pi's line-JSON protocol: the questions IT asks. Dialogs
// arrive as messages, are answered through the backend, and the answer is a
// line on pi's stdin — so what these tests check is what the interface handed
// the backend (the `dial` recorder) and what the reader saw while it decided.
// Nothing here spawns a process.

// sent joins everything the backend was handed, for a containment check.
func sent(d *dial) string { return strings.Join(d.Sent(), "\n") }

// --- notify and setStatus ------------------------------------------------

func TestAnExtensionNotifyLandsOnTheStatusLine(t *testing.T) {
	// Our own /hook, /schedule, /trigger and /now answer through ui.notify.
	// Dropping it is why they looked like no-ops.
	m, _ := liveFixture(t, 120, 30)
	m.Update(agent.UINotify{Message: "hook #3 written", Kind: "info"})
	if !strings.Contains(lastLine(screen(m)), "hook #3 written") {
		t.Fatalf("a notification must be visible where the reader is looking: %q", lastLine(screen(m)))
	}

	// The kind is words, not colour: a warning told apart only by a colour
	// the reader cannot see is not a warning.
	m.Update(agent.UINotify{Message: "gate refused the write", Kind: "warning"})
	if !strings.Contains(lastLine(screen(m)), "warning: gate refused the write") {
		t.Fatalf("a warning must say it is one: %q", lastLine(screen(m)))
	}
}

func TestAnExtensionStatusEntryStaysUntilItsWriterClearsIt(t *testing.T) {
	m, _ := liveFixture(t, 140, 30)
	m.Update(agent.UIStatus{Key: "my-ext", Text: "Turn 3 running..."})
	if !strings.Contains(lastLine(screen(m)), "Turn 3 running...") {
		t.Fatalf("setStatus is the extension asking to be visible: %q", lastLine(screen(m)))
	}

	// Keyed, not global: a second extension's entry must not replace the
	// first, and neither expires on its own.
	m.Update(agent.UIStatus{Key: "other-ext", Text: "watching files"})
	band := lastLine(screen(m))
	if !strings.Contains(band, "Turn 3 running...") || !strings.Contains(band, "watching files") {
		t.Fatalf("two extensions, two slots: %q", band)
	}

	// statusText omitted (empty here) is how an extension clears its own.
	m.Update(agent.UIStatus{Key: "my-ext"})
	band = lastLine(screen(m))
	if strings.Contains(band, "Turn 3 running...") {
		t.Fatalf("an empty text must clear that entry: %q", band)
	}
	if !strings.Contains(band, "watching files") {
		t.Fatalf("...and only that entry: %q", band)
	}
}

// --- dialogs -------------------------------------------------------------

func TestAConfirmDialogIsAnsweredWithTheRowTheReaderPicked(t *testing.T) {
	for _, c := range []struct {
		name string
		keys []string
		want string
	}{
		{"enter picks yes", []string{"enter"}, "confirm yes uuid-2"},
		{"n filters to no", []string{"n", "enter"}, "confirm no uuid-2"},
		{"esc cancels instead of answering", []string{"esc"}, "cancelled uuid-2"},
	} {
		t.Run(c.name, func(t *testing.T) {
			m, d := liveFixture(t, 100, 30)
			m.Update(agent.UIDialog{
				ID: "uuid-2", Method: "confirm",
				Title: "Clear session?", Message: "All messages will be lost.",
				Timeout: 5 * time.Second,
			})
			if m.Overlay() == nil || m.Overlay().Kind != overlay.Dialog {
				t.Fatal("a question must take the screen — it is waiting on an answer")
			}
			shown := screen(m)
			if !strings.Contains(shown, "Clear session?") || !strings.Contains(shown, "All messages will be lost.") {
				t.Fatalf("title and message are what is being answered:\n%s", shown)
			}
			if !strings.Contains(m.Overlay().Purpose, "auto-resolves in 5s") {
				t.Fatalf("pi's deadline must be stated; it resolves without us otherwise: %q", m.Overlay().Purpose)
			}
			for _, k := range c.keys {
				press(t, m, k)
			}
			if got := sent(d); got != c.want {
				t.Fatalf("the agent was handed %q, want %q", got, c.want)
			}
			if m.Overlay() != nil {
				t.Fatal("an answered question must leave the screen")
			}
			if m.dialogWaiting() {
				t.Fatal("nothing is waiting once the answer is out")
			}
		})
	}
}

func TestASelectDialogReturnsTheChosenOptionVerbatim(t *testing.T) {
	m, d := liveFixture(t, 100, 30)
	m.Update(agent.UIDialog{
		ID: "uuid-1", Method: "select",
		Title:   "Allow dangerous command?",
		Options: []string{"Allow", "Block"},
	})
	press(t, m, "down")
	press(t, m, "enter")
	if got := sent(d); got != "select Block uuid-1" {
		t.Fatalf("the option itself is the answer, got %q", got)
	}
}

func TestAnInputDialogIsAnsweredFromThePrompt(t *testing.T) {
	m, d := liveFixture(t, 100, 30)
	m.Update(agent.UIDialog{ID: "uuid-3", Method: "input", Title: "Which branch?", Placeholder: "type something..."})

	// The question has to be readable while you type the answer.
	band := lastLine(screen(m))
	if !strings.Contains(band, "Which branch?") {
		t.Fatalf("the prompt owns the answer, so the question belongs above it: %q", band)
	}

	// A slash is text here, not a command: typing an answer that looks like
	// one must not open the command menu or run anything.
	typeIn(t, m, "feat/x")
	if m.prompt.MenuOpen() {
		t.Fatal("a command menu over an extension's question would turn enter into a run")
	}
	press(t, m, "enter")

	if got := sent(d); got != "input feat/x uuid-3" {
		t.Fatalf("the prompt's text is the answer, got %q", got)
	}
	if !m.prompt.Empty() {
		t.Fatalf("the answer must leave the prompt, got %q", m.prompt.Value())
	}
	if m.answeringText() {
		t.Fatal("the question is answered; the prompt is the prompt again")
	}
	// And a second enter is a normal empty prompt, not another answer.
	press(t, m, "enter")
	if got := len(d.Sent()); got != 1 {
		t.Fatalf("enter on an empty prompt answered something: %v", d.Sent())
	}
}

func TestAnEditorDialogStartsFromThePrefillAndSendsItBack(t *testing.T) {
	m, d := liveFixture(t, 100, 30)
	m.Update(agent.UIDialog{
		ID: "uuid-4", Method: "editor",
		Title:   "Edit some text",
		Prefill: "Line 1\nLine 2",
	})
	if got := m.prompt.Value(); !strings.Contains(got, "Line 1") {
		t.Fatalf("an editor's prefill is its starting text, got %q", got)
	}
	press(t, m, "enter")
	if got := sent(d); !strings.Contains(got, "editor Line 1\nLine 2 uuid-4") {
		t.Fatalf("the edited text is the answer, got %q", got)
	}
}

func TestADialogOwnsTheKeyboardWhileItWaits(t *testing.T) {
	// A chord that opens a palette over an unanswered question takes the
	// question off the screen while the extension sits parked on it.
	m, _ := liveFixture(t, 100, 30)
	m.Update(agent.UIDialog{ID: "uuid-9", Method: "confirm", Title: "Sure?"})
	press(t, m, "ctrl+k")
	if m.Overlay() == nil || m.Overlay().Kind != overlay.Dialog {
		t.Fatalf("^k walked past a question the agent is blocked on: %v", m.Overlay())
	}
}

func TestASecondQuestionIsQueuedNotDropped(t *testing.T) {
	m, d := liveFixture(t, 100, 30)
	m.Update(agent.UIDialog{ID: "uuid-1", Method: "confirm", Title: "First?"})
	m.Update(agent.UIDialog{ID: "uuid-2", Method: "input", Title: "Second?"})

	press(t, m, "enter") // answers the first
	if got := sent(d); !strings.Contains(got, "confirm yes uuid-1") {
		t.Fatalf("the first question must be answered first, got %q", got)
	}
	if !strings.Contains(lastLine(screen(m)), "Second?") {
		t.Fatalf("the queued question must come up next: %q", lastLine(screen(m)))
	}
	typeIn(t, m, "hi")
	press(t, m, "enter")
	if got := sent(d); !strings.Contains(got, "input hi uuid-2") {
		t.Fatalf("the second answer must go out too, got %q", got)
	}
}

func TestADraftSurvivesAQuestion(t *testing.T) {
	m, _ := liveFixture(t, 100, 30)
	typeIn(t, m, "half-written message")
	m.Update(agent.UIDialog{ID: "uuid-5", Method: "input", Title: "Quick question?"})
	if !m.prompt.Empty() {
		t.Fatalf("the question needs the editor, got %q", m.prompt.Value())
	}
	typeIn(t, m, "the answer")
	press(t, m, "enter")
	if got := m.prompt.Value(); got != "half-written message" {
		t.Fatalf("answering a question must not eat the draft, got %q", got)
	}
}

func TestAnAnsweredDialogIsAcknowledgedOnTheStatusLine(t *testing.T) {
	// A dialog that closes silently is indistinguishable from one that was
	// ignored — and being ignored is exactly what used to happen.
	m, _ := liveFixture(t, 120, 30)
	m.Update(agent.UIDialog{ID: "uuid-6", Method: "confirm", Title: "Sure?"})
	press(t, m, "enter")
	if !strings.Contains(lastLine(screen(m)), "answered confirm: yes") {
		t.Fatalf("the answer must leave a trace: %q", lastLine(screen(m)))
	}
}

func TestInterruptingDropsAQuestionNobodyIsWaitingForAnymore(t *testing.T) {
	// The turn is what the question belongs to. pi resolves a waiting dialog
	// with its default when the turn aborts, so a question left on screen
	// after ^c is one whose asker has moved on — and answering it would write
	// a response to a promise that no longer exists.
	m, d := liveFixture(t, 100, 30)
	m.Update(agent.Started{}) // a turn is running, which is what ^c interrupts
	m.Update(agent.UIDialog{ID: "uuid-8", Method: "confirm", Title: "Really?"})
	press(t, m, "ctrl+c")
	if m.Overlay() != nil || m.dialogWaiting() {
		t.Fatal("the question outlived the turn it belonged to")
	}
	if strings.Contains(sent(d), "uuid-8") {
		t.Fatalf("an abandoned question must not be answered: %q", sent(d))
	}
	if !strings.Contains(lastLine(screen(m)), "pending question was dropped") {
		t.Fatalf("and it must say the question went away: %q", lastLine(screen(m)))
	}
}

func TestADialogFitsASmallTerminal(t *testing.T) {
	// A question that overflows the screen is one nobody can read — and the
	// dialog kinds are the one overlay whose content comes from outside.
	for _, wh := range [][2]int{{40, 12}, {60, 16}, {80, 24}} {
		m, _ := liveFixture(t, wh[0], wh[1])
		m.Update(agent.UIDialog{
			ID: "uuid-1", Method: "select",
			Title:   "Allow dangerous command?",
			Message: "a message long enough to be interesting on a narrow terminal",
			Options: []string{"Allow once", "Allow always", "Block", "Block and remember the command"},
		})
		lines := strings.Split(screen(m), "\n")
		if len(lines) != wh[1] {
			t.Fatalf("%dx%d: drew %d rows", wh[0], wh[1], len(lines))
		}
		for i, l := range lines {
			if w := ansi.StringWidth(l); w > wh[0] {
				t.Fatalf("%dx%d: row %d is %d cells: %q", wh[0], wh[1], i, w, l)
			}
		}
	}
}

func TestASelectWithNoOptionsIsStillAnswerable(t *testing.T) {
	// pi's select type allows an empty list. A dialog nobody can answer is
	// the exact failure this whole path exists to fix, so esc must still
	// cancel it.
	m, d := liveFixture(t, 100, 30)
	m.Update(agent.UIDialog{ID: "uuid-0", Method: "select", Title: "Pick one"})
	if m.Overlay() == nil {
		t.Fatal("an empty select is still a question; it must take the screen")
	}
	if !strings.Contains(screen(m), "no options") {
		t.Fatalf("and it must say what is wrong with it:\n%s", screen(m))
	}
	press(t, m, "esc")
	if got := sent(d); got != "cancelled uuid-0" {
		t.Fatalf("esc must cancel even when there is nothing to pick, got %q", got)
	}
}

// --- compaction, retries, extension errors --------------------------------

func TestCompactionIsAnnounced(t *testing.T) {
	// The window can be rewritten underneath the reader. These two lines are
	// the only account of it.
	m, _ := liveFixture(t, 120, 30)
	m.Update(agent.Compaction{Started: true, Reason: "threshold"})
	if !strings.Contains(screen(m), "compacting the context (the context filled up)") {
		t.Fatalf("compaction must say why it starts:\n%s", screen(m))
	}
	m.Update(agent.Compaction{Reason: "threshold", TokensBefore: 150000, TokensAfter: 32000})
	if !strings.Contains(screen(m), "context compacted — 150k → 32.0k tokens") {
		t.Fatalf("the sizes are the news:\n%s", screen(m))
	}

	// The two ways it ends badly are different facts, and saying "compacted"
	// for either would be a lie.
	m.Update(agent.Compaction{Aborted: true})
	if !strings.Contains(screen(m), "compaction aborted — the context is unchanged") {
		t.Fatalf("an abort leaves the context alone:\n%s", screen(m))
	}
	m.Update(agent.Compaction{Err: "quota exceeded"})
	if !strings.Contains(screen(m), "compaction failed: quota exceeded") {
		t.Fatalf("a failure must name itself:\n%s", screen(m))
	}
}

func TestARetryIsNotAHang(t *testing.T) {
	m, _ := liveFixture(t, 140, 30)
	m.Update(agent.Retry{
		Phase: agent.RetryStart, Kind: agent.RetryTurn,
		Attempt: 1, MaxAttempts: 3, Delay: 2 * time.Second,
		Err: "529 overloaded",
	})
	shown := screen(m)
	if !strings.Contains(shown, "retrying the turn (attempt 1 of 3) in 2 seconds: 529 overloaded") {
		t.Fatalf("the transcript must say what it is waiting for:\n%s", shown)
	}
	if !strings.Contains(lastLine(shown), "retrying the turn 1/3") {
		t.Fatalf("and the status line must explain the turning spinner: %q", lastLine(shown))
	}

	m.Update(agent.Retry{Phase: agent.RetryEnd, Kind: agent.RetryTurn, OK: true, Attempt: 2})
	shown = screen(m)
	if !strings.Contains(shown, "the retry succeeded on attempt 2") {
		t.Fatalf("how it ended is the part read later:\n%s", shown)
	}
	if strings.Contains(lastLine(shown), "retrying") {
		t.Fatalf("a finished retry must clear the status line: %q", lastLine(shown))
	}

	// Giving up is a different ending, and the reason has to survive.
	m.Update(agent.Retry{Phase: agent.RetryEnd, Kind: agent.RetryTurn, Attempt: 3, Final: "529 overloaded_error"})
	if !strings.Contains(screen(m), "retries exhausted after 3 attempts: 529 overloaded_error") {
		t.Fatalf("an exhausted retry must say so:\n%s", screen(m))
	}
}

func TestASummarizationRetrySaysItIsTheSummarizer(t *testing.T) {
	m, _ := liveFixture(t, 140, 30)
	// The scheduled event does not know which summary it is yet; the attempt
	// event that follows is where the source arrives.
	m.Update(agent.Retry{Phase: agent.RetryScheduled, Kind: agent.RetrySummary, Attempt: 1, MaxAttempts: 3, Delay: time.Second, Err: "terminated"})
	if !strings.Contains(screen(m), "retrying the summarizer") {
		t.Fatalf("a summarizer retry is not a turn retry:\n%s", screen(m))
	}
	m.Update(agent.Retry{Phase: agent.RetryAttempt, Kind: agent.RetryComp})
	if !strings.Contains(lastLine(screen(m)), "retrying the compaction summary") {
		t.Fatalf("and then it says which one: %q", lastLine(screen(m)))
	}
	m.Update(agent.Retry{Phase: agent.RetryFinished, Kind: agent.RetrySummary})
	if strings.Contains(lastLine(screen(m)), "retrying") {
		t.Fatalf("the loop is over; the status line must be clear: %q", lastLine(screen(m)))
	}
}

func TestAnExtensionErrorIsTheOnlySignalWeGet(t *testing.T) {
	m, _ := liveFixture(t, 140, 30)
	m.Update(agent.ExtensionError{
		Path:  "/repo/.pi/extensions/guardrail.ts",
		Event: "tool_call",
		Err:   "TypeError: cannot read properties of undefined",
	})
	shown := screen(m)
	for _, want := range []string{"extension error", "guardrail.ts", "tool_call", "TypeError"} {
		if !strings.Contains(shown, want) {
			t.Fatalf("an extension's crash must name itself (%q missing):\n%s", want, shown)
		}
	}
}
