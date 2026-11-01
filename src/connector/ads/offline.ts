// Deterministic offline ads provider (GA_ADS_MODE=off, the default).
//
// Mirrors OfflineGscProvider: zero network, zero randomness — every row is a
// pure function of the requested date, so two runs on the same day window
// produce byte-identical reports and tests never flake. Online mode without
// ad-account authorization returns the rejecting provider instead, never this
// fixture silently.

import type { AdsReadonlyProvider, AdsReportInput, AdsReportRow } from './types.js';
import { isWithinWindow } from './types.js';

interface CampaignSeed {
  campaignId: string;
  campaignName: string;
  /** Base impressions per day; the day index scales it deterministically. */
  baseImpressions: number;
  /** Micro-USD spent per click. */
  cpcMicros: number;
  /** Conversions per 1000 impressions, in basis points. */
  cvrPerMille: number;
}

const CAMPAIGNS: readonly CampaignSeed[] = [
  {
    campaignId: 'cmp-offline-brand',
    campaignName: 'Brand — offline fixture',
    baseImpressions: 1200,
    cpcMicros: 850_000,
    cvrPerMille: 32,
  },
  {
    campaignId: 'cmp-offline-growth',
    campaignName: 'Growth — offline fixture',
    baseImpressions: 800,
    cpcMicros: 1_250_000,
    cvrPerMille: 21,
  },
];

/** Days since epoch for a YYYY-MM-DD string; NaN when malformed. */
function dayIndex(date: string): number {
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : Number.NaN;
}

/** Inclusive list of YYYY-MM-DD between two dates (bounded by the caller). */
function daysBetween(input: AdsReportInput): string[] {
  const start = dayIndex(input.startDate);
  const end = dayIndex(input.endDate);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const days: string[] = [];
  // A 400-day guard keeps a malformed window from allocating unbounded memory.
  for (let i = start; i <= end && days.length <= 400; i += 1) {
    days.push(new Date(i * 86_400_000).toISOString().slice(0, 10));
  }
  return days;
}

export class OfflineAdsProvider implements AdsReadonlyProvider {
  readonly name = 'ads-offline';
  readonly mode = 'offline' as const;

  async queryReport(input: AdsReportInput): Promise<AdsReportRow[]> {
    const rows: AdsReportRow[] = [];
    for (const date of daysBetween(input)) {
      if (!isWithinWindow(date, input)) continue;
      const day = dayIndex(date);
      // Deterministic weekly shape: weekends spend less, mid-week peaks.
      const weekday = (day + 4) % 7; // 0 = Sunday (1970-01-01 was a Thursday)
      const weeklyFactor = weekday === 0 || weekday === 6 ? 60 : 100 + (weekday % 3) * 10;
      for (const [index, seed] of CAMPAIGNS.entries()) {
        const impressions = Math.round((seed.baseImpressions * weeklyFactor) / 100) + index;
        const clicks = Math.round(impressions * 0.035) + index;
        const conversions = Math.round((impressions * seed.cvrPerMille) / 1000);
        rows.push({
          date,
          campaignId: seed.campaignId,
          campaignName: seed.campaignName,
          impressions,
          clicks,
          spendMicros: clicks * seed.cpcMicros,
          conversions,
        });
      }
    }
    return rows;
  }
}
