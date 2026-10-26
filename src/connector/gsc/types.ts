// GSC read-only connector port (design §4.1). Growth-agent NEVER writes to
// Search Console: the OAuth installed-app flow is strictly scoped to
// `https://www.googleapis.com/auth/webmasters.readonly`.
//
// Error vocabulary (§4.1 table) is preserved verbatim via src/errors.ts:
//   refresh revoked            GSC_AUTH_REVOKED        401 non-retryable
//   scope insufficient         GSC_SCOPE_INSUFFICIENT  403 non-retryable
//   quotaExceeded/userRateLimit GSC_QUOTA              429 retryable
//   site forbidden / deleted   GSC_SITE_FORBIDDEN      403 non-retryable
//   network error / 5xx        UPSTREAM_UNAVAILABLE     503 retryable
//
// Registry discipline (growth-os SearchProvider): default offline fixture;
// online selected without OAuth credentials -> RejectingGscProvider (422
// GSC_CREDENTIAL_MISSING), never a silent offline fallback.

import { GrowthAgentError, GrowthAgentErrors } from '../../errors.js';

/** One searchanalytics row; `keys` aligns 1:1 with the requested dimensions. */
export interface GscRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GscSite {
  siteUrl: string;
  permissionLevel: string;
}

export interface GscAnalyticsInput {
  siteUrl: string;
  /** YYYY-MM-DD. */
  startDate: string;
  endDate: string;
  dimensions: Array<'query' | 'page' | 'date'>;
  rowLimit?: number;
}

export interface GscReadonlyProvider {
  readonly name: string;
  readonly mode: 'offline' | 'online';
  listSites(): Promise<GscSite[]>;
  queryAnalytics(input: GscAnalyticsInput): Promise<GscRow[]>;
}

/**
 * Map a Google Webmasters HTTP failure to the §4.1 error table.
 * Google returns a JSON error envelope `{ error: { code, message, status } }`;
 * the numeric code is the authoritative classifier, HTTP status only a hint.
 * NOTE: the real online transport (T-B4) is not exercised in this wave; this
 * mapper is the contract the T-B4 adapter must call.
 */
export function mapGscHttpError(status: number, rawBody: unknown): GrowthAgentError {
  const body = (rawBody ?? {}) as {
    error?: { code?: unknown; message?: unknown; status?: unknown };
  };
  const gerr = body.error;
  const message =
    typeof gerr?.message === 'string' && gerr.message !== ''
      ? gerr.message
      : `gsc returned HTTP ${status}`;
  const wireStatus = typeof gerr?.status === 'string' ? gerr.status : '';

  if (status === 401) {
    return GrowthAgentErrors.gscAuthRevoked(message, body);
  }
  if (status === 403) {
    const scopeMismatch =
      wireStatus.includes('insufficient') || /insufficient|scope/i.test(message);
    return scopeMismatch
      ? GrowthAgentErrors.gscScopeInsufficient(message, body)
      : GrowthAgentErrors.gscSiteForbidden(message, body);
  }
  if (status === 429) {
    return GrowthAgentErrors.gscQuota(message, body);
  }
  if (status >= 500 || status === 0) {
    return GrowthAgentErrors.upstreamUnavailable(`gsc unreachable: ${message}`, body);
  }
  // Unknown 4xx: do not classify silently; surface as upstream unavailable
  // with the raw envelope preserved so nothing is swallowed.
  return GrowthAgentErrors.upstreamUnavailable(`gsc returned HTTP ${status}`, body);
}
