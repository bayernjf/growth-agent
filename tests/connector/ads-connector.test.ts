import { describe, expect, it } from 'vitest';
import { OfflineAdsProvider } from '../../src/connector/ads/offline.js';
import { RejectingAdsProvider } from '../../src/connector/ads/rejecting.js';
import { createAdsReadonlyProvider } from '../../src/connector/ads/registry.js';
import { GrowthAgentError } from '../../src/errors.js';
import type { AppConfig } from '../../src/config.js';

const WINDOW = { startDate: '2026-10-26', endDate: '2026-10-28' };

function configWith(adsMode: 'off' | 'online'): AppConfig {
  return { adsMode } as AppConfig;
}

describe('offline ads provider', () => {
  it('is deterministic: the same window yields identical rows', async () => {
    const provider = new OfflineAdsProvider();
    const a = await provider.queryReport(WINDOW);
    const b = await provider.queryReport(WINDOW);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('filters rows to the requested inclusive window', async () => {
    const provider = new OfflineAdsProvider();
    const rows = await provider.queryReport(WINDOW);
    for (const row of rows) {
      expect(row.date >= WINDOW.startDate && row.date <= WINDOW.endDate).toBe(true);
    }
    const single = await provider.queryReport({ startDate: '2026-10-27', endDate: '2026-10-27' });
    expect(new Set(single.map(r => r.date))).toEqual(new Set(['2026-10-27']));
    expect(single.length).toBeLessThan(rows.length);
  });

  it('returns no rows for an inverted window', async () => {
    const provider = new OfflineAdsProvider();
    expect(await provider.queryReport({ startDate: '2026-10-28', endDate: '2026-10-26' })).toEqual([]);
  });
});

describe('ads provider registry', () => {
  it('defaults to the offline fixture', async () => {
    const provider = createAdsReadonlyProvider(configWith('off'));
    expect(provider.mode).toBe('offline');
    expect((await provider.queryReport(WINDOW)).length).toBeGreaterThan(0);
  });

  it('fails closed with 422 when online is selected (OP-31 not implemented)', async () => {
    const provider = createAdsReadonlyProvider(configWith('online'));
    expect(provider.mode).toBe('online');
    await expect(provider.queryReport(WINDOW)).rejects.toBeInstanceOf(GrowthAgentError);
    await expect(provider.queryReport(WINDOW)).rejects.toMatchObject({
      code: 'ADS_CREDENTIAL_MISSING',
      status: 422,
      retryable: false,
    });
  });

  it('never degrades online into the offline fixture', async () => {
    const provider = new RejectingAdsProvider('no ads account authorized');
    await expect(provider.queryReport(WINDOW)).rejects.toThrow(/no ads account authorized/);
  });
});
