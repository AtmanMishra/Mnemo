/**
 * AREA 10.1 — the minimal cron parser. Deterministic: pure functions, fixed
 * local-time dates built the same way the parser builds them, so the suite
 * passes in any timezone. All expected times are constructed with
 * `new Date(y, MONTH_INDEX_0, d, h, min)` — local time, exactly what
 * cronNext searches.
 */
import { test } from "node:test";
import assert from "node:assert";
import { parseCron, cronNext, describeCron } from "../src/schedule/cron.ts";

const JAN = 0, FEB = 1, MAR = 2, APR = 3, MAY = 4, JUN = 5, AUG = 7, DEC = 11;

const at = (y: number, m: number, d: number, h: number, min: number, s = 0): number =>
  new Date(y, m, d, h, min, s, 0).getTime();

test("parseCron expands every element shape", () => {
  const f = parseCron("0,15,30,45 * */2 * 0-6");
  assert.deepEqual([...f.minutes].sort((a, b) => a - b), [0, 15, 30, 45]);
  assert.equal(f.hours.size, 24);
  assert.deepEqual([...f.dom].sort((a, b) => a - b).slice(0, 3), [1, 3, 5]);
  assert.equal(f.months.size, 12);
  assert.equal(f.dow.size, 7);
});

test("parseCron rejects junk", () => {
  for (const bad of [
    "0 9 * *",               // 4 fields
    "0 9 * * * *",           // 6 fields
    "60 9 * * *",            // minute out of range
    "0 24 * * *",            // hour out of range
    "0 9 * 13 *",            // month out of range
    "0 9 0 * *",             // dom 0
    "0 9 * * 8",             // dow out of range
    "*/0 9 * * *",           // step 0
    "* 9 * * * extra",       // trailing junk
    "a 9 * * *",             // not a number
    "0 9 * * 5-2",           // backwards range
    "0 9 31 2 *",            // Feb 31 impossible
    "",                      // empty
    "   ",
  ]) {
    assert.throws(() => parseCron(bad), `expected throw for ${JSON.stringify(bad)}`);
  }
});

test("every minute fires on the next minute boundary", () => {
  const t = at(2026, JUN, 15, 9, 30, 45);
  const next = cronNext("* * * * *", t);
  assert.equal(next, at(2026, JUN, 15, 9, 31));
});

test("09:30 daily fires today only when still before 09:30", () => {
  const before = cronNext("30 9 * * *", at(2026, JUN, 15, 8, 0));
  assert.equal(before, at(2026, JUN, 15, 9, 30));
  const after = cronNext("30 9 * * *", at(2026, JUN, 15, 9, 31));
  assert.equal(after, at(2026, JUN, 16, 9, 30));
});

test("a stepped minute field honours the step", () => {
  // */15 -> 0,15,30,45; from 09:31 the next is 09:45
  assert.equal(cronNext("*/15 * * * *", at(2026, JUN, 15, 9, 31)), at(2026, JUN, 15, 9, 45));
  // 10-40/10 -> 10,20,30,40; from 09:05 -> 09:10
  assert.equal(cronNext("10-40/10 * * * *", at(2026, JUN, 15, 9, 5)), at(2026, JUN, 15, 9, 10));
});

test("an every-30-minutes schedule fires on the half hour both ways", () => {
  assert.equal(cronNext("0,30 * * * *", at(2026, JUN, 15, 9, 41)), at(2026, JUN, 15, 10, 0));
  assert.equal(cronNext("0,30 * * * *", at(2026, JUN, 15, 10, 0)), at(2026, JUN, 15, 10, 30));
});

test("weekly: only Mondays, and 7 means Sunday", () => {
  // 2026-05-11 is a Monday
  assert.equal(cronNext("0 9 * * 1", at(2026, MAY, 11, 0, 0)), at(2026, MAY, 11, 9, 0));
  // after that Monday passes, the following Monday
  assert.equal(cronNext("0 9 * * 1", at(2026, MAY, 11, 10, 0)), at(2026, MAY, 18, 9, 0));
  // 7 == Sunday, and 2026-05-17 is a Sunday
  assert.equal(cronNext("0 9 * * 7", at(2026, MAY, 15, 0, 0)), at(2026, MAY, 17, 9, 0));
});

test("monthly dom rolls over months that lack the day", () => {
  // 31st of the month, starting mid-February (2026-02-15) -> Mar 31
  assert.equal(cronNext("0 0 31 * *", at(2026, FEB, 15, 0, 0)), at(2026, MAR, 31, 0, 0));
});

test("year boundary: a January schedule rolls into January next year", () => {
  assert.equal(cronNext("0 0 1 1 *", at(2025, DEC, 15, 0, 0)), at(2026, JAN, 1, 0, 0));
});

test("dom+dow both restricted use the OR rule (BSD cron)", () => {
  // "0 9 13 * 1": dom 13 OR any Monday. From May 12 (Tue), May 13 (Wed,
  // which is the 13th) fires first — dom wins.
  assert.equal(cronNext("0 9 13 * 1", at(2026, MAY, 12, 0, 0)), at(2026, MAY, 13, 9, 0));
  // From May 20, the next Monday is May 25 — dow wins before June 1.
  assert.equal(cronNext("0 9 1 * 1", at(2026, MAY, 20, 0, 0)), at(2026, MAY, 25, 9, 0));
  // ...but when no Monday remains in May, the 1st-of-June (a Monday anyway)
  // terminates the walk on schedule.
  assert.equal(cronNext("0 9 1 * 1", at(2026, MAY, 31, 0, 0)), at(2026, JUN, 1, 9, 0));
});

test("leap-day cron finds the next leap year", () => {
  // 29 Feb exists only in leap years; from Feb 2026 it lands on Feb 29 2028
  assert.equal(cronNext("0 0 29 2 *", at(2026, FEB, 1, 0, 0)), at(2028, FEB, 29, 0, 0));
});

test("describeCron reads like a sentence", () => {
  assert.match(describeCron("30 9 * * *"), /09:30/);
  assert.match(describeCron("0 9 * * 1"), /Mon/);
});