import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const REPO = "AtmanMishra/Mnemo";
/** The first Mnemo release with `--rpc` (protocol 1). The extension downloads exactly this version. */
export const REQUIRED_VERSION = "0.1.8";
export const RELEASE_BASE = `https://github.com/${REPO}/releases/download`;

/** The release archive for a platform, as the release workflow names them (docs/RELEASING.md). */
export function assetFor(platform: string, arch: string): { name: string; exe: string } | undefined {
  const cpu = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : undefined;
  if (!cpu) return undefined;
  if (platform === "linux") return { name: `mnemo-linux-${cpu}.tar.gz`, exe: "mnemo" };
  if (platform === "darwin") return { name: `mnemo-darwin-${cpu}.tar.gz`, exe: "mnemo" };
  if (platform === "win32" && cpu === "x64") return { name: "mnemo-windows-x64.zip", exe: "mnemo.exe" };
  return undefined;
}

/** `0.1.7` out of `mnemo --version`'s output. */
export function parseVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/.exec(output)?.[1];
}

/** -1, 0 or 1; `0.1.10` is newer than `0.1.9`, a pre-release is older than its release. */
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

/** `SHA256SUMS`: file name → lowercase hex. */
export function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (m) out.set(m[2]!, m[1]!.toLowerCase());
  }
  return out;
}

export async function sha256(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
}

/** The version a `mnemo` at `command` reports, or undefined when it does not run. */
export function probe(command: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, ["--version"], { timeout: 10_000, windowsHide: true }, (error, stdout) => resolve(error ? undefined : parseVersion(stdout)));
  });
}

/** Where the managed copy of `version` lives under `dir`. */
export const managedPath = (dir: string, version: string, platform: string): string => path.join(dir, `v${version}`, platform === "win32" ? "mnemo.exe" : "mnemo");

/** The sources a download may come from: GitHub, or `base`'s own origin (tests serve a fixture). */
function trusted(url: string, base: string): boolean {
  const u = new URL(url);
  if (u.origin === new URL(base).origin) return true;
  return u.protocol === "https:" && (u.hostname === "github.com" || u.hostname.endsWith(".githubusercontent.com"));
}

export interface InstallOptions {
  version: string;
  /** The folder managed copies live in (the extension's global storage). */
  dir: string;
  platform: string;
  arch: string;
  base?: string;
  fetchImpl?: typeof fetch;
  /** Unpack `archive` into `into`. The default is the system `tar`, which reads .zip on Windows too. */
  extract?: (archive: string, into: string) => Promise<void>;
  onProgress?: (message: string) => void;
}

const untar = (archive: string, into: string): Promise<void> =>
  new Promise((resolve, reject) => execFile("tar", ["-xf", archive, "-C", into], { timeout: 120_000, windowsHide: true }, (e) => (e ? reject(new Error(`could not unpack the download: ${e.message}`)) : resolve())));

/**
 * Download Mnemo `version` into `dir`, check the archive's SHA-256 against the release's
 * SHA256SUMS, unpack it and return the path to `mnemo`. The copy appears under its final
 * name only once whole, so a failed or cut-off download leaves nothing half-installed.
 * (The checksum catches damage, not a compromised release: see docs/RELEASING.md.)
 */
export async function install(o: InstallOptions): Promise<string> {
  const asset = assetFor(o.platform, o.arch);
  if (!asset) throw new Error(`There is no Mnemo release for ${o.platform}-${o.arch}. Install Mnemo yourself and set mnemo.path.`);
  const base = o.base ?? RELEASE_BASE;
  const get = o.fetchImpl ?? fetch;
  const url = (name: string) => `${base}/v${o.version}/${name}`;
  const final = path.join(o.dir, `v${o.version}`);
  fs.mkdirSync(o.dir, { recursive: true });
  const work = fs.mkdtempSync(path.join(o.dir, ".download-"));
  try {
    const fetchOk = async (name: string) => {
      const res = await get(url(name), { signal: AbortSignal.timeout(120_000) });
      if (!res.ok || !res.body) throw new Error(`${url(name)} answered ${res.status}`);
      if (!trusted(res.url || url(name), base)) throw new Error(`refusing a download that was redirected to ${new URL(res.url).origin}`);
      return res;
    };
    o.onProgress?.("Checking the release…");
    const sums = parseSums(await (await fetchOk("SHA256SUMS")).text());
    const want = sums.get(asset.name);
    if (!want) throw new Error(`SHA256SUMS has no entry for ${asset.name}`);
    o.onProgress?.(`Downloading ${asset.name}…`);
    const archive = path.join(work, asset.name);
    const res = await fetchOk(asset.name);
    await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(archive));
    if ((await sha256(archive)) !== want) throw new Error(`${asset.name} does not match its checksum; nothing was installed`);
    o.onProgress?.("Unpacking…");
    const out = path.join(work, "out");
    fs.mkdirSync(out);
    await (o.extract ?? untar)(archive, out);
    const exe = path.join(out, asset.exe);
    if (!fs.existsSync(exe)) throw new Error(`${asset.name} has no ${asset.exe}`);
    if (!fs.realpathSync(exe).startsWith(fs.realpathSync(out))) throw new Error("the archive points outside itself");
    if (o.platform !== "win32") fs.chmodSync(exe, 0o755);
    fs.rmSync(final, { recursive: true, force: true });
    fs.renameSync(out, final);
    return path.join(final, asset.exe);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
