/**
 * A downloaded Mnemo installs itself: when it asks, how it swaps the files (as get.ps1
 * does, both or neither), and how it adds its folder to the user PATH. The file system,
 * the PATH and the platform are handed in, so the Windows paths run here too.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mayOffer, placeBinaries, placementProblems, PS_USER_PATH, selfInstall, selfInstallOffer, userPathVia, withPathEntry, type Files, type UserPath } from "../src/runtime/self-install.ts";

const pwsh = process.env.MNEMO_TEST_PWSH || Bun.which("pwsh");

/** An unzipped release in a downloads folder, and an empty Mnemo home. */
function download(platform: NodeJS.Platform = "win32") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-self-")));
  const from = path.join(root, "Downloads", "mnemo-windows-x64");
  const home = path.join(root, ".mnemo");
  fs.mkdirSync(from, { recursive: true });
  const [mnemo, memsrv] = platform === "win32" ? ["mnemo.exe", "memsrv.exe"] : ["mnemo", "memsrv"];
  fs.writeFileSync(path.join(from, mnemo), "new mnemo");
  fs.writeFileSync(path.join(from, memsrv), "new memsrv");
  return { root, from, home, bin: path.join(home, "bin"), execPath: path.join(from, mnemo) };
}

/** node:fs, except that renaming `locked` fails the way Windows fails on a running .exe. */
function lockedFiles(locked: string[]): Files {
  return {
    existsSync: fs.existsSync,
    mkdirSync: fs.mkdirSync,
    copyFileSync: fs.copyFileSync,
    rmSync: fs.rmSync,
    readdirSync: (p) => fs.readdirSync(p),
    renameSync: (a, b) => {
      if (locked.includes(path.basename(a)) && b.endsWith(".old")) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      fs.renameSync(a, b);
    },
  };
}

function memoryPath(value: string): UserPath & { value: string; writes: number } {
  const p = {
    value,
    writes: 0,
    read: () => p.value,
    write: (v: string) => {
      p.value = v;
      p.writes++;
    },
  };
  return p;
}

const filesIn = (dir: string) => Object.fromEntries(fs.readdirSync(dir).sort().map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]));

describe("installing", () => {
  test("fresh: both files go into $MNEMO_HOME/bin and the folder onto the user PATH", () => {
    const d = download();
    const userPath = memoryPath("%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Tools");
    const r = selfInstall({ execPath: d.execPath, home: d.home, platform: "win32", env: {}, userPath });
    expect(filesIn(d.bin)).toEqual({ "memsrv.exe": "new memsrv", "mnemo.exe": "new mnemo" });
    // Appended, with the unexpanded %USERPROFILE% left as it was.
    expect(userPath.value).toBe(`%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Tools;${d.bin}`);
    expect(r.done).toContain(`added ${d.bin} to your PATH`);
    expect(r.next[0]).toBe("Open a new terminal and type  mnemo");
    expect(r.next.join("\n")).toContain(`in ${d.from} are no longer needed`);
  });

  test("a PATH that already holds the folder, in other case or with a trailing backslash, is not written", () => {
    expect(withPathEntry("C:\\Users\\Ann\\.MNEMO\\BIN\\;C:\\Tools", "C:\\Users\\Ann\\.mnemo\\bin", "win32")).toBeUndefined();
    expect(withPathEntry("C:\\Tools;c:\\users\\ann\\.mnemo\\bin", "C:\\Users\\Ann\\.mnemo\\bin", "win32")).toBeUndefined();
    // Case matters elsewhere.
    expect(withPathEntry("/home/ann/.MNEMO/bin", "/home/ann/.mnemo/bin", "linux")).toBe("/home/ann/.MNEMO/bin:/home/ann/.mnemo/bin");
    // An empty or ;-ended PATH does not grow an empty entry.
    expect(withPathEntry("", "C:\\b", "win32")).toBe("C:\\b");
    expect(withPathEntry("C:\\a;", "C:\\b", "win32")).toBe("C:\\a;C:\\b");

    const d = download();
    const userPath = memoryPath(`C:\\Tools;${d.bin.toUpperCase()}\\`);
    const r = selfInstall({ execPath: d.execPath, home: d.home, platform: "win32", env: {}, userPath });
    expect(userPath.writes).toBe(0);
    expect(r.done).toContain(`${d.bin} is already on your PATH`);
  });

  test("an installed mnemo.exe that is running is moved aside as <name>.<random>.old", () => {
    const d = download();
    fs.mkdirSync(d.bin, { recursive: true });
    fs.writeFileSync(path.join(d.bin, "mnemo.exe"), "old mnemo");
    fs.writeFileSync(path.join(d.bin, "memsrv.exe"), "old memsrv");
    // An earlier update's copy, still running, must not stop this one.
    fs.writeFileSync(path.join(d.bin, "mnemo.exe.k2j4.old"), "still running");
    const files: Files = {
      ...lockedFiles([]),
      rmSync: (p, o) => {
        if (p.endsWith(".old")) throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
        fs.rmSync(p, o);
      },
    };
    placeBinaries({ from: d.from, bin: d.bin, home: d.home, platform: "win32", files, random: () => "x1" });
    const now = filesIn(d.bin);
    expect(now["mnemo.exe"]).toBe("new mnemo");
    expect(now["memsrv.exe"]).toBe("new memsrv");
    expect(now["mnemo.exe.x1.old"]).toBe("old mnemo");
    expect(now["memsrv.exe.x1.old"]).toBe("old memsrv");
    expect(now["mnemo.exe.k2j4.old"]).toBe("still running");
  });

  test("when memsrv.exe cannot be moved aside, the old mnemo.exe stays too, and nothing new is left", () => {
    const d = download();
    fs.mkdirSync(d.bin, { recursive: true });
    fs.writeFileSync(path.join(d.bin, "mnemo.exe"), "old mnemo");
    fs.writeFileSync(path.join(d.bin, "memsrv.exe"), "old memsrv");
    const userPath = memoryPath("");
    expect(() => selfInstall({ execPath: d.execPath, home: d.home, platform: "win32", env: {}, userPath, files: lockedFiles(["memsrv.exe"]) })).toThrow(/could not replace/);
    expect(filesIn(d.bin)).toEqual({ "memsrv.exe": "old memsrv", "mnemo.exe": "old mnemo" });
    expect(userPath.writes).toBe(0);
  });

  test("without memsrv beside it, nothing is installed", () => {
    const d = download();
    fs.rmSync(path.join(d.from, "memsrv.exe"));
    expect(() => selfInstall({ execPath: d.execPath, home: d.home, platform: "win32", env: {}, userPath: memoryPath("") })).toThrow(/memsrv\.exe is not beside/);
    expect(fs.existsSync(d.bin)).toBe(false);
  });

  test("off Windows the PATH is not edited: it says the line for the shell profile", () => {
    const d = download("linux");
    const r = selfInstall({ execPath: d.execPath, home: d.home, platform: "linux", env: { PATH: "/usr/bin" } });
    expect(filesIn(d.bin)).toEqual({ memsrv: "new memsrv", mnemo: "new mnemo" });
    expect(r.next).toContain(`  export PATH="${d.bin}:$PATH"`);
    expect(selfInstall({ execPath: d.execPath, home: d.home, platform: "linux", env: { PATH: `/usr/bin:${d.bin}` } }).next[0]).toBe("Type  mnemo  to start it");
  });
});

describe("asking", () => {
  const offer = (d: ReturnType<typeof download>, o: Partial<Parameters<typeof selfInstallOffer>[0]> = {}) =>
    selfInstallOffer({ platform: "win32", execPath: d.execPath, home: d.home, version: "0.2.0", env: {}, installedVersion: () => undefined, ...o });

  test("a downloaded copy with memsrv beside it asks to install itself", () => {
    const d = download();
    expect(offer(d)).toEqual({ from: d.from, bin: d.bin, question: `Install Mnemo to ${d.bin} and add it to your PATH?` });
  });

  test("not for the installed copy, a package manager's, a source run, or a lone mnemo.exe", () => {
    const d = download();
    expect(offer(d, { kind: "installer" })).toBeUndefined();
    expect(offer(d, { kind: "scoop" })).toBeUndefined();
    expect(offer(d, { kind: "homebrew" })).toBeUndefined();
    expect(offer(d, { kind: "source" })).toBeUndefined();
    fs.rmSync(path.join(d.from, "memsrv.exe"));
    expect(offer(d)).toBeUndefined();
  });

  test("not off Windows, unless the terminal tests ask for it", () => {
    const d = download("linux");
    expect(offer(d, { platform: "linux" })).toBeUndefined();
    expect(offer(d, { platform: "linux", env: { MNEMO_SELF_INSTALL_TEST: "1" } })?.bin).toBe(d.bin);
  });

  test("no is remembered for that folder", () => {
    const d = download();
    expect(offer(d, { declined: d.from })).toBeUndefined();
    expect(offer(d, { declined: path.join(d.root, "elsewhere") })).toBeDefined();
  });

  test("the same version installed: no question; another version: asks to replace it", () => {
    const d = download();
    fs.mkdirSync(d.bin, { recursive: true });
    fs.writeFileSync(path.join(d.bin, "mnemo.exe"), "old");
    expect(offer(d, { installedVersion: () => "0.2.0" })).toBeUndefined();
    expect(offer(d, { installedVersion: () => "0.1.2" })?.question).toBe(`Replace the installed Mnemo (v0.1.2) in ${d.bin} with this one (v0.2.0)?`);
    expect(offer(d, { installedVersion: () => undefined })?.question).toBe(`Replace the installed Mnemo in ${d.bin} with this one (v0.2.0)?`);
  });

  test("never without a terminal, under -p, --version, --help, the subcommands, or MNEMO_NO_SELF_INSTALL", () => {
    expect(mayOffer([], true, {})).toBe(true);
    expect(mayOffer(["--cwd", "x", "--plan"], true, {})).toBe(true);
    expect(mayOffer([], false, {})).toBe(false);
    expect(mayOffer([], true, { MNEMO_NO_SELF_INSTALL: "1" })).toBe(false);
    for (const a of [["-p", "hi"], ["--print", "hi"], ["--version"], ["-v"], ["--help"], ["-h"], ["--dump"], ["doctor"], ["uninstall"], ["update"], ["memory", "status"], ["install"]])
      expect([a, mayOffer(a, true, {})]).toEqual([a, false]);
  });
});

describe("doctor", () => {
  test("says when Windows runs Mnemo from outside its folder, and when PATH finds another mnemo", () => {
    const d = download();
    const home = d.home;
    const lines = placementProblems({ execPath: d.execPath, home, platform: "win32", kind: "elsewhere", which: () => "C:\\old\\mnemo.exe" });
    expect(lines[0]).toContain(`running from ${d.from}, not ${d.bin} — mnemo install`);
    expect(lines[1]).toContain("mnemo in a new terminal is C:\\old\\mnemo.exe, not this one");
    expect(lines[1]).toContain("mnemo install");
    // Everywhere: the PATH's mnemo is another file.
    const other = path.join(d.root, "other-mnemo");
    fs.writeFileSync(other, "");
    expect(placementProblems({ execPath: d.execPath, home, platform: "linux", kind: "installer", which: () => other })).toEqual([
      `! path    mnemo in a new terminal is ${other}, not this one (${d.execPath}) — remove that one, or put ${d.from} first on your PATH`,
    ]);
    // A link to this very binary is this one.
    const link = path.join(d.root, "link");
    fs.symlinkSync(d.execPath, link);
    expect(placementProblems({ execPath: d.execPath, home, platform: "linux", kind: "installer", which: () => link })).toEqual([]);
    expect(placementProblems({ execPath: d.execPath, home, platform: "linux", kind: "elsewhere", which: () => null })).toEqual([]);
  });
});

describe("the user PATH on Windows", () => {
  test("is read and written exactly as get.ps1 does", () => {
    const ps1 = fs.readFileSync(path.join(import.meta.dir, "..", "scripts", "get.ps1"), "utf8");
    const lines = (t: string) => t.split("\n").map((l) => l.trim());
    const ours = lines(PS_USER_PATH);
    const at = lines(ps1).indexOf(ours[0]!);
    expect(lines(ps1).slice(at, at + ours.length)).toEqual(ours);
  });

  // Get-UserPath and Set-UserPath stand in for the registry with a file; what runs for real
  // is the PowerShell between them and Mnemo: the command line, the encoding, the broadcast.
  describe.if(!!pwsh)("through PowerShell", () => {
    const stubs = `function Get-UserPath { [IO.File]::ReadAllText($env:MNEMO_TEST_REG) }
function Set-UserPath($value) { [IO.File]::WriteAllText($env:MNEMO_TEST_REG, $value) }`;
    const registry = (value: string) => {
      const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-self-reg-")), "Path");
      fs.writeFileSync(f, value);
      process.env.MNEMO_TEST_REG = f;
      return f;
    };

    test("a non-ASCII folder and unexpanded %VARIABLES% come back as they are", () => {
      const value = "%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Users\\Zoë Ñúñez\\tools;D:\\日本";
      registry(value);
      expect(userPathVia(pwsh!, stubs).read()).toBe(value);
    });

    test("an empty PATH reads as empty", () => {
      registry("");
      expect(userPathVia(pwsh!, stubs).read()).toBe("");
    });

    test("the new value is written as given, never run as PowerShell", () => {
      const f = registry("");
      const value = "C:\\Users\\Zoë\\.mnemo\\bin;%SystemRoot%;$(Remove-Item x);'quoted\";x\"'";
      userPathVia(pwsh!, stubs).write(value);
      expect(fs.readFileSync(f, "utf8")).toBe(value);
    });

    test("selfInstall adds the bin folder once, through PowerShell", () => {
      const d = download();
      const f = registry("C:\\Tools");
      selfInstall({ execPath: d.execPath, home: d.home, platform: "win32", env: {}, userPath: userPathVia(pwsh!, stubs) });
      selfInstall({ execPath: d.execPath, home: d.home, platform: "win32", env: {}, userPath: userPathVia(pwsh!, stubs) });
      expect(fs.readFileSync(f, "utf8")).toBe(`C:\\Tools;${d.bin}`);
    });
  });
});
