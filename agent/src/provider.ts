/**
 * Model provider selection from environment variables. No key is hardcoded
 * and nothing here is required to run tests - only the CLI needs a provider.
 *
 * Precedence: MNEMO_PROVIDER (or legacy SEA_PROVIDER) forces a choice;
 * otherwise the first key present in AUTO_PICK_ORDER wins.
 *
 * The provider list and the env-var map are NOT defined here: they are
 * imported from `src/auth/store.ts`, the agent-side source of truth (see the
 * comment there). This file keeps only AUTO_PICK_ORDER, the order the
 * automatic walk visits providers — a precedence, not a second list.
 */
import { PROVIDERS, ENV_KEY_BY_PROVIDER, type ProviderId } from "./auth/store.ts";

export interface ProviderSelection {
  provider: ProviderId;
  apiKeyEnv: string;
  modelId?: string;
}

const SUPPORTED = PROVIDERS;

// Auto-pick precedence when several keys are present, kept OpenAI-first for
// backwards compatibility with the documented behaviour at the top of this
// file. Membership lives in PROVIDERS; this is only the walk order, and
// provider_ids.test.ts asserts it is a permutation of PROVIDERS — so a
// provider added to the store cannot silently drop out of the walk.
const AUTO_PICK_ORDER: readonly ProviderId[] = [
  "openai",
  "anthropic",
  "openrouter",
  "opencode",
  "opencode-go",
];

export function pickProvider(env: NodeJS.ProcessEnv = process.env): ProviderSelection | null {
  const forced = (env.MNEMO_PROVIDER ?? env.SEA_PROVIDER)?.trim().toLowerCase();
  if (forced) {
    if (!(SUPPORTED as readonly string[]).includes(forced)) {
      throw new Error(`MNEMO_PROVIDER="${forced}" is not supported. Use one of: ${SUPPORTED.join(", ")}`);
    }
    const p = forced as ProviderId;
    return { provider: p, apiKeyEnv: ENV_KEY_BY_PROVIDER[p], modelId: env.MNEMO_MODEL ?? env.SEA_MODEL };
  }
  for (const p of AUTO_PICK_ORDER) {
    const envVar = ENV_KEY_BY_PROVIDER[p];
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
