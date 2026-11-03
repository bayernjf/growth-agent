import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { migrateUp } from '../../src/storage/migrate.js';
import { SqliteDriver } from '../../src/storage/sqlite/sqlite-driver.js';
import { GrowthTaskRepository } from '../../src/task/repository.js';
import { runVerificationBatch, type VerificationDeps } from '../../src/scheduler/verification.js';
import type { GscReadonlyProvider, GscRow } from '../../src/connector/gsc/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

const DAY1 = new Date('2026-10-26T06:00:00.000Z');
const DAY2 = new Date('2026-10-27T06:00:00.000Z');
const MERGED_25H_AGO = '2026-10-25T05:00:00.000Z';

async function setup() {
  process.env.GA_REPO_ROOT = repoRoot;
  const db = new SqliteDriver(':memory:');
  await migrateUp(db);
  const tasks = new GrowthTaskRepository(db);
  return { db, tasks };
}

function gscWith(position: number, impressions: number): GscReadonlyProvider {
  const rows: GscRow[] = [
    { keys: ['/drop'], clicks: 1, impressions, ctr: 0.01, position },
  ];
  return {
    name: 'gsc-stub',
    mode: 'offline',
    listSites: async () => [],
    queryAnalytics: async () => rows.map(r => ({ ...r, keys: [...r.keys] })),
  };
}

function depsFor(
  tasks: GrowthTaskRepository,
  gsc: GscReadonlyProvider,
  at: string,
): VerificationDeps {
  return {
    tasks,
    gsc,
    resolveTargetUrl: task => (task.type === 'fix' ? '/drop' : undefined),
    now: () => new Date(at),
  };
}

describe('runVerificationBatch (§5.D)', () => {
  it('records the first check as a baseline and keeps the task verifying', async () => {
    const { db, tasks } = await setup();
    await tasks.create({ id: 'gt_v1', siteId: 's', type: 'fix', status: 'verifying' }, MERGED_25H_AGO);
    const result = await runVerificationBatch(
      depsFor(tasks, gscWith(12, 500), DAY1.toISOString()),
      DAY1,
    );
    expect(result.checked[0]).toEqual({ taskId: 'gt_v1', outcome: 'pending' });
    const task = await tasks.get('gt_v1');
    expect(task?.status).toBe('verifying');
    expect(task?.verifyChecks).toHaveLength(1);
    expect(task?.verifyChecks?.[0]?.position).toBe(12);
    await db.close();
  });

  it('a >=3 position improvement on the second check ends done/verified', async () => {
    const { db, tasks } = await setup();
    await tasks.create({ id: 'gt_v2', siteId: 's', type: 'fix', status: 'verifying' }, MERGED_25H_AGO);
    await runVerificationBatch(depsFor(tasks, gscWith(12, 500), DAY1.toISOString()), DAY1);
    const result = await runVerificationBatch(
      depsFor(tasks, gscWith(8, 600), DAY2.toISOString()),
      DAY2,
    );
    expect(result.checked[0]?.outcome).toBe('verified');
    const task = await tasks.get('gt_v2');
    expect(task?.status).toBe('done');
    expect(task?.verifyResult?.outcome).toBe('verified');
    expect(task?.verifyResult?.positionDelta).toBeLessThanOrEqual(-3);
    await db.close();
  });

  it('two checks with no gain end done/verified_no_gain', async () => {
    const { db, tasks } = await setup();
    await tasks.create({ id: 'gt_v3', siteId: 's', type: 'fix', status: 'verifying' }, MERGED_25H_AGO);
    await runVerificationBatch(depsFor(tasks, gscWith(12, 500), DAY1.toISOString()), DAY1);
    const result = await runVerificationBatch(
      depsFor(tasks, gscWith(12, 490), DAY2.toISOString()),
      DAY2,
    );
    expect(result.checked[0]?.outcome).toBe('verified_no_gain');
    const task = await tasks.get('gt_v3');
    expect(task?.status).toBe('done');
    expect(task?.verifyResult?.outcome).toBe('verified_no_gain');
    await db.close();
  });

  it('skips tasks within the 24h post-merge window', async () => {
    const { db, tasks } = await setup();
    const recent = new Date(DAY1.getTime() - 60 * 60 * 1000).toISOString();
    await tasks.create({ id: 'gt_v4', siteId: 's', type: 'fix', status: 'verifying' }, recent);
    const result = await runVerificationBatch(
      depsFor(tasks, gscWith(12, 500), DAY1.toISOString()),
      DAY1,
    );
    expect(result.skipped[0]).toMatchObject({ taskId: 'gt_v4', reason: 'within_24h_window' });
    await db.close();
  });

  it('does not record two checks on the same day (safe re-run)', async () => {
    const { db, tasks } = await setup();
    await tasks.create({ id: 'gt_v5', siteId: 's', type: 'fix', status: 'verifying' }, MERGED_25H_AGO);
    const deps = depsFor(tasks, gscWith(12, 500), DAY1.toISOString());
    await runVerificationBatch(deps, DAY1);
    const result = await runVerificationBatch(deps, DAY1);
    expect(result.skipped[0]).toMatchObject({ taskId: 'gt_v5', reason: 'already_checked_today' });
    const task = await tasks.get('gt_v5');
    expect(task?.verifyChecks).toHaveLength(1);
    await db.close();
  });

  // Review F-06: a GSC throw for one task previously propagated out of the
  // batch and silently skipped every remaining verification of the day.
  it('isolates a per-task GSC failure — later tasks are still checked (F-06)', async () => {
    const { db, tasks } = await setup();
    await tasks.create({ id: 'gt_boom', siteId: 's', type: 'fix', status: 'verifying' }, MERGED_25H_AGO);
    await tasks.create({ id: 'gt_ok', siteId: 's', type: 'fix', status: 'verifying' }, MERGED_25H_AGO);

    // First GSC call (gt_boom) throws; subsequent calls (gt_ok) succeed.
    let gscCalls = 0;
    const flakyGsc: GscReadonlyProvider = {
      name: 'gsc-flaky',
      mode: 'offline',
      listSites: async () => [],
      queryAnalytics: async () => {
        gscCalls += 1;
        if (gscCalls === 1) throw new Error('UPSTREAM_UNAVAILABLE: gsc exploded');
        return [{ keys: ['/drop'], clicks: 1, impressions: 500, ctr: 0.01, position: 12 }];
      },
    };

    const result = await runVerificationBatch(depsFor(tasks, flakyGsc, DAY1.toISOString()), DAY1);

    expect(result.failed).toEqual([
      { taskId: 'gt_boom', reason: 'UPSTREAM_UNAVAILABLE: gsc exploded' },
    ]);
    expect(result.checked).toEqual([{ taskId: 'gt_ok', outcome: 'pending' }]);
    // The failed task stays verifying (retryable tomorrow), not wedged/done.
    expect((await tasks.get('gt_boom'))?.status).toBe('verifying');
    await db.close();
  });
});
