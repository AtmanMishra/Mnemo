/**
 * Model provider selection from environment variables. No key is hardcoded
 * and nothing here is required to run tests - only the CLI needs a provider.
 *
 * Precedence: MNEMO_PROVIDER (or legacy SEA_PROVIDER) forces a choice; otherwise the first set of
 * OPENAI_API_KEY / ANTHROPIC_API_KEY / OPENROUTER_API_KEY wins.
 */
export interface ProviderSelection {
  provider: "openai" | "anthropic" | "openrouter" | "opencode" | "opencode-go";
  apiKeyEnv: string;
  modelId?: string;
}

const SUPPORTED = ["openai", "anthropic", "openrouter", "opencode", "opencode-go"] as const;
type SupportedProvider = (typeof SUPPORTED)[number];

const KEY_ENV_BY_PROVIDER: Record<SupportedProvider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  opencode: "OPENCODE_API_KEY",
  "opencode-go": "OPENCODE_API_KEY",
};

export function pickProvider(env: NodeJS.ProcessEnv = process.env): ProviderSelection | null {
  const forced = (env.MNEMO_PROVIDER ?? env.SEA_PROVIDER)?.trim().toLowerCase();
  if (forced) {
    if (!(SUPPORTED as readonly string[]).includes(forced)) {
      throw new Error(`MNEMO_PROVIDER="${forced}" is not supported. Use one of: ${SUPPORTED.join(", ")}`);
    }
    const p = forced as SupportedProvider;
    return { provider: p, apiKeyEnv: KEY_ENV_BY_PROVIDER[p], modelId: env.MNEMO_MODEL ?? env.SEA_MODEL };
  }
  for (const p of SUPPORTED) {
    const envVar = KEY_ENV_BY_PROVIDER[p];
    if (env[envVar]) return { provider: p, apiKeyEnv: envVar, modelId: env.MNEMO_MODEL ?? env.SEA_MODEL };
  }
  return null;
}

export function missingKeyMessage(sel: ProviderSelection | null): string {
  if (!sel) {
    return [
      "mnemo: no model provider configured.",
      "",
      "Set exactly one of these environment variables:",
      "  OPENAI_API_KEY       - use OpenAI models",
      "  ANTHROPIC_API_KEY    - use Anthropic models",
      "  OPENROUTER_API_KEY   - use OpenRouter models",
      "  OPENCODE_API_KEY     - use OpenCode models (e.g. deepseek-v4-flash)",
      "",
      "Optional overrides:",
      "  MNEMO_PROVIDER=openai|anthropic|openrouter force a provider when several keys are set",
      "  MNEMO_MODEL=<provider/model-id>            pick a specific model id",
    ].join("\n");
  }
  return `mnemo: ${sel.apiKeyEnv} is not set (required for provider "${sel.provider}").`;
}
