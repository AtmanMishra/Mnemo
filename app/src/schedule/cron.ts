/** Five-field cron (minute hour day-of-month month day-of-week), in local time. */

const RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];

export interface Cron {
  sets: Set<number>[];
  /** Day-of-month and day-of-week both restricted: either one matches, as in Vixie cron. */
  either: boolean;
}

function field(text: string, [lo, hi]: [number, number], dow: boolean): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const [range, stepText, extra] = part.split("/");
    if (extra !== undefined) throw new Error(`bad field "${text}"`);
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${text}"`);
    let a = lo;
    let b = hi;
    if (range !== "*") {
      const [x, y, more] = range.split("-");
      if (more !== undefined || !/^\d+$/.test(x) || (y !== undefined && !/^\d+$/.test(y))) throw new Error(`bad field "${text}"`);
      a = Number(x);
      b = y === undefined ? (stepText === undefined ? a : hi) : Number(y);
    }
    if (dow && b === 7) b = 6, a === 7 && (a = 0);
    if (a < lo || b > hi || a > b) throw new Error(`"${text}" is outside ${lo}-${hi}`);
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`a schedule has five fields (minute hour day month weekday), got ${parts.length}`);
  const sets = parts.map((p, i) => field(p, RANGES[i], i === 4));
  return { sets, either: parts[2] !== "*" && parts[4] !== "*" };
}

function dayMatches(c: Cron, d: Date): boolean {
  const dom = c.sets[2].has(d.getDate());
  const dow = c.sets[4].has(d.getDay());
  return c.either ? dom || dow : dom && dow;
}

/** The first matching minute strictly after `after`; undefined if none within five years (e.g. 31 February). */
export function cronNext(c: Cron, after: Date): Date | undefined {
  const d = new Date(after.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = after.getTime() + 5 * 366 * 24 * 3600 * 1000;
  while (d.getTime() <= limit) {
    if (!c.sets[3].has(d.getMonth() + 1)) d.setMonth(d.getMonth() + 1, 1), d.setHours(0, 0, 0, 0);
    else if (!dayMatches(c, d)) d.setDate(d.getDate() + 1), d.setHours(0, 0, 0, 0);
    else if (!c.sets[1].has(d.getHours())) d.setHours(d.getHours() + 1, 0, 0, 0);
    else if (!c.sets[0].has(d.getMinutes())) d.setMinutes(d.getMinutes() + 1);
    else return d;
  }
  return undefined;
}
