import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateUp } from '../../src/storage/migrate.js';
import { SqliteDriver } from '../../src/storage/sqlite/sqlite-driver.js';
import { GrowthTaskRepository } from '../../src/task/repository.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

let db: SqliteDriver;
let repo: GrowthTaskRepository;

beforeAll(async () => {
  process.env.GA_REPO_ROOT = repoRoot;
  db = new SqliteDriver(':memory:');
  await migrateUp(db);
  repo = new GrowthTaskRepository(db);
});

afterAll(async () => {
  await db.close();
});

describe('GrowthTaskRepository (sqlite, real 001 migration)', () => {
  it('creates a task with §3.1 defaults and reads it back', async () => {
    const now = '2026-10-26T06:00:00.000Z';
    const created = await repo.create(
      { id: 'gt_demo1', siteId: 'bayjf.com', type: 'write', signalId: 'sig_1' },
      now,
    );
    expect(created).toMatchObject({
      id: 'gt_demo1',
      siteId: 'bayjf.com',
      type: 'write',
      signalId: 'sig_1',
      status: 'signaled',
      qaRevisionCount: 0,
      costMicrosTotal: 0,
      idempotencyKey: 'gt:gt_demo1',
      createdAt: now,
      updatedAt: now,
    });

    const row = await repo.get('gt_demo1');
    expect(row?.id).toBe('gt_demo1');
    expect(row?.signalId).toBe('sig_1');
    // Nullable columns absent in the domain object when unset.
    expect(row).not.toHaveProperty('zeusDecisionId');
    expect(row).not.toHaveProperty('prRef');
  });

  it('persists status transitions and patch fields with JSON roundtrip', async () => {
    const now = '2026-10-26T07:00:00.000Z';
    expect(await repo.setStatus('gt_demo1', 'deciding', now)).toBe(1);

    const patched = await repo.patch(
      'gt_demo1',
      {
        zeusDecisionId: 'dec_123',
        qaResult: { intent: true, dedupe: true, value: false, scores: [80, 70, 55] },
        qaRevisionCount: 1,
      },
      now,
    );
    expect(patched).toBe(1);

    const row = await repo.get('gt_demo1');
    expect(row?.status).toBe('deciding');
    expect(row?.zeusDecisionId).toBe('dec_123');
    expect(row?.qaRevisionCount).toBe(1);
    expect(row?.qaResult).toEqual({ intent: true, dedupe: true, value: false, scores: [80, 70, 55] });
    expect(row?.updatedAt).toBe(now);
  });

  it('round-trips nested JSON snapshots (prRef, verifyResult)', async () => {
    await repo.patch(
      'gt_demo1',
      {
        prRef: { platform: 'github', repo: 'jiangfeng/bayjf', number: 42, url: 'https://example/pr/42', branch: 'bot/gt_demo1' },
        verifyResult: { impressionsDelta: 120, clicksDelta: 8, positionDelta: -3 },
      },
      '2026-10-27T06:00:00.000Z',
    );
    const row = await repo.get('gt_demo1');
    expect(row?.prRef?.number).toBe(42);
    expect(row?.prRef?.branch).toBe('bot/gt_demo1');
    expect(row?.verifyResult?.positionDelta).toBe(-3);
  });

  it('lists tasks and filters by status', async () => {
    await repo.create({ id: 'gt_fix1', siteId: 'bayjf.com', type: 'fix' }, '2026-10-26T06:05:00.000Z');
    const all = await repo.list();
    expect(all.map((t) => t.id).sort()).toEqual(['gt_demo1', 'gt_fix1']);

    const deciding = await repo.list('deciding');
    expect(deciding.map((t) => t.id)).toEqual(['gt_demo1']);
  });

  it('rejects a duplicate task id (which would also collide on idempotency_key)', async () => {
    await expect(
      repo.create({ id: 'gt_demo1', siteId: 'bayjf.com', type: 'monitor' }, '2026-10-26T06:06:00.000Z'),
    ).rejects.toThrow();
  });

  it('returns 0 rows changed when updating a missing id', async () => {
    expect(await repo.setStatus('gt_missing', 'drafting', '2026-10-26T08:00:00.000Z')).toBe(0);
  });
});
