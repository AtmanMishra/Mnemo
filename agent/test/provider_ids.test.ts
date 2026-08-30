/**
 * 1.5: pi's in-TUI `/login` builds its provider list from pi's OWN provider
 * catalog, keyed by provider id. If our ids ever drift from pi's, `/login`
 * would offer providers our auth store cannot fill in (or omit ours entirely),
 * and the mismatch would only show up inside the interactive TUI.
 */
import { test } from "node:test";
import assert from "node:assert";
import { PROVIDERS } from "../src/auth/store.ts";

/** pi does not re-export the resolver, so reach the built file directly. */
async function piProviderIds(): Promise<string[]> {
  const url = new URL(
    "../node_modules/@earendil-works/pi-coding-agent/dist/core/model-resolver.js",
    import.meta.url,
  );
  const mod = await import(url.href);
  return Object.keys(mod.defaultModelPerProvider ?? {});
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
