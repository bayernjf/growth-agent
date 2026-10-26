import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SqliteDriver } from '../../src/storage/sqlite/sqlite-driver.js';
import { migrateUp } from '../../src/storage/migrate.js';
import { GrowthTaskRepository } from '../../src/task/repository.js';
import { ApiCallRepository } from '../../src/cost/api-call-repository.js';
import {
  ChannelFailureRepository,
  WebhookDeliveryRepository,
} from '../../src/connector/zeus/webhook-repository.js';
import { GithubWebhookRepository } from '../../src/publisher/github/webhook-repository.js';
import {
  buildDogfoodPacket,
  renderDogfoodPacket,
  writeDogfoodPacket,
} from '../../src/report/dogfood-packet.js';
import type { PrRef } from '../../src/task/types.js';

const end = new Date('2026-09-30T08:00:00.000Z');
const iso = (offsetDays: number, hour = 6) =>
  new Date(end.getTime() + offsetDays * 86400_000 - 8 * 3600_000 + hour * 3600_000).toISOString();

let db: SqliteDriver;
let tasks: GrowthTaskRepository;
let apiCalls: ApiCallRepository;
let zeusDeliveries: WebhookDeliveryRepository;
let githubDeliveries: GithubWebhookRepository;
let channelFailures: ChannelFailureRepository;
let reportDir: string;

const prRef = (number: number): PrRef => ({
  platform: 'github',
  repo: 'bayernjf/bayjf',
  number,
  url: `https://github.com/bayernjf/bayjf/pull/${number}`,
  branch: `growth-agent/gt-${number}`,
});

beforeAll(async () => {
  reportDir = mkdtempSync(join(tmpdir(), 'dogfood-packet-'));
  db = new SqliteDriver(':memory:');
  await migrateUp(db);
  tasks = new GrowthTaskRepository(db);
  apiCalls = new ApiCallRepository(db);
  zeusDeliveries = new WebhookDeliveryRepository(db);
  githubDeliveries = new GithubWebhookRepository(db);
  channelFailures = new ChannelFailureRepository(db);

  // Task 1: write, opened and merged -> done/verified (new page gain).
  await tasks.create({ id: 'gt_1', siteId: 's', type: 'write', status: 'signaled' }, iso(-10));
  await tasks.patch('gt_1', { zeusDecisionId: 'dec_1', prRef: prRef(1) }, iso(-10));
  await tasks.setStatus('gt_1', 'done', iso(-9));
  await tasks.patch('gt_1', { verifyResult: { positionDelta: 0, impressionsDelta: 12, clicksDelta: 1, outcome: 'verified' } }, iso(-9));

  // Task 2: fix, opened and merged -> done/verified (position gain).
  await tasks.create({ id: 'gt_2', siteId: 's', type: 'fix', status: 'signaled' }, iso(-10));
  await tasks.patch('gt_2', { zeusDecisionId: 'dec_2', prRef: prRef(2) }, iso(-10));
  await tasks.setStatus('gt_2', 'done', iso(-9));
  await tasks.patch('gt_2', { verifyResult: { positionDelta: -6, impressionsDelta: 0, clicksDelta: 0, outcome: 'verified' } }, iso(-9));

  // Task 3: opened but closed without merge -> cancelled.
  await tasks.create({ id: 'gt_3', siteId: 's', type: 'write', status: 'signaled' }, iso(-8));
  await tasks.patch('gt_3', { zeusDecisionId: 'dec_3', prRef: prRef(3) }, iso(-8));
  await tasks.setStatus('gt_3', 'cancelled', iso(-7));

  // D2: all three decisions approved within 24h of task creation.
  for (const [id, decisionId] of [['gt_1', 'dec_1'], ['gt_2', 'dec_2'], ['gt_3', 'dec_3']] as const) {
    const created = await tasks.get(id);
    if (!created) throw new Error(`missing ${id}`);
    await zeusDeliveries.record({
      deliveryId: `dlv_${decisionId}`,
      decisionId,
      eventType: 'approved',
      taskId: id,
      signatureValid: true,
      processingResult: 'accepted',
      createdAt: created.createdAt,
      updatedAt: new Date(Date.parse(created.createdAt) + 3600_000).toISOString(),
    });
  }

  // Human edit pushes: PRs 1 and 3 got 2 pushes each, PR 2 got 4 -> median 2.
  for (const number of [1, 2, 3]) {
    for (let i = 0; i < (number === 2 ? 4 : 2); i += 1) {
      await githubDeliveries.record({
        id: `gh_${number}_${i}`,
        prNumber: number,
        eventType: 'pull_request',
        action: 'synchronize',
        taskId: `gt_${number}`,
        signatureValid: true,
        processingResult: 'accepted',
        createdAt: iso(-9),
        updatedAt: iso(-9),
      });
    }
  }

  // Cost ledger rows across the window.
  for (let d = -10; d <= -1; d += 1) {
    await apiCalls.record({
      provider: 'gsc', method: 'GET', endpoint: 'searchanalytics',
      units: 1, costMicros: 50, httpStatus: 200,
      createdAt: iso(d),
    });
  }
});

afterAll(() => {
  rmSync(reportDir, { recursive: true, force: true });
});

describe('30-day dogfood packet (T-H3, PRD §8.1)', () => {
  it('maps all seven PRD indicators with measured values', async () => {
    const packet = await buildDogfoodPacket(
      { tasks, apiCalls, zeusDeliveries, githubDeliveries, channelFailures, reportDir },
      end, 30,
    );
    expect(packet.indicators).toHaveLength(7);
    const m = new Map(packet.indicators.map(i => [i.id, i]));

    // 1. attainment days: tasks with PRs span two creation days (-10, -8).
    expect(m.get(1)?.value).toContain('2/30 days');
    expect(m.get(1)?.met).toBe(false);
    // 2. adoption: 2 merged (done) / 3 opened.
    expect(m.get(2)?.value).toContain('2/3');
    expect(m.get(2)?.met).toBe(true);
    // 3. edit push median = 2.
    expect(m.get(3)?.value).toBe('2');
    expect(m.get(3)?.met).toBe(true);
    // 4. all decisions within 24h.
    expect(m.get(4)?.value).toContain('3/3');
    expect(m.get(4)?.met).toBe(true);
    // 5. structural zeros.
    expect(m.get(5)?.value).toBe('0 / 0');
    expect(m.get(5)?.met).toBe(true);
    // 6. two verified gains.
    expect(m.get(6)?.value).toBe('2');
    expect(m.get(6)?.met).toBe(true);
    // 7. cost rows exist.
    expect(m.get(7)?.value).toContain('total 500 micros');
    expect(m.get(7)?.met).toBe(true);
  });

  it('renders a markdown table and writes a versioned packet file', async () => {
    const packet = await buildDogfoodPacket(
      { tasks, apiCalls, zeusDeliveries, githubDeliveries, channelFailures, reportDir },
      end, 30,
    );
    const md = renderDogfoodPacket(packet);
    expect(md).toContain('Dogfood 30-day data packet');
    expect(md).toMatch(/\|\s*4\s*\|.*\|\s*3\/3/);
    const path = writeDogfoodPacket({ reportDir }, packet);
    expect(path).toContain('dogfood-packet-');
    expect(path.endsWith('.md')).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  it('reports no D2 failures for an empty window (vacuously compliant)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dogfood-empty-'));
    const d = new SqliteDriver(':memory:');
    await migrateUp(d);
    const packet = await buildDogfoodPacket(
      {
        tasks: new GrowthTaskRepository(d),
        apiCalls: new ApiCallRepository(d),
        zeusDeliveries: new WebhookDeliveryRepository(d),
        githubDeliveries: new GithubWebhookRepository(d),
        channelFailures: new ChannelFailureRepository(d),
        reportDir: tmp,
      },
      end, 30,
    );
    expect(packet.indicators[3]?.value).toContain('0/0');
    expect(packet.indicators[4]?.met).toBe(true);
    rmSync(tmp, { recursive: true, force: true });
  });
});
