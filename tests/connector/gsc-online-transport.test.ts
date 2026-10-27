// T-B4 online GSC transport, exercised against an injected fake fetch. No real
// Google call: the wire shapes are asserted from recorded envelopes, matching
// the repository rule that unreachable externals are covered by contract-level
// fakes. A real-property smoke is still owed (see the TODO in online.ts).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { decodeMasterKey } from '../../src/connector/gsc/crypto.js';
import {
  ACCESS_TOKEN_SKEW_MS,
  DEFAULT_ROW_LIMIT,
  GSC_BASE_URL,
  OnlineGscClient,
} from '../../src/connector/gsc/online.js';
import { GscTokenStore } from '../../src/connector/gsc/token-store.js';
import type { GscAnalyticsInput } from '../../src/connector/gsc/types.js';

const NOW = '2026-10-27T00:00:00.000Z';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SITE_URL = 'https://bayjf.com/';
const QUERY_PATH = `/sites/${encodeURIComponent(SITE_URL)}/searchAnalytics/query`;

const input: GscAnalyticsInput = {
  siteUrl: SITE_URL,
  startDate: '2026-09-29',
  endDate: '2026-10-26',
  dimensions: ['page'],
};

interface RecordedCall {
  url: string;
  method: string;
  authorization: string | null;
  body: unknown;
}

interface FakeRoute {
  status: number;
  body: unknown;
}

let dir: string;
let store: GscTokenStore;
let calls: RecordedCall[];
let sleeps: number[];

/** API routes keyed by path; the token endpoint is handled separately. */
let apiRoutes: Record<string, FakeRoute[]>;
let tokenResponses: FakeRoute[];

function jsonResponse(route: FakeRoute): Response {
  return new Response(JSON.stringify(route.body), {
    status: route.status,
    headers: { 'content-type': 'application/json' },
  });
}

async function fakeFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const target = String(url);
  const headers = new Headers(init?.headers);
  // The token endpoint is form-encoded, the API is JSON; parse accordingly so a
  // form body is recorded instead of throwing inside the fake.
  const raw = typeof init?.body === 'string' ? init.body : undefined;
  const isJson = headers.get('content-type')?.includes('application/json') === true;
  calls.push({
    url: target,
    method: init?.method ?? 'GET',
    authorization: headers.get('authorization'),
    body: raw === undefined ? undefined : isJson ? JSON.parse(raw) : raw,
  });

  if (target === TOKEN_ENDPOINT) {
    const route = tokenResponses.shift() ?? { status: 200, body: { access_token: 'at-fallback' } };
    return jsonResponse(route);
  }

  const path = target.replace(GSC_BASE_URL, '');
  const queue = apiRoutes[path];
  const route = queue === undefined ? { status: 404, body: {} } : (queue.shift() ?? queue[0]);
  if (route === undefined) return jsonResponse({ status: 404, body: {} });
  return jsonResponse(route);
}

function makeClient(maxAttempts = 3): OnlineGscClient {
  return new OnlineGscClient({
    clientId: 'cid',
    clientSecret: 'csec',
    tokenStore: store,
    fetchImpl: fakeFetch as typeof fetch,
    maxAttempts,
    baseBackoffMs: 1,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    now: () => NOW,
  });
}

/** Seal a token whose access token expires `msFromNow` after NOW. */
function sealToken(msFromNow: number, accessToken = 'at-valid'): void {
  store.save({
    refreshToken: 'rt-sealed',
    accessToken,
    accessTokenExpiresAt: new Date(new Date(NOW).getTime() + msFromNow).toISOString(),
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gsc-online-'));
  store = new GscTokenStore({ dir, masterKey: decodeMasterKey(randomBytes(32).toString('hex')) });
  calls = [];
  sleeps = [];
  apiRoutes = {};
  tokenResponses = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('OnlineGscClient wire contract (T-B4)', () => {
  it('posts the documented searchAnalytics request with a bearer token', async () => {
    sealToken(3_600_000);
    apiRoutes[QUERY_PATH] = [
      {
        status: 200,
        body: {
          rows: [
            { keys: ['https://bayjf.com/'], clicks: 12, impressions: 340, ctr: 0.035, position: 8.5 },
          ],
        },
      },
    ];

    const rows = await makeClient().queryAnalytics(input);

    expect(rows).toEqual([
      { keys: ['https://bayjf.com/'], clicks: 12, impressions: 340, ctr: 0.035, position: 8.5 },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${GSC_BASE_URL}${QUERY_PATH}`);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.authorization).toBe('Bearer at-valid');
    expect(calls[0]?.body).toEqual({
      startDate: '2026-09-29',
      endDate: '2026-10-26',
      dimensions: ['page'],
      rowLimit: DEFAULT_ROW_LIMIT,
    });
  });

  it('reuses an unexpired sealed access token without hitting the token endpoint', async () => {
    sealToken(3_600_000);
    apiRoutes[QUERY_PATH] = [{ status: 200, body: { rows: [] } }];

    await makeClient().queryAnalytics(input);

    expect(calls.every(call => call.url !== TOKEN_ENDPOINT)).toBe(true);
  });

  it('refreshes and re-seals when the access token is inside the skew window', async () => {
    sealToken(ACCESS_TOKEN_SKEW_MS - 1_000, 'at-stale');
    tokenResponses = [
      { status: 200, body: { access_token: 'at-fresh', expires_in: 3600, refresh_token: 'rt-rotated' } },
    ];
    apiRoutes[QUERY_PATH] = [{ status: 200, body: { rows: [] } }];

    await makeClient().queryAnalytics(input);

    const apiCall = calls.find(call => call.url.endsWith('/searchAnalytics/query'));
    expect(apiCall?.authorization).toBe('Bearer at-fresh');
    // Google may rotate the refresh token; the rotated value must be sealed.
    expect(store.load()).toMatchObject({ refreshToken: 'rt-rotated', accessToken: 'at-fresh' });
  });

  it('forces one refresh-and-retry on 401, then reports the mapped error', async () => {
    sealToken(3_600_000, 'at-revoked');
    tokenResponses = [{ status: 200, body: { access_token: 'at-still-bad', expires_in: 3600 } }];
    apiRoutes[QUERY_PATH] = [
      { status: 401, body: { error: { code: 401, message: 'invalid credentials', status: 'UNAUTHENTICATED' } } },
      { status: 401, body: { error: { code: 401, message: 'invalid credentials', status: 'UNAUTHENTICATED' } } },
    ];

    await expect(makeClient().queryAnalytics(input)).rejects.toMatchObject({
      code: 'GSC_AUTH_REVOKED',
      retryable: false,
    });
    expect(calls.filter(call => call.url === TOKEN_ENDPOINT)).toHaveLength(1);
    expect(calls.filter(call => call.url.endsWith('/searchAnalytics/query'))).toHaveLength(2);
    // A 401 is not retryable, so no backoff sleep is taken.
    expect(sleeps).toEqual([]);
  });

  it('maps 403 insufficient scope and 403 site forbidden to distinct codes', async () => {
    sealToken(3_600_000);
    apiRoutes[QUERY_PATH] = [
      { status: 403, body: { error: { code: 403, message: 'insufficient_scope', status: 'PERMISSION_DENIED' } } },
      { status: 403, body: { error: { code: 403, message: 'site not found', status: 'PERMISSION_DENIED' } } },
    ];
    const client = makeClient();

    await expect(client.queryAnalytics(input)).rejects.toMatchObject({ code: 'GSC_SCOPE_INSUFFICIENT' });
    await expect(client.queryAnalytics(input)).rejects.toMatchObject({ code: 'GSC_SITE_FORBIDDEN' });
  });

  it('retries a 429 quota error with bounded backoff and then surfaces GSC_QUOTA', async () => {
    sealToken(3_600_000);
    const quota = { status: 429, body: { error: { code: 429, message: 'quotaExceeded' } } };
    apiRoutes[QUERY_PATH] = [quota, quota, quota];

    await expect(makeClient(3).queryAnalytics(input)).rejects.toMatchObject({
      code: 'GSC_QUOTA',
      retryable: true,
    });
    expect(sleeps).toEqual([1, 2]);
  });

  it('retries a 5xx as UPSTREAM_UNAVAILABLE', async () => {
    sealToken(3_600_000);
    const boom = { status: 503, body: { error: { code: 503, message: 'backend' } } };
    apiRoutes[QUERY_PATH] = [boom, boom, boom];

    await expect(makeClient(3).queryAnalytics(input)).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
    expect(sleeps).toEqual([1, 2]);
  });

  it('recovers when a retried 5xx succeeds', async () => {
    sealToken(3_600_000);
    apiRoutes[QUERY_PATH] = [
      { status: 500, body: { error: { code: 500, message: 'backend' } } },
      { status: 200, body: { rows: [{ keys: ['/a'], clicks: 1, impressions: 2, ctr: 0.5, position: 3 }] } },
    ];

    const rows = await makeClient(3).queryAnalytics(input);
    expect(rows).toHaveLength(1);
    expect(sleeps).toEqual([1]);
  });

  it('refuses to score a truncated window', async () => {
    sealToken(3_600_000);
    const fullPage = Array.from({ length: 2 }, (_, i) => ({
      keys: [`/p${i}`],
      clicks: 1,
      impressions: 1,
      ctr: 0.1,
      position: 1,
    }));
    apiRoutes[QUERY_PATH] = [{ status: 200, body: { rows: fullPage } }];

    await expect(
      makeClient().queryAnalytics({ ...input, rowLimit: 2 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('maps the sites list and rejects an empty siteUrl', async () => {
    sealToken(3_600_000);
    apiRoutes['/sites'] = [
      {
        status: 200,
        body: {
          siteEntry: [
            { siteUrl: SITE_URL, permissionLevel: 'siteOwner' },
            { siteUrl: 'sc-domain:bayjf.com', permissionLevel: 'siteRestricted' },
          ],
        },
      },
    ];
    const client = makeClient();

    expect(await client.listSites()).toEqual([
      { siteUrl: SITE_URL, permissionLevel: 'siteOwner' },
      { siteUrl: 'sc-domain:bayjf.com', permissionLevel: 'siteRestricted' },
    ]);
    await expect(client.queryAnalytics({ ...input, siteUrl: '' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('reports a missing OAuth handshake as GSC_AUTH_REVOKED, not a transport fault', async () => {
    expect(store.hasToken()).toBe(false);
    await expect(makeClient().queryAnalytics(input)).rejects.toMatchObject({
      code: 'GSC_AUTH_REVOKED',
    });
    expect(calls).toEqual([]);
  });

  it('maps a network error to a retryable UPSTREAM_UNAVAILABLE', async () => {
    sealToken(3_600_000);
    const client = new OnlineGscClient({
      clientId: 'cid',
      clientSecret: 'csec',
      tokenStore: store,
      fetchImpl: (async () => {
        throw new Error('socket hang up');
      }) as unknown as typeof fetch,
      maxAttempts: 2,
      baseBackoffMs: 1,
      sleep: async () => undefined,
      now: () => NOW,
    });

    await expect(client.queryAnalytics(input)).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
      retryable: true,
    });
  });
});
