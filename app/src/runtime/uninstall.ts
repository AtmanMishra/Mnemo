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
 * A directory is only deleted whole if it is plainly Mnemo's: not a home or a
 * root, and holding what Mnemo puts there. A mistyped MNEMO_HOME must never
 * turn `--deep` into deleting something else.
 */
export function looksLikeMnemoHome(dir: string, userHome = os.homedir()): boolean {
  const abs = path.resolve(dir);
  if (abs === path.parse(abs).root || abs === path.resolve(userHome)) return false;
  if (!fs.existsSync(abs)) return false;
  const known = ["state.json", "agent", "memory", "bin", "logs", "kernel", "best-of"];
  const entries = fs.readdirSync(abs);
  return entries.length > 0 && entries.some((e) => known.includes(e)) && entries.every((e) => known.includes(e) || e.startsWith(".") || e.startsWith("state.json"));
}

export function planUninstall(o: { kind: InstallKind; home: string; deep: boolean; linkDir?: string }): UninstallPlan {
  const plan: UninstallPlan = { files: [] };
  if (o.kind === "homebrew") plan.manager = "brew uninstall mnemo";
  else if (o.kind === "scoop") plan.manager = "scoop uninstall mnemo";
  else if (o.kind === "installer") {
    const bin = path.join(o.home, "bin");
    plan.files = [EXE("mnemo"), EXE("memsrv"), `${EXE("mnemo")}.old`, `${EXE("memsrv")}.old`].map((f) => path.join(bin, f)).filter((f) => fs.existsSync(f));
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

/**
 * Carry it out. On Windows a running .exe cannot be deleted, so the last step
 * (the binaries, and the data folder they live in) is handed to a cmd that
 * waits for this process to exit.
 */
export function runUninstall(plan: UninstallPlan): string[] {
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
  for (const f of plan.files) {
    try {
      fs.rmSync(f, { force: true });
      done.push(`removed ${f}`);
    } catch {
      later.push(f);
    }
  }
  if (plan.data) {
    if (win && later.length) later.push(plan.data.dir);
    else {
      fs.rmSync(plan.data.dir, { recursive: true, force: true });
      done.push(`deleted ${plan.data.dir}`);
    }
  }
  if (later.length) {
    // Wait for this process to go, then delete what it was holding open.
    const cmds = later.map((p) => (p === plan.data?.dir ? `rmdir /s /q "${p}"` : `del /f /q "${p}"`)).join(" & ");
    spawn("cmd", ["/d", "/c", `ping -n 3 127.0.0.1 >nul & ${cmds}`], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    done.push(`${later.join(", ")} will be removed when this window's mnemo exits`);
  }
  return done;
}
