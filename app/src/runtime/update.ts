/**
 * Updating Mnemo.
 *
 * Manual, always: `mnemo update` (or `/update`) asks GitHub for the latest
 * release and, if it is newer, runs that release's own installer, the same
 * script as the one-liner, which checks the archive's SHA-256 against the
 * release's SHA256SUMS before replacing anything. Memory, sessions and
 * settings are never touched.
 *
 * Automatic, only when you turn it on (`mnemo update --auto on`, or
 * MNEMO_AUTO_UPDATE=1): at most once a day, at launch, the same question is
 * asked in the background and a newer version is announced. Nothing is
 * installed without you. Off, Mnemo makes no request of its own.
 *
 * Homebrew and Scoop installs are left to their package manager, and a source
 * checkout to git: running the installer over them would split the install.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const REPO = "AtmanMishra/Mnemo";
const DAY_MS = 24 * 60 * 60 * 1000;

/** -1, 0 or 1. `0.1.10` is newer than `0.1.9`; a pre-release (`0.2.0-rc.1`) is older than its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", pre] = v.replace(/^v/, "").split("-", 2);
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * The latest release's version, from where github.com/<repo>/releases/latest
 * redirects (no API, so no rate limit and no token). Undefined when offline.
 */
export async function latestVersion(fetchImpl: typeof fetch = fetch, timeoutMs = 5000): Promise<string | undefined> {
  try {
    const res = await fetchImpl(`https://github.com/${REPO}/releases/latest`, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    const where = res.headers.get("location") ?? res.url;
    const tag = /\/releases\/tag\/(v[0-9][A-Za-z0-9.+-]*)$/.exec(where ?? "")?.[1];
    return tag?.replace(/^v/, "");
  } catch {
    return undefined;
  }
}

export type InstallKind = "installer" | "homebrew" | "scoop" | "source" | "elsewhere";

/** How this copy of Mnemo was installed, from where its binary is. */
export function installKind(execPath: string, home: string): InstallKind {
  const exe = execPath.replace(/\\/g, "/").toLowerCase();
  const base = path.basename(exe);
  if (base === "bun" || base === "bun.exe" || base === "node" || base === "node.exe") return "source";
  if (exe.includes("/cellar/") || exe.includes("/homebrew/")) return "homebrew";
  if (exe.includes("/scoop/")) return "scoop";
  // Compared as written, then as the file system resolves them: MNEMO_HOME may be a
  // symlink or relative, and Windows may hand back an 8.3 short name for either side.
  const norm = (p: string) => (process.platform === "win32" ? p.replace(/\\/g, "/").toLowerCase() : p.replace(/\\/g, "/"));
  const real = (p: string) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  const dir = (p: string) => path.posix.dirname(norm(p));
  const bin = path.join(home, "bin");
  if (dir(execPath) === norm(bin).replace(/\/$/, "")) return "installer";
  return dir(real(execPath)) === norm(real(bin)) ? "installer" : "elsewhere";
}

/** What to tell someone whose install is not the installer's. */
export function manualStep(kind: InstallKind, version: string): string {
  switch (kind) {
    case "homebrew":
      return "brew upgrade mnemo";
    case "scoop":
      return "scoop update mnemo";
    case "source":
      return "git pull && bun install (you are running from a source checkout)";
    default:
      return process.platform === "win32"
        ? `$env:MNEMO_VERSION="v${version}"; irm https://github.com/${REPO}/releases/download/v${version}/install.ps1 | iex`
        : `curl -fsSL https://github.com/${REPO}/releases/download/v${version}/install.sh | sh`;
  }
}

/**
 * Run release `version`'s installer for this machine. `log` gets each line it
 * prints. Resolves to the installer's exit code.
 */
export async function runInstaller(version: string, home: string, log: (line: string) => void, fetchImpl: typeof fetch = fetch): Promise<number> {
  const win = process.platform === "win32";
  const name = win ? "install.ps1" : "install.sh";
  const res = await fetchImpl(`https://github.com/${REPO}/releases/download/v${version}/${name}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`could not download the v${version} installer (HTTP ${res.status})`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-update-"));
  try {
    const script = path.join(dir, name);
    // Windows PowerShell 5.1 reads a .ps1 without a byte-order mark as ANSI, which garbles the installer's glyphs.
    fs.writeFileSync(script, (win ? "\uFEFF" : "") + (await res.text()), { mode: 0o700 });
    const cmd = win ? ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script] : ["sh", script, "--version", `v${version}`];
    const p = Bun.spawn(cmd, {
      env: { ...process.env, MNEMO_HOME: home, MNEMO_VERSION: `v${version}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const pump = async (stream: ReadableStream<Uint8Array>) => {
      let rest = "";
      for await (const chunk of stream) {
        const lines = (rest + new TextDecoder().decode(chunk)).split(/\r?\n/);
        rest = lines.pop() ?? "";
        for (const l of lines) if (l.trim()) log(l);
      }
      if (rest.trim()) log(rest);
    };
    await Promise.all([pump(p.stdout), pump(p.stderr)]);
    return await p.exited;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Whether to ask GitHub at this launch: only when turned on, and not more than once a day. */
export function shouldCheck(o: { auto?: boolean; checkedAt?: number; now: number; env: Record<string, string | undefined> }): boolean {
  const env = o.env.MNEMO_AUTO_UPDATE;
  const on = env === undefined || env === "" ? !!o.auto : !["0", "false", "no", "off"].includes(env.toLowerCase());
  return on && (o.checkedAt === undefined || o.now - o.checkedAt >= DAY_MS);
}

/**
 * On Windows the installer renames a running binary aside (`mnemo.exe.<random>.old`, a
 * new name each time since an earlier one may still be running); clear those that no
 * longer are.
 */
export function clearReplaced(home: string, files: { readdirSync(p: string): string[]; rmSync(p: string, o: { force: true }): void } = fs): void {
  const bin = path.join(home, "bin");
  let names: string[];
  try {
    names = files.readdirSync(bin).filter((f) => f.endsWith(".old"));
  } catch {
    return;
  }
  for (const f of names) {
    try {
      files.rmSync(path.join(bin, f), { force: true });
    } catch {
      /* still running in another window: next time */
    }
  }
}
