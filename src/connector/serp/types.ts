// SERP / keyword data connector port (design §4.2). BYOK: the operator's own
// DataForSEO-class account is billed per call; growth-agent never proxies or
// resells this data.
//
// Error semantics (§4.2):
//   missing key            CREDENTIAL_MISSING 422  fail-closed, never offline fallback
//   provider balance       PROVIDER_BILLING    402  non-retryable, notify owner to top up
//   429 / 5xx / network    UPSTREAM_UNAVAILABLE 503 retryable bounded backoff
// Every call is also meant to be recorded in api_calls (§11) once the
// cost-ledger writer lands (T-A7); this wave wires the transport only.

/** Seed-keyword expansion result. */
export interface KeywordIdea {
  keyword: string;
  /** Monthly search volume. */
  volume: number;
  /** 0..1 competition score. */
  competition: number;
  /** Cost-per-click, micro USD; optional. */
  cpc?: number;
}

export interface SerpResult {
  url: string;
  title: string;
  /** 1-based natural rank. */
  position: number;
  description: string;
}

export interface RankTrackItem {
  query: string;
  /** null when the domain does not appear in the SERP snapshot. */
  position: number | null;
  url: string | null;
}

export interface KeywordIdeasOpts {
  locationCode?: number | undefined;
  languageCode?: string | undefined;
}

export interface SerpOpts {
  location?: string | undefined;
  language?: string | undefined;
  depth?: number | undefined;
}

export interface SerpKeywordProvider {
  readonly name: string;
  readonly online: boolean;
  keywordIdeas(seed: string, opts?: KeywordIdeasOpts): Promise<KeywordIdea[]>;
  serp(query: string, opts?: SerpOpts): Promise<SerpResult[]>;
  rankTrack(domain: string, queries: string[]): Promise<RankTrackItem[]>;
}
