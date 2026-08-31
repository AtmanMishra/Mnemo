/**
 * AREA 10.2 — the fire lease (O_EXCL + pid + stale detection). Everything is
 * injected (home, now, pid, isAlive), so the whole contract is testable with
 * zero processes and a temp HOME.
 */
import { test, after } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { acquireLease, releaseLease, readLeaseFile } from "../src/schedule/lease.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sea-sched-lease-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const home = path.join(tmp, "home");
const ALIVE = () => true;
const DEAD = () => false;
let nowMs = 1_000_000;
const now = () => nowMs;

test("first acquirer wins; a live holder blocks the second host", () => {
  assert.equal(acquireLease({ home, jobId: "nightly", holdMs: 60_000, now, pid: 100, isAlive: ALIVE }), true);
  assert.equal(acquireLease({ home, jobId: "nightly", holdMs: 60_000, now, pid: 200, isAlive: ALIVE }), false,
    "a live lease held by another pid must block");
});

test("the same pid refreshes its own lease and keeps firing", () => {
  assert.equal(acquireLease({ home, jobId: "fast", holdMs: 30_000, now, pid: 100, isAlive: ALIVE }), true);
  assert.equal(acquireLease({ home, jobId: "fast", holdMs: 30_000, now, pid: 100, isAlive: ALIVE }), true,
    "owning pid re-acquires to extend the window");
  const lease = readLeaseFile(home, "fast");
  assert.equal(lease?.pid, 100);
});

test("a dead holder's lease is stolen immediately", () => {
  assert.equal(acquireLease({ home, jobId: "crashed", holdMs: 60_000, now, pid: 100, isAlive: ALIVE }), true);
  // pid 100 crashed afterwards: the acquirer's probe judges the HOLDER alive or dead
  assert.equal(
    acquireLease({ home, jobId: "crashed", holdMs: 60_000, now, pid: 200, isAlive: (p) => p !== 100 }),
    true,
    "pid 200 reclaims a lease whose holder is dead",
  );
});

test("an expired lease is stolen even when the pid looks alive (pid reuse)", () => {
  assert.equal(acquireLease({ home, jobId: "recycled", holdMs: 60_000, now, pid: 100, isAlive: ALIVE }), true);
  nowMs += 60_001; // lease window elapsed; the "live" pid is a recycled one
  assert.equal(acquireLease({ home, jobId: "recycled", holdMs: 60_000, now, pid: 300, isAlive: ALIVE }), true);
});

test("release only removes the holder's own lease", () => {
  assert.equal(acquireLease({ home, jobId: "own", holdMs: 60_000, now, pid: 100, isAlive: ALIVE }), true);
  assert.equal(releaseLease({ home, jobId: "own", pid: 999 }), false, "another pid cannot release it");
  assert.equal(readLeaseFile(home, "own")?.pid, 100);
  assert.equal(releaseLease({ home, jobId: "own", pid: 100 }), true);
  assert.equal(readLeaseFile(home, "own"), null);
  // a fresh host can now take the freed lease
  assert.equal(acquireLease({ home, jobId: "own", holdMs: 60_000, now, pid: 200, isAlive: ALIVE }), true);
});

test("a junk lockfile counts as stale and is replaced", () => {
  const dir = path.join(home, ".mnemo", "schedules", ".locks");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "junk.lock"), "not json at all");
  assert.equal(acquireLease({ home, jobId: "junk", holdMs: 60_000, now, pid: 100, isAlive: ALIVE }), true);
  assert.equal(readLeaseFile(home, "junk")?.pid, 100);
});