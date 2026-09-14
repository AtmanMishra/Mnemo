package app

import (
	"errors"
	"strings"
	"testing"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/auth"
)

// B4: the wizard's empty-enter fallback is DATA-DRIVEN — the model name comes
// from the provider's row in auth.DefaultModels (beside the provider list)
// and never from a branch naming providers by hand. These two tests pin the
// behaviours the table must produce for ANY table contents:
//
//   - a provider WITH a row: enter on an empty name uses the row;
//   - a provider WITHOUT a row: the "type a model name, or pick one from the
//     list" question comes back, and nothing is invented.
//
// Adding a provider therefore means adding a row, not editing the wizard.

// providerWithATableDefault picks its case out of the table, so the tests
// track the data rather than a snapshot of it.
func providerWithATableDefault(t *testing.T) (provider, model string) {
	t.Helper()
	for _, p := range auth.Providers {
		if m, ok := auth.DefaultModels[p]; ok {
			return p, m
		}
	}
	t.Skip("auth.DefaultModels is empty; there is no table default to drive the wizard")
	return "", ""
}

func providerWithoutATableDefault(t *testing.T) string {
	t.Helper()
	for _, p := range auth.Providers {
		if _, ok := auth.DefaultModels[p]; !ok {
			return p
		}
	}
	t.Skip("every provider has a table default; the ask-for-a-name branch is unreachable")
	return ""
}

// wizardToFailedModelStep drives the real login flow up to the point where
// the catalogue could not be asked for, which is when empty-enter matters.
func wizardToFailedModelStep(t *testing.T, provider string) *Model {
	t.Helper()
	m := fixture(t, 100, 30)
	typeIn(t, m, "/login "+provider+" «redacted:sk-…»")
	press(t, m, "enter")
	m.Update(modelsMsg{provider: provider, err: errors.New("no repository configured")})
	if !strings.Contains(screen(m), "Could not ask the agent for the catalogue.") {
		t.Fatalf("the failure must be named before empty-enter means anything:\n%s", screen(m))
	}
	return m
}

func TestTheWizardTakesAnEmptyModelNameFromTheDefaultsTable(t *testing.T) {
	provider, want := providerWithATableDefault(t)
	m := wizardToFailedModelStep(t, provider)
	press(t, m, "enter") // nothing selected, nothing typed
	if got := auth.Load(m.Home()).DefaultModelFor(provider); got != want {
		t.Fatalf("empty enter stored %q for %s, want the table's %q", got, provider, want)
	}
	if !strings.Contains(screen(m), "default model is now "+want) {
		t.Fatalf("the pick must be said out loud:\n%s", screen(m))
	}
}

func TestAProviderWithoutATableDefaultAsksForAName(t *testing.T) {
	provider := providerWithoutATableDefault(t)
	m := wizardToFailedModelStep(t, provider)
	press(t, m, "enter") // nothing selected, nothing typed
	if got := auth.Load(m.Home()).DefaultModelFor(provider); got != "" {
		t.Fatalf("no table row means no model may be invented; stored %q for %s", got, provider)
	}
	if !strings.Contains(screen(m), "type a model name, or pick one from the list") {
		t.Fatalf("the question must come back empty-handed:\n%s", screen(m))
	}
}
