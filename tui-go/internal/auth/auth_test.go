package auth

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// Every test points at its own temp home. A store that finds its own home is
// one that, in a test, finds the developer's real credentials — and this file
// writes.
func home(t *testing.T) string { t.Helper(); return t.TempDir() }

func TestNotLoggedInIsAStateNotAnError(t *testing.T) {
	f := Load(home(t))
	if f.Configured() || len(f.LoggedIn()) != 0 {
		t.Fatal("an empty home is not logged in")
	}
	if f.Providers == nil {
		t.Fatal("the map must be usable without a nil check at every call site")
	}
	if f.EffectiveProvider() != "" {
		t.Fatal("nothing to pick")
	}
}

func TestAnUnreadableFileAlsoMeansNotLoggedIn(t *testing.T) {
	h := home(t)
	if err := os.MkdirAll(filepath.Dir(Path(h)), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(Path(h), []byte("{ this is not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if Load(h).Configured() {
		t.Fatal("a corrupt store must read as empty; the onboarding screen answers both")
	}
}

func TestAKeyTooShortIsRefusedWithSomethingToRead(t *testing.T) {
	h := home(t)
	_, err := SetKey(h, "anthropic", "short", "", time.Now())
	if err == nil {
		t.Fatal("a seven-character key is a paste that went wrong")
	}
	if !strings.Contains(err.Error(), "paste the whole thing") {
		t.Fatalf("the message is shown verbatim, so it has to say what to do: %q", err)
	}
	if Load(h).Configured() {
		t.Fatal("a refused key must not be stored")
	}
}

func TestAnUnknownProviderIsRefused(t *testing.T) {
	if _, err := SetKey(home(t), "not-a-provider", "sk-longenoughkey", "", time.Now()); err == nil {
		t.Fatal("only pi's own provider ids are storable")
	}
}

func TestCredentialsAreUserOnly(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no unix modes")
	}
	h := home(t)
	if _, err := SetKey(h, "anthropic", "sk-longenoughkey", "", time.Now()); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(Path(h))
	if err != nil {
		t.Fatal(err)
	}
	if mode := st.Mode().Perm(); mode != 0o600 {
		t.Fatalf("auth.json is %o, want 600", mode)
	}
}

func TestAnExistingWorldReadableStoreIsTightenedOnWrite(t *testing.T) {
	// WriteFile only applies its mode when it CREATES the file, so without an
	// explicit chmod a store that was once world-readable stays that way for
	// ever.
	if runtime.GOOS == "windows" {
		t.Skip("no unix modes")
	}
	h := home(t)
	if err := os.MkdirAll(filepath.Dir(Path(h)), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(Path(h), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := SetKey(h, "openai", "sk-longenoughkey", "", time.Now()); err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(Path(h))
	if mode := st.Mode().Perm(); mode != 0o600 {
		t.Fatalf("auth.json stayed %o", mode)
	}
}

func TestTheFirstLoginBecomesTheDefault(t *testing.T) {
	h := home(t)
	f, err := SetKey(h, "openrouter", "sk-longenoughkey", "some-model", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if f.DefaultProvider != "openrouter" {
		t.Fatalf("default = %q", f.DefaultProvider)
	}
	if f.EffectiveProvider() != "openrouter" {
		t.Fatal("the only logged-in provider is the effective one")
	}
}

func TestASecondLoginDoesNotStealTheDefault(t *testing.T) {
	// Logging in somewhere else, or picking a model there, must not silently
	// change which provider new sessions use.
	h := home(t)
	if _, err := SetKey(h, "openrouter", "sk-longenoughkey", "m1", time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := SetKey(h, "anthropic", "sk-anotherlongkey", "m2", time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := SetDefaultModel(h, "anthropic", "m3"); err != nil {
		t.Fatal(err)
	}
	if got := Load(h).DefaultProvider; got != "openrouter" {
		t.Fatalf("default moved to %q", got)
	}
}

func TestAStaleDefaultFallsBackInsteadOfBreaking(t *testing.T) {
	h := home(t)
	if _, err := SetKey(h, "openrouter", "sk-longenoughkey", "", time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := SetKey(h, "anthropic", "sk-anotherlongkey", "", time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := Logout(h, "openrouter"); err != nil {
		t.Fatal(err)
	}
	f := Load(h)
	if f.EffectiveProvider() != "anthropic" {
		t.Fatalf("effective = %q; a default pointing at a logged-out provider is a stale preference, not an error",
			f.EffectiveProvider())
	}
}

func TestLogoutRemovesTheCredential(t *testing.T) {
	h := home(t)
	if _, err := SetKey(h, "anthropic", "sk-longenoughkey", "", time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := Logout(h, "anthropic"); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(Path(h))
	if strings.Contains(string(raw), "sk-longenoughkey") {
		t.Fatal("a logged-out key must not stay on disk")
	}
}

func TestTheCanonicalDefaultIsOpencodeGoDeepseekV4Flash(t *testing.T) {
	// This build's account is opencode-go with deepseek-v4-flash. The login
	// flow must land exactly there and survive a write/read round trip.
	h := home(t)
	f, err := SetKey(h, "opencode-go", "sk-longenoughkey", "deepseek-v4-flash", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if f.DefaultProvider != "opencode-go" {
		t.Fatalf("default provider = %q, want opencode-go", f.DefaultProvider)
	}
	if got := f.DefaultModelFor("opencode-go"); got != "deepseek-v4-flash" {
		t.Fatalf("default model = %q, want deepseek-v4-flash", got)
	}
	rt := Load(h)
	if rt.DefaultProvider != "opencode-go" || rt.DefaultModelFor("opencode-go") != "deepseek-v4-flash" {
		t.Fatalf("the saved store lost the default: %+v", rt)
	}
}

func TestSettingADefaultProviderRequiresBeingLoggedIn(t *testing.T) {
	if _, err := SetDefaultProvider(home(t), "anthropic"); err == nil {
		t.Fatal("you cannot default to a provider you have no key for")
	}
}

func TestTheSchemaMatchesWhatTheAgentWrites(t *testing.T) {
	// Mirrored from agent/src/auth/store.ts. If the key names drift, the
	// interface and the agent stop seeing each other's logins — and the
	// symptom is "it says I am logged in but the agent disagrees".
	h := home(t)
	if _, err := SetKey(h, "anthropic", "sk-longenoughkey", "claude-x", time.Now()); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(Path(h))
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if got["version"] != float64(1) {
		t.Fatalf("version = %v", got["version"])
	}
	if got["defaultProvider"] != "anthropic" {
		t.Fatalf("defaultProvider = %v", got["defaultProvider"])
	}
	p := got["providers"].(map[string]any)["anthropic"].(map[string]any)
	for k, want := range map[string]any{"kind": "api_key", "key": "sk-longenoughkey", "defaultModel": "claude-x"} {
		if p[k] != want {
			t.Fatalf("providers.anthropic.%s = %v, want %v", k, p[k], want)
		}
	}
	if _, ok := p["updated_at"]; !ok {
		t.Fatal("updated_at is part of the schema")
	}
}

func TestEnvExportsEveryLiveKeyUnderItsOwnName(t *testing.T) {
	h := home(t)
	if _, err := SetKey(h, "anthropic", "sk-anthropickey1", "", time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := SetKey(h, "openrouter", "sk-openrouterkey", "", time.Now()); err != nil {
		t.Fatal(err)
	}
	env := strings.Join(Load(h).Env(), " ")
	if !strings.Contains(env, "ANTHROPIC_API_KEY=sk-anthropickey1") ||
		!strings.Contains(env, "OPENROUTER_API_KEY=sk-openrouterkey") {
		t.Fatalf("env = %q", env)
	}
}

func TestEnvKeyNamesAreTheOnesTheProvidersActuallyUse(t *testing.T) {
	for provider, want := range map[string]string{
		"anthropic": "ANTHROPIC_API_KEY", "openai": "OPENAI_API_KEY",
		"openrouter": "OPENROUTER_API_KEY", "opencode": "OPENCODE_API_KEY",
		"opencode-go": "OPENCODE_API_KEY",
	} {
		if got := EnvKeyFor(provider); got != want {
			t.Fatalf("%s exports %s, want %s", provider, got, want)
		}
	}
}
