/**
 * AREA 10.1 — minimal 5-field cron parser (stdlib only).
 *
 * The repo is zero-dep-critical for the agent's schedule piece, so this is a
 * hand-rolled parser instead of a dependency. Fields, left to right:
 *
 *   minute(0-59) hour(0-23) dom(1-31) month(1-12) dow(0-6, Sunday=0; 7 = Sunday too)
 *
 * Field syntax per element: `*` (any), `a` (single), `a-b` (range), stepped
 * forms like `* / 5` or `10-40 / 5`, and comma lists of any of those. dom+dow
 * both restricted uses the BSD OR rule (a day matches if EITHER matches);
 * when only one is restricted, both must hold.
 *
 * Deterministic: pure functions of their inputs, no Date.now() anywhere.
 */
export interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  dom: Set<number>;
  months: Set<number>;
  dow: Set<number>;
  /** dom/dow were written as something other than `*` (drives the OR rule). */
  domRestricted: boolean;
  dowRestricted: boolean;
}

/** Expand one comma-separated field element into a set of values. */
function parseField(spec: string, min: number, max: number, name: string): Set<number> {
  const out = new Set<number>();
  if (spec === "") throw new Error(`cron: empty ${name} field`);
  for (const raw of spec.split(",")) {
    if (raw === "") throw new Error(`cron: empty element in ${name} field "${spec}"`);
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(raw);
    if (!m) throw new Error(`cron: bad ${name} field element "${raw}"`);
    const step = m[4] ? Number(m[4]) : 1;
    if (!(step >= 1)) throw new Error(`cron: bad step in ${name} field "${raw}"`);
    let lo: number;
    let hi: number;
    if (m[1] === "*") {
      lo = min;
      hi = max;
    } else {
      lo = Number(m[2]);
      hi = m[3] !== undefined ? Number(m[3]) : lo;
      if (lo > hi) throw new Error(`cron: ${name} range ${lo}-${hi} is backwards`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

function checkRange(v: number, min: number, max: number, name: string): number {
  if (v < min || v > max) throw new Error(`cron: ${name} value ${v} out of range ${min}..${max}`);
  return v;
}

/** Parse a 5-field cron expression into its component sets. Throws on junk. */
export function parseCron(expr: string): CronFields {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron: expected 5 fields ("min hour dom mon dow"), got ${fields.length} in "${expr}"`);
  }
  const minutes = parseField(fields[0]!, 0, 59, "minute");
  const hours = parseField(fields[1]!, 0, 23, "hour");
  const dom = parseField(fields[2]!, 1, 31, "dom");
  const months = parseField(fields[3]!, 1, 12, "month");
  // dow: 0-7 with 7 meaning Sunday (same as 0)
  const dowSpec = parseField(fields[4]!, 0, 7, "dow");
  const dow = new Set<number>();
  for (const v of dowSpec) dow.add(v === 7 ? 0 : v);
  for (const v of minutes) checkRange(v, 0, 59, "minute");
  for (const v of hours) checkRange(v, 0, 23, "hour");
  for (const v of dom) checkRange(v, 1, 31, "dom");
  for (const v of months) checkRange(v, 1, 12, "month");
  for (const v of dow) checkRange(v, 0, 6, "dow");
  const domRestricted = fields[2] !== "*";
  const dowRestricted = fields[4] !== "*";
  // sanity: an impossible dom/month combo (e.g. Feb 30) can never fire
  if (domRestricted) {
    const doms = [...dom].sort((a, b) => a - b);
    const monthsArr = [...months].sort((a, b) => a - b);
    const longest = monthsArr.length > 0 ? monthsArr[monthsArr.length - 1]! : 12;
    const maxDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
    if (doms[doms.length - 1]! > maxDays[longest - 1]!) {
      throw new Error(`cron: dom ${doms[doms.length - 1]} can never fall in month ${longest}`);
    }
  }
  return { minutes, hours, dom, months, dow, domRestricted, dowRestricted };
}

/**
 * Next fire time (epoch ms) strictly after `from`, or null if the expression
 * can never fire again (it would, in principle, but only past the 10-year
 * horizon we search — which is "never" in any practical sense).
 *
 * Uses local time throughout, so a cron like "30 9 * * *" means 09:30 local
 * wherever the host is. Day matching uses the BSD OR rule when both dom and
 * dow are restricted, AND otherwise.
 */
export function cronNext(expr: string, from: Date | number): number | null {
  const f = parseCron(expr);
  const mins = [...f.minutes].sort((a, b) => a - b);
  const hrs = [...f.hours].sort((a, b) => a - b);
  const fromMs = typeof from === "number" ? from : from.getTime();
  // the next whole minute strictly after `from`
  let t = Math.floor(fromMs / 60_000) * 60_000 + 60_000;
  const cap = t + 10 * 366 * 24 * 60 * 60_000;
  const dayOk = (d: Date): boolean => {
    const domOk = f.dom.has(d.getDate());
    const dowOk = f.dow.has(d.getDay());
    return f.domRestricted && f.dowRestricted ? domOk || dowOk : domOk && dowOk;
  };
  while (t < cap) {
    const d = new Date(t);
    const month = d.getMonth() + 1;
    if (!f.months.has(month)) {
      // jump to the first minute of the next month
      t = new Date(d.getFullYear(), d.getMonth() + 1, 1, 0, 0, 0, 0).getTime();
      continue;
    }
    if (!dayOk(d)) {
      t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
      continue;
    }
    const hour = d.getHours();
    if (!f.hours.has(hour)) {
      const nextHr = hrs.find((h) => h > hour);
      if (nextHr === undefined) {
        t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
      } else {
        t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), nextHr, 0, 0, 0).getTime();
      }
      continue;
    }
    const minute = d.getMinutes();
    if (!f.minutes.has(minute)) {
      const nextMin = mins.find((m2) => m2 > minute);
      const nextHr = hrs.find((h) => h > hour);
      if (nextMin !== undefined) {
        t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, nextMin, 0, 0).getTime();
      } else if (nextHr !== undefined) {
        t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), nextHr, 0, 0, 0).getTime();
      } else {
        t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
      }
      continue;
    }
    return t;
  }
  return null;
}

/** Human one-liner for a cron expression, e.g. "0 9 * * 1 = 09:00 on Mon". */
export function describeCron(expr: string): string {
  const f = parseCron(expr);
  const mins = [...f.minutes].sort((a, b) => a - b);
  const hrs = [...f.hours].sort((a, b) => a - b);
  const parts: string[] = [];
  if (mins.length === 60) parts.push("every minute");
  else if (mins.length === 1 && hrs.length === 1) {
    parts.push(`${String(hrs[0]).padStart(2, "0")}:${String(mins[0]).padStart(2, "0")}`);
  } else {
    parts.push(`min ${mins.join(",")}`, `hour ${hrs.join(",")}`);
  }
  const dowNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  if (f.dowRestricted) {
    const days = [...f.dow].map((d) => dowNames[d]).join(",");
    parts.push(days);
  } else if (f.domRestricted) {
    parts.push(`day ${[...f.dom].sort((a, b) => a - b).join(",")} of month`);
  }
  if (f.months.size < 12) {
    parts.push(`month ${[...f.months].sort((a, b) => a - b).join(",")}`);
  }
  return parts.join(" · ");
}