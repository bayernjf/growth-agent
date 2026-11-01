import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildWeeklyReport, renderWeeklyMarkdown } from '../../src/report/weekly.js';
import type { WeeklyReportDeps } from '../../src/report/weekly.js';
import type { AdsReadonlyProvider, AdsReportInput, AdsReportRow } from '../../src/connector/ads/types.js';
import { SqliteDriver } from '../../src/storage/sqlite/sqlite-driver.js';
import { migrateUp } from '../../src/storage/migrate.js';
import { ApiCallRepository } from '../../src/cost/api-call-repository.js';
import { Pricing, parseCostRates } from '../../src/cost/pricing.js';
import { CostRecorder } from '../../src/cost/recorder.js';

const MONDAY = new Date('2026-10-26T07:00:00.000Z');

/** Minimal deps: the ads section must work without any seeded task data. */
function baseDeps(): WeeklyReportDeps {
  const empty = {
    list: async () => [],
  };
  return {
    tasks: { list: async () => [] } as never,
    apiCalls: { rangeCost: async () => ({ costMicros: 0 }), costByProvider: async () => [], record: async () => undefined } as never,
    snapshots: empty as never,
    zeusDeliveries: empty as never,
    githubDeliveries: empty as never,
    channelFailures: empty as never,
    reportDir: '/tmp/unused',
  };
}

class FakeAds implements AdsReadonlyProvider {
  readonly name = 'ads-fake';
  readonly mode = 'offline' as const;
  constructor(private readonly rows: AdsReportRow[], private readonly fail = false) {}
  async queryReport(_input: AdsReportInput): Promise<AdsReportRow[]> {
    if (this.fail) throw new Error('ads upstream down');
    return this.rows;
  }
}

const ROWS: AdsReportRow[] = [
  { date: '2026-10-26', campaignId: 'c1', campaignName: 'A', impressions: 1000, clicks: 50, spendMicros: 5_000_000, conversions: 10 },
  { date: '2026-10-27', campaignId: 'c1', campaignName: 'A', impressions: 500, clicks: 25, spendMicros: 2_500_000, conversions: 2 },
];

describe('weekly report without ads', () => {
  it('keeps the pre-OP-32 shape: no ads field and no ads section', async () => {
    const report = await buildWeeklyReport(baseDeps(), MONDAY);
    expect('ads' in report).toBe(false);
    expect(renderWeeklyMarkdown(report)).not.toContain('## Ads / ROI');
  });
});

describe('weekly report with ads', () => {
  it('aggregates spend/clicks/conversions and computes CPA', async () => {
    const report = await buildWeeklyReport({ ...baseDeps(), ads: new FakeAds(ROWS) }, MONDAY);
    expect(report.ads).toEqual({
      spendMicros: 7_500_000,
      impressions: 1500,
      clicks: 75,
      conversions: 12,
      cpaMicros: 625_000,
      roiPct: null,
    });
  });

  it('renders "—" for CPA when the week had no conversions', async () => {
    const rows = ROWS.map(r => ({ ...r, conversions: 0 }));
    const report = await buildWeeklyReport({ ...baseDeps(), ads: new FakeAds(rows) }, MONDAY);
    expect(report.ads?.cpaMicros).toBeNull();
    expect(renderWeeklyMarkdown(report)).toContain('CPA: — (no conversions this week)');
  });

  it('renders "—" for ROI without a revenue source', async () => {
    const report = await buildWeeklyReport({ ...baseDeps(), ads: new FakeAds(ROWS) }, MONDAY);
    expect(report.ads?.roiPct).toBeNull();
    expect(renderWeeklyMarkdown(report)).toContain('ROI: — (no revenue source configured)');
  });

  it('computes ROI from revenue when one is injected', async () => {
    const report = await buildWeeklyReport(
      {
        ...baseDeps(),
        ads: new FakeAds(ROWS),
        revenueMicros: async () => 15_000_000,
      },
      MONDAY,
    );
    // (15,000,000 - 7,500,000) / 7,500,000 = 100%
    expect(report.ads?.roiPct).toBe(100);
    expect(renderWeeklyMarkdown(report)).toContain('ROI: 100.0%');
  });

  it('records the ads read in the api_calls ledger with the ads tag', async () => {
    const recorded: Array<{ provider: string; units: number; costMicros: number }> = [];
    const recorder = {
      measure: async (meta: { provider: string }, fn: () => Promise<{ data: unknown; units?: number }>) => {
        const result = await fn();
        recorded.push({ provider: meta.provider, units: result.units ?? 1, costMicros: 0 });
        return result.data;
      },
    };
    await buildWeeklyReport(
      { ...baseDeps(), ads: new FakeAds(ROWS), adsRecorder: recorder as never },
      MONDAY,
    );
    expect(recorded).toEqual([{ provider: 'ads', units: ROWS.length, costMicros: 0 }]);
  });

  it('propagates an ads failure instead of fabricating a zero-spend week', async () => {
    await expect(
      buildWeeklyReport({ ...baseDeps(), ads: new FakeAds(ROWS, true) }, MONDAY),
    ).rejects.toThrow(/ads upstream down/);
  });
});

describe('ads metering through the real ledger', () => {
  let db: SqliteDriver;
  let apiCalls: ApiCallRepository;

  beforeEach(async () => {
    db = new SqliteDriver(':memory:');
    await migrateUp(db);
    apiCalls = new ApiCallRepository(db);
  });

  afterEach(async () => {
    await db.close();
  });

  function recorder(): CostRecorder {
    return new CostRecorder(
      apiCalls,
      new Pricing(parseCostRates('{"ads":7}')),
      () => '2026-10-26T08:00:00.000Z',
    );
  }

  it('records a successful ads read with the ads tag and row units', async () => {
    await buildWeeklyReport(
      { ...baseDeps(), apiCalls: apiCalls as never, ads: new FakeAds(ROWS), adsRecorder: recorder() },
      MONDAY,
    );
    const rows = await apiCalls.list('2026-10-20', '2026-11-02');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: 'ads', units: ROWS.length, costMicros: ROWS.length * 7 });
  });

  it('records a failed ads read with zero units (upstream status)', async () => {
    await expect(
      buildWeeklyReport(
        { ...baseDeps(), apiCalls: apiCalls as never, ads: new FakeAds(ROWS, true), adsRecorder: recorder() },
        MONDAY,
      ),
    ).rejects.toThrow();
    const rows = await apiCalls.list('2026-10-20', '2026-11-02');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: 'ads', units: 0, costMicros: 0 });
  });
});
