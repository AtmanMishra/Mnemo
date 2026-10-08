/**
 * Everything an eval writes to disk goes through here. A model in an eval can
 * run `env` or `cat` a config file and the harness records the output, so the
 * results are scrubbed before they are saved: credential shapes (the same
 * `redact` memory uses) and the exact value of any environment variable named
 * like a secret, whatever shape the key has.
 */
import * as fs from "node:fs";
import { redact } from "@mnemo/memory";

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)S?$/i;

/** The values of secret-named variables worth scrubbing (short ones would match ordinary text). */
function secretValues(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([name, value]) => SECRET_NAME.test(name) && typeof value === "string" && value.length >= 12)
    .map(([, value]) => value!)
    .sort((a, b) => b.length - a.length);
}

export function scrub(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = redact(text);
  for (const v of secretValues(env)) out = out.split(v).join("[redacted]");
  return out;
}

/** `fs.writeFileSync` for results: scrubbed. */
export function writeScrubbed(file: string, text: string, env?: NodeJS.ProcessEnv): void {
  fs.writeFileSync(file, scrub(text, env));
}
