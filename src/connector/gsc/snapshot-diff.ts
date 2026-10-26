// Pure ranking-movement math over gsc_daily_snapshot rows (design §4.1:
// "排名变化 = 今日 position − 昨日 position"). Position 1 is the best
// rank, so a NEGATIVE positionDelta means the page moved UP in rankings.
//
// No I/O, no clock, no storage: trivial to unit-test and reuse in the
// weekly report (weekly delta arrives in W7; this wave ships the daily diff
// plus basic aggregates).

import type { GscSnapshotRow } from './snapshot-repository.js';

export type MovementDirection = 'improved' | 'declined' | 'unchanged' | 'no_data';

export interface PositionDelta {
  dimensionKey: string;
  todayPosition: number;
  yesterdayPosition: number | null;
  /** today.position - yesterday.position; null when there is no yesterday row. */
  positionDelta: number | null;
  direction: MovementDirection;
  clicksDelta: number | null;
  impressionsDelta: number | null;
}

export function diffRow(
  today: GscSnapshotRow,
  yesterday: GscSnapshotRow | undefined,
): PositionDelta {
  if (yesterday === undefined) {
    return {
      dimensionKey: today.dimensionKey,
      todayPosition: today.position,
      yesterdayPosition: null,
      positionDelta: null,
      direction: 'no_data',
      clicksDelta: null,
      impressionsDelta: null,
    };
  }
  const positionDelta = round2(today.position - yesterday.position);
  const clicksDelta = today.clicks - yesterday.clicks;
  const impressionsDelta = today.impressions - yesterday.impressions;
  const direction: MovementDirection =
    positionDelta < -0.05
      ? 'improved'
      : positionDelta > 0.05
        ? 'declined'
        : 'unchanged';
  return {
    dimensionKey: today.dimensionKey,
    todayPosition: today.position,
    yesterdayPosition: yesterday.position,
    positionDelta,
    direction,
    clicksDelta,
    impressionsDelta,
  };
}

/** Pair each today row with its same-dimension yesterday row and diff. */
export function diffDay(
  todayRows: GscSnapshotRow[],
  yesterdayRows: GscSnapshotRow[],
): PositionDelta[] {
  const byKey = new Map<string, GscSnapshotRow>();
  for (const row of yesterdayRows) byKey.set(row.dimensionKey, row);
  return todayRows.map(today => diffRow(today, byKey.get(today.dimensionKey)));
}

/** Basic aggregate over a set of rows (daily totals, mean position). */
export interface SnapshotAggregate {
  clicks: number;
  impressions: number;
  averagePosition: number;
  rowCount: number;
}

export function aggregate(rows: GscSnapshotRow[]): SnapshotAggregate {
  if (rows.length === 0) {
    return { clicks: 0, impressions: 0, averagePosition: 0, rowCount: 0 };
  }
  const clicks = rows.reduce((sum, r) => sum + r.clicks, 0);
  const impressions = rows.reduce((sum, r) => sum + r.impressions, 0);
  const averagePosition = round2(rows.reduce((sum, r) => sum + r.position, 0) / rows.length);
  return { clicks, impressions, averagePosition, rowCount: rows.length };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
