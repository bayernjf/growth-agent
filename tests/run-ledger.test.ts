import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendRunRecord,
  assessCoverage,
  formatCoverage,
  readRunLedger,
  runLedgerPath,
  type RunRecord,
} from '../src/report/run-ledger.js';

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'ga-ledger-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function okRecords(days: string[], site = 'bayjf.com'): RunRecord[] {
  return days.map(day => ({
    ts: `${day}T01:00:00.000Z`,
    command: 'daily',
    site,
    status: 'ok' as const,
    durationMs: 1000,
  }));
}

describe('run ledger file', () => {
  it('appends and reads back records, creating the directory', () => {
    withTempDir(dir => {
      const path = join(dir, 'nested', 'run-ledger.jsonl');
      appendRunRecord(path, {
        ts: '2026-11-07T01:00:00.000Z',
        command: 'daily',
        site: 'bayjf.com',
        status: 'ok',
        durationMs: 1200,
      });
      appendRunRecord(path, {
        ts: '2026-11-07T02:00:00.000Z',
        command: 'report',
        status: 'failed',
        durationMs: 800,
        reason: 'boom',
      });
      const records = readRunLedger(path);
      expect(records).toHaveLength(2);
      expect(records[0]?.command).toBe('daily');
      expect(records[1]?.status).toBe('failed');
      expect(records[1]?.reason).toBe('boom');
    });
  });

  it('treats a missing file as an empty ledger', () => {
    withTempDir(dir => {
      expect(readRunLedger(join(dir, 'absent.jsonl'))).toEqual([]);
    });
  });

  it('skips malformed lines but keeps the rest readable', () => {
    withTempDir(dir => {
      const path = join(dir, 'run-ledger.jsonl');
      writeFileSync(
        path,
        [
          '{"ts":"2026-11-06T01:00:00.000Z","command":"daily","status":"ok","durationMs":5}',
          'not json at all',
          '{"ts":"2026-11-07T01:00:00.000Z","command":"daily","status":"bogus","durationMs":5}',
          '{"ts":"2026-11-07T02:00:00.000Z","command":"report","status":"ok","durationMs":5}',
        ].join('\n'),
        'utf8',
      );
      const records = readRunLedger(path);
      expect(records).toHaveLength(2);
      expect(records.map(r => r.command)).toEqual(['daily', 'report']);
    });
  });

  it('honours GA_RUN_LEDGER override and defaults to the report dir', () => {
    expect(runLedgerPath('./data/reports', {})).toBe('./data/reports/run-ledger.jsonl');
    expect(runLedgerPath('./data/reports/', {})).toBe('./data/reports/run-ledger.jsonl');
    expect(runLedgerPath('./data/reports', { GA_RUN_LEDGER: '/tmp/x.jsonl' })).toBe('/tmp/x.jsonl');
  });
});

describe('coverage assessment', () => {
  const now = new Date('2026-11-08T10:00:00.000Z');

  it('is healthy when every complete day in the window has an ok run', () => {
    const days: string[] = [];
    for (let i = 1; i <= 30; i += 1) {
      const d = new Date(Date.UTC(2026, 10, 8 - i));
      days.push(d.toISOString().slice(0, 10));
    }
    const report = assessCoverage(okRecords(days), { days: 30, now });
    expect(report.healthy).toBe(true);
    expect(report.missingDays).toEqual([]);
    expect(report.consecutiveOkDays).toBe(30);
    expect(report.checkedFrom).toBe('2026-10-09');
    expect(report.checkedTo).toBe('2026-11-07');
  });

  it('reports the exact missing days and stays gap-aware', () => {
    const records = okRecords(['2026-11-07', '2026-11-06', '2026-11-04']);
    const report = assessCoverage(records, { days: 5, now });
    expect(report.checkedFrom).toBe('2026-11-03');
    expect(report.checkedTo).toBe('2026-11-07');
    expect(report.missingDays).toEqual(['2026-11-03', '2026-11-05']);
    expect(report.healthy).toBe(false);
    // Consecutive from 11-07 backwards stops at the 11-05 gap.
    expect(report.consecutiveOkDays).toBe(2);
  });

  it('does not count today as a gap (a run may still be expected today)', () => {
    const report = assessCoverage(okRecords(['2026-11-07']), { days: 1, now });
    expect(report.checkedTo).toBe('2026-11-07');
    expect(report.healthy).toBe(true);
  });

  it('is unhealthy with an empty ledger and says never', () => {
    const report = assessCoverage([], { days: 30, now });
    expect(report.healthy).toBe(false);
    expect(report.lastOkAt).toBeNull();
    expect(report.missingDays).toHaveLength(30);
    expect(formatCoverage(report)).toContain('EMPTY ledger');
  });

  it('ignores skipped and failed runs when deciding a day is covered', () => {
    const records: RunRecord[] = [
      { ts: '2026-11-07T01:00:00.000Z', command: 'daily', site: 'x', status: 'skipped', durationMs: 1 },
      { ts: '2026-11-07T02:00:00.000Z', command: 'daily', site: 'x', status: 'failed', durationMs: 1 },
    ];
    const report = assessCoverage(records, { days: 1, now });
    expect(report.healthy).toBe(false);
    expect(report.missingDays).toEqual(['2026-11-07']);
  });

  it('filters by site when asked', () => {
    const records = [
      ...okRecords(['2026-11-07'], 'site-a'),
      ...okRecords(['2026-11-06'], 'site-b'),
    ];
    const a = assessCoverage(records, { days: 2, now, site: 'site-a' });
    // site-a only covered 11-07: 11-06 is a gap for that site.
    expect(a.totalRecords).toBe(1);
    expect(a.missingDays).toEqual(['2026-11-06']);
  });

  it('crosses month boundaries in the window arithmetic', () => {
    const records = okRecords([
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
    ]);
    const report = assessCoverage(records, {
      days: 4,
      now: new Date('2026-11-04T10:00:00.000Z'),
    });
    expect(report.checkedFrom).toBe('2026-10-31');
    expect(report.checkedTo).toBe('2026-11-03');
    expect(report.healthy).toBe(true);
  });
});

describe('coverage formatting', () => {
  const now = new Date('2026-11-08T10:00:00.000Z');

  it('prints a one-line OK summary', () => {
    const report = assessCoverage(okRecords(['2026-11-07']), { days: 1, now });
    expect(formatCoverage(report)).toContain('OK');
    expect(formatCoverage(report)).toContain('2026-11-07..2026-11-07');
  });

  it('prints missing days, with a +N more suffix beyond five', () => {
    const days: string[] = [];
    for (let i = 1; i <= 10; i += 1) {
      const d = new Date(Date.UTC(2026, 10, 8 - i));
      days.push(d.toISOString().slice(0, 10));
    }
    // Cover only the newest two days of the window.
    const report = assessCoverage(okRecords(days.slice(0, 2)), { days: 10, now });
    const text = formatCoverage(report);
    expect(text).toContain('GAP');
    expect(text).toContain('+3 more');
  });
});
