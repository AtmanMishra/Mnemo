/**
 * Bun bug 27802: a compiled binary started inside some sandboxes (nono on Linux and
 * macOS) sees an empty `process.env`, so no provider key, no MNEMO_HOME, no HOME. On
 * Linux the environment is still in `/proc/self/environ`. This mirrors pi's own
 * `restoreSandboxEnv()` (pi-coding-agent/dist/bun/restore-sandbox-env.js, not
 * exported). Its own module, imported first by bun-setup.ts, so it runs before any
 * module that reads the environment as it loads.
 */
import { readFileSync } from "node:fs";

export function restoreSandboxEnv(env: Record<string, string | undefined> = process.env, read = () => readFileSync("/proc/self/environ", "utf8")): void {
  if (!process.versions.bun || Object.keys(env).length > 0) return;
  try {
    for (const entry of read().split("\0")) {
      const i = entry.indexOf("=");
      if (i > 0) env[entry.slice(0, i)] = entry.slice(i + 1);
    }
  } catch {
    /* not readable (not Linux): nothing to restore from */
  }
}

restoreSandboxEnv();
