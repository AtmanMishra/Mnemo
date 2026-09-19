/**
 * What a provider can actually run, and how to choose one.
 *
 * `/model` used to answer "choosing from the catalogue lands next". That is
 * honest and useless: the reader has a key, the key can list its own models, and
 * the interface has no business asking them to guess. So this fetches the real
 * catalogue and shows it.
 *
 * Three rules:
 *
 *  1. **The list is the provider's, never ours.** A hardcoded menu of model names
 *     is wrong within a month and lies to the reader about what their key can
 *     reach. Whatever the provider returns is what gets shown.
 *  2. **A bounded list, with the count.** A hundred and eighty models is not a
 *     menu; the top cuts plus "…and N more" is, and it never pretends the full
 *     list is what is on screen.
 *  3. **A failure says which failure.** "Could not reach OpenRouter: ECONNREFUSED"
 *     is a different sentence from "your key was refused (401)", and only one of
 *     them is fixed by logging in again.
 */
import { readAuth, authPath } from "../commands/store.ts";
import * as fs from "node:fs";

export interface ModelInfo {
  id: string;
  name: string;
  context?: number;
}

/**
 * Where each provider lists its models, and whether the listing needs the key.
 *
 * OpenRouter publishes its catalogue publicly; the others require the key. Both
 * are handled the same way — attach the key when the reader has one — because
 * "does this endpoint need auth" is not something the reader should ever have to
 * think about.
 */
const CATALOGUES: Record<string, string> = {
  openrouter: "https://openrouter.ai/api/v1/models",
  openai: "https://api.openai.com/v1/models",
  deepseek: "https://api.deepseek.com/models",
  anthropic: "https://api.anthropic.com/v1/models",
};

const DEFAULT_LIMIT = 20;

/** The provider's answer, in our shape — tolerant of the two common envelopes. */
export function parseModels(payload: unknown): ModelInfo[] {
  const raw = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? ((payload as { data: unknown[] }).data)
      : [];

  return raw
    .map((entry): ModelInfo | undefined => {
      if (!entry || typeof entry !== "object") return undefined;
      const e = entry as Record<string, unknown>;
      const id = typeof e.id === "string" ? e.id : undefined;
      if (!id) return undefined;
      const name = typeof e.name === "string" && e.name.trim() ? e.name : id;
      const context =
        typeof e.context_length === "number"
          ? e.context_length
          : typeof e.max_context === "number"
            ? (e.max_context as number)
            : undefined;
      return context ? { id, name, context } : { id, name };
    })
    .filter((m): m is ModelInfo => m !== undefined);
}

export interface ModelQuery {
  provider: string;
  /** The key to send, when the reader has one. */
  key?: string;
  fetchImpl?: typeof fetch;
}

/** The catalogue, or the reason there isn't one. */
export async function fetchModels(query: ModelQuery): Promise<{ models: ModelInfo[] } | { error: string }> {
  const url = CATALOGUES[query.provider];
  if (!url) {
    return { error: `no catalogue is known for ${query.provider} — models can still be chosen by name` };
  }
  const doFetch = query.fetchImpl ?? fetch;

  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (query.key) headers.authorization = `Bearer ${query.key}`;
    const response = await doFetch(url, { headers });

    if (!response.ok) {
      const hint =
        response.status === 401 || response.status === 403
          ? " — the key was refused, so `/login <provider>` again"
          : "";
      return { error: `${query.provider} answered ${response.status}${hint}` };
    }
    const models = parseModels(await response.json());
    return models.length > 0 ? { models } : { error: `${query.provider} returned no models` };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { error: `could not reach ${query.provider}: ${reason}` };
  }
}

/** The list as it is shown: bounded, numbered, and honest about the remainder. */
export function renderModels(models: readonly ModelInfo[], options: { limit?: number } = {}): string[] {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const shown = models.slice(0, Math.max(0, limit));

  const lines = shown.map((model) => {
    const context = model.context ? `  ${Math.round(model.context / 1000)}k ctx` : "";
    const name = model.name === model.id ? "" : `  ${model.name}`;
    return `  ${model.id}${name}${context}`;
  });

  const hidden = models.length - shown.length;
  if (hidden > 0) lines.push(`  …and ${hidden} more — the full list is at your provider's own page`);
  lines.push("", `choose with \`/model <id>\` — the id alone, as shown above`);
  return lines;
}

/** Remember the choice, in the slot the auth file already has for it. */
export function setModel(home: string, provider: string, model: string): string {
  const file = readAuth(home);
  const entry = file.providers[provider];
  if (!entry) {
    throw new Error(`no key stored for ${provider} — /login ${provider} first`);
  }
  entry.defaultModel = model;
  file.defaultProvider ??= provider;

  const target = authPath(home);
  fs.writeFileSync(target, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    /* Windows has no mode bits; the write is the best available there. */
  }
  return target;
}
