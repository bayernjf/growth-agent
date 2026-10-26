// DataForSEO-class online SERP adapter (design §4.2, T-C1 transport skeleton).
//
// WIRE SHAPES ARE NOT YET VALIDATED WITH A REAL KEY — TODO(T-C2): this file
// has only been exercised against a local node:http fake server. Paths and
// request bodies follow DataForSEO v3 documented conventions:
//   auth      : HTTP Basic (login:password)
//   base      : https://api.dataforseo.com
//   ideas     : POST /v3/dataforseo_labs/google/keyword_ideas/live
//               body { keywords: [seed], location_code?, language_code? }
//   serp      : POST /v3/serp/google/organic/live/advanced
//               body { keyword, location_name?, language_name?, depth? }
//   rankTrack : per-query serp call above; the domain match is read off the
//               organic items (rank_absolute field).
//
// Semantics (§4.2): 402 -> PROVIDER_BILLING non-retryable (notify owner to
// top up); 401 -> CREDENTIAL_MISSING; 429/5xx/network -> bounded-exponential
// retry (3 attempts, 200ms base — same rhythm as the zeus dispatcher).

import { GrowthAgentError, GrowthAgentErrors } from '../../errors.js';
import type {
  KeywordIdea,
  KeywordIdeasOpts,
  RankTrackItem,
  SerpKeywordProvider,
  SerpOpts,
  SerpResult,
} from './types.js';

export const DATAFORSEO_BASE_URL = 'https://api.dataforseo.com';

export interface DataForSeoProviderDeps {
  login: string;
  password: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
}

interface IdeasItem {
  keyword_data?: { keyword?: unknown; search_volume?: unknown; competition?: unknown };
  keyword_info?: { cpc?: unknown };
}

interface OrganicItem {
  type?: unknown;
  rank_absolute?: unknown;
  url?: unknown;
  title?: unknown;
  description?: unknown;
}

export class DataForSeoProvider implements SerpKeywordProvider {
  readonly name = 'dataforseo';
  readonly online = true as const;

  private readonly login: string;
  private readonly password: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;

  constructor(deps: DataForSeoProviderDeps) {
    if (deps.login === '' || deps.password === '') {
      throw GrowthAgentErrors.credentialMissing(
        'GA_SERP_MODE=online requires GA_SERP_DATAFORSEO_LOGIN and GA_SERP_DATAFORSEO_PASSWORD',
      );
    }
    this.login = deps.login;
    this.password = deps.password;
    this.baseUrl = (deps.baseUrl ?? DATAFORSEO_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.sleepImpl = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
    this.timeoutMs = deps.timeoutMs ?? 10_000;
    this.maxAttempts = deps.maxAttempts ?? 3;
    this.baseBackoffMs = deps.baseBackoffMs ?? 200;
  }

  async keywordIdeas(seed: string, opts?: KeywordIdeasOpts): Promise<KeywordIdea[]> {
    const body: Record<string, unknown> = { keywords: [seed] };
    if (opts?.locationCode !== undefined) body.location_code = opts.locationCode;
    if (opts?.languageCode !== undefined) body.language_code = opts.languageCode;
    const parsed = await this.withRetry(() =>
      this.request<{ result?: Array<{ items?: unknown[] } | undefined> }>(
        'POST',
        '/v3/dataforseo_labs/google/keyword_ideas/live',
        body,
      ),
    );
    const items = parsed.result?.[0]?.items ?? [];
    return items.map((item) => {
      const it = item as IdeasItem;
      return {
        keyword: String(it.keyword_data?.keyword ?? ''),
        volume: Number(it.keyword_data?.search_volume ?? 0),
        competition: Number(it.keyword_data?.competition ?? 0),
        ...(it.keyword_info?.cpc !== undefined
          ? { cpc: Number(it.keyword_info.cpc) }
          : {}),
      };
    }).filter(k => k.keyword !== '');
  }

  async serp(query: string, opts?: SerpOpts): Promise<SerpResult[]> {
    const body: Record<string, unknown> = { keyword: query, depth: opts?.depth ?? 10 };
    if (opts?.location !== undefined) body.location_name = opts.location;
    if (opts?.language !== undefined) body.language_name = opts.language;
    const parsed = await this.withRetry(() =>
      this.request<{ result?: Array<{ items?: unknown[] } | undefined> }>(
        'POST',
        '/v3/serp/google/organic/live/advanced',
        body,
      ),
    );
    const items = parsed.result?.[0]?.items ?? [];
    return items
      .filter(item => (item as OrganicItem).type === 'organic')
      .map((item) => {
        const it = item as OrganicItem;
        return {
          url: String(it.url ?? ''),
          title: String(it.title ?? ''),
          position: Number(it.rank_absolute ?? 0),
          description: String(it.description ?? ''),
        };
      })
      .filter(r => r.url !== '');
  }

  async rankTrack(domain: string, queries: string[]): Promise<RankTrackItem[]> {
    const host = domain.replace(/^https?:\/\//, '');
    const out: RankTrackItem[] = [];
    for (const query of queries) {
      const items = await this.serp(query);
      const hit = items.find(r => r.url.includes(host));
      out.push(
        hit === undefined
          ? { query, position: null, url: null }
          : { query, position: hit.position, url: hit.url },
      );
    }
    return out;
  }

  /** Retry only retryable GrowthAgentErrors (429/5xx/network); 402/401 fail. */
  private async withRetry<T>(op: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await op();
      } catch (err) {
        if (!(err instanceof GrowthAgentError) || !err.retryable) throw err;
        await this.sleepImpl(this.baseBackoffMs * 2 ** (attempt - 1));
        if (attempt >= this.maxAttempts) throw err;
      }
    }
  }

  private async request<T>(method: string, path: string, body: unknown): Promise<T> {
    const credentials = Buffer.from(`${this.login}:${this.password}`).toString('base64');
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      ctrl.abort();
    }, this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Basic ${credentials}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        signal: ctrl.signal,
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw GrowthAgentErrors.upstreamUnavailable(
        `serp provider ${method} ${path} unreachable: ${err instanceof Error ? err.message : 'network error'}`,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = {};
    }

    if (response.ok) return parsed as T;

    if (response.status === 402) {
      // Balance exhausted / no funds: non-retryable, notify the owner (§4.2).
      throw GrowthAgentErrors.providerBilling('SERP provider rejected the call (402 billing)', parsed);
    }
    if (response.status === 401) {
      throw GrowthAgentErrors.credentialMissing('SERP provider rejected our credentials (401)');
    }
    if (response.status === 429 || response.status >= 500) {
      throw GrowthAgentErrors.upstreamUnavailable(
        `SERP provider returned HTTP ${response.status}`,
        parsed,
      );
    }
    // Unrecognized 4xx: surface without retrying, raw body preserved.
    throw GrowthAgentErrors.validation(
      `SERP provider returned HTTP ${response.status}`,
      parsed,
    );
  }
}
