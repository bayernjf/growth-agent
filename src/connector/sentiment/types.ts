// Sentiment read-only connector port (W6 / OP-40). Growth-agent only READS
// public signals — GitHub stars/releases, Hacker News, Reddit, and search
// engine brand mentions — to fill the daily snapshot and feed weekly-report
// negative alerts. The provider never writes anywhere.
//
// Error vocabulary (mirrors the ads table in connector/ads/types.ts):
//   missing / incomplete credentials   SENTIMENT_CREDENTIAL_MISSING  422 non-retryable
//   quotaExceeded / rate limited       SENTIMENT_QUOTA               429 retryable
//   network error / 5xx                UPSTREAM_UNAVAILABLE          503 retryable
//
// Only the offline fixture is implemented in this batch: the real public-source
// transports belong to a later OP and are blocked on per-source API keys, so
// `online` resolves to the rejecting provider — never to a silent fixture.

export type SentimentKind = 'positive' | 'neutral' | 'negative';

/** One public-sentiment mention for a tracked brand keyword. */
export interface SentimentRow {
  /** YYYY-MM-DD the mention was observed. */
  date: string;
  /** Source family: 'github' | 'hn' | 'reddit' | 'brand'. */
  source: string;
  /** Tracked brand keyword (e.g. bayjf). */
  keyword: string;
  /** Mention title / headline. */
  title: string;
  /** Public URL of the mention. */
  url: string;
  sentiment: SentimentKind;
  /** Source metric: stars, upvotes, mention count — integer. */
  metricValue: number;
}

export interface SentimentInput {
  /** YYYY-MM-DD, inclusive. */
  startDate: string;
  /** YYYY-MM-DD, inclusive. */
  endDate: string;
}

export interface SentimentProvider {
  readonly name: string;
  readonly mode: 'offline' | 'online';
  querySentiment(input: SentimentInput): Promise<SentimentRow[]>;
}

/** Inclusive day-window check shared by the offline fixture and callers. */
export function isWithinWindow(date: string, input: SentimentInput): boolean {
  return date >= input.startDate && date <= input.endDate;
}
