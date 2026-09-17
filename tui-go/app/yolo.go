package app

import (
	"encoding/json"
	"os"
	"strconv"
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/chat"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/pi"
)

// --- /yolo ------------------------------------------------------------------
//
// The command surface for the mode pi's side of the gate already implements
// (internal/pi/yolo.go holds the rules and the file). This file is only the
// conversation: what the reader typed, what it did, and where it was written.
//
// It writes the PROJECT file, and the notice says so. A mode called "full
// privileges" that quietly applied to every repository on the machine would be
// a bad trade for one word saved — turning it on everywhere stays deliberate
// (the global file, or MNEMO_YOLO=1).

// yoloNotice is what the reader sees after every flip. It states the limit of
// the mode in the same breath as the mode itself, because the limit is the
// reason to trust it: yolo relaxes prompts, never prohibitions.
func (m *Model) yoloCommand(args string) tea.Cmd {
	want, ok := yoloWantsOn(args)
	if !ok {
		m.chat.Append(&chat.Block{Kind: chat.Notice, Body: []string{
			"/yolo on — stop asking for approval, for this project",
			"/yolo off — ask again",
		}})
		return nil
	}

	file, err := pi.SetProjectYolo(m.cfg.CWD, want)
	if err != nil {
		m.chat.Append(&chat.Block{Kind: chat.Notice, Body: []string{"could not write " + file + ": " + err.Error()}})
		return nil
	}
	m.yolo = want

	if !want {
		m.chat.Append(&chat.Block{Kind: chat.Notice, Body: []string{
			"yolo off — approval is asked for again",
		}})
		return nil
	}

	lines := []string{
		"yolo on — the agent stops asking for approval in this project",
		"written to " + file + " (a running session picks it up; other sessions are told)",
	}
	if n := countDenies(file); n > 0 {
		// The one thing yolo must not be mistaken for. Say it here, where the
		// reader just chose the mode, not only in the gate's startup notice.
		lines = append(lines, denyRuleCount(n)+" still in force — yolo relaxes prompts, never prohibitions")
	}
	m.chat.Append(&chat.Block{Kind: chat.Notice, Body: lines})
	return nil
}

// yoloWantsOn reads the argument of the mode toggle. Bare "/yolo" means "on": the
// reader typed the mode's name, and asking them to type it twice to mean it
// would be a worse guess than taking the obvious one.
func yoloWantsOn(args string) (bool, bool) {
	switch strings.ToLower(strings.TrimSpace(args)) {
	case "", "on", "1", "true", "yes":
		return true, true
	case "off", "0", "false", "no":
		return false, true
	default:
		return false, false
	}
}

// denyRuleCount phrases the caveat without a plural helper: this sentence
// appears in exactly one place, and a shared plural() is how two files end up
// disagreeing about whether zero takes a singular verb.
func denyRuleCount(n int) string {
	if n == 1 {
		return "1 deny rule is"
	}
	return strconv.Itoa(n) + " deny rules are"
}

// readJSONMap reads a document leniently: the caller is about to warn about
// something, and a file it cannot parse is not a reason to fail the command.
func readJSONMap(file string) (map[string]any, error) {
	raw, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	doc := map[string]any{}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	return doc, nil
}

// countDenies reports how many deny rules the project file holds. Read
// leniently: an unreadable file has no denies to warn about, and a warning
// that failed to load is not a reason to refuse the toggle.
func countDenies(file string) int {
	doc, err := readJSONMap(file)
	if err != nil {
		return 0
	}
	rules, ok := doc["rules"].([]any)
	if !ok {
		return 0
	}
	n := 0
	for _, r := range rules {
		if rule, ok := r.(map[string]any); ok && rule["action"] == "deny" {
			n++
		}
	}
	return n
}
