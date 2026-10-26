// Contract tests for the inbound zeus decision webhook (T-A5). The fake zeus
// side signs with the exact algorithm from zeus webhook.ts: HMAC-SHA256 over
// the exact JSON body, `x-zeus-signature: sha256=<hex>`, deterministic
// `x-zeus-delivery-id: <decisionId>:<type>:<at>`.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateUp } from '../../src/storage/migrate.js';
import { SqliteDriver } from '../../src/storage/sqlite/sqlite-driver.js';
import { GrowthTaskRepository } from '../../src/task/repository.js';
import { createZeusWebhookApp } from '../../src/api/webhooks/zeus.js';
import {
  signZeusBody,
  verifyZeusSignature,
  type ZeusDecisionEvent,
} from '../../src/connector/zeus/inbound.js';
import {
  ChannelFailureRepository,
  WebhookDeliveryRepository,
} from '../../src/connector/zeus/webhook-repository.js';
import type { Hono } from 'hono';
import type { GrowthTaskStatus } from '../../src/task/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

const SECRET = 'test-secret-0123456789abcdef';
const NOW = '2026-10-26T09:00:00.000Z';

function makeEvent(overrides: Partial<ZeusDecisionEvent>): ZeusDecisionEvent {
  return {
    type: 'approved',
    decisionId: 'dec_1',
    at: '2026-10-26T08:00:00.000Z',
    domain: 'growth.content',
    intent: 'write: "growth homepage content"',
    grade: 'D2',
    mode: 'approve-sync',
    status: 'decided',
    ruleId: 'd2-org',
    ...overrides,
  };
}

async function pushRaw(
  app: Hono,
  opts: { body: string; signature?: string; deliveryId?: string },
) {
  return app.request('/', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(opts.signature !== undefined ? { 'x-zeus-signature': opts.signature } : {}),
      ...(opts.deliveryId !== undefined ? { 'x-zeus-delivery-id': opts.deliveryId } : {}),
    },
    body: opts.body,
  });
}

let db: SqliteDriver;
let tasks: GrowthTaskRepository;
let deliveries: WebhookDeliveryRepository;
let failures: ChannelFailureRepository;
let app: Hono;

beforeAll(async () => {
  process.env.GA_REPO_ROOT = repoRoot;
  db = new SqliteDriver(':memory:');
  await migrateUp(db);
  tasks = new GrowthTaskRepository(db);
  deliveries = new WebhookDeliveryRepository(db);
  failures = new ChannelFailureRepository(db);
  app = createZeusWebhookApp({
    secret: SECRET,
    deliveries,
    failures,
    tasks,
    now: () => NOW,
  });
});

afterAll(async () => {
  await db.close();
});

async function seedTask(id: string, decisionId: string, status: string) {
  await tasks.create({ id, siteId: 'bayjf.com', type: 'write' }, NOW);
  await tasks.patch(id, { zeusDecisionId: decisionId }, NOW);
  await tasks.setStatus(id, status as GrowthTaskStatus, NOW);
}

async function deliveryCount(): Promise<number> {
  const row = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM zeus_webhook_deliveries');
  return row?.n ?? 0;
}

describe('inbound zeus webhook: happy-path state transitions (§3.2)', () => {
  it('approved drives deciding->drafting and writes the accepted delivery row', async () => {
    await seedTask('gt_app1', 'dec_1', 'deciding');
    const event = makeEvent({ decisionId: 'dec_1', at: '2026-10-26T08:00:00.000Z' });
    const body = JSON.stringify(event);
    const res = await pushRaw(app, {
      body,
      signature: signZeusBody(SECRET, body),
      deliveryId: 'dec_1:approved:2026-10-26T08:00:00.000Z',
    });
    expect(res.status).toBe(200);
    expect(await tasks.get('gt_app1')).toMatchObject({ status: 'drafting' });
    const row = await deliveries.find('dec_1:approved:2026-10-26T08:00:00.000Z');
    expect(row).toMatchObject({
      decisionId: 'dec_1',
      eventType: 'approved',
      taskId: 'gt_app1',
      processingResult: 'accepted',
      signatureValid: true,
    });
  });

  it('rejected drives deciding->rejected and preserves approver/outcome in the audit payload', async () => {
    await seedTask('gt_rej1', 'dec_2', 'deciding');
    const event = makeEvent({
      type: 'rejected',
      decisionId: 'dec_2',
      at: '2026-10-26T08:10:00.000Z',
      status: 'rejected',
      approver: 'alice',
      outcome: 'rejected: off-brief angle',
    });
    const body = JSON.stringify(event);
    const res = await pushRaw(app, {
      body,
      signature: signZeusBody(SECRET, body),
      deliveryId: 'dec_2:rejected:2026-10-26T08:10:00.000Z',
    });
    expect(res.status).toBe(200);
    expect(await tasks.get('gt_rej1')).toMatchObject({ status: 'rejected' });
    const row = await deliveries.find('dec_2:rejected:2026-10-26T08:10:00.000Z');
    expect((row?.eventPayload as { approver?: string })?.approver).toBe('alice');
  });

  it('timed-out drives deciding->expired', async () => {
    await seedTask('gt_to1', 'dec_3', 'deciding');
    const event = makeEvent({
      type: 'timed-out',
      decisionId: 'dec_3',
      at: '2026-10-26T08:20:00.000Z',
      status: 'timed_out',
    });
    const body = JSON.stringify(event);
    const res = await pushRaw(app, {
      body,
      signature: signZeusBody(SECRET, body),
      deliveryId: 'dec_3:timed-out:2026-10-26T08:20:00.000Z',
    });
    expect(res.status).toBe(200);
    expect(await tasks.get('gt_to1')).toMatchObject({ status: 'expired' });
  });

  it('created and late are audit-only: accepted 200, no state transition', async () => {
    await seedTask('gt_cre1', 'dec_4', 'signaled');
    const created = makeEvent({ type: 'created', decisionId: 'dec_4', at: '2026-10-26T08:05:00.000Z', status: 'awaiting_approval' });
    let body = JSON.stringify(created);
    let res = await pushRaw(app, {
      body,
      signature: signZeusBody(SECRET, body),
      deliveryId: 'dec_4:created:2026-10-26T08:05:00.000Z',
    });
    expect(res.status).toBe(200);
    expect(await tasks.get('gt_cre1')).toMatchObject({ status: 'signaled' });

    const late = makeEvent({ type: 'late', decisionId: 'dec_4', at: '2026-10-26T08:30:00.000Z', status: 'awaiting_approval', lateAt: '2026-10-26T08:30:00.000Z' });
    body = JSON.stringify(late);
    res = await pushRaw(app, {
      body,
      signature: signZeusBody(SECRET, body),
      deliveryId: 'dec_4:late:2026-10-26T08:30:00.000Z',
    });
    expect(res.status).toBe(200);
    expect(await tasks.get('gt_cre1')).toMatchObject({ status: 'signaled' });
  });
});

describe('inbound zeus webhook: 401 family, no state changes and no delivery rows', () => {
  it('rejects missing, malformed, wrong-secret, and tampered signatures with 401', async () => {
    await seedTask('gt_badsig', 'dec_bad', 'deciding');
    const event = makeEvent({ decisionId: 'dec_bad', at: '2026-10-26T09:00:00.000Z' });
    const body = JSON.stringify(event);
    const deliveryId = 'dec_bad:approved:2026-10-26T09:00:00.000Z';
    const rowsBefore = await deliveryCount();

    // missing signature header
    let res = await pushRaw(app, { body, deliveryId });
    expect(res.status).toBe(401);
    // malformed header shape
    res = await pushRaw(app, { body, signature: 'md5=whatever', deliveryId });
    expect(res.status).toBe(401);
    // signed with a different secret
    res = await pushRaw(app, {
      body,
      signature: signZeusBody('a-completely-different-secret', body),
      deliveryId,
    });
    expect(res.status).toBe(401);
    // body tampered after signing
    res = await pushRaw(app, {
      body: JSON.stringify({ ...event, grade: 'D1' }),
      signature: signZeusBody(SECRET, body),
      deliveryId,
    });
    expect(res.status).toBe(401);

    expect(await tasks.get('gt_badsig')).toMatchObject({ status: 'deciding' });
    expect(await deliveryCount()).toBe(rowsBefore);
  });

  it('uses the constant-time compare path for equal-length differing digests', () => {
    // Same header length (same hex length), different digest: this is exactly
    // the case timingSafeEqual guards against (no length shortcut returns).
    const body = JSON.stringify(makeEvent({ decisionId: 'dec_ct', at: '2026-10-26T09:01:00.000Z' }));
    expect(verifyZeusSignature(SECRET, body, signZeusBody(SECRET, body))).toBe(true);
    const forged = signZeusBody('another-secret-of-equal-length!!', body);
    expect(forged.length).toBe(signZeusBody(SECRET, body).length);
    expect(verifyZeusSignature(SECRET, body, forged)).toBe(false);
    // Any empty input fails closed.
    expect(verifyZeusSignature('', body, signZeusBody(SECRET, body))).toBe(false);
    expect(verifyZeusSignature(SECRET, body, null)).toBe(false);
  });

  it('aggregates signature failures into one channel_failures row with incrementing attempts', async () => {
    const row = await failures.get('cf:zeus_webhook:INVALID_SIGNATURE');
    expect(row?.channel).toBe('zeus_webhook');
    expect(row?.attempts).toBeGreaterThanOrEqual(4);
    expect(row?.lastError ?? '').not.toContain(SECRET);
  });
});

describe('inbound zeus webhook: dedupe and rejection policy', () => {
  it('acknowledges a replayed delivery-id with 200 duplicate and never re-drives the task', async () => {
    await seedTask('gt_replay', 'dec_5', 'deciding');
    const event = makeEvent({ decisionId: 'dec_5', at: '2026-10-26T10:00:00.000Z' });
    const body = JSON.stringify(event);
    const deliveryId = 'dec_5:approved:2026-10-26T10:00:00.000Z';
    const opts = { body, signature: signZeusBody(SECRET, body), deliveryId };

    let res = await pushRaw(app, opts);
    expect(res.status).toBe(200);
    expect(await tasks.get('gt_replay')).toMatchObject({ status: 'drafting' });
    const rowsBefore = await deliveryCount();

    res = await pushRaw(app, opts);
    expect(res.status).toBe(200);
    const body2 = (await res.json()) as { duplicate: boolean };
    expect(body2.duplicate).toBe(true);
    expect(await tasks.get('gt_replay')).toMatchObject({ status: 'drafting' });
    expect(await deliveryCount()).toBe(rowsBefore);
  });

  it('returns 422 for an unknown zeusDecisionId, records a rejected delivery and a channel failure', async () => {
    const event = makeEvent({ decisionId: 'dec_ghost', at: '2026-10-26T11:00:00.000Z' });
    const body = JSON.stringify(event);
    const deliveryId = 'dec_ghost:approved:2026-10-26T11:00:00.000Z';
    const res = await pushRaw(app, {
      body,
      signature: signZeusBody(SECRET, body),
      deliveryId,
    });
    expect(res.status).toBe(422);
    const row = await deliveries.find(deliveryId);
    expect(row).toMatchObject({ processingResult: 'rejected', errorCode: 'UNKNOWN_TASK' });
    expect(await failures.get('cf:zeus_webhook:UNKNOWN_TASK')).toMatchObject({
      channel: 'zeus_webhook',
      reason: 'UNKNOWN_TASK',
    });

    // The same delivery-id retried must be acknowledged as duplicate (no 422
    // loop): recovery runs through §9 reconciliation, not re-delivery.
    const retry = await pushRaw(app, { body, signature: signZeusBody(SECRET, body), deliveryId });
    expect(retry.status).toBe(200);
    expect((await retry.json()) as { duplicate: boolean }).toMatchObject({ duplicate: true });
  });

  it('returns 409 for a real drift (approved on a task already drafting) and records it', async () => {
    await seedTask('gt_drift', 'dec_6', 'drafting');
    const event = makeEvent({ decisionId: 'dec_6', at: '2026-10-26T12:00:00.000Z' });
    const body = JSON.stringify(event);
    const deliveryId = 'dec_6:approved:2026-10-26T12:00:00.000Z';
    const res = await pushRaw(app, {
      body,
      signature: signZeusBody(SECRET, body),
      deliveryId,
    });
    expect(res.status).toBe(409);
    expect(await tasks.get('gt_drift')).toMatchObject({ status: 'drafting' });
    const row = await deliveries.find(deliveryId);
    expect(row).toMatchObject({
      processingResult: 'rejected',
      errorCode: 'INVALID_TRANSITION',
      taskId: 'gt_drift',
    });
    expect(await failures.get('cf:zeus_webhook:INVALID_TRANSITION')).toMatchObject({
      channel: 'zeus_webhook',
      reason: 'INVALID_TRANSITION',
    });
  });
});

describe('inbound zeus webhook: malformed requests', () => {
  it('400 when the delivery-id header is missing', async () => {
    const body = JSON.stringify(makeEvent({ decisionId: 'dec_7', at: '2026-10-26T13:00:00.000Z' }));
    const res = await pushRaw(app, { body, signature: signZeusBody(SECRET, body) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('MISSING_DELIVERY_ID');
  });

  it('400 for unparsable JSON and for an event missing required fields', async () => {
    const deliveryId = 'dec_8:approved:2026-10-26T13:00:00.000Z';
    let res = await pushRaw(app, {
      body: '{not json',
      signature: signZeusBody(SECRET, '{not json'),
      deliveryId,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('BAD_JSON');

    const bad = JSON.stringify({ type: 'approved' });
    res = await pushRaw(app, {
      body: bad,
      signature: signZeusBody(SECRET, bad),
      deliveryId,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('BAD_EVENT');
  });

  it('503 fail-closed when the receiver has no configured secret', async () => {
    const unconfigured = createZeusWebhookApp({
      secret: '',
      deliveries,
      failures,
      tasks,
      now: () => NOW,
    });
    const body = JSON.stringify(makeEvent({ decisionId: 'dec_9', at: '2026-10-26T14:00:00.000Z' }));
    const res = await unconfigured.request('/', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-zeus-signature': signZeusBody(SECRET, body),
        'x-zeus-delivery-id': 'dec_9:approved:2026-10-26T14:00:00.000Z',
      },
      body,
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe('WEBHOOK_NOT_CONFIGURED');
  });
});
