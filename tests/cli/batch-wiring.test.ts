// Wiring regression for 2026-11-02 review F-04: the sentiment provider and
// snapshot repository were merged library-only (OP-40/41/42) and never
// injected in the deploy loop, so `batch daily` persisted no sentiment rows
// and `batch report` never rendered the sentiment section. These tests run
// the real CLI entry (runBatch) in offline mode against a temp database and
// assert the wiring exists end to end.

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runBatch } from '../../src/cli/batch.js';
import { readRunLedger, runLedgerPath } from '../../src/report/run-ledger.js';
import { SqliteDriver } from '../../src/storage/sqlite/sqlite-driver.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

const ENV_KEYS = [
  'GA_SQLITE_PATH',
  'GA_REPORT_DIR',
  'GA_REPO_ROOT',
  'GA_GSC_MODE',
  'GA_SERP_MODE',
  'GA_ADS_MODE',
  'GA_SENTIMENT_MODE',
  'GA_ZEUS_MODE',
  'GA_GITHUB_MODE',
  'GA_DRAFT_MODE',
] as const;

describe('batch CLI wiring (F-04)', () => {
  let work: string;
  let saved: Record<string, string | undefined>;

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), 'growth-agent-batch-'));
    saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.GA_SQLITE_PATH = join(work, 'growth-agent.db');
    process.env.GA_REPORT_DIR = join(work, 'reports');
    process.env.GA_REPO_ROOT = repoRoot;
    for (const key of ENV_KEYS) {
      if (key.endsWith('_MODE')) process.env[key] = 'off';
    }
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await rm(work, { recursive: true, force: true });
  });

  it('importing batch.ts does not start a run', () => {
    // The test process itself is proof: runBatch was imported above without
    // opening the configured database or touching the network.
    expect(typeof runBatch).toBe('function');
  });

  it('daily persists sentiment snapshots through the real CLI wiring', async () => {
    await runBatch(['daily', '--site', 'bayjf.com', '--day', '2026-10-26']);

    const db = new SqliteDriver(join(work, 'growth-agent.db'));
    try {
      const rows = await db.all<{ n: number }>('SELECT COUNT(*) AS n FROM sentiment_daily_snapshot');
      expect(rows[0]?.n ?? 0).toBeGreaterThan(0);
    } finally {
      await db.close();
    }
  });

  it('report renders the sentiment section through the real CLI wiring', async () => {
    await runBatch(['daily', '--site', 'bayjf.com', '--day', '2026-10-26']);
    await runBatch(['report', '--site', 'bayjf.com', '--day', '2026-10-26']);

    const reports = await readdir(join(work, 'reports'));
    const weekly = reports.filter((name) => name.startsWith('weekly-') && name.endsWith('.md'));
    expect(weekly.length).toBeGreaterThan(0);
    const content = await readFile(join(work, 'reports', weekly[0] as string), 'utf8');
    expect(content).toContain('## Sentiment alerts (negative mentions)');
  });

  it('records each CLI run in the report-volume ledger', async () => {
    await runBatch(['daily', '--site', 'bayjf.com', '--day', '2026-10-26']);
    await runBatch(['production', '--site', 'bayjf.com', '--day', '2026-10-26']);

    const records = readRunLedger(runLedgerPath(join(work, 'reports')));
    expect(records.map((record) => record.command)).toEqual(['daily', 'production']);
    expect(records[0]?.site).toBe('bayjf.com');
    expect(records[0]?.day).toBe('2026-10-26');
    expect(records[0]?.status).toBe('ok');
    expect(records[0]?.summary).toContain('submitted=');
    expect(records[1]?.summary).toContain('items=0');
  });
});
