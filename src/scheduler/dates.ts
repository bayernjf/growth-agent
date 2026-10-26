// UTC date helpers shared by the daily runner and weekly report. GSC/SERP
// windows are date-based; the site timezone lands with site config in W9,
// until then windows are computed in UTC.

/** YYYY-MM-DD in UTC. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** YYYYMMDD compact form for deterministic task ids. */
export function compactDate(date: Date): string {
  return isoDate(date).replace(/-/g, '');
}

export function addDays(date: Date, days: number): Date {
  const out = new Date(date.getTime());
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

/**
 * Inclusive trailing window. For the 06:00 batch (§5.A.1):
 *   recent = trailingInclusive(day, 28, 1)  -> day-28 .. day-1
 *   prior  = trailingInclusive(day, 28, 29) -> day-56 .. day-29
 */
export function trailingInclusive(
  day: Date,
  length: number,
  endOffsetDays: number,
): { start: string; end: string } {
  const end = addDays(day, -endOffsetDays);
  const start = addDays(end, -(length - 1));
  return { start: isoDate(start), end: isoDate(end) };
}

/** Inclusive [start, nextDay) upper bound for SQL timestamp comparisons. */
export function exclusiveUpperBound(inclusiveDate: string): string {
  return isoDate(addDays(new Date(`${inclusiveDate}T00:00:00.000Z`), 1));
}
