// Contract tests for the inbound GitHub pull_request webhook (T-D3). The fake
// GitHub side signs with the same HMAC-SHA256 algorithm: X-Hub-Signature-256
// `sha256=<hex>` over the exact JSON body, x-github-event: pull_request.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateUp } from '../../src/storage/migrate.js';
import { SqliteDriver } from '../../src/storage/sqlite/sqlite-driver.js';
import { GrowthTaskRepository } from '../../src/task/repository.js';
import { createGithubWebhookApp } from '../../src/api/webhooks/github.js';
import {
  signGithubBody,
  verifyGithubSignature,
  type GithubPullRequestEvent,
} from '../../src/publisher/github/inbound.js';
import {
  githubDeliveryId,
  legacyGithubDeliveryId,
  GithubWebhookRepository,
} from '../../src/publisher/github/webhook-repository.js';
import { ChannelFailureRepository } from '../../src/connector/zeus/webhook-repository.js';
import type { Hono } from 'hono';
import type { GrowthTaskStatus, PrRef } from '../../src/task/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

const SECRET = 'github-test-secret-0123456789abcdef';
const NOW = '2026-10-26T10:00:00.000Z';

function prRef(number: number): PrRef {
  return {
    platform: 'github',
    repo: 'o/r',
    number,
    url: `https://github.com/o/r/pull/${number}`,
    branch: `growth-agent/gt_${number}`,
  };
}

function makeEvent(overrides: Partial<GithubPullRequestEvent>): GithubPullRequestEvent {
  return {
    action: 'opened',
    pull_request: {
      number: 12,
      html_url: 'https://github.com/o/r/pull/12',
      state: 'open',
      merged: false,
      head: { ref: 'growth-agent/gt_12' },
      base: { ref: 'main' },
    },
    repository: { full_name: 'o/r' },
    ...overrides,
  };
}

function closedEvent(merged: boolean): GithubPullRequestEvent {
  return makeEvent({
    action: 'closed',
    pull_request: {
      number: 12,
      html_url: 'https://github.com/o/r/pull/12',
      state: 'closed',
      merged,
      head: { ref: 'growth-agent/gt_12' },
      base: { ref: 'main' },
    },
  });
}

async function pushRaw(
  app: Hono,
  opts: {
    body: string;
    event?: string;
    signature?: string;
    delivery?: string;
  },
) {
  return app.request('/', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': opts.event ?? 'pull_request',
      'x-github-delivery': opts.delivery ?? 'delivery-guid-1',
      ...(opts.signature !== undefined ? { 'x-hub-signature-256': opts.signature } : {}),
    },
    body: opts.body,
  });
}

let db: SqliteDriver;
let tasks: GrowthTaskRepository;
let deliveries: GithubWebhookRepository;
let failures: ChannelFailureRepository;
let app: Hono;

beforeAll(async () => {
  process.env.GA_REPO_ROOT = repoRoot;
  db = new SqliteDriver(':memory:');
  await migrateUp(db);
  tasks = new GrowthTaskRepository(db);
  deliveries = new GithubWebhookRepository(db);
  failures = new ChannelFailureRepository(db);
  app = createGithubWebhookApp({
    secret: SECRET,
    driver: db,
    deliveries,
    failures,
    tasks,
    now: () => NOW,
  });
});

afterAll(async () => {
  await db.close();
});

async function seedTask(id: string, status: GrowthTaskStatus, number = 12): Promise<void> {
  await tasks.create({ id, siteId: 'bayjf.com', type: 'write', status }, NOW);
  await tasks.patch(id, { prRef: prRef(number) }, NOW);
}

describe('inbound github pull_request webhook (T-D3)', () => {
  it('verifies signatures in constant time (length and digest cases)', () => {
    const body = '{"a":1}';
    const good = signGithubBody(SECRET, body);
    expect(verifyGithubSignature(SECRET, body, good)).toBe(true);
    expect(verifyGithubSignature(SECRET, body, null)).toBe(false);
    expect(verifyGithubSignature(SECRET, body, 'sha256=deadbeef')).toBe(false);
    // Equal-length, wrong digest must never pass.
    const wrong = `sha256=${'0'.repeat(good.length - 'sha256='.length)}`;
    expect(verifyGithubSignature(SECRET, body, wrong)).toBe(false);
    expect(verifyGithubSignature('', body, good)).toBe(false);
  });

  it('drives opened -> awaiting_merge', async () => {
    await seedTask('gt_opened', 'pr_opened');
    const body = JSON.stringify(makeEvent({}));
    const res = await pushRaw(app, { body, signature: signGithubBody(SECRET, body) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string };
    expect(json.status).toBe('awaiting_merge');
    expect((await tasks.get('gt_opened'))?.status).toBe('awaiting_merge');
  });

  it('drives merged closed through two edges to verifying and records the PR ref', async () => {
    await seedTask('gt_merge', 'awaiting_merge', 13);
    const event = closedEvent(true);
    event.pull_request.number = 13;
    // Simulate a different branch/url arriving via the payload to confirm
    // the prRef is written back from the event.
    event.pull_request.html_url = 'https://github.com/o/r/pull/13/files';
    event.pull_request.head.ref = 'growth-agent/gt_merge';
    const body = JSON.stringify(event);
    const res = await pushRaw(app, { body, signature: signGithubBody(SECRET, body), delivery: 'guid-13-closed' });
    expect(res.status).toBe(200);
    const stored = await tasks.get('gt_merge');
    expect(stored?.status).toBe('verifying');
    expect(stored?.prRef?.branch).toBe('growth-agent/gt_merge');
    expect(stored?.prRef?.url).toBe('https://github.com/o/r/pull/13/files');
  });

  it('drives unmerged closed -> cancelled', async () => {
    await seedTask('gt_close', 'awaiting_merge', 14);
    const event = closedEvent(false);
    event.pull_request.number = 14;
    const body = JSON.stringify(event);
    const res = await pushRaw(app, { body, signature: signGithubBody(SECRET, body), delivery: 'guid-14-closed' });
    expect(res.status).toBe(200);
    expect((await tasks.get('gt_close'))?.status).toBe('cancelled');
  });

  it('rejects a missing or wrong signature with 401 and never transitions', async () => {
    await seedTask('gt_badsig', 'pr_opened');
    const body = JSON.stringify(makeEvent({ pull_request: { ...makeEvent({}).pull_request, number: 99 } }));
    const missing = await pushRaw(app, { body });
    expect(missing.status).toBe(401);
    const tampered = await pushRaw(app, {
      body,
      signature: signGithubBody('a-different-secret-00000000000000', body),
    });
    expect(tampered.status).toBe(401);
    expect((await tasks.get('gt_badsig'))?.status).toBe('pr_opened');
    const failure = await failures.get('cf:github_webhook:INVALID_SIGNATURE');
    expect(failure?.attempts).toBeGreaterThanOrEqual(2);
    expect(failure?.lastError).not.toContain(SECRET);
  });

  it('deduplicates redelivery by (number, action) without a second transition', async () => {
    await seedTask('gt_dup', 'pr_opened', 77);
    const body = JSON.stringify(makeEvent({ pull_request: { ...makeEvent({}).pull_request, number: 77 } }));
    const first = await pushRaw(app, {
      body,
      delivery: 'guid-77-opened',
      signature: signGithubBody(SECRET, body),
    });
    expect(first.status).toBe(200);
    const second = await pushRaw(app, {
      body,
      delivery: 'guid-77-redelivered',
      signature: signGithubBody(SECRET, body),
    });
    expect(second.status).toBe(200);
    const json = (await second.json()) as { duplicate?: boolean };
    expect(json.duplicate).toBe(true);
    const ledger = await deliveries.find(githubDeliveryId('o/r', 77, 'opened'));
    expect(ledger?.processingResult).toBe('accepted');
    expect((await tasks.get('gt_dup'))?.status).toBe('awaiting_merge');
  });

  it('scopes the ledger id by repository: the same PR number in two repos is not a duplicate (F-03)', async () => {
    // Every site repository numbers PRs from 1; pre-fix both deliveries below
    // shared the id gh:900:opened and the second was swallowed as a duplicate.
    const repoA = JSON.stringify(makeEvent({ pull_request: { ...makeEvent({}).pull_request, number: 900 } }));
    const repoBEvent = makeEvent({
      pull_request: { ...makeEvent({}).pull_request, number: 900, html_url: 'https://github.com/o/s/pull/900' },
      repository: { full_name: 'o/s' },
    });
    const repoB = JSON.stringify(repoBEvent);

    const first = await pushRaw(app, { body: repoA, signature: signGithubBody(SECRET, repoA), delivery: 'guid-900-a' });
    const second = await pushRaw(app, { body: repoB, signature: signGithubBody(SECRET, repoB), delivery: 'guid-900-b' });
    expect(first.status).toBe(422); // unknown task, but recorded under repo A
    expect(second.status).toBe(422);
    expect(((await second.json()) as { duplicate?: boolean }).duplicate).toBeUndefined();

    const ledgerA = await deliveries.find(githubDeliveryId('o/r', 900, 'opened'));
    const ledgerB = await deliveries.find(githubDeliveryId('o/s', 900, 'opened'));
    expect(ledgerA?.processingResult).toBe('rejected');
    expect(ledgerB?.processingResult).toBe('rejected');
  });

  it('still dedupes a redelivery whose row predates the repository-scoped id (F-03 compat)', async () => {
    await seedTask('gt_legacy', 'pr_opened', 66);
    // Simulate a ledger row written before the fix (no repository in the id).
    await deliveries.record({
      id: legacyGithubDeliveryId(66, 'opened'),
      prNumber: 66,
      eventType: 'pull_request',
      action: 'opened',
      taskId: 'gt_legacy',
      signatureValid: true,
      processingResult: 'accepted',
      createdAt: NOW,
      updatedAt: NOW,
    });
    const body = JSON.stringify(makeEvent({ pull_request: { ...makeEvent({}).pull_request, number: 66 } }));
    const res = await pushRaw(app, { body, signature: signGithubBody(SECRET, body), delivery: 'guid-66-redelivered' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { duplicate?: boolean }).duplicate).toBe(true);
    // No second transition: the task must remain exactly as the legacy row left it.
    expect((await tasks.get('gt_legacy'))?.status).toBe('pr_opened');
    expect(await deliveries.find(githubDeliveryId('o/r', 66, 'opened'))).toBeUndefined();
  });

  it('422s when the PR number cannot be linked to a local task', async () => {
    const body = JSON.stringify(makeEvent({ pull_request: { ...makeEvent({}).pull_request, number: 404 } }));
    const res = await pushRaw(app, { body, signature: signGithubBody(SECRET, body) });
    expect(res.status).toBe(422);
    const ledger = await deliveries.find(githubDeliveryId('o/r', 404, 'opened'));
    expect(ledger?.processingResult).toBe('rejected');
    expect(ledger?.errorCode).toBe('UNKNOWN_TASK');
    const failure = await failures.get('cf:github_webhook:UNKNOWN_TASK');
    expect(failure).toBeDefined();
  });

  it('409s on state drift (merged event for a task already verifying)', async () => {
    await seedTask('gt_drift', 'verifying', 88);
    const event = closedEvent(true);
    event.pull_request.number = 88;
    event.pull_request.head.ref = 'growth-agent/gt_drift';
    const body = JSON.stringify(event);
    const res = await pushRaw(app, { body, signature: signGithubBody(SECRET, body), delivery: 'guid-88-closed' });
    expect(res.status).toBe(409);
    expect((await tasks.get('gt_drift'))?.status).toBe('verifying');
    const ledger = await deliveries.find(githubDeliveryId('o/r', 88, 'closed-merged'));
    expect(ledger?.processingResult).toBe('rejected');
    expect(ledger?.errorCode).toBe('INVALID_TRANSITION');
  });

  it('ignores non-pull_request events (ping) and audit-only actions (synchronize)', async () => {
    await seedTask('gt_sync', 'awaiting_merge');
    const ping = await pushRaw(app, { body: '{"zen":"yes"}', event: 'ping', signature: signGithubBody(SECRET, '{"zen":"yes"}') });
    expect(ping.status).toBe(200);
    expect((await ping.json()) as { ignored?: boolean }).toEqual({ ok: true, ignored: true, event: 'ping' });

    const syncBody = JSON.stringify(
      makeEvent({
        action: 'synchronize',
        pull_request: {
          ...makeEvent({}).pull_request,
          number: 55,
        },
      }),
    );
    const sync = await pushRaw(app, { body: syncBody, signature: signGithubBody(SECRET, syncBody), delivery: 'guid-55-sync' });
    expect(sync.status).toBe(200);
    const syncJson = (await sync.json()) as { auditOnly?: boolean };
    expect(syncJson.auditOnly).toBe(true);
    expect((await tasks.get('gt_sync'))?.status).toBe('awaiting_merge');

    // A second human push (new head SHA, new delivery GUID) is a distinct
    // ledger row; redelivery of the same GUID is deduped (PRD §8.1 #3).
    const syncBody2 = JSON.stringify(
      makeEvent({
        action: 'synchronize',
        pull_request: {
          ...makeEvent({}).pull_request,
          number: 55,
          head: { ref: 'growth-agent/gt_sync', sha: 'push-2' },
        },
      }),
    );
    const sync2 = await pushRaw(app, {
      body: syncBody2,
      signature: signGithubBody(SECRET, syncBody2),
      delivery: 'guid-55-sync-2',
    });
    expect(sync2.status).toBe(200);
    expect(await deliveries.find(githubDeliveryId('o/r', 55, 'synchronize', 'push-2'))).toBeDefined();
    const dup = await pushRaw(app, {
      body: syncBody2,
      signature: signGithubBody(SECRET, syncBody2),
      delivery: 'guid-55-sync-2',
    });
    expect((await dup.json()).duplicate).toBe(true);
  });

  it('rolls back status, prRef and ledger together and replays after a mid-write failure (F-11)', async () => {
    await seedTask('gt_tx', 'awaiting_merge', 31);
    const event = closedEvent(true);
    event.pull_request.number = 31;
    event.pull_request.html_url = 'https://github.com/o/r/pull/31/files';
    event.pull_request.head.ref = 'growth-agent/gt_tx';
    const body = JSON.stringify(event);
    const signature = signGithubBody(SECRET, body);

    // Fail the ledger write inside the transaction: the status flip and the
    // prRef patch must roll back with it.
    const failingDeliveries = {
      record: async () => {
        throw new Error('ledger write failed');
      },
    } as unknown as GithubWebhookRepository;
    const failingApp = createGithubWebhookApp({
      secret: SECRET,
      driver: db,
      deliveries,
      failures,
      tasks,
      txDeliveries: () => failingDeliveries,
      now: () => NOW,
    });
    const failed = await pushRaw(failingApp, { body, signature, delivery: 'guid-31-closed' });
    expect(failed.status).toBe(500);
    expect(((await failed.json()) as { retryable?: boolean }).retryable).toBe(true);

    const rolledBack = await tasks.get('gt_tx');
    expect(rolledBack?.status).toBe('awaiting_merge');
    expect(rolledBack?.prRef?.url).toBe('https://github.com/o/r/pull/31');
    expect(await deliveries.find(githubDeliveryId('o/r', 31, 'closed-merged'))).toBeUndefined();

    // Redelivery after the transient failure commits once and advances.
    const retried = await pushRaw(app, { body, signature, delivery: 'guid-31-closed' });
    expect(retried.status).toBe(200);
    expect((await tasks.get('gt_tx'))?.status).toBe('verifying');
    expect((await tasks.get('gt_tx'))?.prRef?.url).toBe('https://github.com/o/r/pull/31/files');
    expect((await deliveries.find(githubDeliveryId('o/r', 31, 'closed-merged')))?.processingResult).toBe(
      'accepted',
    );

    // A further redelivery is deduped: no second transition, no extra row.
    const duplicate = await pushRaw(app, { body, signature, delivery: 'guid-31-closed' });
    expect(((await duplicate.json()) as { duplicate?: boolean }).duplicate).toBe(true);
    expect((await tasks.get('gt_tx'))?.status).toBe('verifying');
  });

  it('returns 503 when no secret is configured', async () => {
    const noSecretApp = createGithubWebhookApp({
      secret: '',
      driver: db,
      deliveries,
      failures,
      tasks,
      now: () => NOW,
    });
    const body = JSON.stringify(makeEvent({}));
    const res = await noSecretApp.request('/', {
      method: 'POST',
      headers: { 'x-github-event': 'pull_request', 'x-hub-signature-256': signGithubBody(SECRET, body) },
      body,
    });
    expect(res.status).toBe(503);
  });
});
