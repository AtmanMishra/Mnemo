/**
 * The facts one frame needs, gathered from the machine.
 *
 * Everything is injected — the environment, the filesystem, the binary lookup —
 * so the answers are tested rather than assumed, and so a test never reads the
 * developer's real `~/.mnemo`.
 *
 * One home, decided once (`mnemoHome`), and nothing else resolves `os.homedir()`
 * on its own. The credentials store in the old code did exactly that and read
 * the wrong file while believing it was somewhere else; every path here comes
 * from the home this file returns.
 */
import * as os from "node:os";
import * as path from "node:path";

export interface Facts {
  runtime: string;
  home: string;
  provider?: string;
  model?: string;
  memory: boolean;
  kernel: boolean;
}

export interface FactSources {
  env?: Record<string, string | undefined>;
  exists?: (p: string) => boolean;
  readFile?: (p: string) => string;
  /** Resolves a command name to a path, or null. */
  which?: (cmd: string) => string | null;
  runtime?: string;
}

/** The Mnemo home: `MNEMO_HOME` when set and not blank, else `~/.mnemo`. */
export function mnemoHome(env: Record<string, string | undefined> = process.env): string {
  const override = env.MNEMO_HOME?.trim();
  if (override) return override;
  return path.join(os.homedir(), ".mnemo");
}

const MEMSRV = process.platform === "win32" ? "memsrv.exe" : "memsrv";

/** Interpreters worth trying, in the order a machine is likely to have them. */
const PYTHONS = ["python3", "python"];

/**
 * What the credentials file says, read directly and tolerantly.
 *
 * A file that cannot be parsed reads as "no provider configured", which is the
 * honest answer to "can this run?" — and the reason this is not the store's
 * loader yet: the store moves into this package later, and until it does this
 * must not pretend to be it.
 */
export function readProviders(
  home: string,
  readFile: (p: string) => string,
): { providers: string[]; model?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFile(path.join(home, "auth.json")));
  } catch {
    return { providers: [] };
  }
  if (!parsed || typeof parsed !== "object") return { providers: [] };
  const store = parsed as {
    defaultProvider?: string;
    defaultModel?: string;
    providers?: Record<string, { key?: string; accessToken?: string; defaultModel?: string }>;
  };
  const providers = Object.entries(store.providers ?? {})
    // A key that is only whitespace is a paste that went wrong, not a
    // credential: counting it would send a run into a failure much further
    // away, where the error no longer points at the file that caused it.
    .filter(([, entry]) => Boolean(entry && (entry.key?.trim() || entry.accessToken?.trim())))
    .map(([name]) => name);
  const chosen = store.defaultProvider && providers.includes(store.defaultProvider)
    ? store.defaultProvider
    : providers[0];
  const model = store.defaultModel ?? (chosen ? store.providers?.[chosen]?.defaultModel : undefined);
  return { providers, model };
}

/** Gather the facts. Every source has a real default; nothing is guessed. */
export function collectFacts(sources: FactSources = {}): Facts {
  const env = sources.env ?? (process.env as Record<string, string | undefined>);
  const exists = sources.exists ?? ((p: string) => require("node:fs").existsSync(p));
  const readFile =
    sources.readFile ?? ((p: string) => require("node:fs").readFileSync(p, "utf8"));
  const which = sources.which ?? defaultWhich;

  const home = mnemoHome(env);
  const { providers, model } = readProviders(home, readFile);

  const memsrvPath = env.MNEMO_MEMSRV_BIN?.trim() || path.join(home, MEMSRV);
  const python = env.SEA_PYTHON?.trim() || PYTHONS.map(which).find(Boolean) || undefined;

  const runtime = sources.runtime ??
    (globalThis as { Bun?: { version: string } }).Bun?.version
      ? `Bun ${(globalThis as { Bun?: { version: string } }).Bun!.version}`
      : `Node ${process.version}`;

  return {
    runtime,
    home,
    provider: providers[0],
    model,
    memory: exists(memsrvPath),
    kernel: Boolean(python && exists(python)),
  };
}

function defaultWhich(cmd: string): string | null {
  const bun = (globalThis as { Bun?: { which: (c: string) => string | null } }).Bun;
  if (bun?.which) return bun.which(cmd);
  return null;
}
