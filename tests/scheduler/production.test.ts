import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { migrateUp } from '../../src/storage/migrate.js';
import { SqliteDriver } from '../../src/storage/sqlite/sqlite-driver.js';
import { GrowthTaskRepository } from '../../src/task/repository.js';
import { ApiCallRepository } from '../../src/cost/api-call-repository.js';
import { Pricing } from '../../src/cost/pricing.js';
import { CostRecorder } from '../../src/cost/recorder.js';
import { FakeSitePublisher } from '../../src/publisher/fake.js';
import { runProductionBatch, type ProductionDeps } from '../../src/scheduler/production.js';
import type { ContentDraft } from '../../src/qa/types.js';
import type { SerpResult } from '../../src/connector/serp/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

let db: SqliteDriver;
let tasks: GrowthTaskRepository;
let publisher: FakeSitePublisher;
let deps: ProductionDeps;
const now = '2026-10-26T08:00:00.000Z';

const goodDraft: ContentDraft = {
  taskType: 'write',
  query: 'how to bake bread',
  slug: 'guides/how-to-bake-bread',
  title: 'How to bake bread',
  paragraphs: [
    'Autolyse the flour and water for forty minutes before adding salt and starter.',
    'A 72 percent hydration dough yields an open crumb when baked in a covered dutch oven.',
    'Cool the loaf on a rack for at least one hour so the crumb finishes setting.',
  ],
};

const goodSerp: SerpResult[] = [
  { url: 'https://en.wikipedia.org/wiki/Bread', title: 'Bread', position: 1, description: 'x' },
  { url: 'https://en.wikipedia.org/wiki/Sourdough', title: 'Sourdough', position: 2, description: 'x' },
  { url: 'https://en.wikipedia.org/wiki/Kneading', title: 'Kneading', position: 3, description: 'x' },
];

beforeAll(async () => {
  process.env.GA_REPO_ROOT = repoRoot;
  db = new SqliteDriver(':memory:');
  await migrateUp(db);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  tasks = new GrowthTaskRepository(db);
  publisher = new FakeSitePublisher();
  deps = {
    tasks,
    publisher,
    recorder: new CostRecorder(new ApiCallRepository(db), new Pricing(), () => now),
    now: () => now,
  };
});

describe('runProductionBatch (§5.C)', () => {
  it('passes QA, opens the change and moves drafting -> pr_opened', async () => {
    await tasks.create({ id: 'gt_pass', siteId: 's', type: 'write', status: 'drafting' }, now);
    const result = await runProductionBatch(deps, {
      taskId: 'gt_pass',
      draft: goodDraft,
      serp: goodSerp,
      gscPages: [],
      existingOpenChanges: [],
      publishedContent: [],
      keywordVolume: 800,
      changeSummary: 'Adds a new sourdough baking guide.',
      repoFullName: 'owner/site',
    });
    expect(result.action).toBe('pr_opened');
    expect(result.prRef?.number).toBe(1);
    expect(result.prRef?.platform).toBe('github');
    const task = await tasks.get('gt_pass');
    expect(task?.status).toBe('pr_opened');
    expect(task?.prRef?.number).toBe(1);
    expect(task?.qaResult?.intent).toBe(true);
  });

  it('first QA failure routes drafting -> qa_revision (one rework only)', async () => {
    await tasks.create({ id: 'gt_fail1', siteId: 's', type: 'write', status: 'drafting' }, now);
    const result = await runProductionBatch(deps, {
      taskId: 'gt_fail1',
      draft: goodDraft,
      serp: goodSerp,
      gscPages: [],
      existingOpenChanges: [],
      publishedContent: [],
      // No demand: value gate fails.
      keywordVolume: 0,
      changeSummary: 'x',
      repoFullName: 'owner/site',
    });
    expect(result.action).toBe('qa_revision');
    const task = await tasks.get('gt_fail1');
    expect(task?.status).toBe('qa_revision');
    expect(task?.qaRevisionCount).toBe(1);
  });

  it('second QA failure after rework routes drafting -> failed', async () => {
    await tasks.create({ id: 'gt_fail2', siteId: 's', type: 'write', status: 'drafting' }, now);
    // Simulate the rework loop: revision counter is 1 and task is back in drafting.
    await tasks.patch('gt_fail2', { qaRevisionCount: 1 }, now);
    const result = await runProductionBatch(deps, {
      taskId: 'gt_fail2',
      draft: goodDraft,
      serp: goodSerp,
      gscPages: [],
      existingOpenChanges: [],
      publishedContent: [],
      keywordVolume: 0,
      changeSummary: 'x',
      repoFullName: 'owner/site',
    });
    expect(result.action).toBe('failed');
    const task = await tasks.get('gt_fail2');
    expect(task?.status).toBe('failed');
  });

  it('refuses to run on a task that is not drafting', async () => {
    await tasks.create({ id: 'gt_wrong', siteId: 's', type: 'write', status: 'signaled' }, now);
    await expect(
      runProductionBatch(deps, {
        taskId: 'gt_wrong',
        draft: goodDraft,
        serp: goodSerp,
        gscPages: [],
        existingOpenChanges: [],
        publishedContent: [],
        keywordVolume: 800,
        changeSummary: 'x',
        repoFullName: 'owner/site',
      }),
    ).rejects.toThrowError(/drafting/);
  });
});

describe('runProductionBatch ordering (P1: external publish before terminal status)', () => {
  const batchInput = (taskId: string) => ({
    taskId,
    draft: goodDraft,
    serp: goodSerp,
    gscPages: [],
    existingOpenChanges: [],
    publishedContent: [],
    keywordVolume: 800,
    changeSummary: 'x',
    repoFullName: 'owner/site',
  });

  it('external publish failure leaves the task retryable in drafting, never stuck', async () => {
    class FlakyPublisher extends FakeSitePublisher {
      override async openChange(): Promise<never> {
        throw new Error('github 503: Service Unavailable');
      }
    }
    deps = { ...deps, publisher: new FlakyPublisher() };
    await tasks.create({ id: 'gt_ext_fail', siteId: 's', type: 'write', status: 'drafting' }, now);

    await expect(runProductionBatch(deps, batchInput('gt_ext_fail'))).rejects.toThrowError(/github 503/);
    const stuck = await tasks.get('gt_ext_fail');
    expect(stuck?.status).toBe('drafting');
    expect(stuck?.prRef).toBeUndefined();

    // The failure is transient: re-running the batch converges to the terminal state.
    deps = { ...deps, publisher: new FakeSitePublisher() };
    const retry = await runProductionBatch(deps, batchInput('gt_ext_fail'));
    expect(retry.action).toBe('pr_opened');
    expect((await tasks.get('gt_ext_fail'))?.status).toBe('pr_opened');
  });

  it('crash after publish but before persist: restart recovers without a duplicate PR', async () => {
    class CrashOnceRepo extends GrowthTaskRepository {
      private crashesLeft = 1;
      override async patch(...args: Parameters<GrowthTaskRepository['patch']>) {
        if (this.crashesLeft > 0) {
          this.crashesLeft -= 1;
          throw new Error('simulated crash after publish');
        }
        return super.patch(...args);
      }
    }
    const crashRepo = new CrashOnceRepo(db);
    const pub = new FakeSitePublisher();
    const crashDeps: ProductionDeps = { ...deps, tasks: crashRepo, publisher: pub };
    await crashRepo.create({ id: 'gt_crash', siteId: 's', type: 'write', status: 'drafting' }, now);

    // Crash window: the PR exists remotely but nothing persisted locally.
    await expect(runProductionBatch(crashDeps, batchInput('gt_crash'))).rejects.toThrowError(/simulated crash/);
    expect((await crashRepo.get('gt_crash'))?.status).toBe('drafting');
    expect(pub.openedChanges()).toHaveLength(1);

    // Restart: the sweep replays the batch; the idempotent publisher returns
    // the SAME change instead of opening a duplicate.
    const retry = await runProductionBatch(crashDeps, batchInput('gt_crash'));
    expect(retry.action).toBe('pr_opened');
    expect(retry.prRef?.number).toBe(1);
    expect(pub.openedChanges()).toHaveLength(1);
    const task = await crashRepo.get('gt_crash');
    expect(task?.status).toBe('pr_opened');
    expect(task?.prRef?.number).toBe(1);
    expect(task?.qaResult?.intent).toBe(true);
  });

  it('re-delivery after a successful publish cannot open a second PR', async () => {
    const pub = new FakeSitePublisher();
    deps = { ...deps, publisher: pub };
    await tasks.create({ id: 'gt_dup', siteId: 's', type: 'write', status: 'drafting' }, now);

    const first = await runProductionBatch(deps, batchInput('gt_dup'));
    expect(first.action).toBe('pr_opened');
    // The batch is guarded by the drafting precondition: a replayed delivery
    // is refused before any external call.
    await expect(runProductionBatch(deps, batchInput('gt_dup'))).rejects.toThrowError(/drafting/);
    expect(pub.openedChanges()).toHaveLength(1);
  });
});
