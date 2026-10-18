import { afterEach, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { assetFor, compareVersions, install, managedPath, parseSums, parseVersion, sha256 } from "../src/install.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-ext-"));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

describe("assetFor", () => {
  test("names the five release archives, nothing else", () => {
    expect(assetFor("linux", "x64")?.name).toBe("mnemo-linux-x64.tar.gz");
    expect(assetFor("linux", "arm64")?.name).toBe("mnemo-linux-arm64.tar.gz");
    expect(assetFor("darwin", "arm64")?.name).toBe("mnemo-darwin-arm64.tar.gz");
    expect(assetFor("darwin", "x64")?.name).toBe("mnemo-darwin-x64.tar.gz");
    expect(assetFor("win32", "x64")).toEqual({ name: "mnemo-windows-x64.zip", exe: "mnemo.exe" });
    expect(assetFor("win32", "arm64")).toBeUndefined();
    expect(assetFor("freebsd", "x64")).toBeUndefined();
  });
});

describe("versions", () => {
  test("parse and compare", () => {
    expect(parseVersion("0.1.7\n")).toBe("0.1.7");
    expect(parseVersion("mnemo 0.2.0-rc.1")).toBe("0.2.0-rc.1");
    expect(parseVersion("unknown argument --version")).toBeUndefined();
    expect(compareVersions("0.1.10", "0.1.9")).toBe(1);
    expect(compareVersions("0.1.7", "0.1.8")).toBe(-1);
    expect(compareVersions("0.2.0-rc.1", "0.2.0")).toBe(-1);
    expect(compareVersions("v0.1.8", "0.1.8")).toBe(0);
  });

  test("SHA256SUMS lines", () => {
    const h = "a".repeat(64);
    expect(parseSums(`${h}  mnemo-linux-x64.tar.gz\n${h.toUpperCase()} *b.zip\njunk\n`)).toEqual(
      new Map([
        ["mnemo-linux-x64.tar.gz", h],
        ["b.zip", h],
      ]),
    );
  });
});

/** A server that plays the release: a real tar.gz with a `mnemo` file, and its SHA256SUMS. */
async function release(o: { badSum?: boolean; omit?: boolean; redirectTo?: string } = {}) {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "stage"));
  fs.writeFileSync(path.join(dir, "stage", "mnemo"), "#!fake\n");
  fs.writeFileSync(path.join(dir, "stage", "memsrv"), "x");
  const name = "mnemo-linux-x64.tar.gz";
  execFileSync("tar", ["-czf", path.join(dir, name), "-C", path.join(dir, "stage"), "mnemo", "memsrv"]);
  const sum = o.badSum ? crypto.randomBytes(32).toString("hex") : await sha256(path.join(dir, name));
  const server = http.createServer((req, res) => {
    if (o.redirectTo && req.url!.endsWith(name)) return (res.statusCode = 302), res.setHeader("location", o.redirectTo), res.end();
    if (req.url === "/v9.9.9/SHA256SUMS") return res.end(o.omit ? "" : `${sum}  ${name}\n`);
    if (req.url === `/v9.9.9/${name}`) return res.end(fs.readFileSync(path.join(dir, name)));
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => server.close());
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe("install", () => {
  test("downloads, verifies, unpacks and returns the binary", async () => {
    const base = await release();
    const dir = tmp();
    const bin = await install({ version: "9.9.9", dir, platform: "linux", arch: "x64", base });
    expect(bin).toBe(managedPath(dir, "9.9.9", "linux"));
    expect(fs.readFileSync(bin, "utf8")).toBe("#!fake\n");
    expect(fs.existsSync(path.join(path.dirname(bin), "memsrv"))).toBe(true);
    expect(fs.statSync(bin).mode & 0o111).not.toBe(0);
    expect(fs.readdirSync(dir)).toEqual(["v9.9.9"]);
  });

  test("a checksum mismatch installs nothing and leaves no scratch behind", async () => {
    const base = await release({ badSum: true });
    const dir = tmp();
    await expect(install({ version: "9.9.9", dir, platform: "linux", arch: "x64", base })).rejects.toThrow(/checksum/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test("a release whose SHA256SUMS lacks the archive is refused", async () => {
    const base = await release({ omit: true });
    const dir = tmp();
    await expect(install({ version: "9.9.9", dir, platform: "linux", arch: "x64", base })).rejects.toThrow(/no entry/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test("a redirect to some other host is refused", async () => {
    const other = await release(); // a perfectly good archive, on another origin
    const base = await release({ redirectTo: `${other}/v9.9.9/mnemo-linux-x64.tar.gz` });
    const dir = tmp();
    await expect(install({ version: "9.9.9", dir, platform: "linux", arch: "x64", base })).rejects.toThrow(/refusing/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test("an unsupported platform says what to do", async () => {
    await expect(install({ version: "9.9.9", dir: tmp(), platform: "freebsd", arch: "x64" })).rejects.toThrow(/mnemo\.path/);
  });

  test("a missing release is an error, not a crash", async () => {
    const base = await release();
    await expect(install({ version: "1.0.0", dir: tmp(), platform: "linux", arch: "x64", base })).rejects.toThrow(/404/);
  });
});
