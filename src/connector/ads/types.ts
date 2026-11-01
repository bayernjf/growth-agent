// Ads read-only connector port (ops M3, OP-30). Growth-agent NEVER writes to
// the ad platform: this port only reads campaign report aggregates so the
// weekly report can show spend and ROI next to its organic numbers.
//
// Error vocabulary (mirrors the GSC table in connector/gsc/types.ts):
//   missing / incomplete credentials   ADS_CREDENTIAL_MISSING  422 non-retryable
//   account not authorized for reads   ADS_SCOPE_INSUFFICIENT  403 non-retryable
//   quotaExceeded / rate limited       ADS_QUOTA               429 retryable
//   network error / 5xx                UPSTREAM_UNAVAILABLE    503 retryable
//
// Only the first row is implemented in this batch: the real 巨量引擎 transport
// belongs to OP-31 and is blocked on the operator's ad-account authorization,
// so `online` resolves to the rejecting provider (see registry.ts) — never to
// a silent offline fixture.

/** One campaign-day aggregate row. Money is integer micro-USD, like the ledger. */
export interface AdsReportRow {
  /** YYYY-MM-DD the row aggregates. */
  date: string;
  campaignId: string;
  campaignName: string;
  impressions: number;
  clicks: number;
  spendMicros: number;
  conversions: number;
}

export interface AdsReportInput {
  /** YYYY-MM-DD, inclusive. */
  startDate: string;
  /** YYYY-MM-DD, inclusive. */
  endDate: string;
}

export interface AdsReadonlyProvider {
  readonly name: string;
  readonly mode: 'offline' | 'online';
  queryReport(input: AdsReportInput): Promise<AdsReportRow[]>;
}

/** Inclusive day-window check shared by the offline fixture and callers. */
export function isWithinWindow(date: string, input: AdsReportInput): boolean {
  return date >= input.startDate && date <= input.endDate;
}
