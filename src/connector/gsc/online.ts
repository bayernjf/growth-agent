// Online GSC transport (T-B4, design §4.1). Strictly read-only: the sealed
// refresh token is scoped to webmasters.readonly and this file only issues
// GET /sites and POST searchAnalytics/query — never a site mutation.
//
// Wire contract (Search Console REST, injectable baseUrl):
//   GET  {base}/sites                                 -> { siteEntry[] }
//   POST {base}/sites/{siteUrl}/searchAnalytics/query -> { rows[] }
//        body { startDate, endDate, dimensions[], rowLimit }
//
// WIRE SHAPES ARE NOT YET VALIDATED AGAINST A REAL PROPERTY — TODO(T-B4
// verify): like the SERP adapter, this has only been exercised against an
// injected fake fetch returning recorded Google envelopes. Field names follow
// the documented v3 shapes; a real-credential smoke must confirm them before
// GSC online is trusted with a live dogfood run.
//
// Token handling: the sealed record is opened per call and the short-lived
// access token is refreshed when absent or within ACCESS_TOKEN_SKEW_MS of
// expiry. Google may rotate the refresh token, so whatever comes back is
// re-sealed via toTokenRecord. A 401 from the API forces exactly one
// refresh-and-retry before the §4.1 mapper classifies it, so a revoked refresh
// token surfaces as GSC_AUTH_REVOKED rather than as a transient blip.

import { GrowthAgentError, GrowthAgentErrors } from '../../errors.js';
import { refreshAccessToken, toTokenRecord, type OAuthClientDeps } from './oauth.js';
import type { GscTokenStore } from './token-store.js';
import {
  mapGscHttpError,
  type GscAnalyticsInput,
  type GscReadonlyProvider,
  type GscRow,
  type GscSite,
} from './types.js';

/** Default Search Console REST root (webmasters v3). */
export const GSC_BASE_URL = 'https://www.googleapis.com/webmasters/v3';

/** Refresh this far before expiry so a call never races the token clock. */
export const ACCESS_TOKEN_SKEW_MS = 60_000;

/**
 * Google's own default rowLimit is 1000, which silently truncates a
 * page-dimension query on any site with more pages than that — and a truncated
 * set biases fix-candidate scoring with no visible symptom. Ask for the
 * maximum, and treat a full page as truncation rather than as data.
 */
export const DEFAULT_ROW_LIMIT = 25_000;

export interface OnlineGscClientDeps {
  clientId: string;
  clientSecret: string;
  tokenStore: GscTokenStore;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  /** Bounded attempts for retryable faults only (429 / 5xx / network). */
  maxAttempts?: number;
  baseBackoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => string;
}

interface WireSiteEntry {
  siteUrl?: unknown;
  permissionLevel?: unknown;
}

interface WireAnalyticsRow {
  keys?: unknown;
  clicks?: unknown;
  impressions?: unknown;
  ctr?: unknown;
  position?: unknown;
}

type AttemptResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'unauthorized'; error: GrowthAgentError }
  | { status: 'error'; error: GrowthAgentError };

export class OnlineGscClient implements GscReadonlyProvider {
  readonly name = 'gsc-http';
  readonly mode = 'online' as const;

  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly tokenStore: GscTokenStore;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly now: () => string;

  constructor(deps: OnlineGscClientDeps) {
    if (deps.clientId === '' || deps.clientSecret === '') {
      throw GrowthAgentErrors.gscCredentialMissing(
        'GA_GSC_MODE=online requires GA_GSC_CLIENT_ID and GA_GSC_CLIENT_SECRET',
      );
    }
    this.clientId = deps.clientId;
    this.clientSecret = deps.clientSecret;
    // The sealed-token store is wired at construction; whether a refresh token
    // exists yet is checked at call time (first OAuth run has no sealed file).
    this.tokenStore = deps.tokenStore;
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.baseUrl = (deps.baseUrl ?? GSC_BASE_URL).replace(/\/$/, '');
    this.timeoutMs = deps.timeoutMs ?? 15_000;
    this.maxAttempts = deps.maxAttempts ?? 3;
    this.baseBackoffMs = deps.baseBackoffMs ?? 200;
    this.sleepImpl = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async listSites(): Promise<GscSite[]> {
    const parsed = await this.withRetry(() => this.request<{ siteEntry?: unknown }>('GET', '/sites'));
    const entries = Array.isArray(parsed.siteEntry) ? parsed.siteEntry : [];
    return entries
      .map((entry) => {
        const item = (entry ?? {}) as WireSiteEntry;
        return {
          siteUrl: String(item.siteUrl ?? ''),
          permissionLevel: String(item.permissionLevel ?? ''),
        };
      })
      .filter(site => site.siteUrl !== '');
  }

  async queryAnalytics(input: GscAnalyticsInput): Promise<GscRow[]> {
    if (input.siteUrl === '') {
      throw GrowthAgentErrors.validation('queryAnalytics: siteUrl is required');
    }
    const rowLimit = input.rowLimit ?? DEFAULT_ROW_LIMIT;
    const path = `/sites/${encodeURIComponent(input.siteUrl)}/searchAnalytics/query`;
    const parsed = await this.withRetry(() =>
      this.request<{ rows?: unknown }>('POST', path, {
        startDate: input.startDate,
        endDate: input.endDate,
        dimensions: input.dimensions,
        rowLimit,
      }),
    );

    const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
    if (rows.length >= rowLimit) {
      throw GrowthAgentErrors.validation(
        `gsc searchAnalytics returned ${rows.length} rows (rowLimit ${rowLimit}); the window is truncated, narrow the date range`,
      );
    }

    return rows.map((row) => {
      const item = (row ?? {}) as WireAnalyticsRow;
      return {
        keys: Array.isArray(item.keys) ? item.keys.map(key => String(key)) : [],
        clicks: Number(item.clicks ?? 0),
        impressions: Number(item.impressions ?? 0),
        ctr: Number(item.ctr ?? 0),
        position: Number(item.position ?? 0),
      };
    });
  }

  /**
   * Access token for the next call, refreshing when absent or near expiry. A
   * first-run deployment has no sealed token yet: that is reported as
   * GSC_AUTH_REVOKED carrying the token-store state (never its contents), so an
   * operator can tell "no handshake yet" from a transport fault.
   */
  private async accessToken(forceRefresh: boolean): Promise<string> {
    const record = this.tokenStore.load();
    if (record === null) {
      throw GrowthAgentErrors.gscAuthRevoked(
        `no sealed GSC refresh token (${this.tokenStore.describe()}); run the installed-app OAuth handshake once before querying`,
      );
    }
    const current = record.accessToken;
    const expiresAt = record.accessTokenExpiresAt;
    if (
      !forceRefresh &&
      current !== undefined &&
      current !== '' &&
      expiresAt !== undefined &&
      new Date(expiresAt).getTime() - new Date(this.now()).getTime() > ACCESS_TOKEN_SKEW_MS
    ) {
      return current;
    }

    const oauthDeps: OAuthClientDeps = {
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      fetchImpl: this.fetchImpl,
    };
    const set = await refreshAccessToken(oauthDeps, record.refreshToken);
    this.tokenStore.save(toTokenRecord(set, record, this.now));
    return set.accessToken;
  }

  /** Retry only retryable faults; 401/403/4xx business errors are never retried. */
  private async withRetry<T>(op: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await op();
      } catch (err) {
        if (!(err instanceof GrowthAgentError) || !err.retryable) throw err;
        if (attempt >= this.maxAttempts) throw err;
        await this.sleepImpl(this.baseBackoffMs * 2 ** (attempt - 1));
      }
    }
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const first = await this.attempt<T>(method, path, body, false);
    if (first.status === 'ok') return first.value;
    if (first.status === 'unauthorized') {
      const second = await this.attempt<T>(method, path, body, true);
      if (second.status === 'ok') return second.value;
      throw second.error;
    }
    throw first.error;
  }

  private async attempt<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    forceRefresh: boolean,
  ): Promise<AttemptResult<T>> {
    const token = await this.accessToken(forceRefresh);
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      ctrl.abort();
    }, this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: ctrl.signal,
      });
    } catch (err) {
      return {
        status: 'error',
        error: GrowthAgentErrors.upstreamUnavailable(
          `gsc ${method} ${path} unreachable: ${err instanceof Error ? err.message : 'network error'}`,
        ),
      };
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let parsed: unknown = {};
    try {
      parsed = text === '' ? {} : (JSON.parse(text) as unknown);
    } catch {
      parsed = {};
    }

    if (response.ok) return { status: 'ok', value: (parsed ?? {}) as T };
    return {
      status: response.status === 401 ? 'unauthorized' : 'error',
      error: mapGscHttpError(response.status, parsed),
    };
  }
}
