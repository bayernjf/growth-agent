// Regression: zero-credential offline daily must produce candidates from the
// recorded fixtures. Before the fix the offline GSC/SERP replays ignored their
// inputs — GSC returned the same query-dimension rows for every dimension and
// every window, SERP returned the same results for every query — so a fresh
// install's `daily` always scored 0 write / 0 fix. These tests pin the replay
// contract: rows depend on the requested dimension, the requested window and
// (for SERP) the requested query, end to end through the daily runner.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateUp } from '../../src/storage/migrate.js';
import { SqliteDriver } from '../../src/storage/sqlite/sqlite-driver.js';
import { GrowthTaskRepository } from '../../src/task/repository.js';
import { GscSnapshotRepository } from '../../src/connector/gsc/snapshot-repository.js';
import { ApiCallRepository } from '../../src/cost/api-call-repository.js';
import { Pricing } from '../../src/cost/pricing.js';
import { CostRecorder } from '../../src/cost/recorder.js';
import { OfflineZeusClient } from '../../src/connector/zeus/offline.js';
import { OfflineGscProvider } from '../../src/connector/gsc/offline.js';
import { OfflineSerpProvider } from '../../src/connector/serp/offline.js';
import { DailyScriptRunner } from '../../src/scheduler/daily.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
// Aligned with the dates recorded in tests/fixtures/gsc-fixture.json:
// 2026-09-15 rows sit in the prior window (08-31..09-27) and the 2026-10-15
// rows sit in the recent window (09-28..10-25); the daily runner's own
// windows are trailingInclusive(day, 28, 1) and (day, 28, 29).
const DAY = new Date('2026-10-26T06:00:00.000Z');

let db: SqliteDriver;

beforeAll(async () => {
  process.env.GA_REPO_ROOT = repoRoot;
  db = new SqliteDriver(':memory:');
  await migrateUp(db);
});

afterAll(async () => {
  await db.close();
});

describe('offline GSC replay keys on the requested dimension and window', () => {
  it('page dimension returns page-url-keyed rows (not query keywords)', async () => {
    const gsc = new OfflineGscProvider();
    const rows = await gsc.queryAnalytics({
      siteUrl: 'https://bayjf.com/',
      startDate: '2026-09-28',
      endDate: '2026-10-25',
      dimensions: ['page'],
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.keys[0] ?? '').toContain('/');
    }
  });

  it('the two recorded windows return different rows for the same page', async () => {
    const gsc = new OfflineGscProvider();
    const recent = await gsc.queryAnalytics({
      siteUrl: 'https://bayjf.com/',
      startDate: '2026-09-28',
      endDate: '2026-10-25',
      dimensions: ['page'],
    });
    const prior = await gsc.queryAnalytics({
      siteUrl: 'https://bayjf.com/',
      startDate: '2026-08-31',
      endDate: '2026-09-27',
      dimensions: ['page'],
    });
    expect(recent).not.toEqual(prior);
    const dropped = recent.find(r => r.keys[0] === 'https://bayjf.com/guides/legacy-guide');
    const before = prior.find(r => r.keys[0] === 'https://bayjf.com/guides/legacy-guide');
    expect(before?.position).toBeLessThan(dropped?.position ?? Number.POSITIVE_INFINITY);
  });
});

describe('offline SERP replay keys on the requested query', () => {
  it('different queries return different recorded result sets', async () => {
    const serp = new OfflineSerpProvider();
    const a = await serp.serp('self hosted growth agent');
    const b = await serp.serp('byok seo automation');
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    expect(a.map(r => r.url)).not.toEqual(b.map(r => r.url));
  });
});

describe('zero-credential offline daily end to end', () => {
  it('produces exactly 1 write + 1 fix candidate from the recorded fixtures', async () => {
    const tasks = new GrowthTaskRepository(db);
    const snapshots = new GscSnapshotRepository(db);
    const apiCalls = new ApiCallRepository(db);
    const recorder = new CostRecorder(apiCalls, new Pricing(), () => DAY.toISOString());
    const runner = new DailyScriptRunner({
      siteId: 'bayjf.com',
      domain: 'bayjf.com',
      gsc: new OfflineGscProvider(),
      snapshots,
      serp: new OfflineSerpProvider(),
      zeus: new OfflineZeusClient(),
      tasks,
      recorder,
      watchQueries: ['bayjf portfolio', 'astral growth agent', 'byok growth pr agent'],
      keywordSeeds: ['self hosted growth agent', 'byok seo automation', 'astral developer portfolio'],
      now: () => DAY,
    });

    const result = await runner.run(DAY);
    expect(result.ran).toBe(true);
    expect(result.submitted.map(s => s.kind).sort()).toEqual(['fix', 'write']);
    const write = result.submitted.find(s => s.kind === 'write');
    const fix = result.submitted.find(s => s.kind === 'fix');
    expect(write?.query).toBe('byok seo automation');
    expect(fix?.query).toBe('https://bayjf.com/guides/legacy-guide');
  });
});
