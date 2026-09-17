// Package doctor answers one question: is this installation able to work?
//
// It exists because of a real failure. Someone installed Mnemo, ran it, and
// could not get anywhere — and had no way to ask what was wrong short of
// reading a transcript for clues. The installer's own verification caught the
// problem, but the only way to ask "is this healthy?" afterwards was to read
// the source.
//
// Two rules shape everything here:
//
//  1. **A check that says "failed" must print the line that fixes it.** A
//     diagnosis without a remedy is a slower way of saying "something is
//     wrong", and the person reading it is already frustrated.
//  2. **Nothing here needs a model, a network, or a key.** Doctor is the one
//     command that must work when everything else is broken, so it may only
//     look at facts already on this machine.
//
// Every fact is injected (LookPath, Stat, ReadFile, Run) rather than read from
// the world, so the failure paths are tested rather than reasoned about — a
// diagnostic that is wrong about a broken machine is worse than no diagnostic.
package doctor

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// NodeFloor is the first Node that runs .ts files with no flag. It is pinned
// in four places across this repository (CI, both package.json files, the
// agent's own runtime check) because a version below it fails on every
// TypeScript file with ERR_UNKNOWN_FILE_EXTENSION — a failure that looks like a
// broken install rather than a wrong runtime.
const NodeFloor = "22.18"

// Check is one diagnosis.
type Check struct {
	Name string
	// Required distinguishes "Mnemo cannot work" from "a feature will be off".
	// The exit code answers the first question only; the memory sidecar being
	// absent is a missing feature, not a broken installation.
	Required bool
	OK       bool
	Detail   string
	Fix      string // empty when OK, and non-empty whenever it is not
}

// Report is the whole diagnosis.
type Report struct {
	Checks []Check
}

// Failed counts the required checks that did not pass — the number the exit
// code is made of.
func (r Report) Failed() int {
	n := 0
	for _, c := range r.Checks {
		if c.Required && !c.OK {
			n++
		}
	}
	return n
}

// Warnings counts optional checks that did not pass: features that are off.
func (r Report) Warnings() int {
	n := 0
	for _, c := range r.Checks {
		if !c.Required && !c.OK {
			n++
		}
	}
	return n
}

// String renders the report the way the CLI prints it.
func (r Report) String() string {
	var b strings.Builder
	for _, c := range r.Checks {
		mark, label := "ok  ", "ok"
		if !c.OK {
			mark, label = "FAIL", "fail"
			if !c.Required {
				mark, label = "warn", "warn"
			}
		}
		fmt.Fprintf(&b, "  %s  %-22s %s\n", mark, c.Name, c.Detail)
		if !c.OK && c.Fix != "" {
			// Indented under its own check, so the remedy cannot be read as
			// belonging to the next one.
			fmt.Fprintf(&b, "        fix: %s\n", c.Fix)
		}
		_ = label
	}
	return b.String()
}

// Summary is the last line: what to do next, or that there is nothing to do.
func (r Report) Summary() string {
	if f := r.Failed(); f > 0 {
		return fmt.Sprintf("%d check(s) must pass before Mnemo can work.", f)
	}
	if w := r.Warnings(); w > 0 {
		return fmt.Sprintf("Mnemo can run. %d optional piece(s) are missing — the features they serve are off.", w)
	}
	return "Everything checks out."
}

// Env is everything doctor is allowed to touch, so tests can lie to it.
type Env struct {
	Home string
	CWD  string
	// Repo is the checkout holding agent/bin/mnemo.ts; empty when not given.
	Repo string
	// Memsrv is an explicit sidecar path, empty when not given.
	Memsrv string

	LookPath func(string) (string, error)
	// Auth reports what the interface itself considers configured — the
	// providers with a key, and the default model. Injected so that doctor
	// reads the store through the same loader /login writes it through: a
	// diagnostic that parses auth.json its own way is a diagnostic that can
	// contradict the command it is telling you to run. (It did, in the first
	// version of this file: a hand-rolled pattern missed a single-line JSON
	// store and announced "no provider" on a machine that had one.)
	Auth      func(home string) (providers []string, model string)
	Stat      func(string) (os.FileInfo, error)
	ReadFile  func(string) ([]byte, error)
	WriteFile func(string, []byte, os.FileMode) error
	Remove    func(string) error
	MkdirAll  func(string, os.FileMode) error
	// Run executes a command and returns its combined output.
	Run func(name string, args ...string) (string, error)
}

// Run performs every check in order, cheapest and most fundamental first, so
// the output reads as a diagnosis rather than a list.
func Run(env Env) Report {
	var checks []Check
	add := func(c Check) { checks = append(checks, c) }

	// --- the home directory: everything else lives under it ----------------
	home := env.Home
	dir := filepath.Join(home, ".mnemo")
	probe := filepath.Join(dir, ".doctor-probe")
	if err := env.MkdirAll(dir, 0o755); err != nil {
		add(Check{Name: "home directory", Required: true, OK: false,
			Detail: dir + " cannot be created",
			Fix:    "check permissions on " + home + ", or pass --home <writable dir>"})
	} else if err := env.WriteFile(probe, []byte("probe"), 0o600); err != nil {
		add(Check{Name: "home directory", Required: true, OK: false,
			Detail: dir + " is not writable",
			Fix:    "check permissions on " + dir})
	} else {
		_ = env.Remove(probe)
		add(Check{Name: "home directory", Required: true, OK: true, Detail: dir})
	}

	// --- a provider, because nothing works without one ---------------------
	var providers []string
	var model string
	if env.Auth != nil {
		providers, model = env.Auth(home)
	}
	if len(providers) == 0 {
		add(Check{Name: "provider", Required: true, OK: false,
			Detail: "no provider is configured",
			Fix:    "run mnemo and type /login (or /login <provider> <key> if you know the name)"})
	} else {
		add(Check{Name: "provider", Required: true, OK: true,
			Detail: strings.Join(providers, ", ")})
	}

	if model == "" {
		add(Check{Name: "default model", Required: false, OK: false,
			Detail: "none chosen",
			Fix:    "run `/model` in Mnemo to pick one from what your key can run"})
	} else {
		add(Check{Name: "default model", Required: false, OK: true, Detail: model})
	}

	// --- the agent runtime: the piece that does the actual work ------------
	if env.Repo == "" {
		add(Check{Name: "agent runtime", Required: false, OK: false,
			Detail: "no --repo given, so the live agent is off",
			Fix:    "start with --repo <checkout> (the directory holding agent/), or pass it in the interface"})
	} else {
		script := filepath.Join(env.Repo, "agent", "bin", "mnemo.ts")
		if _, err := env.Stat(script); err != nil {
			fix := "--repo must point at the checkout root (the directory that contains agent/), not at tui-go/"
			if msysPath(env.Repo) {
				// Hit by hand while writing this file: /c/... is a Git Bash
				// path, and a native Windows program reads it literally as
				// \c\... and never finds anything.
				fix += ". On Windows, " + env.Repo + " is a Git Bash path that native programs do not " +
					"resolve — write it as C:/... instead"
			}
			add(Check{Name: "agent runtime", Required: true, OK: false,
				Detail: "agent/bin/mnemo.ts is not in " + env.Repo,
				Fix:    fix})
		} else if _, err := env.Stat(filepath.Join(env.Repo, "agent", "node_modules")); err != nil {
			add(Check{Name: "agent runtime", Required: true, OK: false,
				Detail: "the agent's dependencies are not installed",
				Fix:    "cd " + filepath.Join(env.Repo, "agent") + " && npm install"})
		} else {
			add(Check{Name: "agent runtime", Required: true, OK: true, Detail: script})
		}
	}

	// --- node, at the floor that actually matters --------------------------
	if node, err := env.LookPath("node"); err != nil {
		add(Check{Name: "node", Required: true, OK: false,
			Detail: "not on PATH",
			Fix:    "install Node >= " + NodeFloor + " (https://nodejs.org) — the agent runtime is TypeScript"})
	} else if out, err := env.Run(node, "--version"); err != nil {
		add(Check{Name: "node", Required: true, OK: false,
			Detail: node + " will not run",
			Fix:    "reinstall Node >= " + NodeFloor})
	} else if v := strings.TrimSpace(out); !nodeAtLeast(v, NodeFloor) {
		add(Check{Name: "node", Required: true, OK: false,
			Detail: v + " is below the floor",
			Fix: "Node >= " + NodeFloor + " is required: below it, every .ts file fails with " +
				"ERR_UNKNOWN_FILE_EXTENSION, which looks like a broken install rather than an old runtime. " +
				"Upgrade Node, or put a newer one earlier on PATH."})
	} else {
		add(Check{Name: "node", Required: true, OK: true, Detail: strings.TrimSpace(out) + " at " + node})
	}

	// --- the memory sidecar: optional, and said so -------------------------
	if path, ok := findMemsrv(env); ok {
		add(Check{Name: "memory sidecar", Required: false, OK: true, Detail: path})
	} else {
		add(Check{Name: "memory sidecar", Required: false, OK: false,
			Detail: "not built",
			Fix:    "cd memory-layer && cargo build --bin memsrv   (the Memory pane stays off without it)"})
	}

	// --- logs: where the interface writes its own diagnostics --------------
	logDir := filepath.Join(dir, "logs")
	if err := env.MkdirAll(logDir, 0o755); err != nil {
		add(Check{Name: "log directory", Required: false, OK: false,
			Detail: logDir + " cannot be created",
			Fix:    "check permissions on " + dir})
	} else {
		add(Check{Name: "log directory", Required: false, OK: true, Detail: logDir})
	}

	// --- is the binary findable next time? ---------------------------------
	// A PATH that does not include the directory this binary lives in is why
	// "mnemo: command not found" arrives right after a successful install.
	if exe, err := os.Executable(); err == nil {
		binDir := filepath.Dir(exe)
		if onPath(env, binDir) {
			add(Check{Name: "on PATH", Required: false, OK: true, Detail: exe})
		} else {
			add(Check{Name: "on PATH", Required: false, OK: false,
				Detail: binDir + " is not on PATH",
				Fix:    "add " + binDir + " to PATH, or run the binary by its full path"})
		}
	}

	return Report{Checks: checks}
}

// findMemsrv looks where the binary is actually put: an explicit flag, then
// the checkout's debug and release dirs, using the platform's executable name.
func findMemsrv(env Env) (string, bool) {
	if env.Memsrv != "" {
		if _, err := env.Stat(env.Memsrv); err == nil {
			return env.Memsrv, true
		}
		return "", false
	}
	if env.Repo == "" {
		return "", false
	}
	name := "memsrv"
	if filepath.Separator == '\\' {
		name = "memsrv.exe"
	}
	for _, rel := range []string{
		filepath.Join("memory-layer", "target", "debug", name),
		filepath.Join("memory-layer", "target", "release", name),
	} {
		p := filepath.Join(env.Repo, rel)
		if _, err := env.Stat(p); err == nil {
			return p, true
		}
	}
	return "", false
}

func onPath(env Env, dir string) bool {
	for _, p := range filepath.SplitList(os.Getenv("PATH")) {
		if p == "" {
			continue
		}
		if same(p, dir) {
			return true
		}
	}
	return false
}

func same(a, b string) bool {
	ra, err1 := filepath.Abs(a)
	rb, err2 := filepath.Abs(b)
	if err1 != nil || err2 != nil {
		return a == b
	}
	if filepath.Separator == '\\' {
		// Windows compares case-insensitively, and this is a PATH question
		// where "C:\Bin" and "c:\bin" are the same directory.
		return strings.EqualFold(ra, rb)
	}
	return ra == rb
}

// msysPath reports a Git Bash path shape (/c/Users/...) on Windows. Native
// Windows programs do not translate it, so it silently addresses a directory
// that does not exist — a failure that looks like a missing checkout.
func msysPath(p string) bool {
	if filepath.Separator != '\\' || len(p) < 3 {
		return false
	}
	if p[0] != '/' && p[0] != '\\' {
		return false
	}
	letter := (p[1] >= 'a' && p[1] <= 'z') || (p[1] >= 'A' && p[1] <= 'Z')
	return letter && (p[2] == '/' || p[2] == '\\')
}

// nodeAtLeast compares "v22.23.2" against "22.18" by major then minor.
//
// Not a semver library: the question is one comparison against one constant,
// and pulling in a parser to answer it would be the kind of dependency that
// makes a diagnosis slower to trust.
func nodeAtLeast(version, floor string) bool {
	clean := func(s string) (int, int) {
		s = strings.TrimPrefix(strings.TrimSpace(s), "v")
		parts := strings.SplitN(s, ".", 3)
		maj, min := 0, 0
		if len(parts) > 0 {
			maj, _ = strconv.Atoi(parts[0])
		}
		if len(parts) > 1 {
			min, _ = strconv.Atoi(parts[1])
		}
		return maj, min
	}
	vmaj, vmin := clean(version)
	fmaj, fmin := clean(floor)
	if vmaj != fmaj {
		return vmaj > fmaj
	}
	return vmin >= fmin
}
