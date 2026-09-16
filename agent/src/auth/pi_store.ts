/**
 * pi's own stores, read-only: the credential it holds and the provider/model it
 * defaults to.
 *
 * Mnemo used to refuse to start unless one of the five API-key providers it
 * knows how to mint a key for was configured. That locked out the two kinds of
 * tester pi serves best and Mnemo cannot key itself:
 *
 *   - someone whose only credential is a pi subscription (pi's own /login:
 *     Claude Pro/Max, ChatGPT Plus/Pro, GitHub Copilot, xAI, OpenRouter,
 *     Radius), whose token lives in pi's auth.json, not in Mnemo's;
 *   - someone running a local model server — a llama.cpp router needs no key
 *     at all, only a base URL.
 *
 * pi keeps both under its agent directory (pi's docs/environment-variables.md,
 * docs/providers.md):
 *
 *   <agentDir>/auth.json      credentials: api_key, or oauth for a subscription
 *   <agentDir>/settings.json  the chosen defaultProvider / defaultModel
 *
 * <agentDir> is PI_CODING_AGENT_DIR when set, else ~/.pi/agent.
 *
 * Nothing here ever WRITES those files. They belong to pi, and a wrapper that
 * edited them would be a second, silently diverging source of truth about
 * somebody else's login.
 *
 * Every function takes env and home explicitly rather than defaulting to
 * process.env and os.homedir(): a test that leaned on either would pass by
 * reading, and one day writing, the developer's real ~/.pi.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** pi's configuration directory under `home`. */
export function agentDir(env: NodeJS.ProcessEnv = {}, home = os.homedir()): string {
  const override = env.PI_CODING_AGENT_DIR?.trim();
  return override ? expandTilde(override, home) : path.join(home, ".pi", "agent");
}

/** pi resolves `~` in its own paths; so do we, against the home we were given. */
function expandTilde(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(home, p.slice(2));
  return p;
}

/** One of pi's JSON files, or null when it is missing, unreadable or not an object. */
function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch { /* missing or corrupt reads as "pi has nothing stored" */ }
  return null;
}

/**
 * Providers pi holds a usable credential for, in file order.
 *
 * "Usable" is the shape pi's own AuthStorage accepts: an api_key with a key or
 * with provider-scoped env values, or an oauth entry with an access token. An
 * entry pi itself would reject is not a credential, and counting it would send
 * us into a start that fails somewhere less obvious.
 */
export function credentials(env: NodeJS.ProcessEnv = {}, home = os.homedir()): string[] {
  const auth = readJson(path.join(agentDir(env, home), "auth.json"));
  if (!auth) return [];
  return Object.entries(auth).filter(([, entry]) => usable(entry)).map(([provider]) => provider);
}

function usable(entry: unknown): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const c = entry as Record<string, unknown>;
  if (c.type === "api_key") {
    if (typeof c.key === "string" && c.key.trim() !== "") return true;
    const scoped = c.env;
    if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) return false;
    return Object.values(scoped as Record<string, unknown>).some((v) => typeof v === "string" && v !== "");
  }
  if (c.type === "oauth") return typeof c.access === "string" && c.access !== "";
  return false;
}

/**
 * Whether pi can serve `provider` from its own store.
 *
 * With no provider named, the question is whether pi has any credential at
 * all — which is what decides between "start anyway, pi knows what to do" and
 * "say what is missing".
 *
 * What this canNOT see: pi's per-provider environment variables (a local
 * LLAMA_BASE_URL, an XAI_API_KEY, …) and providers registered from a package
 * or models.json. It is deliberately one question, not a gate: the caller
 * treats a named MNEMO_PROVIDER as pi's business whether or not this answers
 * yes, because refusing on evidence we cannot collect is the bug being fixed.
 */
export function hasCredential(
  provider?: string,
  env: NodeJS.ProcessEnv = {},
  home = os.homedir(),
): boolean {
  const ids = credentials(env, home);
  return provider ? ids.includes(provider) : ids.length > 0;
}

/** The provider and model pi's global settings.json says pi itself would use. */
export function defaults(
  env: NodeJS.ProcessEnv = {},
  home = os.homedir(),
): { provider?: string; model?: string } {
  const settings = readJson(path.join(agentDir(env, home), "settings.json"));
  const provider = settings?.defaultProvider;
  const model = settings?.defaultModel;
  return {
    provider: typeof provider === "string" && provider !== "" ? provider : undefined,
    model: typeof model === "string" && model !== "" ? model : undefined,
  };
}
