package auth

import "testing"

const listOutput = `mnemo: loading
skills: 27 loaded
memory: journal opened

provider     model
anthropic    claude-opus-5
anthropic    claude-sonnet-5
openrouter   deepseek-v4-flash
`

func TestParsingStartsAtTheHeaderNotLineZero(t *testing.T) {
	// The command prints startup chatter first; a parser that starts at line
	// 0 turns "skills: 27" into a model called 27.
	got := ParseList(listOutput)
	if len(got) != 3 {
		t.Fatalf("parsed %d models: %+v", len(got), got)
	}
	if got[0].Provider != "anthropic" || got[0].Name != "claude-opus-5" {
		t.Fatalf("first row = %+v", got[0])
	}
	if got[2].String() != "openrouter/deepseek-v4-flash" {
		t.Fatalf("last row = %q", got[2])
	}
}

func TestNoHeaderMeansNoModels(t *testing.T) {
	if got := ParseList("some error\nand nothing else\n"); len(got) != 0 {
		t.Fatalf("parsed %+v out of output with no table", got)
	}
	if got := ParseList(""); len(got) != 0 {
		t.Fatalf("parsed %+v out of nothing", got)
	}
}

func TestFilterMatchesEitherHalf(t *testing.T) {
	models := ParseList(listOutput)
	if got := FilterModels(models, "opus"); len(got) != 1 {
		t.Fatalf("filtering by model name gave %+v", got)
	}
	if got := FilterModels(models, "anthropic"); len(got) != 2 {
		t.Fatalf("filtering by provider gave %+v", got)
	}
	if got := FilterModels(models, "ANTHROPIC"); len(got) != 2 {
		t.Fatal("you do not remember the case of a provider id")
	}
	if got := FilterModels(models, ""); len(got) != 3 {
		t.Fatal("an empty filter is not a filter")
	}
}

func TestFetchWithoutARepoSaysSoInsteadOfReturningNothing(t *testing.T) {
	// An empty list and a failed question must not look the same, or a
	// network blip reads as a broken account.
	if _, err := Fetch(""); err == nil {
		t.Fatal("expected an error naming what is missing")
	}
}

func TestLastLineIsTheUsefulPartOfAStackTrace(t *testing.T) {
	if got := lastLine("Error: boom\n  at foo\n  at bar\nActual: no such provider\n"); got != "Actual: no such provider" {
		t.Fatalf("lastLine = %q", got)
	}
	if got := lastLine("   \n\n"); got != "no output" {
		t.Fatalf("lastLine = %q", got)
	}
}
