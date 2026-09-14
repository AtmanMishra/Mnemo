// Package auth reads and writes the same ~/.mnemo/auth.json the agent reads,
// so logging in from inside the interface is indistinguishable from having
// run the CLI wizard.
//
// The schema is mirrored from agent/src/auth/store.ts. If that changes, the
// schema test here is what catches it.
package auth

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Providers Mnemo can authenticate. These ids are pi's own.
//
// The agent keeps the same list in TypeScript (agent/src/auth/store.ts) and
// neither language can import the other, so the two are pinned together by a
// test on each side that PARSES the other side's source:
// providers_test.go here reads store.ts, and agent/test/provider_ids.test.ts
// reads this file. A shared JSON was the alternative and was rejected as a
// bigger blast radius: it would need shipping and path resolution in two
// runtimes (go:embed cannot reach outside the tui-go module), and the two
// source files are already present wherever either test suite runs.
var Providers = []string{"anthropic", "openai", "openrouter", "opencode", "opencode-go"}

// DefaultModels is the model id the login wizard proposes when the model name
// is left empty, per provider — the data half of a data-driven wizard.
//
// A provider with NO entry here is not broken: the model step asks for a name
// instead ("type a model name, or pick one from the list"). Adding a provider
// must never require editing the wizard branch in app/update.go; add or change
// a row here and the wizard follows.
//
// The one entry is the canonical default of this build. It is build-specific
// policy, which is exactly why it lives in a table with the provider list
// rather than inside the wizard.
var DefaultModels = map[string]string{
	"opencode-go": "deepseek-v4-flash",
}

// envKeyByProvider is the environment variable each provider's key is exported
// as. The shape `"id": "ENV"`, one pair per line, is parsed against
// agent/src/auth/store.ts by providers_test.go — keep it.
var envKeyByProvider = map[string]string{
	"anthropic":   "ANTHROPIC_API_KEY",
	"openai":      "OPENAI_API_KEY",
	"openrouter":  "OPENROUTER_API_KEY",
	"opencode":    "OPENCODE_API_KEY",
	"opencode-go": "OPENCODE_API_KEY",
}

// EnvKeyFor is the environment variable each provider's key is exported as.
func EnvKeyFor(provider string) string {
	if env, ok := envKeyByProvider[provider]; ok {
		return env
	}
	// Unknown ids keep the historical default. Only known providers are ever
	// exported (Env walks LoggedIn), so this arm is for callers passing an id
	// that is not in Providers at all.
	return "OPENCODE_API_KEY"
}

// Provider is one stored credential.
type Provider struct {
	Kind         string `json:"kind"`
	Key          string `json:"key,omitempty"`
	DefaultModel string `json:"defaultModel,omitempty"`
	UpdatedAt    int64  `json:"updated_at"`
}

// File is the whole store.
type File struct {
	Version         int                 `json:"version"`
	Providers       map[string]Provider `json:"providers"`
	DefaultProvider string              `json:"defaultProvider,omitempty"`
}

// MinKeyLen is the shortest thing that could be a real API key. Anything
// shorter is a paste that went wrong, and storing it means the failure
// surfaces much later as an authentication error nobody connects to this.
const MinKeyLen = 8

// LoggedIn lists providers with a usable credential, in a stable order.
func (f File) LoggedIn() []string {
	var out []string
	for _, p := range Providers {
		if a, ok := f.Providers[p]; ok && len(a.Key) >= MinKeyLen {
			out = append(out, p)
		}
	}
	return out
}

// Configured reports whether anything is set up at all.
func (f File) Configured() bool { return len(f.LoggedIn()) > 0 }

// EffectiveProvider is what a new session should use: the stored default if
// it is still logged in, otherwise the first one that is.
//
// A default pointing at a provider you logged out of is not an error worth
// showing — it is a stale preference, and falling back silently is what the
// reader would have done anyway.
func (f File) EffectiveProvider() string {
	live := f.LoggedIn()
	for _, p := range live {
		if p == f.DefaultProvider {
			return p
		}
	}
	if len(live) > 0 {
		return live[0]
	}
	return ""
}

// DefaultModelFor is the model chosen for one provider.
func (f File) DefaultModelFor(provider string) string {
	return f.Providers[provider].DefaultModel
}

// Path is where the store lives under a given home.
func Path(home string) string { return filepath.Join(home, ".mnemo", "auth.json") }

// Load reads the store. A missing or unreadable file means "not logged in",
// never an error: the onboarding screen is the answer to both.
func Load(home string) File {
	f := File{Version: 1, Providers: map[string]Provider{}}
	raw, err := os.ReadFile(Path(home))
	if err != nil {
		return f
	}
	var got File
	if json.Unmarshal(raw, &got) != nil {
		return f
	}
	if got.Providers == nil {
		got.Providers = map[string]Provider{}
	}
	if got.Version == 0 {
		got.Version = 1
	}
	return got
}

// Save writes the store, user-readable only.
func Save(home string, f File) error {
	p := Path(home)
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	body, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(p, append(body, '\n'), 0o600); err != nil {
		return err
	}
	// Written and then chmod'ed: WriteFile only applies the mode when it
	// creates the file, so an existing world-readable auth.json would keep
	// its permissions forever.
	return os.Chmod(p, 0o600)
}

// SetKey records a credential. The error is written to be shown verbatim.
func SetKey(home, provider, key, defaultModel string, now time.Time) (File, error) {
	if !known(provider) {
		return File{}, errors.New("unknown provider '" + provider + "'")
	}
	key = strings.TrimSpace(key)
	if len(key) < MinKeyLen {
		return File{}, errors.New("that key looks too short — paste the whole thing")
	}
	f := Load(home)
	f.Providers[provider] = Provider{
		Kind: "api_key", Key: key, DefaultModel: defaultModel,
		UpdatedAt: now.Unix(),
	}
	if f.DefaultProvider == "" {
		f.DefaultProvider = provider
	}
	return f, Save(home, f)
}

// SetDefaultModel records which model a provider should use.
func SetDefaultModel(home, provider, model string) (File, error) {
	f := Load(home)
	a, ok := f.Providers[provider]
	if !ok {
		return f, errors.New("not logged in to " + provider)
	}
	a.DefaultModel = model
	f.Providers[provider] = a
	// Deliberately does NOT repoint DefaultProvider: choosing a model while
	// logging in to a SECOND provider would silently switch which one new
	// sessions use. Changing the default is its own action.
	if f.DefaultProvider == "" {
		f.DefaultProvider = provider
	}
	return f, Save(home, f)
}

// SetDefaultProvider changes which provider new sessions use.
func SetDefaultProvider(home, provider string) (File, error) {
	f := Load(home)
	if !contains(f.LoggedIn(), provider) {
		return f, errors.New("not logged in to " + provider)
	}
	f.DefaultProvider = provider
	return f, Save(home, f)
}

// Logout forgets one provider's credential.
func Logout(home, provider string) (File, error) {
	f := Load(home)
	delete(f.Providers, provider)
	if f.DefaultProvider == provider {
		f.DefaultProvider = ""
		if live := f.LoggedIn(); len(live) > 0 {
			f.DefaultProvider = live[0]
		}
	}
	return f, Save(home, f)
}

// Env is the environment a spawned agent needs to use these credentials.
func (f File) Env() []string {
	var out []string
	for _, p := range f.LoggedIn() {
		out = append(out, EnvKeyFor(p)+"="+f.Providers[p].Key)
	}
	sort.Strings(out)
	return out
}

func known(p string) bool { return contains(Providers, p) }

func contains(all []string, want string) bool {
	for _, p := range all {
		if p == want {
			return true
		}
	}
	return false
}
