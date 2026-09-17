package auth

import (
	"context"
	"errors"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// The model catalogue: which models the logged-in providers actually offer.
//
// Choosing a model used to mean typing its name from memory — the onboarding
// step and /model both asked for a string and rejected anything they did not
// recognise, which is only usable if you already know the answer. The agent
// resolves the real list from pi's provider catalogue using the stored
// credentials, so that is where the list comes from.
//
// Parsing is a pure function over the command's output, so the table format
// is pinned by tests without running node.

// Model is one offering.
type Model struct {
	Provider string
	Name     string
}

// String is how a model is written everywhere in the interface.
func (m Model) String() string { return m.Provider + "/" + m.Name }

// ListTimeout bounds the catalogue call. It normally takes about half a
// second; without a bound, a provider that hangs hangs the interface with it.
//
// A variable rather than a constant because an operator sets it: the value
// here is the built-in default, and ~/.mnemo/limits.json ("list_timeout")
// changes it without a rebuild (internal/limits).
var ListTimeout = 20 * time.Second

// ParseList reads the `--list-models` table.
//
// The command prints unrelated startup chatter ("skills: 27 loaded") before
// the header row, so parsing starts AT the header rather than at line 0 — and
// a missing header means no models, not a panic.
func ParseList(out string) []Model {
	var models []Model
	seenHeader := false
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		if !seenHeader {
			if f[0] == "provider" && f[1] == "model" {
				seenHeader = true
			}
			continue
		}
		models = append(models, Model{Provider: f[0], Name: f[1]})
	}
	return models
}

// Fetch asks the agent for the catalogue.
//
// It returns an error rather than an empty list when the ask fails, so the
// caller can tell "this provider offers nothing" apart from "we could not
// ask". The second must not look like the first, or a network blip reads as a
// broken account.
func Fetch(repoRoot string) ([]Model, error) {
	if repoRoot == "" {
		return nil, errors.New("no repository configured — start with --repo to list models")
	}
	ctx, cancel := context.WithTimeout(context.Background(), ListTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "node",
		filepath.Join(repoRoot, "agent", "bin", "mnemo.ts"), "--list-models")
	cmd.Dir = repoRoot
	out, err := cmd.Output()
	if ctx.Err() != nil {
		return nil, errors.New("listing models timed out")
	}
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return nil, errors.New("--list-models failed: " + lastLine(string(ee.Stderr)))
		}
		return nil, errors.New("could not run the agent: " + err.Error())
	}
	return ParseList(string(out)), nil
}

// FilterModels narrows by a substring over "provider/model".
//
// One filter over both halves: "opus" and "anthropic" both narrow the list,
// which is what somebody typing into a picker expects.
func FilterModels(models []Model, needle string) []Model {
	needle = strings.ToLower(strings.TrimSpace(needle))
	if needle == "" {
		return models
	}
	var out []Model
	for _, m := range models {
		if strings.Contains(strings.ToLower(m.String()), needle) {
			out = append(out, m)
		}
	}
	return out
}

// lastLine is the most specific thing a failing command said. The first line
// of a node stack trace is rarely the reason.
func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if l := strings.TrimSpace(lines[i]); l != "" {
			return l
		}
	}
	return "no output"
}
