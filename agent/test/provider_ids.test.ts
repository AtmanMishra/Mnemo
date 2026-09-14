/**
 * 1.5 / B1: pi's in-TUI `/login` builds its provider list from pi's OWN
 * provider catalog, keyed by provider id. If our ids ever drift from pi's,
 * `/login` would offer providers our auth store cannot fill in (or omit ours
 * entirely), and the mismatch would only show up inside the interactive TUI.
 *
 * The same file pins the OTHER copy of the list: tui-go/internal/auth/auth.go
 * (see the B1 tests at the bottom).
 */
import { test } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import { PROVIDERS, ENV_KEY_BY_PROVIDER } from "../src/auth/store.ts";

/** pi does not re-export the resolver, so reach the built file directly. */
async function piProviderIds(): Promise<string[]> {
  const url = new URL(
    "../node_modules/@earendil-works/pi-coding-agent/dist/core/model-resolver.js",
    import.meta.url,
  );
  const mod = await import(url.href);
  return Object.keys(mod.defaultModelPerProvider ?? {});
}

/**
 * B1: the Go interface cannot import TypeScript, so its copy of the provider
 * list is pinned by PARSING the Go source. This test and its mirror
 * (tui-go/internal/auth/providers_test.go, which parses store.ts) both fail
 * on any divergence, in either direction. Chosen over one shared JSON because
 * a data file would have to be shipped and located by two runtimes, and
 * go:embed cannot reach outside the tui-go module — the parse has the
 * smallest blast radius. The `Providers = []string{...}` and
 * `envKeyByProvider = map[string]string{...}` shapes below are the contract.
 */
function goAuthSource(): string {
  const url = new URL("../../tui-go/internal/auth/auth.go", import.meta.url);
  try {
    return fs.readFileSync(url, "utf8");
  } catch {
    assert.fail(`cannot read ${url.pathname} — the Go provider list moved or was deleted`);
  }
}

test("every mnemo provider id is a provider pi knows", async () => {
  const known = await piProviderIds();
  assert.ok(known.length > 10, `pi catalog looks wrong: ${known.length} providers`);
  for (const p of PROVIDERS) {
    assert.ok(known.includes(p), `provider "${p}" is not in pi's catalog — /login will not list it`);
  }
});

test("the provider list is the one the auth wizard and env resolution share", async () => {
  const { pickProvider } = await import("../src/provider.ts");
  for (const p of PROVIDERS) {
    const sel = pickProvider({ MNEMO_PROVIDER: p } as NodeJS.ProcessEnv);
    assert.equal(sel?.provider, p, `pickProvider rejects "${p}" that the auth store accepts`);
  }
});

test("provider.ts walks AUTO_PICK_ORDER over exactly the store's providers", async () => {
  // One source of truth for membership, an explicit precedence for the walk:
  // dropping a provider from either side must fail here, not surface as "the
  // wizard offers what the agent refuses".
  const src = fs.readFileSync(new URL("../src/provider.ts", import.meta.url), "utf8");
  const block = src.match(/AUTO_PICK_ORDER[^=]*=\s*\[([^\]]*)\]/);
  assert.ok(block, "provider.ts must declare AUTO_PICK_ORDER = [...]");
  const order = [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...order].sort(), [...PROVIDERS].sort(),
    "AUTO_PICK_ORDER must be a permutation of PROVIDERS");
  assert.deepEqual(order, ["openai", "anthropic", "openrouter", "opencode", "opencode-go"],
    "the documented walk order is OpenAI-first; changing it changes which provider wins");
});

test("the Go interface's provider list is the same list, in the same order", () => {
  const src = goAuthSource();
  const block = src.match(/var Providers\s*=\s*\[\]string\{([^}]*)\}/);
  assert.ok(block, "tui-go/internal/auth/auth.go must declare `var Providers = []string{...}`");
  const got = [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(got, [...PROVIDERS],
    "the interface's provider list diverged from agent/src/auth/store.ts");
});

test("the Go interface exports each key under the same environment variable", () => {
  const src = goAuthSource();
  const block = src.match(/envKeyByProvider\s*=\s*map\[string\]string\{([^}]*)\}/);
  assert.ok(block, "auth.go must map providers to env vars via envKeyByProvider");
  const goEnv = new Map(
    [...block![1].matchAll(/"([^"]+)"\s*:\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]),
  );
  for (const p of PROVIDERS) {
    assert.equal(goEnv.get(p), ENV_KEY_BY_PROVIDER[p], `env var for "${p}" diverged between the sides`);
  }
  assert.deepEqual([...goEnv.keys()].sort(), [...PROVIDERS].sort(),
    "the Go env-var map and the agent's provider list cover different providers");
});
