/**
 * `mnemo uninstall [--deep] [--yes]`.
 *
 * Plain: the program goes (mnemo and memsrv in $MNEMO_HOME/bin, the link on the
 * PATH if it is ours, the PATH entry on Windows) and everything Mnemo learned
 * stays. `--deep` also deletes $MNEMO_HOME: memory, sessions, credentials,
 * skills, logs, settings. Homebrew and Scoop installs are removed by their
 * package manager, so for them this says the command and, with --deep, still
 * deletes the data.
 */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { InstallKind } from "./update.ts";

const win = process.platform === "win32";
const EXE = (n: string) => (win ? `${n}.exe` : n);

export interface UninstallPlan {
  /** Files that go. */
  files: string[];
  /** A link on the PATH that points at our binary. */
  link?: string;
  /** Windows: the user PATH entry to drop. */
  pathEntry?: string;
  /** For a package manager's install: the command that removes it. */
  manager?: string;
  /** --deep: the data directory, and what is in it. */
  data?: { dir: string; parts: { what: string; bytes: number }[] };
}

function size(p: string): number {
  const st = fs.lstatSync(p, { throwIfNoEntry: false });
  if (!st) return 0;
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const e of fs.readdirSync(p)) n += size(path.join(p, e));
  return n;
}

/**
 * Everything Mnemo writes at the top of its home (dotfiles such as `.env` aside).
 * Kept in step with get.sh and get.ps1, which make the same check.
 */
export const HOME_ENTRIES = [
  "state.json",
  "agent",
  "memory",
  "bin",
  "logs",
  "kernel",
  "best-of",
  // the permission gate: rules, and approvals saved with "always"
  "permissions.json",
  "grants.json",
  // earlier bodies of skills Mnemo rewrote
  "skill-history",
  // the journal's place before it moved into memory/
  "journal.jsonl",
];

/**
 * A directory is only deleted whole if it is plainly Mnemo's: not a home or a
 * root, and holding what Mnemo puts there. A mistyped MNEMO_HOME must never
 * turn `--deep` into deleting something else.
 */
export function looksLikeMnemoHome(dir: string, userHome = os.homedir()): boolean {
  const abs = path.resolve(dir);
  if (abs === path.parse(abs).root || abs === path.resolve(userHome)) return false;
  if (!fs.existsSync(abs)) return false;
  const entries = fs.readdirSync(abs);
  return entries.length > 0 && entries.some((e) => HOME_ENTRIES.includes(e)) && entries.every((e) => HOME_ENTRIES.includes(e) || e.startsWith(".") || e.startsWith("state.json"));
}

export function planUninstall(o: { kind: InstallKind; home: string; deep: boolean; linkDir?: string }): UninstallPlan {
  const plan: UninstallPlan = { files: [] };
  if (o.kind === "homebrew") plan.manager = "brew uninstall mnemo";
  else if (o.kind === "scoop") plan.manager = "scoop uninstall mnemo";
  else if (o.kind === "installer") {
    const bin = path.join(o.home, "bin");
    // Besides the two binaries: copies a Windows update moved aside (`mnemo.exe.<random>.old`).
    let aside: string[] = [];
    try {
      aside = fs.readdirSync(bin).filter((f) => f.endsWith(".old") || f.endsWith(".exe.new"));
    } catch {
      /* no bin */
    }
    plan.files = [EXE("mnemo"), EXE("memsrv"), ...aside].map((f) => path.join(bin, f)).filter((f) => fs.existsSync(f));
    if (win) plan.pathEntry = bin;
    else {
      const link = path.join(o.linkDir ?? path.join(os.homedir(), ".local", "bin"), "mnemo");
      try {
        if (fs.lstatSync(link).isSymbolicLink() && path.resolve(path.dirname(link), fs.readlinkSync(link)) === path.join(bin, "mnemo")) plan.link = link;
      } catch {
        /* no link */
      }
    }
  }
  if (o.deep && fs.existsSync(o.home)) {
    const parts: [string, string][] = [
      ["memory", "memory (what Mnemo learned)"],
      [path.join("agent", "sessions"), "sessions"],
      [path.join("agent", "auth.json"), "credentials from /login"],
      ["grants.json", "approvals you saved"],
      [path.join("agent", "skills"), "your skills"],
      ["logs", "logs"],
    ];
    plan.data = { dir: o.home, parts: parts.map(([rel, what]) => ({ what, bytes: size(path.join(o.home, rel)) })).filter((p) => p.bytes > 0) };
  }
  return plan;
}

export function describePlan(plan: UninstallPlan): string[] {
  const out: string[] = [];
  if (plan.manager) out.push(`Mnemo was installed by a package manager: run  ${plan.manager}`);
  for (const f of plan.files) out.push(`remove  ${f}`);
  if (plan.link) out.push(`remove  ${plan.link} (the link on your PATH)`);
  if (plan.pathEntry) out.push(`remove  ${plan.pathEntry} from your user PATH`);
  if (plan.data) {
    out.push(`delete  ${plan.data.dir}, everything Mnemo kept:`);
    for (const p of plan.data.parts) out.push(`          ${p.what.padEnd(28)} ${human(p.bytes)}`);
  }
  return out;
}

export function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** A detached helper can remove the executable only after its owner has exited.
 * Encoded PowerShell avoids cmd's incompatible argv quoting and path expansion. */
export function windowsRemovalCommand(files: string[], dataDir: string | undefined, ownerPid = process.pid): string[] {
  // Resolve relative MNEMO_HOME paths before the helper changes its working directory.
  const literal = (p: string) => `'${path.resolve(p).replace(/'/g, "''")}'`;
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$mnemoLast = ''
$mnemoOwner = $null
try { $mnemoOwner = [Diagnostics.Process]::GetProcessById(${ownerPid}) } catch [ArgumentException] {}
if ($mnemoOwner) {
  try { $mnemoOwner.WaitForExit() } finally { $mnemoOwner.Dispose() }
}
$mnemoFiles = @(${files.map(literal).join(", ")})
$mnemoData = ${dataDir ? literal(dataDir) : "$null"}
function Clear-MnemoReadOnly([string] $mnemoPath, [bool] $mnemoRecurse) {
  $mnemoAttributes = [IO.File]::GetAttributes($mnemoPath)
  # Never change a link's target, even when it is outside the Mnemo home.
  if ($mnemoAttributes -band [IO.FileAttributes]::ReparsePoint) { return }
  if ($mnemoAttributes -band [IO.FileAttributes]::ReadOnly) {
    [IO.File]::SetAttributes($mnemoPath, [IO.FileAttributes]($mnemoAttributes -band (-bnot [IO.FileAttributes]::ReadOnly)))
  }
  if ($mnemoRecurse -and ($mnemoAttributes -band [IO.FileAttributes]::Directory)) {
    foreach ($mnemoEntry in [IO.Directory]::EnumerateFileSystemEntries($mnemoPath)) {
      Clear-MnemoReadOnly $mnemoEntry $true
    }
  }
}
for ($mnemoAttempt = 0; $mnemoAttempt -lt 100; $mnemoAttempt++) {
  $mnemoPending = $false
  foreach ($mnemoFile in $mnemoFiles) {
    try {
      if ([IO.File]::Exists($mnemoFile)) {
        Clear-MnemoReadOnly $mnemoFile $false
      }
      [IO.File]::Delete($mnemoFile)
    } catch { $mnemoPending = $true; $mnemoLast = "$($mnemoFile): $($_.Exception.Message)" }
  }
  if ($mnemoData -and [IO.Directory]::Exists($mnemoData)) {
    # Directory.Delete removes junctions/symlinks without traversing their targets.
    try {
      Clear-MnemoReadOnly $mnemoData $true
      [IO.Directory]::Delete($mnemoData, $true)
    } catch { $mnemoPending = $true; $mnemoLast = "$($mnemoData): $($_.Exception.Message)" }
  }
  if (-not $mnemoPending) { exit 0 }
  Start-Sleep -Milliseconds 100
}
# Nobody reads a detached helper's output; a test running it does.
[Console]::Error.WriteLine("could not remove $mnemoLast")
exit 1
`;
  return ["powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}

/**
 * Carry it out. On Windows a running .exe cannot be deleted, so the last step
 * (the binaries, and the data folder they live in) is handed to a helper that
 * waits for this process to exit.
 */
export function runUninstall(plan: UninstallPlan, io = { windows: win, rm: (f: string) => fs.rmSync(f, { force: true }), rename: fs.renameSync, tmp: os.tmpdir() }): string[] {
  const done: string[] = [];
  if (plan.link) {
    fs.rmSync(plan.link, { force: true });
    done.push(`removed ${plan.link}`);
  }
  if (plan.pathEntry) {
    const ps = `$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment'); $p=[string]$k.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); $k.SetValue('Path', (($p -split ';' | Where-Object { $_ -and $_ -ne '${plan.pathEntry.replace(/'/g, "''")}' }) -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString); $k.Close()`;
    const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore" });
    done.push(r.status === 0 ? `removed ${plan.pathEntry} from your PATH` : `could not edit your PATH; remove ${plan.pathEntry} from it by hand`);
  }
  const later: string[] = [];
  /** Running binaries moved out of the install; nothing waits on them but the clean-up. */
  const aside: string[] = [];
  for (const f of plan.files) {
    try {
      io.rm(f);
      done.push(`removed ${f}`);
    } catch (error) {
      if (!io.windows) throw error;
      // A running .exe cannot be deleted, but it can be renamed (get.ps1 relies on the same).
      // Moved to the temporary folder, it leaves the install at once, so nothing below
      // depends on a helper outliving this process; on another volume the move fails.
      const moved = path.join(io.tmp, `${path.basename(f)}.${Math.random().toString(36).slice(2)}.old`);
      try {
        io.rename(f, moved);
        aside.push(moved);
        done.push(`removed ${f}`);
      } catch {
        later.push(f);
      }
    }
  }
  if (aside.length) {
    const [command, ...args] = windowsRemovalCommand(aside, undefined);
    // Best effort: what is left in the temporary folder harms nothing.
    spawn(command!, args, { cwd: io.tmp, detached: true, stdio: "ignore", windowsHide: true }).on("error", () => {}).unref();
  }
  let laterData: string | undefined;
  if (plan.data) {
    if (io.windows && later.length) laterData = plan.data.dir;
    else {
      // Windows will not delete a folder that is some process's working directory, this one's included.
      const inside = path.relative(plan.data.dir, process.cwd());
      if (!inside.startsWith("..") && !path.isAbsolute(inside)) process.chdir(io.tmp);
      fs.rmSync(plan.data.dir, { recursive: true, force: true });
      done.push(`deleted ${plan.data.dir}`);
    }
  }
  if (later.length) {
    const [command, ...args] = windowsRemovalCommand(later, laterData);
    // A helper inside the installation directory would itself keep that directory open.
    spawn(command!, args, { cwd: os.tmpdir(), detached: true, stdio: "ignore", windowsHide: true }).unref();
    done.push(`${[...later, ...(laterData ? [laterData] : [])].join(", ")} will be removed when this window's mnemo exits`);
  }
  return done;
}
