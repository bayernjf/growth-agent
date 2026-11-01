import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { migrateUp } from '../../src/storage/migrate.js';
import { SqliteDriver } from '../../src/storage/sqlite/sqlite-driver.js';
import { GrowthTaskRepository } from '../../src/task/repository.js';
import { GscSnapshotRepository } from '../../src/connector/gsc/snapshot-repository.js';
import { SentimentSnapshotRepository } from '../../src/connector/sentiment/snapshot-repository.js';
import { OfflineSentimentProvider } from '../../src/connector/sentiment/offline.js';
import { ApiCallRepository } from '../../src/cost/api-call-repository.js';
import { Pricing } from '../../src/cost/pricing.js';
import { CostRecorder } from '../../src/cost/recorder.js';
import { OfflineZeusClient } from '../../src/connector/zeus/offline.js';
import { DailyScriptRunner } from '../../src/scheduler/daily.js';
import type { GscReadonlyProvider, GscRow } from '../../src/connector/gsc/types.js';
import type {
  SerpKeywordProvider,
  KeywordIdea,
  RankTrackItem,
  SerpResult,
} from '../../src/connector/serp/types.js';

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
    if (startDate === '2026-09-28') return [gscRow('/drop', 12, 500), gscRow('/stable', 5, 1000)];
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
        ]
      : [],
  rankTrack: async (): Promise<RankTrackItem[]> => [
    { query: 'how to bake bread', position: null, url: null },
  ],
};

let db: SqliteDriver;

beforeAll(async () => {
  db = new SqliteDriver(':memory:');
  await migrateUp(db);
});

afterAll(async () => {
  await db.close();
});

describe('DailyScriptRunner sentiment section (W6 / OP-40/41)', () => {
  it('persists the daily sentiment snapshot and surfaces negative alerts', async () => {
    const tasks = new GrowthTaskRepository(db);
    const snapshots = new GscSnapshotRepository(db);
    const sentimentSnapshots = new SentimentSnapshotRepository(db);
    const apiCalls = new ApiCallRepository(db);
    const recorder = new CostRecorder(apiCalls, new Pricing(), () => DAY.toISOString());
    const runner = new DailyScriptRunner({
      siteId: SITE,
      domain: 'example.com',
      gsc: stubGsc,
      snapshots,
      sentiment: new OfflineSentimentProvider(),
      sentimentSnapshots,
      serp: stubSerp,
      zeus: new OfflineZeusClient(),
      tasks,
      recorder,
      watchQueries: ['how to bake bread'],
      keywordSeeds: ['bread'],
      now: () => DAY,
    });

    const result = await runner.run(DAY);
    expect(result.ran).toBe(true);
    // Negative mentions surfaced as alerts (OP-41).
    expect(result.sentimentAlerts).toBeDefined();
    expect(result.sentimentAlerts!.length).toBeGreaterThan(0);

    // Daily snapshot persisted (OP-40), including a negative row.
    const rows = await sentimentSnapshots.list('2026-10-26', '2026-10-26');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.sentiment === 'negative')).toBe(true);
  });
});
