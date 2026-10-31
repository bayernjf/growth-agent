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
  it('keywordIdeas returns only ideas related to the asked seed', async () => {
    const provider = new OfflineSerpProvider();
    const growth = await provider.keywordIdeas('self hosted growth agent');
    expect(growth.map(k => k.keyword)).toEqual([
      'self hosted growth agent',
      'self hosted growth agent setup',
    ]);
    const byok = await provider.keywordIdeas('byok seo automation');
    expect(byok.map(k => k.keyword)).toEqual([
      'byok seo automation',
      'byok seo automation checklist',
    ]);
    expect(growth).not.toEqual(byok);
  });

  it('keywordIdeas returns [] (not the whole fixture) when no idea matches', async () => {
    const provider = new OfflineSerpProvider();
    await expect(provider.keywordIdeas('quantum underwater weaving')).resolves.toEqual([]);
    await expect(provider.keywordIdeas('')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('serp returns the snapshot recorded for the asked query', async () => {
    const provider = new OfflineSerpProvider();
    const growth = await provider.serp('self hosted growth agent');
    expect(growth).toHaveLength(3);
    expect(growth[0]?.url).toBe('https://en.wikipedia.org/wiki/Growth_engineering');
    // A different query replays its own recorded snapshot, never the same
    // morphology for every query.
    const setup = await provider.serp('self hosted growth agent setup');
    expect(setup).not.toEqual(growth);
  });

  it('serp returns [] for an unrecorded query and honours depth', async () => {
    const provider = new OfflineSerpProvider();
    await expect(provider.serp('query with no fixture data')).resolves.toEqual([]);
    const depth = await provider.serp('self hosted growth agent', { depth: 1 });
    expect(depth).toHaveLength(1);
    await expect(provider.serp('')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rankTrack matches the asked queries and stays honest about the domain', async () => {
    const provider = new OfflineSerpProvider();
    const track = await provider.rankTrack('bayjf.com', [
      'astral developer portfolio',
      'keyword with no presence',
      'untracked query',
    ]);
    expect(track).toEqual([
      { query: 'astral developer portfolio', position: 2, url: 'https://bayjf.com/' },
      { query: 'keyword with no presence', position: null, url: null },
      { query: 'untracked query', position: null, url: null },
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
