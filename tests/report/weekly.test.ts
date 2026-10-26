import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { migrateUp } from '../../src/storage/migrate.js';
import { SqliteDriver } from '../../src/storage/sqlite/sqlite-driver.js';
import { GrowthTaskRepository } from '../../src/task/repository.js';
import { ApiCallRepository } from '../../src/cost/api-call-repository.js';
import { GscSnapshotRepository } from '../../src/connector/gsc/snapshot-repository.js';
import {
  ChannelFailureRepository,
  WebhookDeliveryRepository,
} from '../../src/connector/zeus/webhook-repository.js';
import { GithubWebhookRepository } from '../../src/publisher/github/webhook-repository.js';
import { buildWeeklyReport, renderWeeklyMarkdown, writeWeeklyReport, weekStartDate } from '../../src/report/weekly.js';
import { isoDate } from '../../src/scheduler/dates.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

// 2026-10-26 is a Monday.
const MONDAY = new Date('2026-10-26T07:00:00.000Z');
const SITE = 'https://example.com';

let db: SqliteDriver;
let deps: {
  tasks: GrowthTaskRepository;
  apiCalls: ApiCallRepository;
  snapshots: GscSnapshotRepository;
  zeusDeliveries: WebhookDeliveryRepository;
  githubDeliveries: GithubWebhookRepository;
  channelFailures: ChannelFailureRepository;
  reportDir: string;
  siteId: string;
};

beforeAll(async () => {
  process.env.GA_REPO_ROOT = repoRoot;
  db = new SqliteDriver(':memory:');
  await migrateUp(db);
  const reportDir = join(tmpdir(), `ga-weekly-${randomUUID()}`);
  deps = {
    tasks: new GrowthTaskRepository(db),
    apiCalls: new ApiCallRepository(db),
    snapshots: new GscSnapshotRepository(db),
    zeusDeliveries: new WebhookDeliveryRepository(db),
    githubDeliveries: new GithubWebhookRepository(db),
    channelFailures: new ChannelFailureRepository(db),
    reportDir,
    siteId: SITE,
  };

  // One merged PR (done), one rejected/expired task, one still in pipeline.
  await deps.tasks.create({ id: 'gt_1', siteId: SITE, type: 'write', status: 'done' }, '2026-10-27T09:00:00.000Z');
  await deps.tasks.patch(
    'gt_1',
    { prRef: { platform: 'github', repo: 'o/r', number: 1, url: 'https://x/1', branch: 'b' } },
    '2026-10-27T09:00:00.000Z',
  );
  await deps.tasks.create({ id: 'gt_2', siteId: SITE, type: 'write', status: 'rejected' }, '2026-10-28T09:00:00.000Z');
  await deps.tasks.create({ id: 'gt_3', siteId: SITE, type: 'write', status: 'pr_opened' }, '2026-10-29T09:00:00.000Z');
  await deps.tasks.patch(
    'gt_3',
    { prRef: { platform: 'github', repo: 'o/r', number: 2, url: 'https://x/2', branch: 'b2' } },
    '2026-10-29T09:00:00.000Z',
  );

  await deps.apiCalls.record({
    provider: 'serp:dataforseo', method: 'GET', endpoint: 'serp', units: 10,
    costMicros: 120, httpStatus: 200, cached: false, createdAt: '2026-10-27T06:00:00.000Z',
  });
  await deps.apiCalls.record({
    provider: 'gsc', method: 'GET', endpoint: 'searchanalytics', units: 5,
    costMicros: 0, httpStatus: 200, cached: false, createdAt: '2026-10-27T06:01:00.000Z',
  });

  // One human edit push after the bot PR.
  await deps.githubDeliveries.record({
    id: 'gh:1:synchronize', prNumber: 1, eventType: 'pull_request', action: 'synchronize',
    taskId: 'gt_1', signatureValid: true, processingResult: 'accepted',
    createdAt: '2026-10-28T12:00:00.000Z', updatedAt: '2026-10-28T12:00:00.000Z',
  });

  // One zeus rejection with an outcome reason.
  await deps.zeusDeliveries.record({
    deliveryId: 'zd_1', decisionId: 'dec_2', eventType: 'rejected', taskId: 'gt_2',
    signatureValid: true, processingResult: 'accepted',
    eventPayload: { detail: { outcome: 'low_value' } },
    createdAt: '2026-10-28T09:00:00.000Z', updatedAt: '2026-10-28T09:00:00.000Z',
  });

  await deps.channelFailures.upsert({
    channel: 'zeus', reason: 'GRADE_REQUIRES_APPROVAL_TIMEOUT', retryable: true,
    lastError: 'simulated delivery failure', now: '2026-10-28T09:05:00.000Z',
  });

  // Two snapshots per page (start/end of week) showing a 4-position gain.
  await deps.snapshots.upsert([
    { siteUrl: SITE, date: '2026-10-26', dimensionKey: '/a', clicks: 1, impressions: 100, position: 12 },
  ]);
  await deps.snapshots.upsert([
    { siteUrl: SITE, date: '2026-10-30', dimensionKey: '/a', clicks: 4, impressions: 200, position: 8 },
  ]);
});

afterAll(async () => {
  await db.close();
  if (existsSync(deps.reportDir)) rmSync(deps.reportDir, { recursive: true, force: true });
});

describe('weekly report (§5.E)', () => {
  it('anchors the week to Monday UTC', () => {
    expect(isoDate(weekStartDate(MONDAY))).toBe('2026-10-26');
    expect(isoDate(weekStartDate(new Date('2026-10-29T00:00:00.000Z')))).toBe('2026-10-26');
  });

  it('aggregates PRD §8.1 metrics', async () => {
    const report = await buildWeeklyReport(deps, MONDAY);
    expect(report.tasksCreated).toBe(3);
    expect(report.prOpened).toBe(2);
    expect(report.prMerged).toBe(1);
    expect(report.adoptionRate).toBe(0.5);
    expect(report.humanEditCount).toBe(1);
    expect(report.autoMergeViolations).toBe(0);
    expect(report.costMicros).toBe(120);
    expect(report.costByProvider.find(c => c.provider === 'serp:dataforseo')?.calls).toBe(1);
    expect(report.rejectionReasons).toContainEqual({ reason: 'low_value', count: 1 });
    expect(report.channelFailures[0]?.channel).toBe('zeus');
    expect(report.improvedPages).toBe(1);
    expect(report.averagePositionDelta).toBe(-4);
  });

  it('renders the required markdown sections', () => {
    const md = renderWeeklyMarkdown({
      weekStart: '2026-10-26', weekEnd: '2026-11-01', tasksCreated: 1, prOpened: 1, prMerged: 1,
      adoptionRate: 1, humanEditCount: 0, autoMergeViolations: 0, averagePositionDelta: -2,
      improvedPages: 1, declinedPages: 0, costMicros: 10,
      costByProvider: [{ provider: 'serp', calls: 1, costMicros: 10 }],
      rejectionReasons: [], channelFailures: [],
    });
    expect(md).toContain('## Throughput');
    expect(md).toContain('## Ranking movement');
    expect(md).toContain('## API cost');
    expect(md).toContain('## Zeus human-review outcomes');
    expect(md).toContain('## Channel health');
  });

  it('writes versioned files without overwriting', async () => {
    const report = await buildWeeklyReport(deps, MONDAY);
    const v1 = writeWeeklyReport(deps.reportDir, report);
    const v2 = writeWeeklyReport(deps.reportDir, report);
    expect(v1.endsWith('weekly-2026-10-26-v1.md')).toBe(true);
    expect(v2.endsWith('weekly-2026-10-26-v2.md')).toBe(true);
    expect(readFileSync(v1, 'utf8')).toContain('Growth-agent weekly report');
  });
});
