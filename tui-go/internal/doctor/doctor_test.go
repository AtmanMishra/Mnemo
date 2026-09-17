package doctor

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A doctor that is wrong about a broken machine is worse than no doctor, so
// every check is exercised through the injected environment rather than by
// reasoning about what it would do.

type fakeFS struct {
	files map[string]string
	dirs  map[string]bool
	deny  map[string]bool // paths that refuse to be written
}

func newFS() *fakeFS {
	return &fakeFS{files: map[string]string{}, dirs: map[string]bool{}, deny: map[string]bool{}}
}

func (f *fakeFS) stat(p string) (os.FileInfo, error) {
	if _, ok := f.files[p]; ok {
		return fakeInfo{}, nil
	}
	if f.dirs[p] {
		return fakeInfo{}, nil
	}
	return nil, errors.New("not found")
}

func (f *fakeFS) read(p string) ([]byte, error) {
	if s, ok := f.files[p]; ok {
		return []byte(s), nil
	}
	return nil, errors.New("not found")
}

func (f *fakeFS) write(p string, b []byte, _ os.FileMode) error {
	if f.deny[p] || f.deny[filepath.Dir(p)] {
		return errors.New("permission denied")
	}
	f.files[p] = string(b)
	return nil
}

func (f *fakeFS) remove(p string) error { delete(f.files, p); return nil }
func (f *fakeFS) mkdir(p string, _ os.FileMode) error {
	if f.deny[p] {
		return errors.New("permission denied")
	}
	f.dirs[p] = true
	return nil
}

// fakeInfo satisfies os.FileInfo minimally; only its existence is read.
type fakeInfo struct{}

func (fakeInfo) Name() string       { return "f" }
func (fakeInfo) Size() int64        { return 1 }
func (fakeInfo) Mode() os.FileMode  { return 0o644 }
func (fakeInfo) ModTime() time.Time { return time.Unix(0, 0) }
func (fakeInfo) IsDir() bool        { return false }
func (fakeInfo) Sys() any           { return nil }

// healthy is an installation where everything works, so each test can break
// exactly one thing and assert the difference.
func healthy(t *testing.T) (Env, *fakeFS) {
	t.Helper()
	fs := newFS()
	home := `/home/u`
	repo := `/repo`
	fs.dirs[home+`/.mnemo`] = true
	fs.files[home+`/.mnemo/auth.json`] = `{"providers":{"anthropic":{"api_key":"sk-x"}},"defaultModel":"claude-x"}`
	fs.files[filepath.Join(repo, "agent", "bin", "mnemo.ts")] = "// agent"
	fs.dirs[filepath.Join(repo, "agent", "node_modules")] = true
	return Env{
		Home: home, CWD: home, Repo: repo,
		// The real loader is what main() injects; here it is a stub, because
		// what is under test is the diagnosis, not the store.
		Auth: func(string) ([]string, string) {
			if fs.files[home+`/.mnemo/auth.json`] == "" {
				return nil, ""
			}
			return []string{"anthropic"}, "claude-x"
		},
		LookPath:  func(string) (string, error) { return "/usr/bin/node", nil },
		Stat:      fs.stat,
		ReadFile:  fs.read,
		WriteFile: fs.write,
		Remove:    fs.remove,
		MkdirAll:  fs.mkdir,
		Run:       func(string, ...string) (string, error) { return "v22.23.2", nil },
	}, fs
}

func find(r Report, name string) (Check, bool) {
	for _, c := range r.Checks {
		if c.Name == name {
			return c, true
		}
	}
	return Check{}, false
}

func TestAHealthyInstallationPasses(t *testing.T) {
	env, _ := healthy(t)
	r := Run(env)
	if got := r.Failed(); got != 0 {
		t.Fatalf("Failed() = %d, want 0:\n%s", got, r)
	}
	if !strings.Contains(r.Summary(), "can run") && !strings.Contains(r.Summary(), "Everything") {
		t.Fatalf("summary = %q", r.Summary())
	}
}

// The invariant the whole package exists for: a failure without a remedy is a
// slower way of saying "something is wrong", and the person reading it is
// already frustrated.
func TestEveryFailureCarriesAFix(t *testing.T) {
	broken := map[string]func(Env, *fakeFS) Env{
		"no provider": func(e Env, f *fakeFS) Env {
			f.files[e.Home+`/.mnemo/auth.json`] = `{}`
			return e
		},
		"no node": func(e Env, f *fakeFS) Env {
			e.LookPath = func(string) (string, error) { return "", errors.New("not found") }
			return e
		},
		"old node": func(e Env, f *fakeFS) Env {
			e.Run = func(string, ...string) (string, error) { return "v22.12.0", nil }
			return e
		},
		"node will not run": func(e Env, f *fakeFS) Env {
			e.Run = func(string, ...string) (string, error) { return "", errors.New("boom") }
			return e
		},
		"wrong repo": func(e Env, f *fakeFS) Env {
			e.Repo = `/not-a-checkout`
			return e
		},
		"deps not installed": func(e Env, f *fakeFS) Env {
			delete(f.dirs, filepath.Join(e.Repo, "agent", "node_modules"))
			return e
		},
		"no repo flag": func(e Env, f *fakeFS) Env {
			e.Repo = ""
			return e
		},
		"home not writable": func(e Env, f *fakeFS) Env {
			f.deny[e.Home+`/.mnemo`] = true
			return e
		},
		"no sidecar": func(e Env, f *fakeFS) Env {
			return e // healthy() never places one
		},
	}

	for name, breakIt := range broken {
		env, fs := healthy(t)
		r := Run(breakIt(env, fs))
		bad := 0
		for _, c := range r.Checks {
			if c.OK {
				continue
			}
			bad++
			if strings.TrimSpace(c.Fix) == "" {
				t.Fatalf("%s: check %q failed with no fix:\n%s", name, c.Name, r)
			}
		}
		if bad == 0 {
			t.Fatalf("%s: nothing was reported as wrong, so the test proves nothing", name)
		}
	}
}

// The failure that started this: a Node below the floor fails on every .ts
// file with a message that reads like a broken install rather than an old
// runtime, so the fix has to name the version AND say why.
func TestAnOldNodeIsNamedWithTheReason(t *testing.T) {
	env, _ := healthy(t)
	env.Run = func(string, ...string) (string, error) { return "v22.12.0", nil }
	r := Run(env)

	c, ok := find(r, "node")
	if !ok || c.OK {
		t.Fatalf("an old node must fail the node check:\n%s", r)
	}
	if !strings.Contains(c.Fix, NodeFloor) || !strings.Contains(c.Fix, "ERR_UNKNOWN_FILE_EXTENSION") {
		t.Fatalf("the fix must name the floor and the symptom, got %q", c.Fix)
	}
	if r.Failed() == 0 {
		t.Fatal("a broken node is a required failure — the exit code must say so")
	}
}

// A missing memory sidecar turns a feature off; it does not stop Mnemo from
// working, and an exit code that says otherwise sends people chasing the wrong
// thing.
func TestAMissingOptionalPieceWarnsWithoutFailing(t *testing.T) {
	env, _ := healthy(t)
	r := Run(env)
	c, _ := find(r, "memory sidecar")
	if c.OK || c.Required {
		t.Fatalf("the sidecar check should be a warning: OK=%v Required=%v", c.OK, c.Required)
	}
	if r.Failed() != 0 {
		t.Fatalf("Failed() = %d, want 0 — a feature being off is not a broken install", r.Failed())
	}
	if r.Warnings() == 0 {
		t.Fatal("it must still be counted as a warning so the summary mentions it")
	}
	if !strings.Contains(r.Summary(), "can run") {
		t.Fatalf("summary must not cry wolf: %q", r.Summary())
	}
}

func TestAWrongRepoPathSaysWhatRightLooksLike(t *testing.T) {
	env, _ := healthy(t)
	env.Repo = `/somewhere/else`
	r := Run(env)
	c, _ := find(r, "agent runtime")
	if c.OK {
		t.Fatalf("a checkout without agent/bin/mnemo.ts cannot run the agent:\n%s", r)
	}
	if !strings.Contains(c.Fix, "contains agent/") {
		t.Fatalf("the fix must describe the right shape of path, got %q", c.Fix)
	}
}

// Hit by hand while writing this file: on Windows a Git Bash path addresses
// nothing, and the resulting failure reads as a missing checkout rather than a
// path that was never resolved. The hint is Windows-only, and the assertion
// follows suit rather than asserting a platform detail on every OS.
func TestAGitBashPathOnWindowsIsNamed(t *testing.T) {
	if filepath.Separator != '\\' {
		t.Skip("a Git Bash path is a Windows-specific trap")
	}
	env, _ := healthy(t)
	env.Repo = `/c/self-evolving-agent`
	c, _ := find(Run(env), "agent runtime")
	if c.OK {
		t.Fatal("an un-translated path must not read as healthy")
	}
	if !strings.Contains(c.Fix, "Git Bash") || !strings.Contains(c.Fix, "C:/") {
		t.Fatalf("the fix must name the trap and the shape that works, got %q", c.Fix)
	}
}

func TestNodeComparison(t *testing.T) {
	for _, tc := range []struct {
		version string
		want    bool
	}{
		{"v22.23.2", true}, {"22.18.0", true}, {"v22.18", true},
		{"v22.17.9", false}, {"v22.12.0", false}, {"v20.11.0", false},
		{"v23.0.0", true}, {"", false}, {"nonsense", false},
	} {
		if got := nodeAtLeast(tc.version, NodeFloor); got != tc.want {
			t.Errorf("nodeAtLeast(%q, %q) = %v, want %v", tc.version, NodeFloor, got, tc.want)
		}
	}
}
