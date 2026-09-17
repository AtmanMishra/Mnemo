// Package command is everything you can invoke by name: the built-in slash
// commands, the SKILL.md skills on disk, the plugins that ship skills of
// their own, and the harness bundles.
//
// One list, one lookup. The palette and the prompt's slash menu both read it,
// so a command cannot exist in one and not the other.
package command

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Kind decides how a command is run and how its row is coloured.
type Kind int

const (
	// Builtin is handled by the interface itself.
	Builtin Kind = iota
	// Skill is a SKILL.md the agent can be asked to use.
	Skill
	// Plugin is a skill that came from an installed plugin.
	Plugin
	// Harness is a bundle of tools.
	Harness
	// File is a @-mention completion — a reference to a file, not a runnable.
	File
	// Agent is a command the agent implements. The interface does not run it
	// and does not rewrite it: the line goes to pi as typed, which is what
	// executes an extension command and expands a prompt template or
	// /skill:name. Kept last so it cannot move the kinds already in use.
	Agent
)

func (k Kind) String() string {
	switch k {
	case Skill:
		return "skill"
	case Plugin:
		return "plugin"
	case Harness:
		return "harness"
	case File:
		return "file"
	case Agent:
		return "agent"
	}
	return "built-in"
}

// Command is one invocable thing.
type Command struct {
	Name  string // without the leading slash
	Desc  string
	Kind  Kind
	Scope string // "project" | "global" | plugin name
	Path  string // SKILL.md or manifest.json, for skills
	Chord string // the keystroke that also does it, for built-ins
}

// Builtins are the commands the interface handles itself.
//
// Every one of them is also a key. The slash menu exists because a name is
// easier to remember than a chord, not because there are two systems.
func Builtins() []Command {
	return []Command{
		{Name: "help", Desc: "every key and command", Kind: Builtin, Chord: "^h"},
		{Name: "explorer", Desc: "the folder explorer, on the right", Kind: Builtin, Chord: "^t"},
		{Name: "sessions", Desc: "resume a conversation", Kind: Builtin, Chord: "^s"},
		{Name: "memory", Desc: "what Mnemo remembers", Kind: Builtin, Chord: "^m"},
		{Name: "logs", Desc: "every run as a call graph", Kind: Builtin, Chord: "^l"},
		{Name: "schedules", Desc: "schedules and triggers", Kind: Builtin, Chord: "^o"},
		{Name: "thinking", Desc: "open every thinking block", Kind: Builtin, Chord: "^e"},
		{Name: "tools", Desc: "open every tool block", Kind: Builtin, Chord: "^r"},
		{Name: "expand", Desc: "open everything", Kind: Builtin, Chord: "^a"},
		{Name: "collapse", Desc: "close everything", Kind: Builtin, Chord: "^a"},
		{Name: "copy", Desc: "copy the whole transcript", Kind: Builtin, Chord: "Y"},
		{Name: "clear", Desc: "start a new session", Kind: Builtin},
		{Name: "compact", Desc: "summarise the older turns to shrink the context", Kind: Builtin},
		{Name: "fork", Desc: "branch the session at the message you choose", Kind: Builtin},
		{Name: "commands", Desc: "ask the agent for its command list again", Kind: Builtin},
		{Name: "theme", Desc: "pick the palette — saved to ~/.mnemo/theme.json", Kind: Builtin},
		{Name: "yolo", Desc: "stop asking for approval — on|off, saved to this project", Kind: Builtin},
		{Name: "login", Desc: "log in a provider — /login <provider> <key>, or /login alone to list them", Kind: Builtin},
		{Name: "model", Desc: "pick the default model from what your providers offer", Kind: Builtin},
		{Name: "logout", Desc: "forget a provider's key — /logout <provider>", Kind: Builtin},
		{Name: "quit", Desc: "leave", Kind: Builtin, Chord: "^d"},
	}
}

// Roots are every directory a skill can live in, nearest first.
//
// Nearest first matters: a project skill with the same name as a global one
// is the one you meant. Walking stops at the git root, because above a
// repository you are in somebody else's business.
func Roots(start, home string) []struct {
	Dir   string
	Scope string
} {
	type root = struct {
		Dir   string
		Scope string
	}
	var out []root
	cur := start
	for i := 0; i < 64; i++ { // a symlink loop must not hang the interface
		for _, d := range []string{".claude", ".pi", ".agents"} {
			out = append(out, root{filepath.Join(cur, d, "skills"), "project"})
		}
		if _, err := os.Stat(filepath.Join(cur, ".git")); err == nil {
			break
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			break
		}
		cur = parent
	}
	out = append(out,
		root{filepath.Join(home, ".claude", "skills"), "global"},
		root{filepath.Join(home, ".pi", "agent", "skills"), "global"},
		root{filepath.Join(home, ".agents", "skills"), "global"},
	)
	return out
}

// Frontmatter reads the first name/description pair out of a SKILL.md.
func Frontmatter(md string) (name, desc string) {
	lines := strings.Split(md, "\n")
	i := 0
	for i < len(lines) && strings.TrimSpace(lines[i]) == "" {
		i++
	}
	if i >= len(lines) || strings.TrimSpace(lines[i]) != "---" {
		return "", ""
	}
	for i++; i < len(lines); i++ {
		l := strings.TrimSpace(lines[i])
		if l == "---" {
			break
		}
		if v, ok := strings.CutPrefix(l, "name:"); ok && name == "" {
			name = clean(v)
		}
		if v, ok := strings.CutPrefix(l, "description:"); ok && desc == "" {
			desc = clean(v)
			// YAML folded and literal scalars: `description: >-` puts the
			// text on the following indented lines. Taking the marker
			// literally is how a whole shelf of skills ends up described as
			// ">" — which is what shipped the first time.
			if desc == ">" || desc == "|" || desc == ">-" || desc == "|-" {
				desc = folded(lines, i+1)
			}
		}
	}
	return name, desc
}

// folded gathers the indented continuation of a YAML block scalar.
func folded(lines []string, from int) string {
	var parts []string
	for i := from; i < len(lines); i++ {
		l := lines[i]
		if strings.TrimSpace(l) == "---" {
			break
		}
		if strings.TrimSpace(l) == "" {
			if len(parts) > 0 {
				break
			}
			continue
		}
		if l[0] != ' ' && l[0] != '\t' {
			break // back at column zero: the next key, not our text
		}
		parts = append(parts, strings.TrimSpace(l))
	}
	return strings.Join(parts, " ")
}

func clean(s string) string {
	return strings.Trim(strings.TrimSpace(s), `"'`)
}

// ScanSkills reads one directory of skill folders. A missing directory is not
// an error — most of the roots do not exist on most machines.
func ScanSkills(dir, scope string, kind Kind) []Command {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []Command
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		md := filepath.Join(dir, e.Name(), "SKILL.md")
		body, err := os.ReadFile(md)
		if err != nil {
			continue
		}
		name, desc := Frontmatter(string(body))
		if name == "" {
			name = e.Name()
		}
		out = append(out, Command{
			Name: slug(name), Desc: desc, Kind: kind, Scope: scope, Path: md,
		})
	}
	return out
}

// ScanPlugins walks the plugin cache: ~/.claude/plugins/cache/<owner>/<plugin>/<version>/skills/*.
//
// A plugin's skills are named after the plugin, the way they are invoked, so
// two plugins shipping a "review" skill do not collide.
func ScanPlugins(home string) []Command {
	cache := filepath.Join(home, ".claude", "plugins", "cache")
	owners, err := os.ReadDir(cache)
	if err != nil {
		return nil
	}
	var out []Command
	for _, o := range owners {
		if !o.IsDir() {
			continue
		}
		plugins, err := os.ReadDir(filepath.Join(cache, o.Name()))
		if err != nil {
			continue
		}
		for _, p := range plugins {
			if !p.IsDir() {
				continue
			}
			versions, err := os.ReadDir(filepath.Join(cache, o.Name(), p.Name()))
			if err != nil {
				continue
			}
			// Newest version wins; an older copy left in the cache is not a
			// second plugin.
			names := make([]string, 0, len(versions))
			for _, v := range versions {
				if v.IsDir() {
					names = append(names, v.Name())
				}
			}
			if len(names) == 0 {
				continue
			}
			sort.Strings(names)
			dir := filepath.Join(cache, o.Name(), p.Name(), names[len(names)-1], "skills")
			for _, c := range ScanSkills(dir, p.Name(), Plugin) {
				c.Name = slug(p.Name()) + ":" + c.Name
				out = append(out, c)
			}
		}
	}
	return out
}

// ScanHarnesses reads bundle manifests.
func ScanHarnesses(dir string) []Command {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []Command
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		manifest := filepath.Join(dir, e.Name(), "manifest.json")
		body, err := os.ReadFile(manifest)
		if err != nil {
			continue
		}
		var v map[string]any
		_ = json.Unmarshal(body, &v)
		name, _ := v["name"].(string)
		if name == "" {
			name = e.Name()
		}
		tools, _ := v["tools"].([]any)
		out = append(out, Command{
			Name: slug(name), Desc: plural(len(tools), "tool"), Kind: Harness,
			Scope: "harness", Path: manifest,
		})
	}
	return out
}

// Load builds the whole list: built-ins first, then skills, plugins and
// bundles, with duplicates removed nearest-first.
//
// start, home and harnessDir are all parameters. A discovery function that
// finds its own home is one that, in a test, finds the developer's.
func Load(start, home, harnessDir string) []Command {
	out := Builtins()
	seen := map[string]bool{}
	for _, c := range out {
		seen[c.Name] = true
	}
	add := func(cs []Command) {
		for _, c := range cs {
			if c.Name == "" || seen[c.Name] {
				continue // nearest wins; a shadowed skill is not a second one
			}
			seen[c.Name] = true
			out = append(out, c)
		}
	}
	for _, r := range Roots(start, home) {
		add(ScanSkills(r.Dir, r.Scope, Skill))
	}
	add(ScanPlugins(home))
	add(ScanHarnesses(harnessDir))
	return out
}

// Match filters by a typed prefix, the way a slash menu does.
//
// A prefix match, not a fuzzy one: you are completing a name you are part way
// through typing, and a fuzzy matcher that reorders the list under your
// fingers as you type is worse than no menu.
func Match(cs []Command, q string) []Command {
	q = strings.ToLower(strings.TrimPrefix(q, "/"))
	var exact, contains []Command
	for _, c := range cs {
		name := strings.ToLower(c.Name)
		switch {
		case strings.HasPrefix(name, q):
			exact = append(exact, c)
		case q != "" && strings.Contains(name, q):
			// Names only. Matching descriptions too turns "/c" into eighty
			// rows, because almost every sentence contains a c — and a menu
			// that answers a two-letter prefix with everything is a menu you
			// stop reading.
			contains = append(contains, c)
		}
	}
	return append(exact, contains...)
}

// Merge folds commands the agent implements into a list the interface built
// for itself.
//
// The interface's copy wins a name collision. Its commands are client
// affordances — they open overlays, fold the transcript, move the reader
// around — and nothing sent to the agent can do any of that, so a shadowed
// name is dropped rather than renamed: two rows that read the same and behave
// differently is worse than one row missing.
//
// Names are compared after canon(), not literally, because the same command
// arrives under two spellings: pi registers a skill as `skill:review` and the
// disk scan calls the same skill `review`.
func Merge(base, extra []Command) []Command {
	out := make([]Command, 0, len(base)+len(extra))
	seen := make(map[string]bool, len(base)+len(extra))
	take := func(cs []Command) {
		for _, c := range cs {
			name := canon(c.Name)
			if name == "" || seen[name] {
				continue
			}
			seen[name] = true
			out = append(out, c)
		}
	}
	take(base)
	take(extra)
	return out
}

// Catalogue is the one list: the interface's own commands, then whatever the
// agent answers with, then the disk scan.
//
// The agent's answer is the catalogue for the commands the agent implements —
// asked at start, re-asked on a new session and on demand, because a package
// installed mid-session is otherwise invisible until the process restarts.
//
// The disk scan is the fallback: with no agent attached it IS the list, and
// while one is attached it still contributes the rows pi does not answer for.
// Both can be in play at once, which is why names are folded (see canon): a
// name the agent already answers must not appear a second time under the
// spelling only the disk knows.
func Catalogue(live, disk []Command) []Command {
	return Merge(Merge(Builtins(), live), disk)
}

// canon is a command name's identity, for the one-row-per-command rule.
//
// It folds the three ways the same name gets spelled on the way here: case
// (pi is free to capitalise), separators (a SKILL.md may say "Code Review"
// where the folder says code-review), and the `skill:` prefix pi puts in front
// of a skill it registers. Only the LEADING skill: is dropped: a plugin's
// `alpha:review` is a different command from a bare `review`, and that colon is
// not a prefix marker.
func canon(name string) string {
	s := strings.ToLower(strings.TrimSpace(name))
	s = strings.TrimPrefix(s, "skill:")
	s = strings.Map(func(r rune) rune {
		switch r {
		case ' ', '_', '.':
			return '-'
		}
		return r
	}, s)
	for strings.Contains(s, "--") {
		s = strings.ReplaceAll(s, "--", "-")
	}
	return strings.Trim(s, "-")
}

// Find returns the command with exactly this name.
func Find(cs []Command, name string) (Command, bool) {
	name = strings.ToLower(strings.TrimPrefix(name, "/"))
	for _, c := range cs {
		if strings.ToLower(c.Name) == name {
			return c, true
		}
	}
	return Command{}, false
}

// Prompt is what to send the agent when a skill is invoked.
//
// The skill's path goes in because the agent has to read the file to follow
// it, and a name alone makes it guess which one you meant.
func (c Command) Prompt(args string) string {
	var b strings.Builder
	switch c.Kind {
	case Harness:
		b.WriteString("Use the " + c.Name + " harness bundle (" + c.Path + ").")
	default:
		b.WriteString("Use the " + c.Name + " skill. Its instructions are in " + c.Path + ".")
	}
	if strings.TrimSpace(args) != "" {
		b.WriteString("\n\n" + strings.TrimSpace(args))
	}
	return b.String()
}

// slug makes a name typeable: lowercase, no spaces.
func slug(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-', r == ':':
			return r
		case r == ' ', r == '_', r == '.':
			return '-'
		}
		return -1
	}, s)
	for strings.Contains(s, "--") {
		s = strings.ReplaceAll(s, "--", "-")
	}
	return strings.Trim(s, "-")
}

func plural(n int, unit string) string {
	s := itoa(n) + " " + unit
	if n != 1 {
		s += "s"
	}
	return s
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
