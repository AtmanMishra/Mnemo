/**
 * Mnemo auth store: persistent provider credentials.
 * File: ~/.mnemo/auth.json, chmod 600. Read order everywhere: env var first,
 * then this store (pickProvider integration lands with the wizard).
 *
 * Schema: { version: 1, providers: { [providerId]: {
 *   kind: "api_key" | "oauth",
 *   key?: string,            // api_key kind
 *   accessToken?: string,    // oauth kind
 *   refreshToken?: string,
 *   expiresAt?: number,
 *   defaultModel?: string,
 *   updated_at: number } } }
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export const PROVIDERS = [
  "anthropic",
  "openai",
  "openrouter",
  "opencode",
  "opencode-go",
] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export const ENV_KEY_BY_PROVIDER: Record<ProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  opencode: "OPENCODE_API_KEY",
  "opencode-go": "OPENCODE_API_KEY",
};

export interface ProviderAuth {
  kind: "api_key" | "oauth";
  key?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  defaultModel?: string;
  updated_at: number;
}

export interface AuthFile {
  version: 1;
  providers: Partial<Record<ProviderId, ProviderAuth>>;
  defaultProvider?: ProviderId;
}

export function authDir(home = os.homedir()): string {
  return path.join(home, ".mnemo");
}
export function authFile(home = os.homedir()): string {
  return path.join(authDir(home), "auth.json");
}

export function loadAuth(home = os.homedir()): AuthFile {
  try {
    const raw = fs.readFileSync(authFile(home), "utf8");
    const parsed = JSON.parse(raw) as AuthFile;
    if (parsed?.version === 1 && typeof parsed.providers === "object") return parsed;
  } catch { /* missing/corrupt -> fresh */ }
  return { version: 1, providers: {} };
}

export function saveAuth(auth: AuthFile, home = os.homedir()): void {
  const dir = authDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const file = authFile(home);
  fs.writeFileSync(file, JSON.stringify(auth, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* some filesystems */ }
}

export function setProviderAuth(
  provider: ProviderId,
  auth: Omit<ProviderAuth, "updated_at">,
  home = os.homedir(),
): void {
  const a = loadAuth(home);
  a.providers[provider] = { ...auth, updated_at: Date.now() };
  saveAuth(a, home);
}

export function getProviderAuth(provider: ProviderId, home = os.homedir()): ProviderAuth | null {
  return loadAuth(home).providers[provider] ?? null;
}

export function clearProviderAuth(provider: ProviderId, home = os.homedir()): boolean {
  const a = loadAuth(home);
  if (!a.providers[provider]) return false;
  delete a.providers[provider];
  saveAuth(a, home);
  return true;
}

export function setDefaultProvider(provider: ProviderId, model?: string, home = os.homedir()): void {
  const a = loadAuth(home);
  a.defaultProvider = provider;
  if (model && a.providers[provider]) a.providers[provider].defaultModel = model;
  saveAuth(a, home);
}

/** Resolve a provider's usable API key: env wins, then store. */
export function resolveApiKey(provider: ProviderId, env: NodeJS.ProcessEnv = process.env,
  home = os.homedir()):
  { key: string; source: "env" | "store" } | null {
  const envKey = env[ENV_KEY_BY_PROVIDER[provider]];
  if (envKey) return { key: envKey, source: "env" };
  const stored = getProviderAuth(provider, home)?.key;
  if (stored) return { key: stored, source: "store" };
  return null;
}
