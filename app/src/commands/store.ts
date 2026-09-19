/**
 * Writing a key where the rest of Mnemo will find it.
 *
 * The schema is not ours to invent: `agent/src/auth/store.ts` reads
 * `{ version, providers: { [id]: { kind, key, updated_at } } }` from
 * `$MNEMO_HOME/auth.json`, and the old Go interface parsed the same file. A
 * second opinion about the format is how a key gets written successfully and
 * still not found.
 *
 * Two rules about the key itself, both non-negotiable:
 *
 *  1. **It never appears anywhere but the file.** Not in the transcript, not in
 *     a log line, not in a status message, not in an error. The functions here
 *     return the *path* they wrote, never the value.
 *  2. **The file is private on arrival.** Created with mode 0600 and chmod'd
 *     afterwards, because the mode argument is ignored on Windows and honoured
 *     on POSIX — doing both is the only way to be right on both.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface ProviderAuth {
  kind: "api_key" | "oauth";
  key?: string;
  defaultModel?: string;
  updated_at: number;
}

export interface AuthFile {
  version: 1;
  providers: Record<string, ProviderAuth>;
  defaultProvider?: string;
}

export function authPath(home: string): string {
  return path.join(home, "auth.json");
}

/** The file as it stands, or a fresh one when it is missing or unreadable. */
export function readAuth(home: string): AuthFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(authPath(home), "utf8")) as AuthFile;
    if (parsed?.version === 1 && typeof parsed.providers === "object" && parsed.providers !== null) {
      return parsed;
    }
  } catch {
    // Missing, empty, or someone's hand-edited mistake: start clean rather than
    // refusing to log in. Nothing here is worth losing a working install over.
  }
  return { version: 1, providers: {} };
}

/**
 * Store a provider's key, merging with what is already there.
 *
 * Merge, not replace: adding OpenAI must not delete the OpenRouter key that was
 * working, and `defaultProvider` only moves when nothing is set — logging in for
 * a second opinion should not silently change what runs.
 */
export function saveKey(home: string, provider: string, key: string, now: number = Date.now()): string {
  fs.mkdirSync(home, { recursive: true });
  const file = readAuth(home);

  file.providers[provider] = { kind: "api_key", key, updated_at: now };
  file.defaultProvider ??= provider;

  const target = authPath(home);
  fs.writeFileSync(target, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // Windows has no mode bits; the write above is the best available there.
  }
  return target;
}

/** A key's shape, named for the reader instead of described as wrong. */
export function describeKeyShape(key: string): string {
  if (key.length < 8) return "that looks too short to be a key";
  if (/\s/.test(key.trim())) return "keys have no spaces in them";
  return "";
}
