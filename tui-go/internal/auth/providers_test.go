package auth

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// B1: the provider list lives in two languages, and neither can import the
// other. These tests PARSE the agent's TypeScript and fail when the two sides
// diverge — the mirror is agent/test/provider_ids.test.ts, which parses THIS
// file. Both run in their own CI job, so either side changing alone fails.
//
// A shared JSON was the alternative and was rejected as a bigger blast radius:
// it would need shipping and path resolution in two runtimes, and go:embed
// cannot reach outside the tui-go module. Source parsing adds no build step
// and no shipped artifact.
//
// Contract shapes (keep them; the sister test depends on them too):
//
//	export const PROVIDERS = [...];                     // store.ts
//	export const ENV_KEY_BY_PROVIDER: Record<...> = {   // store.ts
//	  anthropic: "ANTHROPIC_API_KEY",
//	};
var (
	tsProviderListRe = regexp.MustCompile(`(?s)PROVIDERS\s*=\s*\[(.*?)\]`)
	tsEnvMapRe       = regexp.MustCompile(`(?s)ENV_KEY_BY_PROVIDER[^=]*=\s*\{(.*?)\}`)
	tsQuotedRe       = regexp.MustCompile(`"([^"]+)"`)
	tsEnvPairRe      = regexp.MustCompile(`([A-Za-z_][\w-]*)\s*:\s*"([^"]+)"`)
)

// agentStoreSource is the agent's auth store, relative to this package.
// `go test` runs with the package directory as the working directory, so the
// checkout root is three levels up — and the repo layout is guaranteed here
// because the tui-go module only exists inside it.
func agentStoreSource(t *testing.T) string {
	t.Helper()
	p := filepath.Join("..", "..", "..", "agent", "src", "auth", "store.ts")
	raw, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("the agent's provider list is not where this test expects it (%s): %v", p, err)
	}
	return string(raw)
}

func TestTheAgentStoreIsTheSameProviderList(t *testing.T) {
	src := agentStoreSource(t)
	block := tsProviderListRe.FindStringSubmatch(src)
	if block == nil {
		t.Fatal("store.ts no longer declares `PROVIDERS = [...]` — update this test's contract")
	}
	got := quotedIDs(block[1])
	if len(got) == 0 {
		t.Fatal("parsed zero provider ids; the store.ts format changed")
	}
	if len(got) != len(Providers) {
		t.Fatalf("agent has %d providers %v, the interface has %d %v", len(got), got, len(Providers), Providers)
	}
	for i := range got {
		if got[i] != Providers[i] {
			t.Fatalf("provider lists diverge at %d: agent %q, interface %q (agent: %v, interface: %v)",
				i, got[i], Providers[i], got, Providers)
		}
	}
}

func TestTheAgentStoreExportsTheSameEnvVars(t *testing.T) {
	src := agentStoreSource(t)
	block := tsEnvMapRe.FindStringSubmatch(src)
	if block == nil {
		t.Fatal("store.ts no longer declares `ENV_KEY_BY_PROVIDER = {...}` — update this test's contract")
	}
	pairs := tsEnvPairRe.FindAllStringSubmatch(block[1], -1)
	if len(pairs) == 0 {
		t.Fatal("parsed zero provider→env pairs; the store.ts format changed")
	}
	for _, p := range pairs {
		if got := EnvKeyFor(p[1]); got != p[2] {
			t.Fatalf("EnvKeyFor(%q) = %q but the agent exports it as %q", p[1], got, p[2])
		}
	}
	// The agent's map IS the coverage contract: every id it knows must resolve
	// through the explicit map here rather than falling into the default arm.
	for _, p := range pairs {
		if _, ok := envKeyByProvider[p[1]]; !ok {
			t.Fatalf("provider %q has no explicit env var in auth.go; it falls into the historical default arm", p[1])
		}
	}
}

func TestDefaultModelsPointAtRealProviders(t *testing.T) {
	// A stale row here would seed a login that cannot work; an empty model id
	// would write a default model that is not a model.
	for provider, model := range DefaultModels {
		if !contains(Providers, provider) {
			t.Fatalf("DefaultModels names %q, which is not a provider", provider)
		}
		if model == "" {
			t.Fatalf("DefaultModels[%q] is empty", provider)
		}
	}
}

func quotedIDs(s string) []string {
	var out []string
	for _, m := range tsQuotedRe.FindAllStringSubmatch(s, -1) {
		out = append(out, m[1])
	}
	return out
}
