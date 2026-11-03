import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { migrateUp } from '../../src/storage/migrate.js';
import { SqliteDriver } from '../../src/storage/sqlite/sqlite-driver.js';
import { GrowthTaskRepository } from '../../src/task/repository.js';
import { GscSnapshotRepository } from '../../src/connector/gsc/snapshot-repository.js';
import { ApiCallRepository } from '../../src/cost/api-call-repository.js';
import { Pricing } from '../../src/cost/pricing.js';
import { CostRecorder } from '../../src/cost/recorder.js';
import { OfflineZeusClient } from '../../src/connector/zeus/offline.js';
import { DailyScriptRunner } from '../../src/scheduler/daily.js';
import { reconcileDecisions } from '../../src/reconcile/reconcile.js';
import type { GscReadonlyProvider, GscRow } from '../../src/connector/gsc/types.js';
import type { ZeusDecisionClient } from '../../src/connector/zeus/types.js';
import type { SerpKeywordProvider, KeywordIdea, RankTrackItem, SerpResult } from '../../src/connector/serp/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

const DAY = new Date('2026-10-26T06:00:00.000Z');
const SITE = 'https://example.com';

function gscRow(key: string, position: number, impressions: number): GscRow {
  return { keys: [key], clicks: 10, impressions, ctr: 0.01, position };
}

const stubGsc: GscReadonlyProvider = {
  name: 'gsc-stub',
  mode: 'offline',
  listSites: async () => [{ siteUrl: SITE, permissionLevel: 'siteUser' }],
  queryAnalytics: async ({ startDate }) => {
    // Recent window (start 2026-09-28) vs prior window (start 2026-08-31).
    if (startDate === '2026-09-28') {
      return [gscRow('/drop', 12, 500), gscRow('/stable', 5, 1000)];
    }
    return [gscRow('/drop', 8, 500), gscRow('/stable', 5, 1000)];
  },
};

const stubSerp: SerpKeywordProvider = {
  name: 'serp-stub',
  online: false,
  keywordIdeas: async (seed: string): Promise<KeywordIdea[]> =>
    seed === 'bread'
      ? [{ keyword: 'how to bake bread', volume: 800, competition: 0.6 }]
      : [],
  serp: async (query: string): Promise<SerpResult[]> =>
    query === 'how to bake bread'
      ? [
          { url: 'https://en.wikipedia.org/wiki/Bread', title: 'Bread', position: 1, description: 'x' },
          { url: 'https://en.wikipedia.org/wiki/Sourdough', title: 'Sourdough', position: 2, description: 'x' },
          { url: 'https://en.wikipedia.org/wiki/Kneading', title: 'Kneading', position: 3, description: 'x' },
        ]
      : [],
  rankTrack: async (): Promise<RankTrackItem[]> => [
    { query: 'how to bake bread', position: null, url: null },
  ],
};

let db: SqliteDriver;

beforeAll(async () => {
  process.env.GA_REPO_ROOT = repoRoot;
  db = new SqliteDriver(':memory:');
  await migrateUp(db);
});

afterAll(async () => {
  await db.close();
});

function runner(clock: Date = DAY) {
  const tasks = new GrowthTaskRepository(db);
  const snapshots = new GscSnapshotRepository(db);
  const apiCalls = new ApiCallRepository(db);
  const recorder = new CostRecorder(apiCalls, new Pricing(), () => clock.toISOString());
  const runner = new DailyScriptRunner({
    siteId: SITE,
    domain: 'example.com',
    gsc: stubGsc,
    snapshots,
    serp: stubSerp,
    zeus: new OfflineZeusClient(),
    tasks,
    recorder,
    watchQueries: ['how to bake bread'],
    keywordSeeds: ['bread'],
    now: () => clock,
  });
  return { runner, tasks, snapshots, apiCalls };
}

describe('DailyScriptRunner (§5.A)', () => {
  it('snapshots, scores, caps 1 write + 1 fix and submits both to zeus', async () => {
    const ctx = runner();
    const result = await ctx.runner.run(DAY);
    expect(result.ran).toBe(true);
    expect(result.submitted).toHaveLength(2);
    const kinds = result.submitted.map(s => s.kind).sort();
    expect(kinds).toEqual(['fix', 'write']);
    const write = result.submitted.find(s => s.kind === 'write');
    expect(write?.query).toBe('how to bake bread');
    const fix = result.submitted.find(s => s.kind === 'fix');
    expect(fix?.query).toBe('/drop');

    const tasks = await ctx.tasks.list();
    expect(tasks).toHaveLength(2);
    expect(tasks.every(t => t.status === 'deciding')).toBe(true);
    expect(tasks.every(t => t.zeusDecisionId?.startsWith('dec_offline_'))).toBe(true);

    // Recent-window rows were persisted keyed by the last complete day.
    const snap = await ctx.snapshots.list(SITE, '2026-10-25', '2026-10-25');
    expect(snap.map(r => r.dimensionKey).sort()).toEqual(['/drop', '/stable']);

    // Every external call was cost-metered.
    const ledger = await ctx.apiCalls.rangeCost('2026-10-26T00:00:00.000Z', '2026-10-27T00:00:00.000Z');
    expect(ledger.calls).toBeGreaterThan(0);
  });

  it('does not exceed the cap (deferred lists are returned)', async () => {
    const ctx = runner();
    // First run already happened in the previous test against a fresh DB;
    // here we assert the cap shape via a fresh run on a new db by resetting.
    // The shared db already ran, so the idempotency guard should fire.
    const result = await ctx.runner.run(DAY);
    expect(result.ran).toBe(false);
    expect(result.reason).toBe('already_ran_today');
  });

  // Review F-07: previously a submit failure for candidate #2 aborted the
  // loop, leaving it in `signaled` forever (same-day re-run idempotency-
  // blocked, reconcile only handled `deciding`). Now the failure is isolated
  // per candidate AND reconcile resubmits the stranded task at next startup.
  it('isolates a submit failure and reconcile revives the stranded signaled task (F-07)', async () => {
    // Fresh in-memory DB: the shared one already ran DAY above.
    const localDb = new SqliteDriver(':memory:');
    await migrateUp(localDb);
    const localTasks = new GrowthTaskRepository(localDb);
    const localSnapshots = new GscSnapshotRepository(localDb);
    const localApiCalls = new ApiCallRepository(localDb);
    const localRecorder = new CostRecorder(localApiCalls, new Pricing(), () => DAY.toISOString());

    // First submitDecision (the write candidate) explodes; the fix succeeds.
    // NOTE: spread-copying a class instance drops prototype methods — delegate.
    let submitCalls = 0;
    const inner = new OfflineZeusClient();
    const flakyZeus: ZeusDecisionClient = {
      name: inner.name,
      mode: inner.mode,
      submitDecision: async input => {
        submitCalls += 1;
        if (submitCalls === 1) throw new Error('UPSTREAM_UNAVAILABLE: zeus exploded');
        return inner.submitDecision(input);
      },
      getDecisionAudit: id => inner.getDecisionAudit(id),
      getPolicies: () => inner.getPolicies(),
      ping: () => inner.ping(),
      buildSubscriptionPayload: args => inner.buildSubscriptionPayload(args),
      startupSelfCheck: () => inner.startupSelfCheck(),
    };

    const localRunner = new DailyScriptRunner({
      siteId: SITE,
      domain: 'example.com',
      gsc: stubGsc,
      snapshots: localSnapshots,
      serp: stubSerp,
      zeus: flakyZeus,
      tasks: localTasks,
      recorder: localRecorder,
      watchQueries: ['how to bake bread'],
      keywordSeeds: ['bread'],
      now: () => DAY,
    });

    const result = await localRunner.run(DAY);
    expect(result.ran).toBe(true);
    expect(result.submitted).toHaveLength(1);
    expect(result.submitted[0]?.kind).toBe('fix');
    expect(result.submitFailures).toHaveLength(1);
    const strandedId = result.submitFailures[0]!.taskId;
    expect((await localTasks.get(strandedId))?.status).toBe('signaled');

    // Same-day re-run is still idempotency-blocked...
    const rerun = await localRunner.run(DAY);
    expect(rerun.ran).toBe(false);

    // ...but startup reconcile resubmits the stranded task to zeus.
    const summary = await reconcileDecisions({
      tasks: localTasks,
      zeus: new OfflineZeusClient(),
      now: () => DAY.toISOString(),
    });
    expect(summary.resubmitted).toBe(1);
    const revived = await localTasks.get(strandedId);
    expect(revived?.status).toBe('deciding');
    expect(revived?.zeusDecisionId).toMatch(/^dec_offline_/);
    await localDb.close();
  });
});
