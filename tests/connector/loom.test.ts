import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { HttpLoomClient, type HttpLoomClientDeps } from '../../src/connector/loom/http.js';
import { MockLoomClient } from '../../src/connector/loom/mock.js';
import { createLoomClient } from '../../src/connector/loom/registry.js';

// Recorded wire payload: ContentProductView (loom backend/app/content/schemas.py).
const wireView = {
  content_id: 'cp_01JTEST',
  tenant_id: 'tenant_bayjf',
  product_space_id: 'ps_01',
  final_id: 'fcw_01JTEST',
  goal: 'self hosted growth agent guide',
  platform: 'web',
  slot_id: null,
  country: null,
  kind: 'article',
  language: 'en',
  body: '# Self-hosted growth agent\n\nAssembled by the 13-segment chain.',
  review_hits: { intent: true, dedupe: true, value: true },
  status: 'review',
  reject_reason: null,
  regenerate_count: 0,
  created_at: '2026-10-27T02:00:00Z',
  published_url: null,
  platform_post_id: null,
  published_at: null,
  quality_score: 0.91,
  quality_issues: null,
  quality_threshold: 0.8,
  quality_advisory: false,
};

function scriptedFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; auth: string; body: string }> = [];
  const fetchImpl = async (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const next = responses.shift();
    if (next === undefined) throw new Error('scripted fetch exhausted');
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      auth: headers.get('authorization') ?? '',
      body: typeof init?.body === 'string' ? init.body : '',
    });
    return new Response(JSON.stringify(next.body), { status: next.status });
  };
  return { fetchImpl, calls };
}

const deps = (overrides: Partial<HttpLoomClientDeps> = {}): HttpLoomClientDeps => ({
  baseUrl: 'http://loom.internal:8000/',
  tenantId: 'tenant_bayjf',
  ...overrides,
});

describe('MockLoomClient (offline path, reconciled shapes)', () => {
  it('returns deterministic openapi-shaped ids and review status', async () => {
    const loom = new MockLoomClient();
    const ref = await loom.submitTopicDraft({
      taskId: 'gt_1',
      finalId: 'fcw_gt_1',
      query: 'self hosted growth agent',
      angle: 'guide',
      siteId: 'bayjf.com',
      evidenceSignalIds: ['sig_1'],
    });
    expect(ref.contentId).toBe('loom_content_gt_1');
    expect(ref.finalId).toBe('fcw_gt_1');
    expect(ref.status).toBe('review');

    const content = await loom.getContent('loom_content_gt_1');
    expect(content.finalId).toBe('fcw_gt_1');
    expect(content.status).toBe('review');
    expect(typeof content.body).toBe('string');
    expect(content.body).toContain('self hosted growth agent');
    expect(content.publishedUrl).toBeNull();
    expect(content.qualityScore).toBeNull();
  });

  it('is idempotent on taskId', async () => {
    const loom = new MockLoomClient();
    const input = {
      taskId: 'gt_2', finalId: 'fcw_gt_2', query: 'q', angle: 'a', siteId: 's', evidenceSignalIds: [],
    };
    const first = await loom.submitTopicDraft(input);
    const second = await loom.submitTopicDraft(input);
    expect(second).toEqual(first);
  });

  it('honors seeded terminal status', async () => {
    const loom = new MockLoomClient({
      statusByFinalId: new Map([['fcw_gt_3', 'ready_for_publish']]),
    });
    await loom.submitTopicDraft({
      taskId: 'gt_3', finalId: 'fcw_gt_3', query: 'q', angle: 'a', siteId: 's', evidenceSignalIds: [],
    });
    expect(await loom.getReviewStatus('loom_content_gt_3')).toBe('ready_for_publish');
    expect((await loom.getContent('loom_content_gt_3')).status).toBe('ready_for_publish');
  });

  it('returns a 404-shaped error for unknown content', async () => {
    const loom = new MockLoomClient();
    await expect(loom.getContent('loom_content_missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });

  it('rejects empty taskId, query or finalId', async () => {
    const loom = new MockLoomClient();
    await expect(
      loom.submitTopicDraft({ taskId: '', finalId: 'f', query: 'q', angle: 'a', siteId: 's', evidenceSignalIds: [] }),
    ).rejects.toThrow();
    await expect(
      loom.submitTopicDraft({ taskId: 't', finalId: '', query: 'q', angle: 'a', siteId: 's', evidenceSignalIds: [] }),
    ).rejects.toThrow();
  });

  it('issueFinal returns a deterministic id per space+slot (idempotent duplicate)', async () => {
    const loom = new MockLoomClient();
    const material = { productSpaceId: 'ps_1', platform: 'x_platform', slotId: 'slot_1', goal: 'ENGAGEMENT' };
    const first = await loom.issueFinal(material);
    const second = await loom.issueFinal(material);
    expect(first).toBe(second);
    expect(first).toBe('fcw_ps_1_slot_1');
  });

  it('issueFinal rejects empty required material', async () => {
    const loom = new MockLoomClient();
    await expect(
      loom.issueFinal({ productSpaceId: '', platform: 'x', slotId: 's', goal: 'g' }),
    ).rejects.toThrow();
    await expect(
      loom.issueFinal({ productSpaceId: 'p', platform: '', slotId: 's', goal: 'g' }),
    ).rejects.toThrow();
    await expect(
      loom.issueFinal({ productSpaceId: 'p', platform: 'x', slotId: '', goal: 'g' }),
    ).rejects.toThrow();
    await expect(
      loom.issueFinal({ productSpaceId: 'p', platform: 'x', slotId: 's', goal: '' }),
    ).rejects.toThrow();
  });
});

describe('HttpLoomClient (reconciled loom FastAPI wire contract)', () => {
  it('submitTopicDraft POSTs /api/content/generate with the exact wire body and maps the view', async () => {
    const { fetchImpl, calls } = scriptedFetch([{ status: 201, body: wireView }]);
    const client = new HttpLoomClient(deps({ fetchImpl }));
    const ref = await client.submitTopicDraft({
      taskId: 'gt_1',
      finalId: 'fcw_01JTEST',
      query: 'local audit only',
      angle: 'guide',
      siteId: 'bayjf.com',
      evidenceSignalIds: [],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://loom.internal:8000/api/content/generate');
    expect(calls[0]?.method).toBe('POST');
    const body = JSON.parse(calls[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body).toEqual({
      final_id: 'fcw_01JTEST',
      kind: 'article',
      language: 'en',
      actor: { id: 'gt_1', roles: ['operations'] },
    });
    // Local audit fields are NOT fabricated into the wire request.
    expect(body).not.toHaveProperty('query');
    expect(ref).toEqual({ contentId: 'cp_01JTEST', finalId: 'fcw_01JTEST', status: 'review' });
  });

  it('submitTopicDraft sends explicit actor roles and per-call language override', async () => {
    const { fetchImpl, calls } = scriptedFetch([{ status: 201, body: wireView }]);
    const client = new HttpLoomClient(deps({ fetchImpl, language: 'zh-CN' }));
    await client.submitTopicDraft({
      taskId: 'gt_9', finalId: 'fcw_x', query: 'q', angle: 'a', siteId: 's', evidenceSignalIds: [],
      language: 'en',
    });
    const body = JSON.parse(calls[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body.language).toBe('en');
    expect((body.actor as { roles: string[] }).roles).toEqual(['operations']);
  });

  it('getContent GETs /api/content/{id}?tenant_id= and maps body/published_url/quality_score', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      { status: 200, body: wireView },
      { status: 200, body: wireView },
    ]);
    const client = new HttpLoomClient(deps({ fetchImpl }));
    const content = await client.getContent('cp_01JTEST');
    expect(calls[0]?.url).toBe('http://loom.internal:8000/api/content/cp_01JTEST?tenant_id=tenant_bayjf');
    expect(content).toEqual({
      contentId: 'cp_01JTEST',
      finalId: 'fcw_01JTEST',
      status: 'review',
      goal: 'self hosted growth agent guide',
      platform: 'web',
      body: '# Self-hosted growth agent\n\nAssembled by the 13-segment chain.',
      publishedUrl: null,
      qualityScore: 0.91,
    });
    expect(await client.getReviewStatus('cp_01JTEST')).toBe('review');
  });

  it('sends the Bearer token when configured; omits auth header otherwise', async () => {
    const without = scriptedFetch([{ status: 200, body: wireView }]);
    const anon = new HttpLoomClient(deps({ fetchImpl: without.fetchImpl }));
    await anon.getContent('cp_01JTEST');
    expect(without.calls[0]?.auth).toBe('');

    const withTok = scriptedFetch([{ status: 200, body: wireView }]);
    const authed = new HttpLoomClient(deps({ fetchImpl: withTok.fetchImpl, token: 'loom_staff_abc' }));
    await authed.getContent('cp_01JTEST');
    expect(withTok.calls[0]?.auth).toBe('Bearer loom_staff_abc');
  });

  it('maps FastAPI error envelope: 404 NOT_FOUND, 401/403 CREDENTIAL_MISSING, 409 INVALID_TRANSITION, 422 VALIDATION_FAILED', async () => {
    const cases: Array<[number, string]> = [
      [404, 'NOT_FOUND'],
      [401, 'CREDENTIAL_MISSING'],
      [403, 'CREDENTIAL_MISSING'],
      [409, 'INVALID_TRANSITION'],
      [422, 'VALIDATION_FAILED'],
    ];
    for (const [status, code] of cases) {
      const { fetchImpl } = scriptedFetch([{ status, body: { detail: 'boom' } }]);
      const client = new HttpLoomClient(deps({ fetchImpl }));
      await expect(client.getContent('cp_x')).rejects.toMatchObject({ code });
    }
  });

  it('retries 502/network then raises retryable UPSTREAM_UNAVAILABLE; 4xx never retries', async () => {
    const sleeps: number[] = [];
    const { fetchImpl } = scriptedFetch([
      { status: 502, body: { detail: 'gen output invalid' } },
      { status: 502, body: { detail: 'gen output invalid' } },
      { status: 502, body: { detail: 'gen output invalid' } },
    ]);
    const client = new HttpLoomClient(deps({
      fetchImpl,
      sleep: async (ms: number) => { sleeps.push(ms); },
    }));
    await expect(
      client.submitTopicDraft({ taskId: 't', finalId: 'f', query: 'q', angle: 'a', siteId: 's', evidenceSignalIds: [] }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', retryable: true });
    expect(sleeps).toEqual([200, 400, 800]);

    const n422 = scriptedFetch([{ status: 422, body: { detail: 'bad kind' } }]);
    const once = new HttpLoomClient(deps({ fetchImpl: n422.fetchImpl, sleep: async () => {} }));
    await expect(
      once.submitTopicDraft({ taskId: 't', finalId: 'f', query: 'q', angle: 'a', siteId: 's', evidenceSignalIds: [] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(n422.calls).toHaveLength(1);
  });

  it('rejects an unknown wire status instead of fabricating one', async () => {
    const { fetchImpl } = scriptedFetch([{ status: 200, body: { ...wireView, status: 'made_up_state' } }]);
    const client = new HttpLoomClient(deps({ fetchImpl }));
    await expect(client.getContent('cp_x')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('issueFinal POSTs /api/fcw/assemble with the exact wire body and returns final_id', async () => {
    const { fetchImpl, calls } = scriptedFetch([{ status: 201, body: { final_id: 'fcw_new' } }]);
    const client = new HttpLoomClient(deps({ fetchImpl }));
    const finalId = await client.issueFinal({
      productSpaceId: 'ps_1', platform: 'x_platform', slotId: 'slot_1', goal: 'ENGAGEMENT',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://loom.internal:8000/api/fcw/assemble');
    expect(calls[0]?.method).toBe('POST');
    const body = JSON.parse(calls[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body).toEqual({
      product_space_id: 'ps_1',
      platform: 'x_platform',
      slot_id: 'slot_1',
      goal: 'ENGAGEMENT',
      actor: { id: 'growth-agent', roles: ['operations'] },
    });
    expect(finalId).toBe('fcw_new');
  });

  it('issueFinal forwards optional country and pws_id, omitting them when empty', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      { status: 201, body: { final_id: 'fcw_cn' } },
      { status: 201, body: { final_id: 'fcw_plain' } },
    ]);
    const client = new HttpLoomClient(deps({ fetchImpl }));
    await client.issueFinal({
      productSpaceId: 'ps_1', platform: 'x', slotId: 's', goal: 'g', country: 'CN', pwsId: 'pws_1',
    });
    const withOpt = JSON.parse(calls[0]?.body ?? '{}') as Record<string, unknown>;
    expect(withOpt).toMatchObject({ country: 'CN', pws_id: 'pws_1' });

    await client.issueFinal({ productSpaceId: 'ps_1', platform: 'x', slotId: 's', goal: 'g' });
    const withoutOpt = JSON.parse(calls[1]?.body ?? '{}') as Record<string, unknown>;
    expect(withoutOpt).not.toHaveProperty('country');
    expect(withoutOpt).not.toHaveProperty('pws_id');
  });

  it('issueFinal reuses the already-issued final_id on 409 DuplicateIssuance', async () => {
    const { fetchImpl } = scriptedFetch([
      { status: 409, body: { detail: 'FCW already issued: 537a2f28-c0e5-11f1-8218-9bc72af50592' } },
    ]);
    const client = new HttpLoomClient(deps({ fetchImpl }));
    await expect(
      client.issueFinal({ productSpaceId: 'ps_1', platform: 'x', slotId: 's', goal: 'g' }),
    ).resolves.toBe('537a2f28-c0e5-11f1-8218-9bc72af50592');
  });

  it('issueFinal does NOT treat a guards-failed 409 as a duplicate', async () => {
    const { fetchImpl } = scriptedFetch([
      { status: 409, body: { detail: { message: 'FCW guards failed', guards: [{ code: 'g2', passed: false }] } } },
    ]);
    const client = new HttpLoomClient(deps({ fetchImpl }));
    await expect(
      client.issueFinal({ productSpaceId: 'ps_1', platform: 'x', slotId: 's', goal: 'g' }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('issueFinal rejects empty required material and an empty final_id response', async () => {
    const noFetch = new HttpLoomClient(deps());
    await expect(
      noFetch.issueFinal({ productSpaceId: '', platform: 'x', slotId: 's', goal: 'g' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const { fetchImpl } = scriptedFetch([{ status: 201, body: { final_id: '' } }]);
    const empty = new HttpLoomClient(deps({ fetchImpl }));
    await expect(
      empty.issueFinal({ productSpaceId: 'p', platform: 'x', slotId: 's', goal: 'g' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('loom registry discipline (SERP/zeus shape)', () => {
  it('defaults off to the mock; online without url/tenant rejects 422 (no mock fallback)', async () => {
    expect(createLoomClient(loadConfig()).name).toBe('loom-mock');
    process.env.GA_LOOM_MODE = 'online';
    const rejecting = createLoomClient(loadConfig());
    expect(rejecting.name).toBe('loom-rejecting');
    await expect(rejecting.getContent('cp_x')).rejects.toMatchObject({
      code: 'CREDENTIAL_MISSING',
      status: 422,
    });
    delete process.env.GA_LOOM_MODE;
  });

  it('online with url+tenant constructs the HTTP adapter', () => {
    process.env.GA_LOOM_MODE = 'online';
    process.env.GA_LOOM_URL = 'http://loom.internal:8000';
    process.env.GA_LOOM_TENANT_ID = 'tenant_bayjf';
    const client = createLoomClient(loadConfig());
    expect(client.name).toBe('loom-http');
    expect(client.mode).toBe('online');
    delete process.env.GA_LOOM_MODE;
    delete process.env.GA_LOOM_URL;
    delete process.env.GA_LOOM_TENANT_ID;
  });

  it('online with url but no tenant still rejects (GET wire contract needs tenant_id)', () => {
    process.env.GA_LOOM_MODE = 'online';
    process.env.GA_LOOM_URL = 'http://loom.internal:8000';
    expect(createLoomClient(loadConfig()).name).toBe('loom-rejecting');
    delete process.env.GA_LOOM_MODE;
    delete process.env.GA_LOOM_URL;
  });
});
