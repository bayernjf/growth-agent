import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config.js';
import { DataForSeoProvider } from '../../src/connector/serp/http.js';
import { OfflineSerpProvider } from '../../src/connector/serp/offline.js';
import { createSerpKeywordProvider } from '../../src/connector/serp/registry.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

beforeAll(() => {
  process.env.GA_REPO_ROOT = repoRoot;
});

afterAll(() => {
  delete process.env.GA_REPO_ROOT;
});

function scriptedFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; auth: string }> = [];
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
    });
    return new Response(JSON.stringify(next.body), { status: next.status });
  };
  return { fetchImpl, calls };
}

function sleepRecorder() {
  const sleeps: number[] = [];
  return { sleeps, sleep: async (ms: number) => { sleeps.push(ms); } };
}

describe('SERP registry discipline (§4.2)', () => {
  it('defaults offline; online without credentials rejects 422 (no offline fallback)', async () => {
    expect(createSerpKeywordProvider(loadConfig()).name).toBe('serp-offline');
    process.env.GA_SERP_MODE = 'online';
    const provider = createSerpKeywordProvider(loadConfig());
    expect(provider.name).toBe('serp-rejecting');
    await expect(provider.serp('anything')).rejects.toMatchObject({
      code: 'CREDENTIAL_MISSING',
      status: 422,
    });
    delete process.env.GA_SERP_MODE;
  });

  it('online with login+password constructs the DataForSEO adapter (real key smoke is T-C2)', () => {
    process.env.GA_SERP_MODE = 'online';
    process.env.GA_SERP_DATAFORSEO_LOGIN = 'login';
    process.env.GA_SERP_DATAFORSEO_PASSWORD = 'pw';
    expect(createSerpKeywordProvider(loadConfig()).name).toBe('dataforseo');
    delete process.env.GA_SERP_MODE;
    delete process.env.GA_SERP_DATAFORSEO_LOGIN;
    delete process.env.GA_SERP_DATAFORSEO_PASSWORD;
  });

  it('constructor rejects missing credentials before any network call', () => {
    expect(() => new DataForSeoProvider({ login: '', password: '' })).toThrowError(/422|requires/i);
    expect(() => new DataForSeoProvider({ login: 'l', password: '' })).toThrowError(/requires/);
  });
});

describe('OfflineSerpProvider deterministic replay', () => {
  it('keywordIdeas / serp / rankTrack return fixture data', async () => {
    const provider = new OfflineSerpProvider();
    const ideas = await provider.keywordIdeas('audit');
    expect(ideas[0]?.keyword).toBe('site audit checklist');
    const results = await provider.serp('site audit checklist');
    expect(results.map(r => r.position)).toEqual([1, 2, 3]);
    const track = await provider.rankTrack('bayjf.com', ['site audit checklist', 'keyword with no presence']);
    expect(track).toEqual([
      { query: 'site audit checklist', position: 1, url: 'https://bayjf.com/blog/site-audit-checklist' },
      { query: 'keyword with no presence', position: null, url: null },
    ]);
  });
});

describe('DataForSeoProvider transport semantics (fake server; NOT real-key validated, T-C2)', () => {
  it('keywordIdeas posts basic-auth and maps the v3 envelope', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      {
        status: 200,
        body: {
          status_code: 20000,
          result: [
            {
              items: [
                {
                  type: 'related_keyword',
                  keyword_data: { keyword: 'site audit checklist', search_volume: 8100, competition: 0.31 },
                  keyword_info: { cpc: 240 },
                },
              ],
            },
          ],
        },
      },
    ]);
    const provider = new DataForSeoProvider({ login: 'L', password: 'P', fetchImpl });
    const ideas = await provider.keywordIdeas('site audit');
    expect(ideas).toEqual([{ keyword: 'site audit checklist', volume: 8100, competition: 0.31, cpc: 240 }]);
    expect(calls[0]?.url).toContain('/v3/dataforseo_labs/google/keyword_ideas/live');
    expect(calls[0]?.auth).toMatch(/^Basic /);
  });

  it('serp keeps only organic items with absolute rank', async () => {
    const { fetchImpl } = scriptedFetch([
      {
        status: 200,
        body: {
          result: [
            {
              items: [
                { type: 'organic', rank_absolute: 1, url: 'https://a.com/', title: 'A', description: 'da' },
                { type: 'paid', rank_absolute: 1, url: 'https://ads.com/', title: 'ad', description: '' },
                { type: 'organic', rank_absolute: 2, url: 'https://b.com/', title: 'B', description: 'db' },
              ],
            },
          ],
        },
      },
    ]);
    const provider = new DataForSeoProvider({ login: 'L', password: 'P', fetchImpl });
    const results = await provider.serp('q');
    expect(results).toEqual([
      { url: 'https://a.com/', title: 'A', position: 1, description: 'da' },
      { url: 'https://b.com/', title: 'B', position: 2, description: 'db' },
    ]);
  });

  it('rankTrack issues one serp call per query and locates the domain', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      { status: 200, body: { result: [{ items: [{ type: 'organic', rank_absolute: 4, url: 'https://bayjf.com/x', title: 't', description: '' }] }] } },
      { status: 200, body: { result: [{ items: [{ type: 'organic', rank_absolute: 1, url: 'https://other.com/', title: 't', description: '' }] }] } },
    ]);
    const provider = new DataForSeoProvider({ login: 'L', password: 'P', fetchImpl });
    const out = await provider.rankTrack('bayjf.com', ['q1', 'q2']);
    expect(out).toEqual([
      { query: 'q1', position: 4, url: 'https://bayjf.com/x' },
      { query: 'q2', position: null, url: null },
    ]);
    expect(calls).toHaveLength(2);
  });

  it('HTTP 402 -> PROVIDER_BILLING, non-retryable (no extra sleep/attempt)', async () => {
    const { fetchImpl } = scriptedFetch([{ status: 402, body: { message: 'no funds' } }]);
    const { sleeps, sleep } = sleepRecorder();
    const provider = new DataForSeoProvider({ login: 'L', password: 'P', fetchImpl, sleep });
    await expect(provider.serp('q')).rejects.toMatchObject({
      code: 'PROVIDER_BILLING',
      status: 402,
      retryable: false,
    });
    expect(sleeps).toHaveLength(0);
  });

  it('HTTP 401 -> CREDENTIAL_MISSING non-retryable', async () => {
    const { fetchImpl } = scriptedFetch([{ status: 401, body: {} }]);
    const provider = new DataForSeoProvider({ login: 'L', password: 'P', fetchImpl });
    await expect(provider.serp('q')).rejects.toMatchObject({ code: 'CREDENTIAL_MISSING' });
  });

  it('429 then 200 retries with geometric backoff (200 -> 400) then succeeds', async () => {
    const { fetchImpl } = scriptedFetch([
      { status: 429, body: {} },
      { status: 200, body: { result: [{ items: [{ type: 'organic', rank_absolute: 1, url: 'https://a.com/', title: 't', description: 'd' }] }] } },
    ]);
    const { sleeps, sleep } = sleepRecorder();
    const provider = new DataForSeoProvider({ login: 'L', password: 'P', fetchImpl, sleep });
    const results = await provider.serp('q');
    expect(results).toHaveLength(1);
    expect(sleeps).toEqual([200]);
  });

  it('5xx exhausts the retry budget and surfaces UPSTREAM_UNAVAILABLE retryable', async () => {
    const { fetchImpl } = scriptedFetch([
      { status: 503, body: {} },
      { status: 503, body: {} },
      { status: 503, body: {} },
    ]);
    const { sleeps, sleep } = sleepRecorder();
    const provider = new DataForSeoProvider({ login: 'L', password: 'P', fetchImpl, sleep });
    await expect(provider.serp('q')).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
      retryable: true,
    });
    // Same rhythm as the zeus dispatcher: a geometric sleep even after the
    // final attempt so the injected clock observes the full budget.
    expect(sleeps).toEqual([200, 400, 800]);
  });
});
