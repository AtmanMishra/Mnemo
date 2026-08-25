/**
 * Model provider selection from environment variables. No key is hardcoded
 * and nothing here is required to run tests - only the CLI needs a provider.
 *
 * Precedence: SEA_PROVIDER forces a choice; otherwise the first set of
 * OPENAI_API_KEY / ANTHROPIC_API_KEY / OPENROUTER_API_KEY wins.
 */
export interface ProviderSelection {
  provider: "openai" | "anthropic" | "openrouter";
  apiKeyEnv: string;
  modelId?: string;
}

const SUPPORTED = ["openai", "anthropic", "openrouter"] as const;
type SupportedProvider = (typeof SUPPORTED)[number];

const KEY_ENV_BY_PROVIDER: Record<SupportedProvider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

export function pickProvider(env: NodeJS.ProcessEnv = process.env): ProviderSelection | null {
  const forced = env.SEA_PROVIDER?.trim().toLowerCase();
  if (forced) {
    if (!(SUPPORTED as readonly string[]).includes(forced)) {
      throw new Error(`SEA_PROVIDER="${forced}" is not supported. Use one of: ${SUPPORTED.join(", ")}`);
    }
    const p = forced as SupportedProvider;
    return { provider: p, apiKeyEnv: KEY_ENV_BY_PROVIDER[p], modelId: env.SEA_MODEL };
  }
  for (const p of SUPPORTED) {
    const envVar = KEY_ENV_BY_PROVIDER[p];
    if (env[envVar]) return { provider: p, apiKeyEnv: envVar, modelId: env.SEA_MODEL };
  }
  return null;
}

export function missingKeyMessage(sel: ProviderSelection | null): string {
  if (!sel) {
    return [
      "sea-agent: no model provider configured.",
      "",
      "Set exactly one of these environment variables:",
      "  OPENAI_API_KEY       - use OpenAI models",
      "  ANTHROPIC_API_KEY    - use Anthropic models",
      "  OPENROUTER_API_KEY   - use OpenRouter models",
      "",
      "Optional overrides:",
      "  SEA_PROVIDER=openai|anthropic|openrouter   force a provider when several keys are set",
      "  SEA_MODEL=<provider/model-id>              pick a specific model id",
    ].join("\n");
  }
  return `sea-agent: ${sel.apiKeyEnv} is not set (required for provider "${sel.provider}").`;
}
