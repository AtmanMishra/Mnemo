/**
 * The environment a command the agent runs is given: Mnemo's own, minus the
 * keys that pay for the model. The model can write `env` or `os.environ` as
 * easily as anything else, and a key it prints lands in the transcript, the
 * session file and the provider's logs. Mnemo itself still reads the keys; only
 * children lose them. `MNEMO_PASS_ENV=NAME,NAME` hands named ones back.
 */
import * as fs from "node:fs";
import * as path from "node:path";

type Env = Record<string, string | undefined>;

/**
 * The credentials pi reads for its model providers (pi-ai's env lookups, and
 * LLAMA_API_KEY for pi's llama extension). test/env.test.ts reads pi-ai's own
 * code and fails when a provider's key is missing here.
 */
export const PROVIDER_KEYS = new Set([
  "AI_GATEWAY_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANT_LING_API_KEY",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AZURE_OPENAI_API_KEY",
  "BASETEN_API_KEY",
  "CEREBRAS_API_KEY",
  "CLOUDFLARE_API_KEY",
  "COPILOT_GITHUB_TOKEN",
  "DEEPSEEK_API_KEY",
  "FIREWORKS_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_CLOUD_API_KEY",
  "GROQ_API_KEY",
  "HF_TOKEN",
  "KIMI_API_KEY",
  "LLAMA_API_KEY",
  "META_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "MISTRAL_API_KEY",
  "MOONSHOT_API_KEY",
  "NVIDIA_API_KEY",
  "OPENAI_API_KEY",
  "OPENCODE_API_KEY",
  "OPENROUTER_API_KEY",
  "QWEN_TOKEN_PLAN_API_KEY",
  "QWEN_TOKEN_PLAN_CN_API_KEY",
  "RADIUS_API_KEY",
  "TOGETHER_API_KEY",
  "TYPESAFE_API_KEY",
  "XAI_API_KEY",
  "XIAOMI_API_KEY",
  "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  "ZAI_API_KEY",
  "ZAI_CODING_CN_API_KEY",
]);

/** Variables `models.json` interpolates (`$NAME`, `${NAME}`): a custom provider's keys. */
export function configuredKeys(agentDir: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(path.join(agentDir, "models.json"), "utf8");
  } catch {
    return [];
  }
  return [...new Set([...text.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)].map((m) => m[1]!))];
}

export function childEnv(env: Env = process.env, extra: Iterable<string> = []): Record<string, string> {
  const drop = new Set(extra);
  const pass = new Set((env.MNEMO_PASS_ENV ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if ((PROVIDER_KEYS.has(name.toUpperCase()) || drop.has(name)) && !pass.has(name)) continue;
    out[name] = value;
  }
  return out;
}
