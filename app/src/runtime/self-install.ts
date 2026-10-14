/**
 * A downloaded Mnemo installs itself.
 *
 * The Windows zip holds mnemo.exe and memsrv.exe. Double-clicked from Downloads, mnemo.exe
 * offers once to put both in $MNEMO_HOME\bin (where the installer puts them) and that
 * folder on the user PATH; `mnemo install` does the same from a script. The files are
 * swapped the way get.ps1 swaps them, and the PATH is edited the way get.ps1 edits it.
 * Elsewhere `mnemo install` copies the files and says what to add to the shell profile:
 * profiles are not edited.
 *
 * Everything here takes the file system, the PATH and the platform as parameters, so
 * it runs under test on any machine; only the PowerShell that edits the PATH is Windows'.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { clearReplaced, installKind, type InstallKind } from "./update.ts";

export type Env = Record<string, string | undefined>;

/** The two files a release holds, as they are named on `platform`. */
export function binaryNames(platform: NodeJS.Platform): [string, string] {
  return platform === "win32" ? ["mnemo.exe", "memsrv.exe"] : ["mnemo", "memsrv"];
}

/** Commands and flags that must run as asked, without a question first. */
const NO_OFFER_COMMANDS = ["doctor", "uninstall", "update", "memory", "install"];
const NO_OFFER_FLAGS = ["-p", "--print", "-v", "--version", "-h", "--help", "--dump"];

/** Whether this launch may ask at all: a person at a terminal, starting Mnemo itself. */
export function mayOffer(argv: string[], tty: boolean, env: Env): boolean {
  if (!tty || env.MNEMO_NO_SELF_INSTALL) return false;
  if (argv[0] && NO_OFFER_COMMANDS.includes(argv[0])) return false;
  return !argv.some((a) => NO_OFFER_FLAGS.includes(a));
}

export interface Offer {
  /** The folder this copy runs from. */
  from: string;
  bin: string;
  question: string;
}

/**
 * What to ask, or nothing: on Windows, a copy from a release archive (memsrv beside
 * it) that is not the installed one, unless the person said no for this folder, or
 * the installed copy is this same version.
 */
export function selfInstallOffer(o: {
  platform: NodeJS.Platform;
  execPath: string;
  home: string;
  version: string;
  env: Env;
  /** The folder the person last said no for. */
  declined?: string;
  exists?: (p: string) => boolean;
  /** The version of the copy installed at `exe`, if it runs. */
  installedVersion?: (exe: string) => string | undefined;
  kind?: InstallKind;
}): Offer | undefined {
  const exists = o.exists ?? fs.existsSync;
  // MNEMO_SELF_INSTALL_TEST lets the terminal tests reach the question off Windows.
  if (o.platform !== "win32" && o.env.MNEMO_SELF_INSTALL_TEST !== "1") return undefined;
  if ((o.kind ?? installKind(o.execPath, o.home)) !== "elsewhere") return undefined;
  const [mnemo, memsrv] = binaryNames(o.platform);
  const from = path.dirname(o.execPath);
  if (!exists(path.join(from, memsrv)) || o.declined === from) return undefined;
  const bin = path.join(o.home, "bin");
  const target = path.join(bin, mnemo);
  if (exists(target)) {
    const installed = (o.installedVersion ?? versionOf)(target);
    if (installed === o.version) return undefined;
    return { from, bin, question: `Replace the installed Mnemo${installed ? ` (v${installed})` : ""} in ${bin} with this one (v${o.version})?` };
  }
  return { from, bin, question: `Install Mnemo to ${bin} and add it to your PATH?` };
}

/** What `<exe> --version` prints, or undefined when it does not run. */
export function versionOf(exe: string): string | undefined {
  const r = spawnSync(exe, ["--version"], { encoding: "utf8", timeout: 10_000, env: { ...process.env, MNEMO_NO_SELF_INSTALL: "1" }, windowsHide: true });
  return r.status === 0 ? r.stdout.trim() || undefined : undefined;
}

/** The file operations an install makes; node:fs by default, a failing stand-in under test. */
export interface Files {
  existsSync(p: string): boolean;
  mkdirSync(p: string, o: { recursive: true }): unknown;
  copyFileSync(from: string, to: string): void;
  renameSync(from: string, to: string): void;
  rmSync(p: string, o: { force: true }): void;
  readdirSync(p: string): string[];
}

/**
 * Put mnemo and memsrv from `from` into `bin`, as get.ps1 does: both new files go in
 * beside the old ones as `.new` first; each old one is moved aside as
 * `<name>.<random>.old` (a running .exe cannot be overwritten, but it can be renamed);
 * if either cannot be moved, the other is put back and nothing has changed.
 */
export function placeBinaries(o: { from: string; bin: string; home: string; platform: NodeJS.Platform; files?: Files; random?: () => string }): void {
  const f = o.files ?? fs;
  const random = o.random ?? (() => Math.random().toString(36).slice(2, 10));
  const names = binaryNames(o.platform);
  f.mkdirSync(o.bin, { recursive: true });
  // Copies left aside by earlier updates; one still running stays.
  clearReplaced(o.home, f);
  for (const n of names) f.copyFileSync(path.join(o.from, n), path.join(o.bin, `${n}.new`));
  const aside: { old: string; dest: string }[] = [];
  for (const n of names) {
    const dest = path.join(o.bin, n);
    if (!f.existsSync(dest)) continue;
    const old = `${dest}.${random()}.old`;
    try {
      f.renameSync(dest, old);
      aside.push({ old, dest });
    } catch {
      for (const a of aside) f.renameSync(a.old, a.dest);
      for (const m of names) f.rmSync(path.join(o.bin, `${m}.new`), { force: true });
      throw new Error(`could not replace ${dest}; close every Mnemo window and try again`);
    }
  }
  for (const n of names) f.renameSync(path.join(o.bin, `${n}.new`), path.join(o.bin, n));
}

/**
 * `current` with `dir` added at the end, or undefined when it is already there. On
 * Windows entries compare without case and without a trailing backslash.
 */
export function withPathEntry(current: string, dir: string, platform: NodeJS.Platform): string | undefined {
  const win = platform === "win32";
  const sep = win ? ";" : ":";
  const norm = (p: string) => {
    const s = p.trim().replace(win ? /[\\/]+$/ : /\/+$/, "");
    return win ? s.toLowerCase() : s;
  };
  const entries = current.split(sep).filter((e) => e.trim());
  if (entries.some((e) => norm(e) === norm(dir))) return undefined;
  return [...entries, dir].join(sep);
}

/**
 * The user PATH, read and written as get.ps1 does: straight from HKCU\Environment, raw,
 * so %VARIABLES% in it stay unexpanded, and written back as REG_EXPAND_SZ.
 * ([Environment]::SetEnvironmentVariable would write REG_SZ and break them.)
 */
export const PS_USER_PATH = `function Get-UserPath {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment")
    try { if ($key) { return [string]$key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { return "" } } finally { if ($key) { $key.Close() } }
  }
  function Set-UserPath($value) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Environment")
    try { $key.SetValue("Path", $value, [Microsoft.Win32.RegistryValueKind]::ExpandString) } finally { $key.Close() }
  }`;
/** The value goes out as base64 of UTF-8: the console's code page would mangle a non-ASCII folder. */
export const PS_READ = "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-UserPath)))";
/**
 * The value comes in through the environment, so nothing in it is parsed as PowerShell.
 * Clearing a variable that is not there tells open windows (Explorer, so a terminal it
 * starts) that the environment changed, which the registry write alone does not.
 */
export const PS_WRITE = `Set-UserPath $env:MNEMO_USER_PATH; [Environment]::SetEnvironmentVariable("MNEMO_PATH_CHANGED", $null, "User")`;

export interface UserPath {
  read(): string;
  write(value: string): void;
}

/** The user PATH through `exe` (Windows PowerShell); `prelude` defines Get-UserPath and Set-UserPath. */
export function userPathVia(exe = "powershell", prelude = PS_USER_PATH): UserPath {
  // -EncodedCommand: nothing in the script is re-quoted on its way through the command line.
  const run = (script: string, env: Env = {}) => {
    const r = spawnSync(exe, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(`${prelude}\n${script}`, "utf16le").toString("base64")], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    if (r.status !== 0) throw new Error(`could not ${env.MNEMO_USER_PATH === undefined ? "read" : "change"} your PATH: ${r.stderr.trim() || `powershell exited ${r.status}`}`);
    return r.stdout;
  };
  return {
    read: () => Buffer.from(run(PS_READ).trim(), "base64").toString("utf8"),
    write: (value) => void run(PS_WRITE, { MNEMO_USER_PATH: value }),
  };
}

/**
 * Install this copy. Returns what was done, then what to do next, one line each.
 * Throws when the files cannot be put in place (nothing changed then).
 */
export function selfInstall(o: {
  execPath: string;
  home: string;
  platform: NodeJS.Platform;
  env: Env;
  files?: Files;
  userPath?: UserPath;
  random?: () => string;
}): { done: string[]; next: string[] } {
  const [mnemo, memsrv] = binaryNames(o.platform);
  const from = path.dirname(o.execPath);
  const bin = path.join(o.home, "bin");
  const exists = (o.files ?? fs).existsSync;
  if (!exists(path.join(from, memsrv))) throw new Error(`${memsrv} is not beside ${o.execPath}; unzip the whole release archive and run ${mnemo} from there`);
  placeBinaries({ from, bin, home: o.home, platform: o.platform, files: o.files, random: o.random });
  const done = [`copied ${mnemo} and ${memsrv} to ${bin}`];
  const next: string[] = [];
  if (o.platform === "win32") {
    const userPath = o.userPath ?? userPathVia();
    const added = withPathEntry(userPath.read(), bin, o.platform);
    if (added === undefined) done.push(`${bin} is already on your PATH`);
    else {
      userPath.write(added);
      done.push(`added ${bin} to your PATH`);
    }
    next.push("Open a new terminal and type  mnemo");
  } else if (withPathEntry(o.env.PATH ?? "", bin, o.platform) !== undefined) {
    next.push(`Add ${bin} to your PATH: put this line in your shell profile (~/.profile, ~/.zshrc)`, `  export PATH="${bin}:$PATH"`, "then open a new terminal and type  mnemo");
  } else next.push("Type  mnemo  to start it");
  next.push(`The downloaded ${mnemo} and ${memsrv} in ${from} are no longer needed; you can delete them.`);
  return { done, next };
}

/**
 * Whether this console window is ours alone, as when mnemo.exe was double-clicked: it
 * closes the moment Mnemo exits, so the last lines need an Enter first. Assumed so when
 * Windows cannot be asked.
 */
export async function ownConsole(platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (platform !== "win32") return false;
  try {
    const { dlopen, FFIType, ptr } = await import("bun:ffi");
    const k = dlopen("kernel32.dll", { GetConsoleProcessList: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 } });
    const ids = new Uint32Array(4);
    const n = k.symbols.GetConsoleProcessList(ptr(ids), ids.length);
    k.close();
    return n <= 1;
  } catch {
    return true;
  }
}
