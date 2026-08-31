/**
 * AREA 10.2 — the fire lease: agent-side double-fire prevention.
 *
 * Both the `mnemo schedule daemon` and the in-session ticker can see the same
 * job due in the same minute. Exactly one of them may spawn the child. The
 * guard is a per-job lockfile created with O_EXCL that carries the holder's
 * pid plus an expiry, so a crashed holder cannot park a job forever:
 *
 *   ~/.mnemo/schedules/.locks/<jobId>.lock   {"pid":N,"at":ms,"expiresAt":ms}
 *
 * acquireLease() wins when the file is free OR the holder is dead (pid no
 * longer alive) OR the lease has expired (covers a crashed process whose pid
 * got recycled by something else). A file the CURRENT process owns is simply
 * refreshed — a host that fired once can fire again next period, but the
 * OTHER host still sees a live lease and skips. releaseLease() only ever
 * removes our own lease, so a ticker that stops mid-run (session ends) never
 * steals the daemon's rights.
 *
 * Every lever is injectable (home, now, isAlive, pid) so the whole thing is
 * deterministic-testable with a temp HOME.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface LeaseFile {
  pid: number;
  at: number;
  expiresAt: number;
}

export interface LeaseOptions {
  home: string;
  jobId: string;
  holdMs: number;
  now?: () => number;
  /** Defaults to process.pid; injected so tests can fake ownership. */
  pid?: number;
  /** Defaults to a real process-alive probe; injected in tests. */
  isAlive?: (pid: number) => boolean;
}

/** The parts releaseLease cares about (no holdMs — it never writes). */
export interface LeaseKey {
  home: string;
  jobId: string;
  /** Defaults to process.pid; injected so tests can fake ownership. */
  pid?: number;
}

function lockDir(home: string): string {
  return path.join(home, ".mnemo", "schedules", ".locks");
}

/** jobId slugs are filename-safe by construction (newJobId), but guard anyway. */
function lockFile(home: string, jobId: string): string {
  return path.join(lockDir(home), jobId.replace(/[^A-Za-z0-9_.-]/g, "_") + ".lock");
}

function realIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // exists but not ours
  }
}

function readLease(file: string): LeaseFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<LeaseFile>;
    if (typeof parsed.pid === "number" && typeof parsed.at === "number" && typeof parsed.expiresAt === "number") {
      return parsed as LeaseFile;
    }
    return null; // junk content = stale
  } catch {
    return null;
  }
}

function writeLease(file: string, lease: LeaseFile, mode: "wx" | "w"): boolean {
  try {
    fs.writeFileSync(file, JSON.stringify(lease) + "\n", { flag: mode, mode: 0o600 });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST" && mode === "wx") return false;
    throw err;
  }
}

/** Try to take (or refresh) the lease for one job. True = we may fire. */
export function acquireLease(opts: LeaseOptions): boolean {
  const now = opts.now ?? Date.now;
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? realIsAlive;
  const file = lockFile(opts.home, opts.jobId);
  fs.mkdirSync(lockDir(opts.home), { recursive: true });
  const lease: LeaseFile = { pid, at: now(), expiresAt: now() + Math.max(1, opts.holdMs) };

  // Fast path: nobody holds it.
  if (writeLease(file, lease, "wx")) {
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
    return true;
  }

  const existing = readLease(file);
  // Unreadable/junk file → treat as stale, replace it.
  if (existing === null) {
    fs.rmSync(file, { force: true });
    return writeLease(file, lease, "wx");
  }
  // We already hold it → refresh the window and keep going.
  if (existing.pid === pid) {
    return writeLease(file, lease, "w");
  }
  // Someone else holds it. Stale = holder dead, or lease expired.
  const stale = !isAlive(existing.pid) || now() >= existing.expiresAt;
  if (!stale) return false;
  fs.rmSync(file, { force: true });
  return writeLease(file, lease, "wx");
}

/** Remove our own lease. Never touches a file another pid owns. */
export function releaseLease(opts: LeaseKey): boolean {
  const file = lockFile(opts.home, opts.jobId);
  const existing = readLease(file);
  if (existing === null) return false;
  const pid = opts.pid ?? process.pid;
  if (existing.pid !== pid) return false;
  fs.rmSync(file, { force: true });
  return true;
}

/** Purely for tests/diagnostics: what the lease file currently says. */
export function readLeaseFile(home: string, jobId: string): LeaseFile | null {
  return readLease(lockFile(home, jobId));
}

/**
 * Give back every lease this pid holds — used when a ticker/daemon stops so
 * a healthy host never parks a job another host could be running. `keep` are
 * jobIds whose child is still in flight; their leases stay (a crashed
 * ticker's own pid makes them stale-reclaimable, and leaving them is what
 * prevents a double-fire while the orphan child still runs).
 */
export function releaseOwnLeases(home: string, pid = process.pid, keep: ReadonlySet<string> = new Set()): number {
  const dir = lockDir(home);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith(".lock")) continue;
    const jobId = name.slice(0, -".lock".length);
    if (keep.has(jobId)) continue;
    const lease = readLease(path.join(dir, name));
    if (lease?.pid !== pid) continue;
    try {
      fs.rmSync(path.join(dir, name), { force: true });
      removed++;
    } catch { /* best effort */ }
  }
  return removed;
}