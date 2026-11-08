// 30-day dogfood visibility (#10, 2026-11-08 backlog).
//
// A "keeps running for 30 days" claim can only be trusted if a missed day
// surfaces on the day it happens. Until now no code path recorded whether a
// batch invocation ran at all: a silent gap stayed invisible until someone
// read the weekly report or remembered the cron. This module gives the loop
// a local run ledger and a coverage check:
//
//   - every `batch <command>` invocation appends one JSON line;
//   - `batch health --days 30` reads the ledger and exits 1 when any
//     *complete* day in the window has no successful record, so a missed
//     day surfaces the next morning, not thirty days later;
//   - `batch history --days N` replays the recorded rounds (pass `--day` to
//     any batch command to re-run one of them).
//
// The ledger is local by design: no external dependency, no schema, no
// business-default change. Format: one JSON object per line, one per run.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type RunStatus = 'ok' | 'skipped' | 'failed';

export interface RunRecord {
  /** ISO timestamp when the command started (UTC). */
  ts: string;
  /** UTC run date the command acted on (`--day`), YYYY-MM-DD. Older lines
   *  without it fall back to the ts day. */
  day?: string;
  command: string;
  site?: string;
  status: RunStatus;
  durationMs: number;
  /** Why the run failed or skipped; absent for ok runs. */
  reason?: string;
  /** Human-readable result summary (counts, file names); absent when empty. */
  summary?: string;
}

export interface CoverageOptions {
  /** Length of the requested window in complete days (default 30). */
  days: number;
  /** Reference "now"; defaults to the real clock. */
  now?: Date;
  /** When set, only records for this site count toward coverage. */
  site?: string;
  /** When set, only this command counts toward coverage (e.g. `daily`). */
  command?: string;
}

export interface CoverageReport {
  /** Complete days actually checked: the requested window, clipped to the
   *  day of the ledger's first record so a fresh deployment does not report
   *  every pre-install day as a gap. */
  windowDays: number;
  /** First complete day in the checked window (YYYY-MM-DD, UTC). */
  checkedFrom: string;
  /** Last complete day in the window (YYYY-MM-DD, UTC). */
  checkedTo: string;
  /** Records in scope (after the optional site filter). */
  totalRecords: number;
  okRecords: number;
  failedRecords: number;
  /** Complete days in the window that have no successful run. */
  missingDays: string[];
  /** Most recent successful run timestamp, anywhere in the ledger. */
  lastOkAt: string | null;
  /** Most recent failed run, anywhere in the ledger. */
  lastFailure: RunRecord | null;
  /** Consecutive ok days counting back from the last complete day. */
  consecutiveOkDays: number;
  /** False when any complete day in the window is missing, or no run exists. */
  healthy: boolean;
}

/** UTC calendar day key, matching the batch --day convention. */
export function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utcDayStart(dayKey: string): Date {
  return new Date(`${dayKey}T00:00:00.000Z`);
}

function addUtcDays(date: Date, delta: number): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + delta),
  );
}

/** Resolve the ledger path inside the existing report volume. */
export function runLedgerPath(reportDir: string): string {
  return `${reportDir.replace(/\/+$/, '')}/run-ledger.jsonl`;
}

/**
 * Append one run record. Creates the parent directory when missing.
 * Throws only on real I/O failure; callers must treat a ledger write failure
 * as a warning, never as a business failure.
 */
export function appendRunRecord(ledgerPath: string, record: RunRecord): void {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`, 'utf8');
}

/**
 * Read the ledger. A missing file is an empty ledger; malformed lines are
 * skipped so one hand-edited or truncated line cannot break the health check.
 */
export function readRunLedger(ledgerPath: string): RunRecord[] {
  if (!existsSync(ledgerPath)) return [];
  const raw = readFileSync(ledgerPath, 'utf8');
  const records: RunRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<RunRecord>;
      if (
        typeof parsed.ts === 'string' &&
        typeof parsed.command === 'string' &&
        (parsed.status === 'ok' || parsed.status === 'skipped' || parsed.status === 'failed')
      ) {
        records.push({
          ts: parsed.ts,
          command: parsed.command,
          status: parsed.status,
          durationMs: typeof parsed.durationMs === 'number' ? parsed.durationMs : 0,
          ...(typeof parsed.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.day)
            ? { day: parsed.day }
            : {}),
          ...(typeof parsed.site === 'string' ? { site: parsed.site } : {}),
          ...(typeof parsed.reason === 'string' ? { reason: parsed.reason } : {}),
          ...(typeof parsed.summary === 'string' ? { summary: parsed.summary } : {}),
        });
      }
    } catch {
      // Corrupt line: skip, keep the rest of the ledger readable.
    }
  }
  return records;
}

/**
 * Coverage over the last `days` *complete* UTC days (today excluded, so a
 * run that is still expected today never reads as a gap by itself).
 *
 * Days before the ledger's first record are not required: a deployment that
 * started three days ago has three days of history, not thirty days of gaps.
 */
export function assessCoverage(
  records: readonly RunRecord[],
  options: CoverageOptions,
): CoverageReport {
  const now = options.now ?? new Date();
  const requestedDays = Math.max(1, Math.trunc(options.days));
  const inScope = records.filter(
    record =>
      (options.site === undefined || record.site === options.site) &&
      (options.command === undefined || record.command === options.command),
  );

  const okDays = new Set<string>();
  let firstDay: string | null = null;
  let lastOkAt: string | null = null;
  let lastFailure: RunRecord | null = null;
  let okRecords = 0;
  let failedRecords = 0;

  for (const record of inScope) {
    const parsed = new Date(record.ts);
    if (Number.isNaN(parsed.getTime())) continue;
    // Key by the day the run acted on (`--day`), not by wall clock: a
    // backfilled `daily --day 2026-11-05` covers that day.
    const key = record.day ?? utcDayKey(parsed);
    if (firstDay === null || key < firstDay) firstDay = key;
    if (record.status === 'ok') {
      okRecords += 1;
      okDays.add(key);
      if (lastOkAt === null || record.ts > lastOkAt) lastOkAt = record.ts;
    } else if (record.status === 'failed') {
      failedRecords += 1;
      if (lastFailure === null || record.ts > lastFailure.ts) lastFailure = record;
    }
  }

  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const windowEnd = addUtcDays(today, -1);
  const configuredStart = addUtcDays(windowEnd, -(requestedDays - 1));
  const start = firstDay === null ? configuredStart : maxDate(configuredStart, utcDayStart(firstDay));

  const checkedTo = utcDayKey(windowEnd);
  const checkedFrom = utcDayKey(start);

  // Only today has a record so far: no complete day is expected yet.
  if (start.getTime() > windowEnd.getTime()) {
    return {
      windowDays: 0,
      checkedFrom,
      checkedTo,
      totalRecords: inScope.length,
      okRecords,
      failedRecords,
      missingDays: [],
      lastOkAt,
      lastFailure,
      consecutiveOkDays: 0,
      healthy: inScope.length > 0,
    };
  }

  const missingDays: string[] = [];
  let windowDays = 0;
  for (
    let cursor = start;
    cursor.getTime() <= windowEnd.getTime();
    cursor = addUtcDays(cursor, 1)
  ) {
    windowDays += 1;
    const key = utcDayKey(cursor);
    if (!okDays.has(key)) missingDays.push(key);
  }

  // Consecutive ok days counting back from the last complete day.
  let consecutiveOkDays = 0;
  for (
    let cursor = windowEnd;
    cursor.getTime() >= start.getTime();
    cursor = addUtcDays(cursor, -1)
  ) {
    if (!okDays.has(utcDayKey(cursor))) break;
    consecutiveOkDays += 1;
  }

  return {
    windowDays,
    checkedFrom,
    checkedTo,
    totalRecords: inScope.length,
    okRecords,
    failedRecords,
    missingDays,
    lastOkAt,
    lastFailure,
    consecutiveOkDays,
    // Any gap is an alarm. A failed round that was retried successfully leaves
    // no gap, but is still reported below so it does not stay invisible.
    healthy: missingDays.length === 0 && inScope.length > 0,
  };
}

function maxDate(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

/** One-line report for cron logs; the exit code carries the alarm. */
export function formatCoverage(report: CoverageReport): string {
  const span = `${report.checkedFrom}..${report.checkedTo}`;
  if (report.totalRecords === 0) {
    return `health: EMPTY ledger — no run recorded ever (window ${span}). Wire the batch scheduler.`;
  }
  if (report.windowDays === 0) {
    return `health: OK (warming up) — no complete day in the ledger yet (window ends ${report.checkedTo}), ${report.totalRecords} run(s) recorded today.`;
  }
  const covered = report.windowDays - report.missingDays.length;
  const failures =
    report.failedRecords === 0
      ? ''
      : `; ${report.failedRecords} failed run(s), latest ${report.lastFailure?.ts} ${report.lastFailure?.command}${
          report.lastFailure?.reason === undefined ? '' : ` (${report.lastFailure.reason})`
        }`;
  if (report.healthy) {
    return `health: OK — ${covered}/${report.windowDays} complete days covered (${span}), ${report.okRecords} ok run(s), ${report.consecutiveOkDays} consecutive day(s), last ok ${report.lastOkAt}${failures}.`;
  }
  const firstMissing = report.missingDays.slice(0, 5).join(', ');
  const more = report.missingDays.length > 5 ? `, +${report.missingDays.length - 5} more` : '';
  return `health: GAP — ${report.missingDays.length}/${report.windowDays} complete days missing (${firstMissing}${more}) in ${span}; last ok ${report.lastOkAt ?? 'never'}${failures}.`;
}

/** One-line history entry; `ts` sorts lexicographically because it is UTC ISO. */
export function formatRunRecord(record: RunRecord): string {
  const site = record.site === undefined ? '' : ` ${record.site}`;
  const day = record.day === undefined ? '' : ` day=${record.day}`;
  const detail = record.summary ?? record.reason;
  return `${record.ts} ${record.command} ${record.status}${site}${day} ${record.durationMs}ms${
    detail === undefined ? '' : ` ${detail}`
  }`;
}

/**
 * Replay the recorded rounds of the last `days` calendar days (today included,
 * unlike health: history is an inspection view, not a coverage check). Use
 * `batch <command> --day YYYY-MM-DD` to actually re-run one of these days.
 */
export function formatHistory(
  records: readonly RunRecord[],
  options: { days: number; now?: Date },
): string {
  const now = options.now ?? new Date();
  const days = Math.max(1, Math.trunc(options.days));
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = addUtcDays(today, -(days - 1));
  const startKey = utcDayKey(start);
  const endKey = utcDayKey(today);
  const selected = records.filter(record => {
    const parsed = new Date(record.ts);
    if (Number.isNaN(parsed.getTime())) return false;
    const key = record.day ?? utcDayKey(parsed);
    return key >= startKey && key <= endKey;
  });
  const header = `history: ${utcDayKey(start)}..${utcDayKey(today)} — ${selected.length} run(s)`;
  if (selected.length === 0) return `${header}: none recorded.`;
  return [header, ...selected.map(formatRunRecord)].join('\n');
}
