/**
 * The environment a command the agent runs is given: the part of Mnemo's own that
 * locates things, never the part that grants access. The model can write `env` or
 * `os.environ` as easily as anything else, and a token it prints lands in the
 * transcript, the session file and the provider's logs; a prompt injection can send
 * it anywhere. So this is an allowlist, not a list of known secrets: a token named
 * nothing anyone predicted stays out too. Mnemo itself still reads everything; only
 * children lose it. `MNEMO_PASS_ENV=NAME,NAME` and the `passEnv` setting hand named
 * ones back.
 */
import * as fs from "node:fs";
import * as path from "node:path";

type Env = Record<string, string | undefined>;

/**
 * What a command gets from Mnemo's environment: what a shell, a compiler and a
 * package manager need to find things and talk to the terminal, and nothing that
 * grants access to anything. Compared upper-cased (Windows spells it `Path`).
 * `GITHUB_TOKEN`, `NPM_TOKEN`, `AWS_*`, `SSH_AUTH_SOCK` and every model key stay
 * out until the user names them. A proxy URL is passed as it is, password and all:
 * without it nothing on that network reaches a package registry.
 */
const BASE = new Set([
  // Shell, user and terminal
  "PATH", "HOME", "USER", "LOGNAME", "USERNAME", "SHELL", "PWD", "HOSTNAME", "SHLVL",
  "TERM", "COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "COLUMNS", "LINES", "NO_COLOR", "FORCE_COLOR",
  "LANG", "LANGUAGE", "TZ", "TMPDIR", "TMP", "TEMP", "EDITOR", "VISUAL", "PAGER", "DISPLAY", "WAYLAND_DISPLAY", "CI",
  // Windows
  "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "ALLUSERSPROFILE", "PUBLIC", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432",
  "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "COMMONPROGRAMW6432", "COMPUTERNAME", "USERDOMAIN", "OS",
  "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "NUMBER_OF_PROCESSORS", "PSMODULEPATH", "DRIVERDATA",
  // Toolchains: where they are installed
  "JAVA_HOME", "GOPATH", "GOROOT", "GOBIN", "CARGO_HOME", "RUSTUP_HOME", "VIRTUAL_ENV", "CONDA_PREFIX", "CONDA_DEFAULT_ENV",
  "PYENV_ROOT", "PYTHONPATH", "NVM_DIR", "NVM_BIN", "BUN_INSTALL", "PNPM_HOME", "VOLTA_HOME", "DENO_DIR",
  "ANDROID_HOME", "ANDROID_SDK_ROOT", "HOMEBREW_PREFIX", "HOMEBREW_CELLAR", "HOMEBREW_REPOSITORY",
  "MANPATH", "INFOPATH", "PKG_CONFIG_PATH", "LD_LIBRARY_PATH",
  // The network the user is on
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
  // Mnemo's and pi's own: the Python kernel's memory cap, and what pi tells the model it may read
  "MNEMO_HOME", "MNEMO_KERNEL_MEMORY_MB", "PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL",
]);
const BASE_PREFIXES = ["LC_", "XDG_"];

const inBase = (name: string): boolean => {
  const n = name.toUpperCase();
  return BASE.has(n) || BASE_PREFIXES.some((p) => n.startsWith(p));
};

/** `A, B,C` as names; anything that is not a variable name is dropped. */
export function envNames(text: string | undefined): string[] {
  return (text ?? "").split(",").map((s) => s.trim()).filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s));
}

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

/**
 * The base names, less `drop` (a custom provider's keys), plus the names the user
 * passes: `MNEMO_PASS_ENV=NAME,NAME` and the `passEnv` setting.
 */
export function childEnv(env: Env = process.env, drop: Iterable<string> = [], passEnv: Iterable<string> = []): Record<string, string> {
  const dropped = new Set(drop);
  const pass = new Set([...envNames(env.MNEMO_PASS_ENV), ...passEnv]);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (pass.has(name) || (inBase(name) && !dropped.has(name))) out[name] = value;
  }
  return out;
}
