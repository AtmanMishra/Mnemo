package limits

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/auth"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/memory"
	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/prompt"
)

// write puts a file where Resolve will look for it, creating the directory
// ~/.mnemo the interface keeps its preferences in.
func write(t *testing.T, body string) string {
	t.Helper()
	p := Path(t.TempDir())
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// silent is an environment that says nothing, so a test asserting the file's
// answer is not reading the developer's.
func silent(string) string { return "" }

// The five tests below are one per tunable: the file takes effect. They are
// separate rather than table-driven so a failure names the number that broke.

func TestTheFileSetsTheListTimeout(t *testing.T) {
	got := Resolve(write(t, `{"list_timeout":"45s"}`), Overrides{}, silent)
	if got.ListTimeout != 45*time.Second {
		t.Fatalf("list_timeout: got %v, want 45s", got.ListTimeout)
	}
}

func TestTheFileSetsTheMemoryTimeout(t *testing.T) {
	got := Resolve(write(t, `{"memory_timeout":"90s"}`), Overrides{}, silent)
	if got.MemoryTimeout != 90*time.Second {
		t.Fatalf("memory_timeout: got %v, want 90s", got.MemoryTimeout)
	}
}

func TestTheFileSetsTheNoticeWindow(t *testing.T) {
	got := Resolve(write(t, `{"notice_for":"250ms"}`), Overrides{}, silent)
	if got.NoticeFor != 250*time.Millisecond {
		t.Fatalf("notice_for: got %v, want 250ms", got.NoticeFor)
	}
}

func TestTheFileSetsTheMenuRows(t *testing.T) {
	got := Resolve(write(t, `{"menu_rows":3}`), Overrides{}, silent)
	if got.MenuRows != 3 {
		t.Fatalf("menu_rows: got %d, want 3", got.MenuRows)
	}
}

func TestTheFileSetsTheMinimumKeyLength(t *testing.T) {
	got := Resolve(write(t, `{"min_key_len":4}`), Overrides{}, silent)
	if got.MinKeyLen != 4 {
		t.Fatalf("min_key_len: got %d, want 4", got.MinKeyLen)
	}
}

func TestOneFileCanSetAllFive(t *testing.T) {
	got := Resolve(write(t, `{
	  "list_timeout": "45s",
	  "memory_timeout": "90s",
	  "notice_for": "250ms",
	  "menu_rows": 3,
	  "min_key_len": 4
	}`), Overrides{}, silent)
	want := Limits{45 * time.Second, 90 * time.Second, 250 * time.Millisecond, 3, 4}
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

// TestACorruptFileConfiguresNothing is the one that matters for a hand-edited
// file: no way of failing to read it may stop the interface starting, and none
// of them may half-apply.
func TestACorruptFileConfiguresNothing(t *testing.T) {
	for name, body := range map[string]string{
		"half a file":               `{"list_timeout": "45s"`,
		"not an object":             `[1, 2, 3]`,
		"a bare string":             `"18s"`,
		"the literal null":          `null`,
		"nothing at all":            ``,
		"a value of the wrong kind": `{"menu_rows": "three"}`,
	} {
		if got := Resolve(write(t, body), Overrides{}, silent); got != (Limits{}) {
			t.Fatalf("%s: resolved %+v; every key must stay unconfigured, so the built-in default answers", name, got)
		}
	}
}

func TestAMissingFileConfiguresNothing(t *testing.T) {
	if got := Resolve(Path(t.TempDir()), Overrides{}, silent); got != (Limits{}) {
		t.Fatalf("no file: resolved %+v, want nothing configured", got)
	}
}

// TestAValueNobodyCanUseFallsBackToTheDefault: a value outside its range is
// ignored, not obeyed and not fatal. Zero is the case worth naming — a menu of
// no rows shows nothing, and a minimum key length of zero accepts an empty key.
func TestAValueNobodyCanUseFallsBackToTheDefault(t *testing.T) {
	for name, body := range map[string]string{
		"a timeout of zero":        `{"list_timeout": "0s"}`,
		"a negative timeout":       `{"memory_timeout": "-5s"}`,
		"a timeout in words":       `{"notice_for": "soon"}`,
		"a timeout past a day":     `{"list_timeout": "48h"}`,
		"a menu with no rows":      `{"menu_rows": 0}`,
		"a menu of minus one":      `{"menu_rows": -1}`,
		"a menu taller than ever":  `{"menu_rows": 5000}`,
		"an empty key accepted":    `{"min_key_len": 0}`,
		"a shorter key forbidden":  `{"min_key_len": -4}`,
		"a fractional menu height": `{"menu_rows": 2.5}`,
	} {
		if got := Resolve(write(t, body), Overrides{}, silent); got != (Limits{}) {
			t.Fatalf("%s: resolved %+v; an unusable value must leave the default in place", name, got)
		}
	}
}

// TestAKeyNobodyWroteIsLeftAlone: the file is partial all the time — this is
// one preference, not a profile — so the keys it does not mention must not be
// reset by its presence.
func TestAKeyNobodyWroteIsLeftAlone(t *testing.T) {
	got := Resolve(write(t, `{"menu_rows":3,"also_spelled_menu_rows":9}`), Overrides{}, silent)
	if got.MenuRows != 3 {
		t.Fatalf("menu_rows: got %d, want 3", got.MenuRows)
	}
	if got.ListTimeout != 0 || got.MemoryTimeout != 0 || got.NoticeFor != 0 || got.MinKeyLen != 0 {
		t.Fatalf("keys the file never mentioned must stay unconfigured, got %+v", got)
	}
}

func TestAKeyNobodyKnowsIsIgnored(t *testing.T) {
	got := Resolve(write(t, `{"rows":3,"spinner_interval":"1s","mnemo":{"menu_rows":3}}`), Overrides{}, silent)
	if got != (Limits{}) {
		t.Fatalf("unknown keys resolved into %+v; a file written for another build must still be readable", got)
	}
}

// TestANumberInTheFileIsSeconds: a hand-written file says 20, not "20s", and
// that has to mean twenty seconds rather than twenty nanoseconds.
func TestANumberInTheFileIsSeconds(t *testing.T) {
	got := Resolve(write(t, `{"list_timeout":20,"notice_for":0.5}`), Overrides{}, silent)
	if got.ListTimeout != 20*time.Second || got.NoticeFor != 500*time.Millisecond {
		t.Fatalf("got %v and %v, want 20s and 500ms", got.ListTimeout, got.NoticeFor)
	}
}

// TestTheFlagBeatsTheEnvironmentBeatsTheFile pins the precedence in one place:
// the more specific the answer, the later it is applied.
func TestTheFlagBeatsTheEnvironmentBeatsTheFile(t *testing.T) {
	p := write(t, `{"list_timeout":"45s","memory_timeout":"45s","menu_rows":3}`)
	env := func(k string) string {
		if k == EnvListTimeout {
			return "30s"
		}
		return ""
	}
	got := Resolve(p, Overrides{ListTimeout: "15s"}, env)
	if got.ListTimeout != 15*time.Second {
		t.Fatalf("flag: got %v, want 15s", got.ListTimeout)
	}
	if got.MemoryTimeout != 45*time.Second {
		t.Fatalf("file, with neither flag nor environment: got %v, want 45s", got.MemoryTimeout)
	}
	got = Resolve(p, Overrides{}, env)
	if got.ListTimeout != 30*time.Second {
		t.Fatalf("environment over the file: got %v, want 30s", got.ListTimeout)
	}
}

// TestAnUnreadableLayerIsSkippedNotFatal: a typo in the environment must not
// throw away a good file, and a typo on the command line must not throw away
// either.
func TestAnUnreadableLayerIsSkippedNotFatal(t *testing.T) {
	p := write(t, `{"menu_rows":3}`)
	env := func(k string) string {
		if k == EnvMenuRows {
			return "lots"
		}
		return ""
	}
	if got := Resolve(p, Overrides{MenuRows: "many"}, env); got.MenuRows != 3 {
		t.Fatalf("got %d, want the file's 3: an unusable value is silent, not fatal", got.MenuRows)
	}
}

// TestTheEnvironmentHasOneVariablePerKey pins the names README.md documents to
// the ones the code reads. They are the interface for anybody with a shell and
// no wish to write a file.
func TestTheEnvironmentHasOneVariablePerKey(t *testing.T) {
	want := map[string]string{
		EnvFile:          "MNEMO_LIMITS_FILE",
		EnvListTimeout:   "MNEMO_LIST_TIMEOUT",
		EnvMemoryTimeout: "MNEMO_MEMORY_TIMEOUT",
		EnvNoticeFor:     "MNEMO_NOTICE_FOR",
		EnvMenuRows:      "MNEMO_MENU_ROWS",
		EnvMinKeyLen:     "MNEMO_MIN_KEY_LEN",
	}
	for got, name := range want {
		if got != name {
			t.Fatalf("variable %q is documented as %q", got, name)
		}
	}
}

func TestTheKeyNamesAreTheFileSpelling(t *testing.T) {
	want := map[string]string{
		KeyListTimeout:   "list_timeout",
		KeyMemoryTimeout: "memory_timeout",
		KeyNoticeFor:     "notice_for",
		KeyMenuRows:      "menu_rows",
		KeyMinKeyLen:     "min_key_len",
	}
	for got, name := range want {
		if got != name {
			t.Fatalf("key %q is documented as %q", got, name)
		}
	}
}

// TestTheFileSitsBesideTheOtherPreferences: one home directory holds auth.json,
// theme.json and this file, so there is one place to look.
func TestTheFileSitsBesideTheOtherPreferences(t *testing.T) {
	if got, want := Path("/home/somebody"), filepath.Join("/home/somebody", ".mnemo", FileName); got != want {
		t.Fatalf("Path = %q, want %q", got, want)
	}
	// No home means no file: a path built from nothing would look for
	// .mnemo/limits.json under whatever directory the process is in.
	if got := Path(""); got != "" {
		t.Fatalf("an empty home found %q", got)
	}
}

// TestApplyHandsEachNumberToItsOwner is the wiring: the four numbers that live
// in packages this change owns are set from the resolved values, and the notice
// window is carried for the app package to read. Every value is put back, so
// running this test cannot change what another test sees.
func TestApplyHandsEachNumberToItsOwner(t *testing.T) {
	oldList, oldKey := auth.ListTimeout, auth.MinKeyLen
	oldMemory, oldRows := memory.Timeout, prompt.MenuRows
	oldNotice := NoticeFor
	t.Cleanup(func() {
		auth.ListTimeout, auth.MinKeyLen = oldList, oldKey
		memory.Timeout, prompt.MenuRows = oldMemory, oldRows
		NoticeFor = oldNotice
	})

	Apply(Limits{ListTimeout: 45 * time.Second, MemoryTimeout: 90 * time.Second, NoticeFor: 250 * time.Millisecond, MenuRows: 3, MinKeyLen: 4})
	if auth.ListTimeout != 45*time.Second {
		t.Fatalf("auth.ListTimeout = %v", auth.ListTimeout)
	}
	if auth.MinKeyLen != 4 {
		t.Fatalf("auth.MinKeyLen = %d", auth.MinKeyLen)
	}
	if memory.Timeout != 90*time.Second {
		t.Fatalf("memory.Timeout = %v", memory.Timeout)
	}
	if prompt.MenuRows != 3 {
		t.Fatalf("prompt.MenuRows = %d", prompt.MenuRows)
	}
	if NoticeFor != 250*time.Millisecond {
		t.Fatalf("NoticeFor = %v", NoticeFor)
	}
}

// TestApplyOfNothingChangesNothing is the out-of-the-box promise: with no file
// and no flags, every built-in default is exactly what it was. Apply is given
// the zero value on purpose — that is what Resolve answers with when nothing
// configured anything, and it must be read as "leave it alone".
func TestApplyOfNothingChangesNothing(t *testing.T) {
	before := []any{auth.ListTimeout, auth.MinKeyLen, memory.Timeout, prompt.MenuRows, NoticeFor}
	Apply(Limits{})
	after := []any{auth.ListTimeout, auth.MinKeyLen, memory.Timeout, prompt.MenuRows, NoticeFor}
	for i := range before {
		if before[i] != after[i] {
			t.Fatalf("field %d changed from %v to %v; nothing was configured", i, before[i], after[i])
		}
	}
}

// TestTheFiveKeysAreTheOnlySpellingThatReads: a near-miss key is unknown, not
// guessed at. Reading "list-timeout" as list_timeout would make the file's
// typos behave differently from its unknowns, and the reader would have no way
// to know which one happened.
func TestTheFiveKeysAreTheOnlySpellingThatReads(t *testing.T) {
	body, err := json.Marshal(map[string]any{
		"list-timeout": "45s", "memorytimeout": "90s", "MenuRows": 3, "menurows": 3, "minKeyLen": 4,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := Resolve(write(t, string(body)), Overrides{}, silent); got != (Limits{}) {
		t.Fatalf("near-miss keys resolved into %+v", got)
	}
}

// TestTheDurationGrammarIsTheFilesAndTheFlags pins the two spellings that are
// accepted, so the README's examples are the ones the code reads.
func TestTheDurationGrammarIsTheFilesAndTheFlags(t *testing.T) {
	for _, s := range []string{"20s", "1m30s", "20", " 250ms ", "0.5"} {
		if _, ok := parseDuration(s); !ok {
			t.Fatalf("%q must be a duration", s)
		}
	}
	for _, s := range []string{"", "  ", "soon", "20 s", "0s", "-1s", "s"} {
		if _, ok := parseDuration(s); ok {
			t.Fatalf("%q must not be accepted", s)
		}
	}
	if d, _ := parseDuration("1m30s"); d != 90*time.Second {
		t.Fatalf("1m30s = %v", d)
	}
	if !strings.Contains(FileName, ".json") {
		t.Fatalf("the file is %q, which is not a JSON file by name", FileName)
	}
}
