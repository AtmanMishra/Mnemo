/** Run the Windows removal helper itself, with real processes and literal paths. */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { windowsRemovalCommand } from "../src/runtime/uninstall.ts";
import { waitFor } from "./wait-for.ts";

// Exercise Windows PowerShell on Windows CI; pwsh also lets other hosts check the script.
const powershell = process.platform === "win32"
  ? Bun.which("powershell") ?? process.env.MNEMO_TEST_PWSH ?? Bun.which("pwsh")
  : process.env.MNEMO_TEST_PWSH ?? Bun.which("pwsh");
const children: Bun.Subprocess[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null) child.kill();
  }
  await Promise.all(children.splice(0).map((child) => child.exited));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

function installed() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-win-uninstall-"));
  roots.push(root);
  // All are valid Windows filename characters, but significant to shells or wildcards.
  const home = path.join(root, "Mnemo ' [literal] %TEMP% $cash & 雪");
  const bin = path.join(home, "bin");
  const memory = path.join(home, "memory", "journal.jsonl");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.dirname(memory));
  fs.writeFileSync(memory, "remember this");
  const files = ["mnemo.exe", "memsrv.exe", "mnemo.exe.update.old"].map((name) => path.join(bin, name));
  for (const file of files) fs.writeFileSync(file, path.basename(file));
  const external = path.join(root, "outside");
  fs.mkdirSync(external);
  const sentinel = path.join(external, "keep.txt");
  fs.writeFileSync(sentinel, "not Mnemo's data");
  return { root, home, memory, files, external, sentinel };
}

async function owner() {
  const child = Bun.spawn([process.execPath, "-e", 'process.stdout.write("ready\\n"); await Bun.stdin.text();'], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  children.push(child);
  const ready = child.stdout.getReader();
  expect(new TextDecoder().decode((await ready.read()).value)).toBe("ready\n");
  ready.releaseLock();
  return child;
}

function remove(command: string[], cwd: string) {
  expect(command[0]).toBe("powershell");
  const child = Bun.spawn([powershell ?? "powershell", ...command.slice(1)], {
    cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  children.push(child);
  return child;
}

async function succeeded(child: ReturnType<typeof remove>) {
  await waitFor(() => expect(child.exitCode).not.toBeNull(), 15_000);
  const stderr = await new Response(child.stderr).text();
  expect({ code: await child.exited, error: child.exitCode === 0 ? "" : stderr }).toEqual({ code: 0, error: "" });
}

describe.skipIf(process.platform !== "win32" && !powershell)("Windows removal helper", () => {
  test("waits for its owner beyond two seconds, then removes literal file paths and keeps memory", async () => {
    const w = installed();
    fs.chmodSync(w.files[0]!, 0o444); // Windows read-only files still have to uninstall (formerly del /f).
    const held = await owner();
    const helper = remove(windowsRemovalCommand(w.files, undefined, held.pid), w.root);
    // A fixed delay is wrong here: shutdown can outlast the old two-second timer.
    await Bun.sleep(2500);
    expect(held.exitCode).toBeNull();
    expect(helper.exitCode).toBeNull();
    for (const file of w.files) expect(fs.readFileSync(file, "utf8")).toBe(path.basename(file));
    held.stdin.end();
    expect(await held.exited).toBe(0);
    await succeeded(helper);
    for (const file of w.files) expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(w.memory, "utf8")).toBe("remember this");
    expect(fs.readFileSync(w.sentinel, "utf8")).toBe("not Mnemo's data");
  }, 30_000);

  test("deep removes the home after owner exit without following a directory junction or symlink", async () => {
    const w = installed();
    fs.chmodSync(w.memory, 0o444);
    fs.chmodSync(w.sentinel, 0o444);
    const sentinelMode = fs.statSync(w.sentinel).mode;
    fs.symlinkSync(w.external, path.join(w.home, "memory", "external"), process.platform === "win32" ? "junction" : "dir");
    const held = await owner();
    const helper = remove(windowsRemovalCommand(w.files, w.home, held.pid), w.external);
    expect(fs.existsSync(w.home)).toBe(true);
    held.stdin.end();
    expect(await held.exited).toBe(0);
    await succeeded(helper);
    expect(fs.existsSync(w.home)).toBe(false);
    expect(fs.readFileSync(w.sentinel, "utf8")).toBe("not Mnemo's data");
    expect(fs.statSync(w.sentinel).mode).toBe(sentinelMode);
  }, 30_000);

  test("an already-exited owner and relative paths work from a helper outside the home", async () => {
    const w = installed();
    const exited = await owner();
    exited.stdin.end();
    expect(await exited.exited).toBe(0);
    const moduleUrl = new URL("../src/runtime/uninstall.ts", import.meta.url).href;
    // Generate from the caller's cwd without changing the test process's global cwd.
    const generated = Bun.spawnSync([process.execPath, "-e", `
      import { windowsRemovalCommand } from ${JSON.stringify(moduleUrl)};
      process.stdout.write(JSON.stringify(windowsRemovalCommand(
        ${JSON.stringify(w.files.map((file) => path.relative(w.root, file)))},
        ${JSON.stringify(path.relative(w.root, w.home))}, ${exited.pid}
      )));
    `], { cwd: w.root, stdout: "pipe", stderr: "pipe" });
    expect({ code: generated.exitCode, error: generated.stderr.toString() }).toEqual({ code: 0, error: "" });
    const helper = remove(JSON.parse(generated.stdout.toString()), w.external);
    await succeeded(helper);
    expect(fs.existsSync(w.home)).toBe(false);
    expect(fs.readFileSync(w.sentinel, "utf8")).toBe("not Mnemo's data");
  }, 30_000);

  test.skipIf(process.platform !== "win32")("retries a file still locked by another process after the owner exits", async () => {
    const w = installed();
    const exited = await owner();
    exited.stdin.end();
    expect(await exited.exited).toBe(0);
    const script = `
      $ErrorActionPreference = 'Stop'
      $held = [IO.File]::Open('${w.files[0]!.replace(/'/g, "''")}', [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
      try { [Console]::WriteLine('locked'); [Console]::In.ReadLine() | Out-Null } finally { $held.Dispose() }
    `;
    const lock = Bun.spawn([powershell!, "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    children.push(lock);
    const ready = lock.stdout.getReader();
    expect(new TextDecoder().decode((await ready.read()).value).trim()).toBe("locked");
    ready.releaseLock();
    const helper = remove(windowsRemovalCommand(w.files, undefined, exited.pid), w.root);
    // An unlocked file disappearing proves the helper has tried this batch.
    await waitFor(() => expect(fs.existsSync(w.files[1]!)).toBe(false));
    expect(helper.exitCode).toBeNull();
    expect(fs.existsSync(w.files[0]!)).toBe(true);
    lock.stdin.end();
    expect(await lock.exited).toBe(0);
    await succeeded(helper);
    for (const file of w.files) expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(w.memory, "utf8")).toBe("remember this");
  }, 30_000);
});
