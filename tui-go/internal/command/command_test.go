package command

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// skill writes a SKILL.md under a temporary tree. Every path in this file is
// derived from t.TempDir(): a discovery test that reaches the developer's
// real ~/.claude passes for the wrong reason and lists their machine.
func skill(t *testing.T, dir, folder, front string) {
	t.Helper()
	d := filepath.Join(dir, folder)
	if err := os.MkdirAll(d, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(d, "SKILL.md"), []byte(front), 0o644); err != nil {
		t.Fatal(err)
	}
}

func front(name, desc string) string {
	return "---\nname: " + name + "\ndescription: " + desc + "\n---\n\nbody\n"
}

func names(cs []Command) []string {
	out := make([]string, len(cs))
	for i, c := range cs {
		out[i] = c.Name
	}
	return out
}

func has(cs []Command, name string) bool {
	_, ok := Find(cs, name)
	return ok
}

func TestFrontmatterTakesTheFirstPair(t *testing.T) {
	n, d := Frontmatter("---\nname: caveman\ndescription: terse prose\nname: ignored\n---\n")
	if n != "caveman" || d != "terse prose" {
		t.Fatalf("got %q / %q", n, d)
	}
}

func TestFrontmatterToleratesQuotesAndBlankLeadingLines(t *testing.T) {
	n, _ := Frontmatter("\n\n---\nname: \"quoted-name\"\n---\n")
	if n != "quoted-name" {
		t.Fatalf("got %q", n)
	}
}

func TestAFileWithNoFrontmatterYieldsNothing(t *testing.T) {
	if n, d := Frontmatter("# just a heading\n"); n != "" || d != "" {
		t.Fatalf("got %q / %q", n, d)
	}
}

func TestASkillFolderWithoutFrontmatterIsNamedByItsFolder(t *testing.T) {
	dir := t.TempDir()
	skill(t, dir, "my-thing", "no frontmatter here")
	got := ScanSkills(dir, "project", Skill)
	if len(got) != 1 || got[0].Name != "my-thing" {
		t.Fatalf("got %#v", got)
	}
}

func TestNamesAreMadeTypeable(t *testing.T) {
	// A skill called "High End Visual Design" has to be reachable by typing.
	dir := t.TempDir()
	skill(t, dir, "x", front("High End Visual Design", "d"))
	got := ScanSkills(dir, "project", Skill)
	if got[0].Name != "high-end-visual-design" {
		t.Fatalf("name = %q", got[0].Name)
	}
}

func TestMissingDirectoriesAreNotAnError(t *testing.T) {
	// Most of the roots do not exist on most machines.
	if got := ScanSkills(filepath.Join(t.TempDir(), "nope"), "project", Skill); got != nil {
		t.Fatalf("got %#v", got)
	}
	if got := ScanPlugins(t.TempDir()); got != nil {
		t.Fatalf("got %#v", got)
	}
	if got := ScanHarnesses(filepath.Join(t.TempDir(), "nope")); got != nil {
		t.Fatalf("got %#v", got)
	}
}

func TestRootsWalkUpToTheGitRootAndNoFurther(t *testing.T) {
	base := t.TempDir()
	repo := filepath.Join(base, "repo")
	deep := filepath.Join(repo, "a", "b")
	if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	var dirs []string
	for _, r := range Roots(deep, filepath.Join(base, "home")) {
		dirs = append(dirs, r.Dir)
	}
	joined := strings.Join(dirs, "\n")
	if !strings.Contains(joined, filepath.Join(deep, ".claude", "skills")) {
		t.Fatal("the directory you are in must be searched first")
	}
	if !strings.Contains(joined, filepath.Join(repo, ".claude", "skills")) {
		t.Fatal("the repository root must be searched")
	}
	if strings.Contains(joined, filepath.Join(base, ".claude", "skills")) {
		t.Fatal("above the repository you are in somebody else's business")
	}
}

func TestNearestSkillWins(t *testing.T) {
	base := t.TempDir()
	repo := filepath.Join(base, "repo")
	home := filepath.Join(base, "home")
	if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	skill(t, filepath.Join(repo, ".claude", "skills"), "review", front("review", "the project's own"))
	skill(t, filepath.Join(home, ".claude", "skills"), "review", front("review", "the global one"))
	got := Load(repo, home, filepath.Join(base, "bundles"))
	c, ok := Find(got, "review")
	if !ok {
		t.Fatal("review not found")
	}
	if c.Desc != "the project's own" {
		t.Fatalf("the project skill must shadow the global one, got %q", c.Desc)
	}
	if n := strings.Count(strings.Join(names(got), " "), "review"); n != 1 {
		t.Fatalf("a shadowed skill must not appear twice: %v", names(got))
	}
}

func TestPluginSkillsAreNamespacedByTheirPlugin(t *testing.T) {
	// Two plugins shipping a "review" skill must not collide.
	home := t.TempDir()
	for _, p := range []string{"alpha", "beta"} {
		dir := filepath.Join(home, ".claude", "plugins", "cache", "owner", p, "1.0.0", "skills")
		skill(t, dir, "review", front("review", "from "+p))
	}
	got := ScanPlugins(home)
	if len(got) != 2 {
		t.Fatalf("got %v", names(got))
	}
	if !has(got, "alpha:review") || !has(got, "beta:review") {
		t.Fatalf("got %v", names(got))
	}
}

func TestOnlyTheNewestVersionOfAPluginCounts(t *testing.T) {
	home := t.TempDir()
	base := filepath.Join(home, ".claude", "plugins", "cache", "owner", "p")
	skill(t, filepath.Join(base, "1.0.0", "skills"), "s", front("s", "old"))
	skill(t, filepath.Join(base, "2.0.0", "skills"), "s", front("s", "new"))
	got := ScanPlugins(home)
	if len(got) != 1 || got[0].Desc != "new" {
		t.Fatalf("an older copy in the cache is not a second plugin: %#v", got)
	}
}

func TestHarnessBundlesReportTheirToolCount(t *testing.T) {
	dir := t.TempDir()
	b := filepath.Join(dir, "web")
	if err := os.MkdirAll(b, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(b, "manifest.json"),
		[]byte(`{"name":"Web Tools","tools":[1,2,3]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	got := ScanHarnesses(dir)
	if len(got) != 1 || got[0].Name != "web-tools" || got[0].Desc != "3 tools" {
		t.Fatalf("got %#v", got)
	}
}

func TestEveryBuiltinHasADescription(t *testing.T) {
	for _, c := range Builtins() {
		if c.Name == "" || c.Desc == "" {
			t.Fatalf("a command with no description would show a blank row: %#v", c)
		}
		if strings.HasPrefix(c.Name, "/") {
			t.Fatalf("names are stored without the slash: %q", c.Name)
		}
	}
}

func TestAFoldedDescriptionIsReadNotTakenLiterally(t *testing.T) {
	// `description: >-` puts the text on the following lines. Taking the
	// marker literally described a whole shelf of skills as ">".
	_, d := Frontmatter("---\nname: x\ndescription: >-\n  first line\n  second line\n---\n")
	if d != "first line second line" {
		t.Fatalf("got %q", d)
	}
	_, d = Frontmatter("---\ndescription: |\n  literal text\nname: y\n---\n")
	if d != "literal text" {
		t.Fatalf("got %q", d)
	}
}

func TestMatchIgnoresDescriptions(t *testing.T) {
	// A two-letter prefix that matches eighty rows is a menu you stop
	// reading. Names only.
	cs := []Command{
		{Name: "copy", Desc: "copy the whole transcript"},
		{Name: "sessions", Desc: "resume a conversation"},
	}
	if got := Match(cs, "/c"); len(got) != 1 || got[0].Name != "copy" {
		t.Fatalf("got %v", names(got))
	}
}

func TestMatchIsAPrefixMatchFirst(t *testing.T) {
	// You are completing a name you are part way through typing. A fuzzy
	// matcher that reorders the list under your fingers is worse than none.
	cs := []Command{
		{Name: "memory", Desc: "what Mnemo remembers"},
		{Name: "sessions", Desc: "resume a conversation"},
		{Name: "mouse", Desc: "drag-select"},
	}
	got := Match(cs, "/me")
	if len(got) == 0 || got[0].Name != "memory" {
		t.Fatalf("got %v", names(got))
	}
	all := Match(cs, "/ou")
	if len(all) != 1 || all[0].Name != "mouse" {
		t.Fatalf("a name that contains the query still matches: %v", names(all))
	}
}

func TestAnEmptyQueryListsEverything(t *testing.T) {
	cs := Builtins()
	if len(Match(cs, "/")) != len(cs) {
		t.Fatal("typing just a slash must show the whole menu")
	}
}

func TestASkillPromptCarriesItsPathSoTheAgentCanReadIt(t *testing.T) {
	c := Command{Name: "caveman", Kind: Skill, Path: "/tmp/skills/caveman/SKILL.md"}
	got := c.Prompt("be terse")
	if !strings.Contains(got, "/tmp/skills/caveman/SKILL.md") {
		t.Fatalf("a name alone makes the agent guess which one you meant: %q", got)
	}
	if !strings.Contains(got, "be terse") {
		t.Fatalf("arguments must survive: %q", got)
	}
	if strings.Contains(c.Prompt(""), "\n\n") {
		t.Fatal("no arguments means no trailing blank paragraph")
	}
}

func TestLoadAlwaysIncludesTheBuiltins(t *testing.T) {
	got := Load(t.TempDir(), t.TempDir(), t.TempDir())
	for _, want := range []string{"help", "sessions", "memory", "logs", "login", "model", "logout", "clear", "quit"} {
		if !has(got, want) {
			t.Fatalf("/%s is missing: %v", want, names(got))
		}
	}
}

func TestASkillCannotShadowABuiltin(t *testing.T) {
	// /quit must always quit.
	base := t.TempDir()
	repo := filepath.Join(base, "repo")
	if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	skill(t, filepath.Join(repo, ".claude", "skills"), "quit", front("quit", "not the built-in"))
	c, _ := Find(Load(repo, filepath.Join(base, "home"), base), "quit")
	if c.Kind != Builtin {
		t.Fatalf("a skill shadowed a built-in: %#v", c)
	}
}

func TestDeepTreesDoNotHang(t *testing.T) {
	// No .git anywhere: the walk must stop on its own rather than climbing to /.
	deep := t.TempDir()
	for i := 0; i < 5; i++ {
		deep = filepath.Join(deep, "d")
	}
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	if got := Roots(deep, t.TempDir()); len(got) == 0 {
		t.Fatal("expected some roots")
	}
}

// --- the agent's own commands --------------------------------------------

func TestTheAgentsCommandsJoinTheListWithoutDisplacingIt(t *testing.T) {
	// pi's answer: what it implements (an extension command and a prompt
	// template), plus two shapes that happen in the wild — a name that is
	// already taken, and an entry with no name at all.
	base := []Command{
		{Name: "help", Desc: "every key and command", Kind: Builtin, Chord: "^h"},
		{Name: "tidy", Desc: "clean up", Kind: Skill, Scope: "project", Path: "/p/SKILL.md"},
	}
	got := Merge(base, []Command{
		{Name: "help", Desc: "the agent's own help", Kind: Agent},
		{Name: "hook", Desc: "list hooks", Kind: Agent, Scope: "extension"},
		{Name: "", Desc: "nameless", Kind: Agent},
		{Name: "hook", Desc: "a second hook", Kind: Agent, Scope: "extension"},
	})
	if len(got) != 3 {
		t.Fatalf("got %v", names(got))
	}

	// The interface's own command keeps the name: it is the one that can open
	// a surface, and an agent command cannot do that for it.
	help, _ := Find(got, "help")
	if help.Kind != Builtin || help.Chord != "^h" || help.Desc != "every key and command" {
		t.Fatalf("the agent displaced the interface's own command: %#v", help)
	}
	// The agent's row is kept, in its own kind, with what the backend said.
	hook, ok := Find(got, "hook")
	if !ok || hook.Kind != Agent || hook.Kind.String() != "agent" || hook.Scope != "extension" {
		t.Fatalf("got %#v", hook)
	}
	// And the agent's rows come after everything the interface found itself.
	if got[len(got)-1].Name != "hook" {
		t.Fatalf("the agent's rows should follow the interface's: %v", names(got))
	}
}

func TestMergeOfAnEmptyAnswerChangesNothing(t *testing.T) {
	// A backend that says nothing — no reply, a failed reply, an empty list —
	// must leave the list it already had, not an empty one.
	base := Builtins()
	for _, extra := range [][]Command{nil, {}, {{Name: "", Desc: "nameless"}}} {
		got := Merge(base, extra)
		if len(got) != len(base) || strings.Join(names(got), ",") != strings.Join(names(base), ",") {
			t.Fatalf("Merge(base, %#v) = %v", extra, names(got))
		}
	}
}

// --- one name, one row ---------------------------------------------------

// TestOneCommandIsOneRowWhicheverWayItIsSpelled: pi registers a skill as
// `skill:review`, the disk scan calls the same skill `review`; a SKILL.md whose
// frontmatter says "Code Review" and a folder called code-review are the same
// command too. Two rows for one command means the reader types one spelling and
// gets a different thing from the other.
func TestOneCommandIsOneRowWhicheverWayItIsSpelled(t *testing.T) {
	live := []Command{
		{Name: "skill:review", Desc: "review the diff", Kind: Agent, Scope: "skill"},
		{Name: "skill:Code Review", Desc: "the same skill, capitalised", Kind: Agent, Scope: "skill"},
		{Name: "impl", Desc: "implement a plan", Kind: Agent, Scope: "prompt"},
	}
	disk := []Command{
		{Name: "help", Desc: "every key and command", Kind: Builtin, Chord: "^h"},
		{Name: "review", Desc: "the same skill, off disk", Kind: Skill, Path: "/p/review/SKILL.md"},
		{Name: "code-review", Desc: "and again from the frontmatter", Kind: Skill},
		{Name: "tidy", Desc: "clean up", Kind: Skill},
	}
	got := Catalogue(live, disk)

	// The agent's two rows are kept — they are what pi will run — and the two
	// disk spellings of the same commands are not listed beside them.
	for _, want := range []string{"skill:review", "skill:Code Review"} {
		c, ok := Find(got, want)
		if !ok || c.Kind != Agent {
			t.Fatalf("the surviving row for %s must be the agent's own: %#v", want, c)
		}
	}
	for _, dup := range []string{"review", "code-review"} {
		if has(got, dup) {
			t.Fatalf("/%s is a second spelling of a command the agent already answers: %v", dup, names(got))
		}
	}
	// And the rows that are nobody else's are still there: folding names must
	// not quietly shorten the catalogue.
	for _, want := range []string{"help", "impl", "tidy"} {
		if !has(got, want) {
			t.Fatalf("/%s went missing: %v", want, names(got))
		}
	}
}

// TestTheCatalogueIsTheDiskScanWhenTheAgentSaysNothing: offline (and before a
// live answer arrives) the disk scan IS the list — the built-ins, which the
// interface always has, plus everything found on disk. This is the fallback the
// whole design rests on.
func TestTheCatalogueIsTheDiskScanWhenTheAgentSaysNothing(t *testing.T) {
	disk := []Command{
		{Name: "help", Desc: "every key and command", Kind: Builtin},
		{Name: "tidy", Desc: "clean up", Kind: Skill, Path: "/p/tidy/SKILL.md"},
	}
	got := Catalogue(nil, disk)
	want := Merge(Builtins(), disk)
	if strings.Join(names(got), ",") != strings.Join(names(want), ",") {
		t.Fatalf("Catalogue(nil, disk) = %v, want every disk row under the built-ins", names(got))
	}
	if !has(got, "tidy") {
		t.Fatalf("with nothing to ask, the disk is the catalogue: %v", names(got))
	}
	if got[0].Kind != Builtin {
		t.Fatalf("the interface's own commands come first: %#v", got[0])
	}
}

// TestTheAgentsRowsComeBeforeTheDisks: the list is read top to bottom in the
// palette, and the rows that will actually run belong above the ones that are
// only installed.
func TestTheAgentsRowsComeBeforeTheDisks(t *testing.T) {
	live := []Command{{Name: "hook", Desc: "list and fire hooks", Kind: Agent}}
	disk := []Command{{Name: "tidy", Desc: "clean up", Kind: Skill}}
	got := Catalogue(live, disk)
	at := func(name string) int {
		for i, c := range got {
			if c.Name == name {
				return i
			}
		}
		t.Fatalf("%s is missing from %v", name, names(got))
		return -1
	}
	if !(at("help") < at("hook") && at("hook") < at("tidy")) {
		t.Fatalf("order should be built-ins, then the agent's rows, then disk: %v", names(got))
	}
}
