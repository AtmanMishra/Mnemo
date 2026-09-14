package pi

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Project trust, resolved explicitly.
//
// pi loads a project's own resources — .pi/settings.json, .pi/extensions,
// .pi/skills, .pi/prompts, .pi/themes, .pi/SYSTEM.md, .pi/APPEND_SYSTEM.md,
// and project .agents/skills — only when the project is trusted. In RPC mode
// there is no prompt to ask: `defaultProjectTrust: "ask"` (pi's default)
// simply ignores them, and --approve / --no-approve are the only levers.
//
// The failure mode is the reason this file exists. A project's own guardrail
// extension lives in .pi/extensions and quietly does not run, while
// AGENTS.md still loads (it is trust-exempt), so a partial load looks total
// and the interface never says a word about it.
//
// So: a decision is read from ~/.mnemo/trust.json here, both flags are passed
// explicitly at spawn, and the transcript says which one applied and what it
// means. With no recorded decision the answer is the safe one — not approved
// — and the note says that too, so the reader can tell "denied" from
// "nobody ever decided".
type Trust struct {
	// Approve is the decision: true passes --approve, false --no-approve.
	Approve bool
	// From is the trust.json key the decision came from (an absolute
	// directory, possibly an ancestor of the project). Empty when nothing
	// was recorded and the default applied.
	From string
	// File is the decision file consulted, for the transcript line.
	File string
	// Err is non-empty when the file existed but could not be read or
	// parsed. The decision is still made — the safe one — and this is why.
	Err string
}

// decisions is the file's shape: absolute project path → trusted.
//
// A bool map, not a list of records, because the file is meant to be written
// by hand and read at a glance: {"…/src/thing": true}. An entry for a parent
// directory covers its children, the way pi's own trust.json does — deciding
// once for ~/src is the common case; deciding again per checkout is not.
type decisions map[string]bool

// TrustFile is where a project-trust decision is recorded, under a home.
func TrustFile(home string) string { return filepath.Join(home, ".mnemo", "trust.json") }

// ResolveTrust reads the recorded decision for a project directory.
//
// The lookup walks from the project up to the filesystem root and takes the
// closest entry, because that is what pi does with its own trust store and
// two different answers to "is this project trusted" would be a bug in the
// part of the system that decides whether a repo's extensions run.
//
// Every failure — no file, unreadable file, malformed JSON, empty home —
// lands on the same safe answer. A trust decision that defaults to "yes"
// when the file is broken is not a decision.
func ResolveTrust(home, project string) Trust {
	t := Trust{File: TrustFile(home)}
	if home == "" {
		return t
	}
	abs, err := filepath.Abs(project)
	if err != nil {
		return t
	}
	abs = filepath.Clean(abs)

	raw, err := os.ReadFile(t.File)
	switch {
	case os.IsNotExist(err):
		return t // normal first run: nothing recorded, default applies
	case err != nil:
		t.Err = err.Error()
		return t
	}
	var d decisions
	if err := json.Unmarshal(raw, &d); err != nil {
		t.Err = fmt.Sprintf("%s is not a JSON object of path → true/false: %v", t.File, err)
		return t
	}

	for p := abs; ; {
		for key, ok := range d {
			if cleanKey(key) != p {
				continue
			}
			t.Approve, t.From = ok, key
			return t
		}
		parent := filepath.Dir(p)
		if parent == p {
			return t
		}
		p = parent
	}
}

// cleanKey normalises a recorded path so a key written with a trailing slash
// (or in mixed separators) still matches the project it names.
func cleanKey(k string) string {
	if abs, err := filepath.Abs(k); err == nil {
		return filepath.Clean(abs)
	}
	return filepath.Clean(k)
}

// Flag is the pi CLI flag this decision asks for. One of the two always goes
// on the command line; there is no "let pi decide" here, because in RPC mode
// pi deciding means ignoring the project without saying so.
func (t Trust) Flag() string {
	if t.Approve {
		return "--approve"
	}
	return "--no-approve"
}

// Note is the one line the transcript shows, so the reader can tell which way
// it went and what it cost. It names the resources at stake rather than
// saying "trust", which is a word that answers nothing.
func (t Trust) Note() string {
	switch {
	case t.Approve && t.From != "":
		return "project trust: approved by the entry for " + t.From + " in " + t.File +
			" — this project's .pi settings, extensions, prompts and skills load"
	case t.Approve:
		// Constructed by hand (tests, a caller that decided out of band);
		// the file did not say so.
		return "project trust: approved — this project's .pi settings, extensions, prompts and skills load"
	case t.From != "":
		return "project trust: denied by the entry for " + t.From + " in " + t.File +
			" — pi ignores this project's .pi settings, extensions, prompts and skills"
	default:
		note := "project trust: no decision recorded for this project — defaulting to --no-approve; " +
			"pi ignores this project's .pi settings, extensions, prompts and skills until one is recorded in " + t.File
		if t.Err != "" {
			note += " (" + t.Err + ")"
		}
		return note
	}
}

// ShortNote is Note shortened for a status line, when a surface wants the
// gist rather than the sentence.
func (t Trust) ShortNote() string {
	if t.Approve {
		return "project trusted (" + t.Flag() + ")"
	}
	if t.Err != "" {
		return "project not trusted — " + t.Err + " (" + t.Flag() + ")"
	}
	return "project not trusted (" + t.Flag() + ")"
}
