import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config.js';
import { OfflineGscProvider } from '../../src/connector/gsc/offline.js';
import { createGscReadonlyProvider } from '../../src/connector/gsc/registry.js';
import { mapGscHttpError } from '../../src/connector/gsc/types.js';
import { decodeMasterKey } from '../../src/connector/gsc/crypto.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const fixture = JSON.parse(readFileSync(join(repoRoot, 'tests/fixtures/gsc-fixture.json'), 'utf8')) as {
  sites: unknown[];
  analytics: unknown[];
};

function withEnv(env: Record<string, string | undefined>): ReturnType<typeof loadConfig> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  const config = loadConfig();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return config;
}

beforeAll(() => {
  process.env.GA_REPO_ROOT = repoRoot;
});

afterAll(() => {
  delete process.env.GA_REPO_ROOT;
});

describe('GSC registry discipline (§4.1 / growth-os provider pattern)', () => {
  it('defaults to the deterministic offline provider', () => {
    const config = withEnv({ GA_GSC_MODE: undefined });
    const provider = createGscReadonlyProvider(config);
    expect(provider.name).toBe('gsc-offline');
    expect(provider.mode).toBe('offline');
  });

  it('online selected without OAuth config rejects 422 and never falls back offline', async () => {
    const config = withEnv({
      GA_GSC_MODE: 'online',
      GA_GSC_CLIENT_ID: undefined,
      GA_GSC_CLIENT_SECRET: undefined,
      GA_GROWTH_MASTER_KEY: undefined,
    });
    const provider = createGscReadonlyProvider(config);
    expect(provider.name).toBe('gsc-rejecting');
    await expect(provider.listSites()).rejects.toMatchObject({
      code: 'GSC_CREDENTIAL_MISSING',
      status: 422,
    });
    await expect(
      provider.queryAnalytics({
        siteUrl: 'https://bayjf.com/',
        startDate: '2026-10-20',
        endDate: '2026-10-26',
        dimensions: ['query'],
      }),
    ).rejects.toMatchObject({ code: 'GSC_CREDENTIAL_MISSING' });
  });

  it('online fully configured constructs the real transport (not 422, not offline)', async () => {
    const config = withEnv({
      GA_GSC_MODE: 'online',
      GA_GSC_CLIENT_ID: 'cid',
      GA_GSC_CLIENT_SECRET: 'csec',
      GA_GROWTH_MASTER_KEY: 'a'.repeat(64),
      GA_GSC_TOKEN_DIR: join(repoRoot, 'tests', 'fixtures', 'gsc-tmp-tokens'),
    });
    const provider = createGscReadonlyProvider(config);
    expect(provider.name).toBe('gsc-http');
    expect(provider.mode).toBe('online');
    // No sealed refresh token yet: the operator has not run the OAuth
    // handshake, which must be reported distinctly from a transport fault.
    await expect(provider.listSites()).rejects.toMatchObject({
      code: 'GSC_AUTH_REVOKED',
    });
  });

  it('online with a malformed master key fails closed at registry time', () => {
    const config = withEnv({
      GA_GSC_MODE: 'online',
      GA_GSC_CLIENT_ID: 'cid',
      GA_GSC_CLIENT_SECRET: 'csec',
      GA_GROWTH_MASTER_KEY: 'too-short',
    });
    expect(() => createGscReadonlyProvider(config)).toThrowError(/invalid format/);
    expect(() => decodeMasterKey('too-short')).toThrowError(/invalid format/);
  });
});

describe('OfflineGscProvider deterministic replay', () => {
  it('replays the recorded sites and rows for the asked site/window/dimensions', async () => {
    const provider = new OfflineGscProvider();
    const sites = await provider.listSites();
    expect(sites).toEqual(fixture.sites);
    const rows = await provider.queryAnalytics({
      // Site-config spelling ("bayjf.com") must match rows recorded as
      // "https://bayjf.com/".
      siteUrl: 'bayjf.com',
      startDate: '2026-10-01',
      endDate: '2026-10-31',
      dimensions: ['page'],
    });
    expect(rows.map(r => r.keys[0])).toEqual([
      'https://bayjf.com/guides/legacy-guide',
      'https://bayjf.com/blog/astro-content-pipeline',
    ]);
  });

  it('different windows replay different rows (no date-window collapse)', async () => {
    const provider = new OfflineGscProvider();
    const recent = await provider.queryAnalytics({
      siteUrl: 'https://bayjf.com/',
      startDate: '2026-09-28',
      endDate: '2026-10-25',
      dimensions: ['page'],
    });
    const prior = await provider.queryAnalytics({
      siteUrl: 'https://bayjf.com/',
      startDate: '2026-08-31',
      endDate: '2026-09-27',
      dimensions: ['page'],
    });
    expect(recent).not.toEqual(prior);
    expect(recent.find(r => r.keys[0] === 'https://bayjf.com/guides/legacy-guide')?.position).toBe(9.5);
    expect(prior.find(r => r.keys[0] === 'https://bayjf.com/guides/legacy-guide')?.position).toBe(5.0);
  });

  it('a miss on site/window/dimensions yields [] instead of misaligned rows', async () => {
    const provider = new OfflineGscProvider();
    await expect(
      provider.queryAnalytics({
        siteUrl: 'https://other.example/',
        startDate: '2026-09-01',
        endDate: '2026-10-31',
        dimensions: ['page'],
      }),
    ).resolves.toEqual([]);
    await expect(
      provider.queryAnalytics({
        siteUrl: 'https://bayjf.com/',
        startDate: '2025-01-01',
        endDate: '2025-12-31',
        dimensions: ['page'],
      }),
    ).resolves.toEqual([]);
    await expect(
      provider.queryAnalytics({
        siteUrl: 'https://bayjf.com/',
        startDate: '2026-09-01',
        endDate: '2026-10-31',
        dimensions: ['query'],
      }),
    ).resolves.toEqual([]);
  });

  it('honours rowLimit over the filtered set and validates the input contract', async () => {
    const provider = new OfflineGscProvider();
    const rows = await provider.queryAnalytics({
      siteUrl: 'https://bayjf.com/',
      startDate: '2026-09-01',
      endDate: '2026-10-31',
      dimensions: ['page'],
      rowLimit: 2,
    });
    expect(rows).toHaveLength(2);
    await expect(
      provider.queryAnalytics({
        siteUrl: '',
        startDate: '2026-10-20',
        endDate: '2026-10-26',
        dimensions: ['query'],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('mapGscHttpError (§4.1 error-semantics table)', () => {
  const envelope = (status: number, msg: string, wireStatus = '') => ({
    error: { code: status, message: msg, status: wireStatus },
  });

  it('401 -> GSC_AUTH_REVOKED, 403 scope -> GSC_SCOPE_INSUFFICIENT, 403 site -> GSC_SITE_FORBIDDEN', () => {
    expect(mapGscHttpError(401, envelope(401, 'unauthorized')).code).toBe('GSC_AUTH_REVOKED');
    const scope = mapGscHttpError(403, envelope(403, 'insufficient scopes', 'PERMISSION_DENIED'));
    expect(scope.code).toBe('GSC_SCOPE_INSUFFICIENT');
    const site = mapGscHttpError(403, envelope(403, 'forbidden'));
    expect(site.code).toBe('GSC_SITE_FORBIDDEN');
    expect(site.retryable).toBe(false);
  });

  it('429 -> GSC_QUOTA retryable; 5xx -> UPSTREAM_UNAVAILABLE retryable', () => {
    const quota = mapGscHttpError(429, envelope(429, 'quotaExceeded'));
    expect(quota.code).toBe('GSC_QUOTA');
    expect(quota.status).toBe(429);
    expect(quota.retryable).toBe(true);
    const down = mapGscHttpError(503, envelope(503, 'backend'));
    expect(down.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(down.retryable).toBe(true);
  });
});
