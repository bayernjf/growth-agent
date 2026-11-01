// Deterministic offline sentiment provider (GA_SENTIMENT_MODE=off, default).
//
// Mirrors OfflineAdsProvider: zero network, zero randomness — every row is a
// pure function of the requested date, so two runs on the same window produce
// byte-identical rows and tests never flake. Each tracked keyword yields a
// fixed set of mentions per day including one negative row, so negative-alert
// tests are deterministic.

import type { SentimentProvider, SentimentInput, SentimentRow, SentimentKind } from './types.js';
import { isWithinWindow } from './types.js';

interface MentionSeed {
  source: string;
  sentiment: SentimentKind;
  label: string;
  /** Base metric value; the day index scales it deterministically. */
  baseMetric: number;
}

const MENTIONS: readonly MentionSeed[] = [
  { source: 'github', sentiment: 'positive', label: 'GitHub stars', baseMetric: 40 },
  { source: 'github', sentiment: 'positive', label: 'GitHub release', baseMetric: 12 },
  { source: 'hn', sentiment: 'neutral', label: 'Hacker News discussion', baseMetric: 15 },
  { source: 'reddit', sentiment: 'negative', label: 'Reddit complaint', baseMetric: 3 },
  { source: 'brand', sentiment: 'neutral', label: 'Brand mention', baseMetric: 5 },
];

const KEYWORDS: readonly string[] = ['bayjf', 'zeus', 'loom'];

/** Days since epoch for a YYYY-MM-DD string; NaN when malformed. */
function dayIndex(date: string): number {
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : Number.NaN;
}

/** Inclusive list of YYYY-MM-DD between two dates (bounded by the caller). */
function daysBetween(input: SentimentInput): string[] {
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

export class OfflineSentimentProvider implements SentimentProvider {
  readonly name = 'sentiment-offline';
  readonly mode = 'offline' as const;

  async querySentiment(input: SentimentInput): Promise<SentimentRow[]> {
    const rows: SentimentRow[] = [];
    for (const date of daysBetween(input)) {
      if (!isWithinWindow(date, input)) continue;
      const day = dayIndex(date);
      for (const [ki, keyword] of KEYWORDS.entries()) {
        for (const [mi, seed] of MENTIONS.entries()) {
          const metricValue = seed.baseMetric + (day % 5) + ki + mi;
          rows.push({
            date,
            source: seed.source,
            keyword,
            title: `${seed.label} — ${keyword}`,
            url: `https://example.com/${seed.source}/${keyword}/${date}`,
            sentiment: seed.sentiment,
            metricValue,
          });
        }
      }
    }
    return rows;
  }
}
