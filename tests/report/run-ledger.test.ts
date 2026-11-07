// 30-day continuity (#10): the run ledger must make a missed day or a failed
// round visible the day it happens. These tests pin the arithmetic that the
// `health` exit code depends on.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assessCoverage,
  appendRunRecord,
  formatCoverage,
  formatHistory,
  formatRunRecord,
  readRunLedger,
  runLedgerPath,
  utcDayKey,
  type RunRecord,
} from '../../src/report/run-ledger.js';

function record(
  ts: string,
  status: RunRecord['status'] = 'ok',
  extra: Partial<RunRecord> = {},
): RunRecord {
  return { ts, command: 'daily', site: 'bayjf.com', status, durationMs: 120, ...extra };
}

const NOW = new Date('2026-11-08T12:00:00.000Z');

describe('run ledger file', () => {
  let work: string;

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), 'growth-agent-ledger-'));
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it('resolves inside the report volume', () => {
    expect(runLedgerPath('/data/reports')).toBe('/data/reports/run-ledger.jsonl');
    expect(runLedgerPath('/data/reports/')).toBe('/data/reports/run-ledger.jsonl');
  });

  it('appends one JSON line per run and reads it back', async () => {
    const path = runLedgerPath(join(work, 'nested', 'reports'));
    appendRunRecord(path, record('2026-11-03T06:00:00.000Z', 'ok', { summary: 'submitted=1' }));
    appendRunRecord(path, record('2026-11-04T06:00:00.000Z', 'failed', { reason: 'boom' }));

    const raw = await readFile(path, 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(2);

    const records = readRunLedger(path);
    expect(records).toHaveLength(2);
    expect(records[0]?.summary).toBe('submitted=1');
    expect(records[1]?.status).toBe('failed');
    expect(records[1]?.reason).toBe('boom');
  });

  it('skips corrupt lines and treats a missing file as empty', async () => {
    const path = join(work, 'run-ledger.jsonl');
    expect(readRunLedger(path)).toEqual([]);

    await writeFile(
      path,
      `${JSON.stringify(record('2026-11-03T06:00:00.000Z'))}\nnot json\n{"ts":42}\n`,
      'utf8',
    );
    expect(readRunLedger(path)).toHaveLength(1);
  });

  it('uses UTC day keys', () => {
    expect(utcDayKey(new Date('2026-11-08T23:59:59.000Z'))).toBe('2026-11-08');
    expect(utcDayKey(new Date('2026-11-09T00:00:00.000Z'))).toBe('2026-11-09');
  });
});

describe('coverage assessment', () => {
  it('flags a complete day with no successful run', () => {
    const report = assessCoverage(
      [
        record('2026-11-03T06:00:00.000Z'),
        record('2026-11-04T06:00:00.000Z'),
        record('2026-11-06T06:00:00.000Z'),
      ],
      { days: 30, now: NOW },
    );

    expect(report.checkedFrom).toBe('2026-11-03');
    expect(report.checkedTo).toBe('2026-11-07');
    expect(report.missingDays).toEqual(['2026-11-05', '2026-11-07']);
    expect(report.healthy).toBe(false);
    expect(formatCoverage(report)).toContain('health: GAP');
    expect(formatCoverage(report)).toContain('2026-11-05');
  });

  it('does not count a failed round as a covered day, and reports it', () => {
    const report = assessCoverage(
      [
        record('2026-11-03T06:00:00.000Z'),
        record('2026-11-04T06:00:00.000Z', 'failed', { reason: 'postgres driver requires pg' }),
      ],
      { days: 30, now: NOW },
    );

    expect(report.failedRecords).toBe(1);
    expect(report.missingDays).toContain('2026-11-04');
    expect(report.lastFailure?.reason).toBe('postgres driver requires pg');
    const line = formatCoverage(report);
    expect(line).toContain('health: GAP');
    expect(line).toContain('failed run(s), latest 2026-11-04T06:00:00.000Z daily');
  });

  it('stays healthy when a failed round is retried later the same day', () => {
    const report = assessCoverage(
      [
        record('2026-11-06T06:00:00.000Z', 'failed', { reason: 'transient' }),
        record('2026-11-06T07:00:00.000Z'),
        record('2026-11-07T06:00:00.000Z'),
      ],
      { days: 2, now: NOW },
    );

    expect(report.missingDays).toEqual([]);
    expect(report.healthy).toBe(true);
    expect(report.consecutiveOkDays).toBe(2);
    expect(formatCoverage(report)).toContain('1 failed run(s)');
  });

  it('excludes today so a run still expected today is not a gap', () => {
    const report = assessCoverage(
      [
        record('2026-11-06T06:00:00.000Z'),
        record('2026-11-07T06:00:00.000Z'),
        record('2026-11-08T00:10:00.000Z'),
      ],
      { days: 30, now: NOW },
    );

    expect(report.checkedTo).toBe('2026-11-07');
    expect(report.missingDays).toEqual([]);
    expect(report.healthy).toBe(true);
  });

  it('does not require days before the first ledger record', () => {
    const report = assessCoverage(
      [
        record('2026-11-05T06:00:00.000Z'),
        record('2026-11-06T06:00:00.000Z'),
        record('2026-11-07T06:00:00.000Z'),
      ],
      { days: 30, now: NOW },
    );

    expect(report.checkedFrom).toBe('2026-11-05');
    expect(report.windowDays).toBe(3);
    expect(report.missingDays).toEqual([]);
    expect(report.healthy).toBe(true);
  });

  it('reports warming up when only today has a record', () => {
    const report = assessCoverage([record('2026-11-08T00:10:00.000Z')], { days: 30, now: NOW });

    expect(report.windowDays).toBe(0);
    expect(report.missingDays).toEqual([]);
    expect(report.healthy).toBe(true);
    expect(formatCoverage(report)).toContain('warming up');
  });

  it('treats an empty ledger as unhealthy', () => {
    const report = assessCoverage([], { days: 30, now: NOW });

    expect(report.totalRecords).toBe(0);
    expect(report.healthy).toBe(false);
    expect(formatCoverage(report)).toContain('EMPTY ledger');
  });

  it('keys coverage by the run day, so a backfilled --day covers that day', () => {
    const report = assessCoverage(
      [
        record('2026-11-08T00:10:00.000Z', 'ok', { day: '2026-11-05' }),
        record('2026-11-08T00:11:00.000Z', 'ok', { day: '2026-11-06' }),
        record('2026-11-08T00:12:00.000Z', 'ok', { day: '2026-11-07' }),
      ],
      { days: 30, now: NOW },
    );

    expect(report.checkedFrom).toBe('2026-11-05');
    expect(report.windowDays).toBe(3);
    expect(report.missingDays).toEqual([]);
    expect(report.healthy).toBe(true);
  });

  it('can require daily as the heartbeat so other commands cannot mask a gap', () => {
    const records = [
      record('2026-11-06T06:00:00.000Z', 'ok', { command: 'daily' }),
      record('2026-11-07T06:00:00.000Z', 'ok', { command: 'production' }),
    ];

    expect(assessCoverage(records, { days: 2, now: NOW }).healthy).toBe(true);

    const dailyOnly = assessCoverage(records, { days: 2, now: NOW, command: 'daily' });
    expect(dailyOnly.missingDays).toEqual(['2026-11-07']);
    expect(dailyOnly.healthy).toBe(false);
  });

  it('filters by site when asked', () => {
    const records = [
      record('2026-11-06T06:00:00.000Z', 'ok', { site: 'site-a' }),
      record('2026-11-07T06:00:00.000Z', 'ok', { site: 'site-a' }),
      record('2026-11-05T06:00:00.000Z', 'ok', { site: 'site-b' }),
    ];

    const all = assessCoverage(records, { days: 2, now: NOW });
    expect(all.checkedFrom).toBe('2026-11-06');
    expect(all.healthy).toBe(true);

    const siteA = assessCoverage(records, { days: 2, now: NOW, site: 'site-a' });
    expect(siteA.totalRecords).toBe(2);
    expect(siteA.healthy).toBe(true);

    const siteB = assessCoverage(records, { days: 2, now: NOW, site: 'site-b' });
    expect(siteB.totalRecords).toBe(1);
    expect(siteB.missingDays).toEqual(['2026-11-06', '2026-11-07']);
    expect(siteB.healthy).toBe(false);
  });
});

describe('history replay', () => {
  it('includes today and drops records older than the window', () => {
    const records = [
      record('2026-10-31T06:00:00.000Z'),
      record('2026-11-02T06:00:00.000Z', 'skipped', { reason: 'already_ran_today' }),
      record('2026-11-07T06:00:00.000Z', 'ok', { summary: 'submitted=1 deferredWrites=2' }),
      record('2026-11-08T00:10:00.000Z', 'ok'),
    ];

    const text = formatHistory(records, { days: 7, now: NOW });
    const lines = text.split('\n');

    expect(lines[0]).toBe('history: 2026-11-02..2026-11-08 — 3 run(s)');
    expect(text).not.toContain('2026-10-31');
    expect(text).toContain('submitted=1 deferredWrites=2');
    expect(text).toContain('daily skipped bayjf.com');
  });

  it('formats a single record with status, duration and detail', () => {
    expect(
      formatRunRecord(record('2026-11-07T06:00:00.000Z', 'failed', { reason: 'boom', durationMs: 42 })),
    ).toBe('2026-11-07T06:00:00.000Z daily failed bayjf.com 42ms boom');
  });

  it('says so when nothing is recorded', () => {
    expect(formatHistory([record('2026-10-01T00:00:00.000Z')], { days: 7, now: NOW })).toBe(
      'history: 2026-11-02..2026-11-08 — 0 run(s): none recorded.',
    );
  });
});
