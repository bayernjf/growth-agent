// Production sweep tests (§5.C driver). These are the guards that make the
// loop operable rather than merely assembled: they prove the sweep sources a
// draft, derives evidence from persisted GSC snapshots, and — critically —
// never lets a missing input consume the single §3.2 qa_revision rework.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ApiCallRepository } from '../../src/cost/api-call-repository.js';
import { Pricing } from '../../src/cost/pricing.js';
import { CostRecorder } from '../../src/cost/recorder.js';
import { GscSnapshotRepository } from '../../src/connector/gsc/snapshot-repository.js';
import type {
  KeywordIdea,
  RankTrackItem,
  SerpKeywordProvider,
  SerpResult,
} from '../../src/connector/serp/types.js';
import { InboxDraftProvider } from '../../src/draft/inbox.js';
import type { DraftOutcome, DraftProvider, DraftRequest } from '../../src/draft/types.js';
import { FakeSitePublisher } from '../../src/publisher/fake.js';
import { runProductionSweep, type ProductionSweepDeps } from '../../src/scheduler/production-sweep.js';
import { migrateUp } from '../../src/storage/migrate.js';
import { SqliteDriver } from '../../src/storage/sqlite/sqlite-driver.js';
import { GrowthTaskRepository } from '../../src/task/repository.js';
import type { GrowthTaskContext } from '../../src/task/types.js';

const DAY = new Date('2026-10-27T00:00:00.000Z');
const NOW = DAY.toISOString();
const SNAPSHOT_DATE = '2026-10-26';
const SITE_ID = 'bayjf.com';
const ORIGIN = 'https://bayjf.com';
const FIX_PAGE = 'https://bayjf.com/guides/legacy-guide';
const HOME_PAGE = 'https://bayjf.com/';

/** SERP shape known to satisfy the intent gate (see production.test.ts). */
const informationalSerp: SerpResult[] = [
  { url: 'https://en.wikipedia.org/wiki/Bread', title: 'Bread', position: 1, description: 'x' },
  { url: 'https://en.wikipedia.org/wiki/Sourdough', title: 'Sourdough', position: 2, description: 'x' },
  { url: 'https://en.wikipedia.org/wiki/Kneading', title: 'Kneading', position: 3, description: 'x' },
];

class FakeSerp implements SerpKeywordProvider {
  readonly name = 'serp-fake';
  readonly online = false;

  constructor(private readonly volumes: Record<string, number> = {}) {}

  async keywordIdeas(seed: string): Promise<KeywordIdea[]> {
    const volume = this.volumes[seed];
    return volume === undefined ? [] : [{ keyword: seed, volume, competition: 0.3 }];
  }

  async serp(): Promise<SerpResult[]> {
    return informationalSerp;
  }

  async rankTrack(_domain: string, queries: string[]): Promise<RankTrackItem[]> {
    return queries.map(query => ({ query, position: null, url: null }));
  }
}

/** Draft source that always reports unavailability, optionally with a content id. */
class UnavailableDrafts implements DraftProvider {
  readonly name = 'draft-unavailable';
  readonly mode = 'inbox' as const;

  constructor(private readonly outcome: DraftOutcome & { status: 'unavailable' }) {}

  async obtain(_input: DraftRequest): Promise<DraftOutcome> {
    return this.outcome;
  }
}

/** F-06: draft source that throws for one task and delegates to the inbox otherwise. */
class FlakyDrafts implements DraftProvider {
  readonly name = 'draft-flaky';
  readonly mode = 'inbox' as const;

  constructor(
    private readonly failTaskId: string,
    private readonly inner: DraftProvider,
  ) {}

  async obtain(input: DraftRequest): Promise<DraftOutcome> {
    if (input.taskId === this.failTaskId) {
      throw new Error('UPSTREAM_UNAVAILABLE: draft chain exploded');
    }
    return this.inner.obtain(input);
  }
}

const fixDraftFile = {
  slug: 'guides/legacy-guide',
  title: 'Legacy guide (refreshed)',
  changeSummary: 'Refresh deteriorated page',
  paragraphs: [
    'The refreshed guide replaces the 2019 setup steps with the current command sequence and verified values.',
    'In our recheck the repaired page moved from position 20 to position 10 and impressions recovered from 80 to 200.',
    'Two new worked examples show how the daily quota of 1 write and 1 repair is enforced at the scheduler level.',
  ],
};

const writeDraftFile = {
  slug: 'guides/how-to-bake-bread',
  title: 'How to bake bread',
  changeSummary: 'Adds a new sourdough baking guide.',
  paragraphs: [
    'Autolyse the flour and water for forty minutes before adding salt and starter.',
    'A 72 percent hydration dough yields an open crumb when baked in a covered dutch oven.',
    'Cool the loaf on a rack for at least one hour so the crumb finishes setting.',
  ],
};

let db: SqliteDriver;
let tasks: GrowthTaskRepository;
let snapshots: GscSnapshotRepository;
let publisher: FakeSitePublisher;
let inboxDir: string;

function depsFor(overrides: Partial<ProductionSweepDeps> = {}): ProductionSweepDeps {
  return {
    tasks,
    snapshots,
    serp: new FakeSerp(),
    publisher,
    drafts: new InboxDraftProvider(inboxDir),
    recorder: new CostRecorder(new ApiCallRepository(db), new Pricing(), () => NOW),
    siteId: SITE_ID,
    repoFullName: 'bayernjf/bayjf',
    siteOrigin: ORIGIN,
    now: () => DAY,
    ...overrides,
  };
}

async function seedSnapshot(rows: Array<{ page: string; impressions: number; position: number }>): Promise<void> {
  await snapshots.upsert(
    rows.map(row => ({
      siteUrl: SITE_ID,
      date: SNAPSHOT_DATE,
      dimensionKey: row.page,
      clicks: 4,
      impressions: row.impressions,
      position: row.position,
    })),
  );
}

function dropDraft(taskId: string, file: unknown): void {
  writeFileSync(join(inboxDir, `${taskId}.json`), JSON.stringify(file), 'utf8');
}

async function createTask(
  id: string,
  type: 'write' | 'fix',
  context: GrowthTaskContext | undefined,
  status: 'drafting' | 'qa_revision' = 'drafting',
  siteId = SITE_ID,
): Promise<void> {
  await tasks.create(
    {
      id,
      siteId,
      type,
      status,
      ...(context !== undefined ? { context } : {}),
    },
    NOW,
  );
}

const fixContext = (targetUrl = FIX_PAGE): GrowthTaskContext => ({
  query: targetUrl,
  targetUrl,
  angle: 'daily fix candidate: declining page with natural exposure',
});

beforeEach(async () => {
  // A fresh in-memory database per test: deleting rows instead would trip the
  // foreign keys from api_calls / webhook deliveries onto growth_tasks.
  db = new SqliteDriver(':memory:');
  await migrateUp(db);
  tasks = new GrowthTaskRepository(db);
  snapshots = new GscSnapshotRepository(db);
  publisher = new FakeSitePublisher();
  inboxDir = mkdtempSync(join(tmpdir(), 'sweep-inbox-'));
});

afterEach(async () => {
  await db.close();
  rmSync(inboxDir, { recursive: true, force: true });
});

describe('runProductionSweep (§5.C driver)', () => {
  it('opens a PR for an approved fix task using only its own page as demand evidence', async () => {
    await seedSnapshot([
      { page: FIX_PAGE, impressions: 80, position: 20 },
      { page: HOME_PAGE, impressions: 5000, position: 1 },
    ]);
    await createTask('gt_fix', 'fix', fixContext());
    dropDraft('gt_fix', fixDraftFile);

    const result = await runProductionSweep(depsFor());

    expect(result.items).toEqual([
      expect.objectContaining({ taskId: 'gt_fix', outcome: 'pr_opened' }),
    ]);
    const task = await tasks.get('gt_fix');
    expect(task?.status).toBe('pr_opened');
    expect(task?.prRef?.repo).toBe('bayernjf/bayjf');
  });

  it('does not let a fix task borrow demand from other pages on the site', async () => {
    // The target has ZERO impressions; the home page has plenty. Leaking the
    // whole site into gscPages would satisfy the value gate's impressions sum
    // and open a PR for a page with no organic demand to defend.
    await seedSnapshot([
      { page: FIX_PAGE, impressions: 0, position: 40 },
      { page: HOME_PAGE, impressions: 5000, position: 1 },
    ]);
    await createTask('gt_fix_nodemand', 'fix', fixContext());
    dropDraft('gt_fix_nodemand', fixDraftFile);

    const result = await runProductionSweep(depsFor());

    expect(result.items[0]).toMatchObject({ taskId: 'gt_fix_nodemand', outcome: 'qa_revision' });
    expect((await tasks.get('gt_fix_nodemand'))?.status).toBe('qa_revision');
  });

  it('does not treat the page a fix task repairs as a dedupe collision', async () => {
    // The repair target is by definition already published; the sweep must
    // exclude it from publishedContent or every fix task would be blocked.
    await seedSnapshot([{ page: FIX_PAGE, impressions: 120, position: 18 }]);
    await createTask('gt_fix_self', 'fix', fixContext());
    dropDraft('gt_fix_self', { ...fixDraftFile, slug: 'https://bayjf.com/guides/legacy-guide' });

    const result = await runProductionSweep(depsFor());

    expect(result.items[0]).toMatchObject({ taskId: 'gt_fix_self', outcome: 'pr_opened' });
  });

  it('opens a write PR and records the published URL for next-day verification', async () => {
    await seedSnapshot([{ page: HOME_PAGE, impressions: 5000, position: 1 }]);
    await createTask('gt_write', 'write', {
      query: 'how to bake bread',
      angle: 'daily write candidate: informational demand with no top-10 coverage',
    });
    dropDraft('gt_write', writeDraftFile);

    const result = await runProductionSweep(
      depsFor({ serp: new FakeSerp({ 'how to bake bread': 800 }) }),
    );

    expect(result.items[0]).toMatchObject({ taskId: 'gt_write', outcome: 'pr_opened' });
    const task = await tasks.get('gt_write');
    expect(task?.status).toBe('pr_opened');
    expect(task?.context?.publishedUrl).toBe('https://bayjf.com/guides/how-to-bake-bread');
  });

  // Review F-06: before the fix, an exception from drafts.obtain / SERP /
  // GSC for one task propagated out of runProductionSweep and silently skipped
  // every remaining drafting task of the day.
  it('isolates a per-task draft failure — the rest of the sweep still runs (F-06)', async () => {
    await seedSnapshot([{ page: HOME_PAGE, impressions: 5000, position: 1 }]);
    await createTask('gt_boom', 'write', {
      query: 'exploding topic',
      angle: 'daily write candidate',
    });
    await createTask('gt_ok', 'write', {
      query: 'how to bake bread',
      angle: 'daily write candidate: informational demand with no top-10 coverage',
    });
    dropDraft('gt_ok', writeDraftFile);

    const result = await runProductionSweep(
      depsFor({
        drafts: new FlakyDrafts('gt_boom', new InboxDraftProvider(inboxDir)),
        serp: new FakeSerp({ 'how to bake bread': 800 }),
      }),
    );

    expect(result.items).toEqual([
      expect.objectContaining({
        taskId: 'gt_boom',
        outcome: 'failed',
        reason: expect.stringContaining('UPSTREAM_UNAVAILABLE'),
      }),
      expect.objectContaining({ taskId: 'gt_ok', outcome: 'pr_opened' }),
    ]);
    // The failed task stays drafting (retryable next sweep), not wedged.
    expect((await tasks.get('gt_boom'))?.status).toBe('drafting');
    expect((await tasks.get('gt_ok'))?.status).toBe('pr_opened');
  });

  it('skips a write task with no SERP volume instead of burning the one rework', async () => {
    await seedSnapshot([{ page: HOME_PAGE, impressions: 5000, position: 1 }]);
    await createTask('gt_write_novol', 'write', {
      query: 'an obscure long tail query',
      angle: 'daily write candidate',
    });
    dropDraft('gt_write_novol', writeDraftFile);

    const result = await runProductionSweep(depsFor({ serp: new FakeSerp() }));

    expect(result.items[0]).toMatchObject({ taskId: 'gt_write_novol', outcome: 'skipped' });
    expect(result.items[0]?.reason).toContain('no volume for');
    // The task must still be awaiting a draft, not consuming its rework.
    const task = await tasks.get('gt_write_novol');
    expect(task?.status).toBe('drafting');
    expect(task?.qaRevisionCount).toBe(0);
  });

  it('skips a fix task whose page has no persisted snapshot yet', async () => {
    await createTask('gt_fix_nosnap', 'fix', fixContext());
    dropDraft('gt_fix_nosnap', fixDraftFile);

    const result = await runProductionSweep(depsFor());

    expect(result.items[0]).toMatchObject({ taskId: 'gt_fix_nosnap', outcome: 'skipped' });
    expect(result.items[0]?.reason).toContain('no GSC snapshot row');
    expect((await tasks.get('gt_fix_nosnap'))?.status).toBe('drafting');
  });

  it('leaves a task in drafting while its draft file is missing', async () => {
    await seedSnapshot([{ page: FIX_PAGE, impressions: 80, position: 20 }]);
    await createTask('gt_fix_nodraft', 'fix', fixContext());

    const result = await runProductionSweep(depsFor());

    expect(result.items[0]).toMatchObject({ taskId: 'gt_fix_nodraft', outcome: 'skipped' });
    expect(result.items[0]?.reason).toContain('no draft file');
    expect((await tasks.get('gt_fix_nodraft'))?.status).toBe('drafting');
  });

  it('skips a task created before migration 007 rather than guessing its query', async () => {
    await seedSnapshot([{ page: FIX_PAGE, impressions: 80, position: 20 }]);
    await createTask('gt_legacy', 'fix', undefined);

    const result = await runProductionSweep(depsFor());

    expect(result.items[0]).toMatchObject({ taskId: 'gt_legacy', outcome: 'skipped' });
    expect(result.items[0]?.reason).toContain('no persisted candidate context');
  });

  it('gives a re-drafted task its single qa_revision rework', async () => {
    await seedSnapshot([{ page: FIX_PAGE, impressions: 80, position: 20 }]);
    await createTask('gt_rework', 'fix', fixContext(), 'qa_revision');
    await tasks.patch('gt_rework', { qaRevisionCount: 1 }, NOW);
    dropDraft('gt_rework', fixDraftFile);

    const result = await runProductionSweep(depsFor());

    expect(result.items[0]).toMatchObject({ taskId: 'gt_rework', outcome: 'pr_opened' });
    expect((await tasks.get('gt_rework'))?.status).toBe('pr_opened');
  });

  it('persists a loom content id from an unavailable draft so the next run polls', async () => {
    await seedSnapshot([{ page: FIX_PAGE, impressions: 80, position: 20 }]);
    await createTask('gt_loom', 'fix', fixContext());

    const result = await runProductionSweep(
      depsFor({
        drafts: new UnavailableDrafts({
          status: 'unavailable',
          reason: 'loom content ct_9 still generating',
          loomContentId: 'ct_9',
        }),
      }),
    );

    expect(result.items[0]).toMatchObject({ taskId: 'gt_loom', outcome: 'skipped' });
    const task = await tasks.get('gt_loom');
    expect(task?.loomContentId).toBe('ct_9');
    expect(task?.status).toBe('drafting');
  });

  it('ignores tasks belonging to another site and reports an empty sweep', async () => {
    await createTask('gt_other', 'fix', fixContext(), 'drafting', 'zeus-landing.pages.dev');

    const result = await runProductionSweep(depsFor());

    expect(result.items).toEqual([]);
  });

  it('isolates a publish failure per task and the next sweep retries it to pr_opened', async () => {
    await seedSnapshot([{ page: FIX_PAGE, impressions: 80, position: 20 }]);
    await createTask('gt_fix_retry', 'fix', fixContext());
    dropDraft('gt_fix_retry', fixDraftFile);

    class FailOncePublisher extends FakeSitePublisher {
      private failuresLeft = 1;
      override async openChange(input: Parameters<FakeSitePublisher['openChange']>[0]) {
        if (this.failuresLeft > 0) {
          this.failuresLeft -= 1;
          throw new Error('github 503: Service Unavailable');
        }
        return super.openChange(input);
      }
    }
    const failOnce = new FailOncePublisher();

    // First sweep: the external publish fails. The task must stay retryable in
    // drafting (never wedged), the reason is reported, and the sweep survives.
    const first = await runProductionSweep(depsFor({ publisher: failOnce }));
    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.outcome).toBe('failed');
    expect(first.items[0]?.reason).toMatch(/github 503/);
    expect((await tasks.get('gt_fix_retry'))?.status).toBe('drafting');

    // Restart (= the next scheduled sweep): the batch replays end-to-end and
    // the idempotent publisher returns the same change — no duplicate PR.
    const second = await runProductionSweep(depsFor({ publisher: failOnce }));
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.outcome).toBe('pr_opened');
    expect((await tasks.get('gt_fix_retry'))?.status).toBe('pr_opened');
    expect(failOnce.openedChanges()).toHaveLength(1);
  });
});
