import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateUp, migrationStatus } from '../../src/storage/migrate.js';
import { SqliteDriver } from '../../src/storage/sqlite/sqlite-driver.js';
import { GscSnapshotRepository } from '../../src/connector/gsc/snapshot-repository.js';
import { aggregate, diffDay, diffRow } from '../../src/connector/gsc/snapshot-diff.js';
import type { GscSnapshotRow } from '../../src/connector/gsc/snapshot-repository.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

let db: SqliteDriver;
let repo: GscSnapshotRepository;

const row = (over: Partial<GscSnapshotRow>): GscSnapshotRow => ({
  siteUrl: 'https://bayjf.com/',
  date: '2026-10-26',
  dimensionKey: 'site audit checklist',
  clicks: 12,
  impressions: 480,
  position: 3.4,
  ...over,
});

beforeAll(() => {
  process.env.GA_REPO_ROOT = repoRoot;
  db = new SqliteDriver(':memory:');
  repo = new GscSnapshotRepository(db, () => '2026-10-26T06:00:00.000Z');
});

afterAll(async () => {
  await db.close();
  delete process.env.GA_REPO_ROOT;
});

describe('003_gsc_snapshot migration (sqlite execution)', () => {
  it('applies and is idempotent on a fresh database', async () => {
    const applied = await migrateUp(db);
    expect(applied).toContain('003_gsc_snapshot');
    expect((await migrationStatus(db)).pending).toEqual([]);
    expect(await migrateUp(db)).toEqual([]);
  });
});

describe('GscSnapshotRepository upsert idempotency (same-day rerun overwrites)', () => {
  it('insert then same-key upsert overwrites clicks/impressions/position', async () => {
    await repo.upsert([row({})]);
    await repo.upsert([row({ clicks: 15, impressions: 600, position: 2.8 })]);
    const found = await repo.find('https://bayjf.com/', '2026-10-26', 'site audit checklist');
    expect(found).toMatchObject({ clicks: 15, impressions: 600, position: 2.8 });
  });

  it('list filters by site and date range, ordered', async () => {
    await repo.upsert([
      row({ dimensionKey: 'astro pipeline', date: '2026-10-25', position: 7.9, clicks: 5, impressions: 210 }),
      row({ dimensionKey: 'astro pipeline', date: '2026-10-26', position: 6.1, clicks: 8, impressions: 300 }),
    ]);
    const rows = await repo.list('https://bayjf.com/', '2026-10-25', '2026-10-26');
    // Includes the site audit checklist row upserted by the previous test
    // in this same in-memory database (rows share the test file lifetime).
    expect(rows.map(r => r.dimensionKey).sort()).toEqual([
      'astro pipeline',
      'astro pipeline',
      'site audit checklist',
    ]);
    expect(await repo.find('https://bayjf.com/', '2099-01-01', 'nope')).toBeUndefined();
  });
});

describe('snapshot diff pure functions (today - yesterday)', () => {
  const todayRow: GscSnapshotRow = {
    siteUrl: 'https://bayjf.com/',
    date: '2026-10-26',
    dimensionKey: 'site audit checklist',
    clicks: 15,
    impressions: 600,
    position: 2.8,
  };

  it('improved when position decreased; declined when it increased', () => {
    const improved = diffRow(todayRow, { ...todayRow, position: 3.4, clicks: 12, impressions: 480 });
    expect(improved.positionDelta).toBeCloseTo(-0.6);
    expect(improved.direction).toBe('improved');
    expect(improved.clicksDelta).toBe(3);
    expect(improved.impressionsDelta).toBe(120);

    const declined = diffRow(todayRow, { ...todayRow, position: 1.5, clicks: 20, impressions: 900 });
    expect(declined.positionDelta).toBeCloseTo(1.3);
    expect(declined.direction).toBe('declined');
  });

  it('no_data when yesterday has no row (new query)', () => {
    const delta = diffRow(todayRow, undefined);
    expect(delta.direction).toBe('no_data');
    expect(delta.positionDelta).toBeNull();
    expect(delta.clicksDelta).toBeNull();
  });

  it('unchanged for tiny movements; diffDay pairs by dimension key', () => {
    const yesterday = [
      { ...todayRow, dimensionKey: 'site audit checklist', position: 2.81 },
      { ...todayRow, dimensionKey: 'other page', position: 9.0 },
    ];
    const deltas = diffDay([todayRow], yesterday);
    expect(deltas[0]?.direction).toBe('unchanged');
    const paired = diffDay(
      [todayRow, { ...todayRow, dimensionKey: 'fresh query', position: 12 }],
      yesterday,
    );
    expect(paired.map(d => d.direction)).toEqual(['unchanged', 'no_data']);
  });

  it('aggregate totals clicks/impressions and averages position', () => {
    const agg = aggregate([todayRow, { ...todayRow, position: 6.2, clicks: 5, impressions: 100 }]);
    expect(agg).toEqual({ clicks: 20, impressions: 700, averagePosition: 4.5, rowCount: 2 });
    expect(aggregate([])).toMatchObject({ rowCount: 0, clicks: 0 });
  });
});
