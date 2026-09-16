/**
 * Model provider selection from environment variables. No key is hardcoded
 * and nothing here is required to run tests - only the CLI needs a provider.
 *
 * Precedence: MNEMO_PROVIDER (or legacy SEA_PROVIDER) forces a choice;
 * otherwise the first key present in AUTO_PICK_ORDER wins.
 *
 * A forced provider that is not one of ours is passed through UNCHANGED, with
 * no key demanded of Mnemo. pi supports far more than we can key — a
 * subscription behind pi's own /login, a local llama.cpp router, a provider a
 * package registered — and a wrapper that refused to start on a provider pi
 * can drive would lock those testers out of the tool entirely. Whether pi
 * knows the name is pi's answer to give: an unknown one comes back as pi's
 * own error, which reaches the transcript like any other startup failure.
 *
 * The provider list and the env-var map are NOT defined here: they are
 * imported from `src/auth/store.ts`, the agent-side source of truth (see the
 * comment there). This file keeps only AUTO_PICK_ORDER, the order the
 * automatic walk visits providers — a precedence, not a second list.
 */
import * as os from "node:os";
import {
  PROVIDERS, ENV_KEY_BY_PROVIDER, type ProviderId,
} from "./auth/store.ts";
import { defaults as piDefaults, hasCredential } from "./auth/pi_store.ts";

export interface ProviderSelection {
  /**
   * One of Mnemo's providers, or any id pi knows (an id Mnemo has no key for
   * arrives here with an empty apiKeyEnv: the credential is pi's).
   */
  provider: string;

  /** The environment variable Mnemo would put this provider's key in; "" when Mnemo has no key to offer. */
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

/**
 * The provider and model to run on, from the environment alone.
 *
 * Environment only, on purpose: this is the one place that decides from what
 * the process was handed, and the stores (Mnemo's and pi's) are read by the
 * caller, which knows which home it is working in.
 */
export function pickProvider(env: NodeJS.ProcessEnv = process.env): ProviderSelection | null {
  const forced = (env.MNEMO_PROVIDER ?? env.SEA_PROVIDER)?.trim();
  const modelId = env.MNEMO_MODEL ?? env.SEA_MODEL;
  if (forced) {
    const id = forced.toLowerCase();
    if (!(SUPPORTED as readonly string[]).includes(id)) {
      // pi's to resolve. No key of ours is demanded, because Mnemo does not
      // have one for it and never will: llama.cpp needs none at all, and a
      // subscription token is pi's to hold.
      return { provider: forced, apiKeyEnv: "", modelId };
    }
    const p = id as ProviderId;
    return { provider: p, apiKeyEnv: ENV_KEY_BY_PROVIDER[p], modelId };
  }
  for (const p of AUTO_PICK_ORDER) {
    const envVar = ENV_KEY_BY_PROVIDER[p];
    if (env[envVar]) return { provider: p, apiKeyEnv: envVar, modelId };
  }
  return null;
}

/**
 * pi's own default model, when it describes the provider we are about to run.
 *
 * Mnemo's model wins wherever it is set; this only fills the gap left when
 * someone configured a provider in pi and told Mnemo nothing. The provider is
 * checked because a model id belongs to a provider: pi's defaultModel with
 * pi's defaultProvider on `anthropic` says nothing about what `llama.cpp`
 * should run, and passing it would be inventing an answer.
 */
export function piDefaultModel(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string | undefined {
  const pi = piDefaults(env, home);
  return pi.provider === provider ? pi.model : undefined;
}

/**
 * Whether a run can start: a key Mnemo can supply, or a credential pi already
 * holds.
 *
 * The second half is the point of #23. A provider with no apiKeyEnv is pi's
 * own from the start — a llama.cpp router needs no key at all, and a
 * subscription token is stored by pi's own /login — so it is never refused.
 * A provider Mnemo COULD key is not refused either when pi holds a credential
 * for it: a Claude Pro/Max login lives in pi's auth.json, and demanding
 * ANTHROPIC_API_KEY for it locks out a tester for no reason.
 */
export function canStart(
  selection: ProviderSelection | null,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): boolean {
  if (!selection) return hasCredential(undefined, env, home);
  if (!selection.apiKeyEnv) return true;
  if (env[selection.apiKeyEnv]) return true;
  return hasCredential(selection.provider, env, home);
}

/**
 * What to say when nothing anywhere can run a model.
 *
 * It names the working options rather than one missing variable, because
 * "OPENAI_API_KEY is not set" was the message that made a subscription user
 * conclude the tool was not for them.
 */
export function missingKeyMessage(sel: ProviderSelection | null): string {
  const head = sel
    ? `mnemo: no credential for provider "${sel.provider}" — not in Mnemo's store or environment, and not in pi's.`
    : "mnemo: no usable credential found.";
  return [
    head,
    "",
    "Give Mnemo a key of its own — the web wizard, `mnemo auth`, or:",
    "  OPENAI_API_KEY       - openai",
    "  ANTHROPIC_API_KEY    - anthropic",
    "  OPENROUTER_API_KEY   - openrouter",
    "  OPENCODE_API_KEY     - opencode, opencode-go",
    "",
    "or run on a credential pi already holds (Mnemo needs no key of its own):",
    "  a subscription   - run `pi` once and /login: Claude Pro/Max, ChatGPT Plus/Pro,",
    "                     GitHub Copilot, xAI, OpenRouter, Radius. The token is stored",
    "                     in pi's ~/.pi/agent/auth.json and Mnemo starts on it.",
    "  a local model    - a llama.cpp router, configured with LLAMA_BASE_URL or",
    "                     /login llama.cpp, then MNEMO_PROVIDER=llama.cpp.",
    "",
    "Optional overrides:",
    "  MNEMO_PROVIDER=<id>  any provider id pi knows is passed straight through",
    "  MNEMO_MODEL=<model>  pick a model; without it pi's own default is used",
  ].join("\n");
}
