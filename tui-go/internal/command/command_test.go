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
	for _, want := range []string{"help", "sessions", "memory", "logs", "clear", "quit"} {
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
