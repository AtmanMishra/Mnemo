/**
 * mnemo auth wizard: first-run provider setup.
 * Injectable IO so tests script the whole conversation deterministically.
 */
import {
  PROVIDERS,
  setProviderAuth, setDefaultProvider, loadAuth, type ProviderId,
} from "./store.ts";

export interface AuthIO {
  write: (s: string) => void;
  question: (q: string) => Promise<string>;
}

export const PROVIDER_LABELS_INTERNAL: Record<ProviderId, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI (GPT)",
  openrouter: "OpenRouter (300+ models, free tier)",
  opencode: "OpenCode Zen (Claude/GPT via OpenCode)",
  "opencode-go": "OpenCode GO (Ox models, e.g. deepseek-v4-flash)",
};

export function providerMenu(): string {
  const lines = PROVIDERS.map((p, i) =>
    `  ${i + 1}) ${PROVIDER_LABELS_INTERNAL[p]}`);
  return ["Select a provider:", ...lines].join("\n") + "\n> ";
}

export function parseProviderChoice(raw: string): ProviderId | null {
  const s = raw.trim().toLowerCase();
  const n = Number.parseInt(s, 10);
  if (!Number.isNaN(n) && n >= 1 && n <= PROVIDERS.length) return PROVIDERS[n - 1];
  const hit = PROVIDERS.find((p) => p === s || p.replace("-go", "") === s);
  return hit ?? null;
}

/** Full interactive flow. Returns what was saved. */
export async function runWizard(
  io: AuthIO,
  home: string,
): Promise<{ provider: ProviderId; defaultModel?: string }> {
  io.write("Welcome to MNEMO // agentic coding assistant\n");
  io.write(providerMenu());
  let provider: ProviderId | null = null;
  while (!provider) {
    const pick = parseProviderChoice(await io.question(""));
    if (pick) { provider = pick; break; }
    io.write("Unknown provider. Enter a number or name.\n> ");
  }

  let key = "";
  while (true) {
    key = (await io.question(`Paste your API key for ${provider}: `)).trim();
    if (key.length >= 8) break;
    io.write("Key looks too short. Try again.\n");
  }

  io.write("Default model id (optional, enter to skip): ");
  const modelRaw = (await io.question("")).trim();

  setProviderAuth(provider, { kind: "api_key", key }, home);
  setDefaultProvider(provider, modelRaw || undefined, home);
  void loadAuth(home); // sanity read-back
  const result = { provider, defaultModel: modelRaw || undefined };
  io.write(`Saved. mnemo will use ${provider}${modelRaw ? ` (${modelRaw})` : ""}.\n`);
  return result;
}
