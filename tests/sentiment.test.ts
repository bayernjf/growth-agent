import { describe, it, expect } from 'vitest';
import { migrateUp } from '../src/storage/migrate.js';
import { SqliteDriver } from '../src/storage/sqlite/sqlite-driver.js';
import { OfflineSentimentProvider } from '../src/connector/sentiment/offline.js';
import { RejectingSentimentProvider } from '../src/connector/sentiment/rejecting.js';
import { createSentimentProvider } from '../src/connector/sentiment/registry.js';
import { SentimentSnapshotRepository } from '../src/connector/sentiment/snapshot-repository.js';
import { scoreSentimentAlerts } from '../src/scheduler/sentiment.js';
import { renderWeeklyMarkdown, type WeeklyReport } from '../src/report/weekly.js';
import type { AppConfig } from '../src/config.js';

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    host: '127.0.0.1',
    port: 8790,
    dbDriver: 'sqlite',
    sqlitePath: ':memory:',
    zeusMode: 'off',
    gscMode: 'off',
    adsMode: 'off',
    sentimentMode: 'off',
    gscTokenDir: '/tmp/tokens',
    serpMode: 'off',
    loomMode: 'off',
    draftMode: 'inbox',
    draftInboxDir: '/tmp/drafts',
    githubMode: 'off',
    githubBaseBranch: 'main',
    reportDir: '/tmp/reports',
    zeusWebhookMaxSkewSeconds: 300,
    ...overrides,
  };
}

function baseReport(overrides: Partial<WeeklyReport> = {}): WeeklyReport {
  return {
    weekStart: '2026-11-02',
    weekEnd: '2026-11-08',
    tasksCreated: 0,
    prOpened: 0,
    prMerged: 0,
    adoptionRate: 0,
    humanEditCount: 0,
    autoMergeViolations: 0,
    averagePositionDelta: 0,
    improvedPages: 0,
    declinedPages: 0,
    costMicros: 0,
    costByProvider: [],
    rejectionReasons: [],
    channelFailures: [],
    ...overrides,
  };
}

describe('sentiment provider (OP-40)', () => {
  it('offline returns deterministic rows including a negative mention', async () => {
    const p = new OfflineSentimentProvider();
    const rows = await p.querySentiment({ startDate: '2026-11-02', endDate: '2026-11-02' });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.sentiment === 'negative')).toBe(true);
    const again = await p.querySentiment({ startDate: '2026-11-02', endDate: '2026-11-02' });
    expect(again).toEqual(rows);
  });

  it('rejecting provider fails closed with 422 SENTIMENT_CREDENTIAL_MISSING', async () => {
    const p = new RejectingSentimentProvider('no keys');
    await expect(
      p.querySentiment({ startDate: '2026-11-02', endDate: '2026-11-02' }),
    ).rejects.toMatchObject({ code: 'SENTIMENT_CREDENTIAL_MISSING' });
  });

  it('registry selects offline by default and rejecting online', () => {
    expect(createSentimentProvider(config()).mode).toBe('offline');
    expect(createSentimentProvider(config({ sentimentMode: 'online' })).mode).toBe('online');
  });
});

describe('sentiment snapshot repository (OP-40)', () => {
  it('upserts idempotently and lists negatives', async () => {
    const db = new SqliteDriver(':memory:');
    await migrateUp(db);
    const repo = new SentimentSnapshotRepository(db);
    const row = {
      keyword: 'bayjf',
      source: 'reddit',
      date: '2026-11-02',
      title: 'bug report',
      url: 'https://example.com/reddit/bayjf/1',
      sentiment: 'negative' as const,
      metricValue: 1,
    };
    await repo.upsert([row]);
    await repo.upsert([{ ...row, metricValue: 2 }]); // same-day rerun overwrites
    const all = await repo.list('2026-11-02', '2026-11-02');
    expect(all).toHaveLength(1);
    expect(all[0].metricValue).toBe(2);
    const negatives = await repo.listNegative('2026-11-02', '2026-11-02');
    expect(negatives).toHaveLength(1);
  });
});

describe('scoreSentimentAlerts (OP-41)', () => {
  it('raises alerts only for negative mentions', () => {
    const rows = [
      {
        keyword: 'bayjf', source: 'reddit', date: '2026-11-02', title: 'bug',
        url: 'u1', sentiment: 'negative' as const, metricValue: 1,
      },
      {
        keyword: 'bayjf', source: 'github', date: '2026-11-02', title: 'stars',
        url: 'u2', sentiment: 'positive' as const, metricValue: 40,
      },
    ];
    const alerts = scoreSentimentAlerts(rows);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ keyword: 'bayjf', source: 'reddit', title: 'bug' });
  });

  it('returns no alerts without negative mentions', () => {
    const rows = [
      {
        keyword: 'bayjf', source: 'github', date: '2026-11-02', title: 'stars',
        url: 'u', sentiment: 'positive' as const, metricValue: 40,
      },
    ];
    expect(scoreSentimentAlerts(rows)).toHaveLength(0);
  });
});

describe('weekly markdown sentiment section (OP-42)', () => {
  it('renders negative-mention alerts when present', () => {
    const md = renderWeeklyMarkdown(baseReport({
      sentimentAlerts: [
        { keyword: 'bayjf', source: 'reddit', date: '2026-11-02', title: 'bug', url: 'u' },
      ],
    }));
    expect(md).toContain('## Sentiment alerts (negative mentions)');
    expect(md).toContain('[bayjf] bug (reddit, 2026-11-02)');
  });

  it('omits the section entirely when no sentiment repo is wired', () => {
    const md = renderWeeklyMarkdown(baseReport());
    expect(md).not.toContain('Sentiment alerts');
  });
});
