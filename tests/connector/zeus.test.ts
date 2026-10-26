// Contract tests for the zeus decision client (T-A3). The upstream is an
// in-process fake zeus over node:http; no real zeus, no new dependency.
import { describe, expect, it } from 'vitest';
import { GrowthAgentError } from '../../src/errors.js';
import { createZeusDecisionClient } from '../../src/connector/zeus/registry.js';
import { OnlineZeusClient } from '../../src/connector/zeus/http.js';
import { OfflineZeusClient } from '../../src/connector/zeus/offline.js';
import type { AppConfig } from '../../src/config.js';
import {
  makeDeps,
  startFakeZeus,
  type FakeRequest,
  type FakeResponse,
} from './zeus-helpers.js';

const DECISION_INPUT = {
  taskId: 'gt_20261026_001',
  kind: 'write' as const,
  query: 'best cordless drill for home use',
  angle: 'independent roundup with measured torque data',
  evidenceSignalIds: ['sig_1', 'sig_2'],
};

describe('OnlineZeusClient submitDecision (POST /api/v1/decisions)', () => {
  it('posts to the right path with bearer auth and the §3.3 body shape', async () => {
    const fake = await startFakeZeus();
    const { baseUrl, token, sleep } = makeDeps(fake.baseUrl);
    const client = new OnlineZeusClient({ baseUrl, token, sleep });

    const res = await client.submitDecision(DECISION_INPUT);
    expect(res.decisionId).toBe('dec_1');
    expect(res.grade).toBe('D2');
    expect(res.status).toBe('awaiting_approval');

    const req = fake.requests[0] as FakeRequest;
    expect(req.method).toBe('POST');
    expect(req.pathname).toBe('/api/v1/decisions');
    expect(req.headers['authorization']).toBe(`Bearer ${token}`);
    expect(req.headers['content-type']).toBe('application/json');

    const body = req.body as Record<string, unknown>;
    expect(body.idempotencyKey).toBe(`gt:${DECISION_INPUT.taskId}`);
    expect(body.domain).toBe('growth.content');
    expect(body.impact).toBe('org');
    expect(body.reversibility).toBe('hard');
    expect(body.riskTags).toEqual(['seo_quality']);
    expect(body.intent).toContain(DECISION_INPUT.query);
    expect(body.proposal).toMatchObject({
      query: DECISION_INPUT.query,
      angle: DECISION_INPUT.angle,
      evidenceSignalIds: ['sig_1', 'sig_2'],
    });

    await fake.close();
  });

  it('maps 409 IDEMPOTENCY_CONFLICT verbatim (no retry)', async () => {
    const fake = await startFakeZeus();
    fake.route = () => ({
      status: 409,
      json: { code: 'IDEMPOTENCY_CONFLICT', message: 'key reused', retryable: false },
    });
    const { baseUrl, token, sleep, sleeps } = makeDeps(fake.baseUrl);
    const client = new OnlineZeusClient({ baseUrl, token, sleep });

    const err = await client.submitDecision(DECISION_INPUT).catch(e => e);
    expect(err).toBeInstanceOf(GrowthAgentError);
    expect((err as GrowthAgentError).code).toBe('IDEMPOTENCY_CONFLICT');
    expect((err as GrowthAgentError).status).toBe(409);
    expect(fake.requests.length).toBe(1); // 4xx never retried
    expect(sleeps).toEqual([]);
    await fake.close();
  });

  it('maps 409 GRADE_REQUIRES_APPROVAL and APPROVAL_TIMEOUT', async () => {
    for (const code of ['GRADE_REQUIRES_APPROVAL', 'APPROVAL_TIMEOUT'] as const) {
      const fake = await startFakeZeus();
      fake.route = () => ({ status: 409, json: { code, message: 'x', retryable: false } });
      const { baseUrl, token, sleep } = makeDeps(fake.baseUrl);
      const client = new OnlineZeusClient({ baseUrl, token, sleep });
      const err = await client.submitDecision(DECISION_INPUT).catch(e => e);
      expect((err as GrowthAgentError).code).toBe(code);
      expect((err as GrowthAgentError).status).toBe(409);
      await fake.close();
    }
  });

  it('maps 404 DECISION_NOT_FOUND', async () => {
    const fake = await startFakeZeus();
    fake.route = () => ({
      status: 404,
      json: { code: 'DECISION_NOT_FOUND', message: 'no', retryable: false },
    });
    const { baseUrl, token, sleep } = makeDeps(fake.baseUrl);
    const client = new OnlineZeusClient({ baseUrl, token, sleep });
    const err = await client.getDecisionAudit('missing').catch(e => e);
    expect((err as GrowthAgentError).code).toBe('DECISION_NOT_FOUND');
    expect((err as GrowthAgentError).status).toBe(404);
    await fake.close();
  });

  it('maps 500 POLICY_NOT_FOUND as non-retryable', async () => {
    const fake = await startFakeZeus();
    fake.route = () => ({
      status: 500,
      json: { code: 'POLICY_NOT_FOUND', message: 'no policy', retryable: false },
    });
    const { baseUrl, token, sleep, sleeps } = makeDeps(fake.baseUrl);
    const client = new OnlineZeusClient({ baseUrl, token, sleep });
    const err = await client.getPolicies().catch(e => e);
    expect((err as GrowthAgentError).code).toBe('POLICY_NOT_FOUND');
    expect((err as GrowthAgentError).status).toBe(500);
    expect((err as GrowthAgentError).retryable).toBe(false);
    expect(fake.requests.length).toBe(1);
    expect(sleeps).toEqual([]);
    await fake.close();
  });

  it('maps any other upstream code to 400 while preserving the raw code', async () => {
    const fake = await startFakeZeus();
    fake.route = () => ({
      status: 400,
      json: { code: 'VALIDATION_FAILED', message: 'bad body', retryable: false, details: ['intent missing'] },
    });
    const { baseUrl, token, sleep } = makeDeps(fake.baseUrl);
    const client = new OnlineZeusClient({ baseUrl, token, sleep });
    const err = await client.submitDecision(DECISION_INPUT).catch(e => e);
    expect((err as GrowthAgentError).code).toBe('VALIDATION_FAILED');
    expect((err as GrowthAgentError).status).toBe(400);
    await fake.close();
  });

  it('treats a bare 5xx / 429 as retryable DECISION_UNAVAILABLE', async () => {
    const fake = await startFakeZeus();
    let calls = 0;
    fake.route = () => {
      calls += 1;
      return { status: 503, json: {} } satisfies FakeResponse;
    };
    const { baseUrl, token, sleep, sleeps } = makeDeps(fake.baseUrl);
    const client = new OnlineZeusClient({ baseUrl, token, sleep });
    const err = await client.submitDecision(DECISION_INPUT).catch(e => e);
    expect((err as GrowthAgentError).code).toBe('DECISION_UNAVAILABLE');
    expect((err as GrowthAgentError).status).toBe(503);
    expect((err as GrowthAgentError).retryable).toBe(true);
    expect(calls).toBe(3); // maxAttempts
    expect(sleeps).toEqual([200, 400, 800]); // injected backoff schedule
    await fake.close();
  });

  it('classifies a 401 bearer rejection as credential-missing (non-retryable)', async () => {
    const fake = await startFakeZeus();
    fake.route = () => ({ status: 401, json: { error: 'unauthorized' } });
    const { baseUrl, token, sleep } = makeDeps(fake.baseUrl);
    const client = new OnlineZeusClient({ baseUrl, token, sleep });
    const err = await client.getPolicies().catch(e => e);
    expect((err as GrowthAgentError).code).toBe('CREDENTIAL_MISSING');
    await fake.close();
  });
});

describe('GET audit / policies / ping', () => {
  it('GET audit 200 returns the replay timeline', async () => {
    const fake = await startFakeZeus();
    fake.route = () => ({
      status: 200,
      json: {
        format: 'json',
        record: { id: 'dec_1' },
        events: [{ type: 'decision.created', at: '2026-10-26T00:00:00Z' }],
      },
    });
    const { baseUrl, token, sleep } = makeDeps(fake.baseUrl);
    const client = new OnlineZeusClient({ baseUrl, token, sleep });
    const replay = await client.getDecisionAudit('dec_1');
    expect(replay.format).toBe('json');
    expect(replay.events).toHaveLength(1);
    expect(fake.requests[0]?.pathname).toBe('/api/v1/decisions/dec_1/replay');
    await fake.close();
  });

  it('GET policies 200 returns the policy document', async () => {
    const fake = await startFakeZeus();
    fake.route = () => ({
      status: 200,
      json: { version: 1, defaultGrade: 'D2', rules: [{ id: 'd2-org', grade: 'D2', slaHours: 24 }] },
    });
    const { baseUrl, token, sleep } = makeDeps(fake.baseUrl);
    const client = new OnlineZeusClient({ baseUrl, token, sleep });
    const policy = await client.getPolicies();
    expect(policy.defaultGrade).toBe('D2');
    expect(fake.requests[0]?.pathname).toBe('/api/v1/policy');
    await fake.close();
  });

  it('ping resolves true when reachable and false on connection refused', async () => {
    const fake = await startFakeZeus();
    fake.route = () => ({ status: 200, json: { version: 1, defaultGrade: 'D2', rules: [] } });
    const { baseUrl, token, sleep } = makeDeps(fake.baseUrl);
    const client = new OnlineZeusClient({ baseUrl, token, sleep });
    expect(await client.ping()).toBe(true);
    await fake.close();

    // Port closed now -> ping must resolve false rather than throw.
    const dead = new OnlineZeusClient({ baseUrl, token, sleep });
    expect(await dead.ping()).toBe(false);
  });
});

describe('unreachable upstream', () => {
  it('maps connection-refused to DECISION_UNAVAILABLE 503 retryable', async () => {
    const client = new OnlineZeusClient({
      baseUrl: 'http://127.0.0.1:1', // nothing listens here
      token: 'x',
      sleep: async () => {},
      maxAttempts: 1,
    });
    const err = await client.getPolicies().catch(e => e);
    expect((err as GrowthAgentError).code).toBe('DECISION_UNAVAILABLE');
    expect((err as GrowthAgentError).status).toBe(503);
    expect((err as GrowthAgentError).retryable).toBe(true);
  });
});

describe('startup self-check (§6.2)', () => {
  it('ping -> policy -> idempotent webhook re-attach on first boot', async () => {
    const fake = await startFakeZeus();
    let listCalls = 0;
    let addBody: unknown = null;
    fake.route = (req: FakeRequest): FakeResponse => {
      if (req.pathname === '/api/v1/policy') {
        return { status: 200, json: { version: 1, defaultGrade: 'D2', rules: [] } };
      }
      if (req.pathname === '/api/v1/decision-webhooks' && req.method === 'GET') {
        listCalls += 1;
        return { status: 200, json: { webhooks: [] } };
      }
      if (req.pathname === '/api/v1/decision-webhooks' && req.method === 'POST') {
        addBody = req.body;
        return { status: 201, json: { id: 'wh_1', url: 'http://cb', active: true } };
      }
      return { status: 404, json: {} };
    };
    const { baseUrl, token, sleep } = makeDeps(fake.baseUrl);
    const client = new OnlineZeusClient({ baseUrl, token, sleep });

    const result = await client.startupSelfCheck({
      callbackUrl: 'http://127.0.0.1:8790/webhooks/zeus',
      secret: 'local-secret-0123456789abcdef',
    });
    expect(result.ping).toBe(true);
    expect(result.policyDefaultGrade).toBe('D2');
    expect(result.resubscribed).toBe(true);
    expect(listCalls).toBe(1);
    const body = addBody as Record<string, unknown>;
    expect(body.url).toBe('http://127.0.0.1:8790/webhooks/zeus');
    expect(body.active).toBe(true);
    expect(String(body.secret).length).toBeGreaterThanOrEqual(16);
    await fake.close();
  });

  it('skips re-attach when the callback url is already registered', async () => {
    const fake = await startFakeZeus();
    fake.route = (req: FakeRequest): FakeResponse => {
      if (req.pathname === '/api/v1/policy') {
        return { status: 200, json: { version: 1, defaultGrade: 'D2', rules: [] } };
      }
      if (req.pathname === '/api/v1/decision-webhooks' && req.method === 'GET') {
        return {
          status: 200,
          json: { webhooks: [{ id: 'wh_1', url: 'http://cb', active: true }] },
        };
      }
      return { status: 500, json: { code: 'INTERNAL_ERROR', message: 'should not POST' } };
    };
    const { baseUrl, token, sleep } = makeDeps(fake.baseUrl);
    const client = new OnlineZeusClient({ baseUrl, token, sleep });
    const result = await client.startupSelfCheck({ callbackUrl: 'http://cb', secret: 'local-secret-0123456789abcdef' });
    expect(result.resubscribed).toBe(false);
    await fake.close();
  });

  it('fails closed when ping cannot reach zeus', async () => {
    const client = new OnlineZeusClient({
      baseUrl: 'http://127.0.0.1:1',
      token: 'x',
      sleep: async () => {},
      maxAttempts: 1,
    });
    const err = await client.startupSelfCheck().catch(e => e);
    expect((err as GrowthAgentError).code).toBe('DECISION_UNAVAILABLE');
  });
});

describe('registry fail-closed and offline', () => {
  it('online without url/token returns a rejecting client (422 on call)', async () => {
    const config = { zeusMode: 'online', zeusUrl: undefined, zeusToken: undefined } as unknown as AppConfig;
    const client = createZeusDecisionClient(config);
    expect(client.mode).toBe('online');
    const err = await client.submitDecision(DECISION_INPUT).catch(e => e);
    expect((err as GrowthAgentError).code).toBe('CREDENTIAL_MISSING');
    expect((err as GrowthAgentError).status).toBe(422);
  });

  it('offline (default) is deterministic and makes no network calls', async () => {
    const config = { zeusMode: 'off' } as unknown as AppConfig;
    const client = createZeusDecisionClient(config);
    expect(client.mode).toBe('offline');
    const res = await client.submitDecision(DECISION_INPUT);
    expect(res.grade).toBe('D2');
    expect(res.decisionId).toBe(`dec_offline_${DECISION_INPUT.taskId}`);
    const policy = await client.getPolicies();
    expect(policy.defaultGrade).toBe('D2');
    expect(await client.ping()).toBe(true);
    const self = await client.startupSelfCheck();
    expect(self.resubscribed).toBe(false);
  });

  it('buildSubscriptionPayload rejects a secret shorter than 16 chars', async () => {
    const client = new OfflineZeusClient();
    expect(() => client.buildSubscriptionPayload({ callbackUrl: 'http://cb', secret: 'short' })).toThrow(
      /at least 16 characters/,
    );
    const body = client.buildSubscriptionPayload({ callbackUrl: 'http://cb', secret: '0123456789abcdef' });
    expect(body).toEqual({ url: 'http://cb', secret: '0123456789abcdef', active: true });
  });
});
