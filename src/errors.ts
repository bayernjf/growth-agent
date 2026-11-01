// Domain error type for growth-agent, aligned with the Tier0 error body
// convention { code, message, retryable, details? } (zeus / growth-os share it).
// The HTTP layer maps `status`; the pure domain layer only ever throws this.
//
// T-A3 (zeus decision client) extends the vocabulary with the upstream zeus
// decision error codes verbatim — they are NOT collapsed into a generic
// "decision unavailable" so the orchestrator can tell a 409 idempotency
// conflict from a 401/network failure (zeus/src/core/grading/errors.ts,
// zeus/src/http/decision-v1.ts statusForDecisionError).

export type GrowthAgentErrorCode =
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'INVALID_TRANSITION'
  // zeus decision error codes, preserved verbatim (grading/errors.ts).
  | 'DECISION_NOT_FOUND'
  | 'GRADE_REQUIRES_APPROVAL'
  | 'IDEMPOTENCY_CONFLICT'
  | 'APPROVAL_TIMEOUT'
  | 'POLICY_NOT_FOUND'
  | 'INTERNAL_ERROR'
  // local integration errors.
  | 'DECISION_UNAVAILABLE'
  | 'CREDENTIAL_MISSING'
  // GSC read-only connector (design §4.1 error-semantics table, verbatim codes).
  | 'GSC_CREDENTIAL_MISSING'
  | 'GSC_AUTH_REVOKED'
  | 'GSC_SCOPE_INSUFFICIENT'
  | 'GSC_QUOTA'
  | 'GSC_SITE_FORBIDDEN'
  // Ads read-only connector (OP-30; same table shape as GSC).
  | 'ADS_CREDENTIAL_MISSING'
  // Sentiment read-only connector (OP-40; same table shape as GSC).
  | 'SENTIMENT_CREDENTIAL_MISSING'
  | 'SENTIMENT_QUOTA'
  // Shared upstream-unavailable (§4.1 network/5xx row; reused by SERP).
  | 'UPSTREAM_UNAVAILABLE'
  // Generic non-retryable upstream HTTP error (e.g. GitHub 4xx not mapped).
  | 'UPSTREAM_HTTP_ERROR'
  // SERP BYOK provider billing (§4.2: balance exhausted, non-retryable).
  | 'PROVIDER_BILLING'
  // Publisher token / permission failures (§4.3).
  | 'PUBLISH_AUTH'
  // Publisher token valid but lacks write scope / repo access denied (§4.3, 403).
  | 'PUBLISH_FORBIDDEN'
  // Encrypted credential store corruption (§8: bad master key, tampered ciphertext).
  | 'CREDENTIAL_STORAGE_INVALID';

export class GrowthAgentError extends Error {
  readonly code: GrowthAgentErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(
    code: GrowthAgentErrorCode,
    message: string,
    status: number,
    retryable = false,
    details?: unknown,
  ) {
    super(message);
    this.name = 'GrowthAgentError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.details = details;
  }

  toBody(): { code: string; message: string; retryable: boolean; details?: unknown } {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

export const GrowthAgentErrors = {
  validation: (message: string, details?: unknown) =>
    new GrowthAgentError('VALIDATION_FAILED', message, 400, false, details),
  notFound: (what: string) => new GrowthAgentError('NOT_FOUND', `${what} not found`, 404),
  invalidTransition: (message: string) =>
    new GrowthAgentError('INVALID_TRANSITION', message, 409),
  /** Upstream zeus unreachable / timed out / 5xx / 429 — retryable (§9). */
  decisionUnavailable: (message: string, details?: unknown) =>
    new GrowthAgentError('DECISION_UNAVAILABLE', message, 503, true, details),
  /** online mode selected but url/token (or the bearer was rejected) missing. */
  credentialMissing: (message: string) =>
    new GrowthAgentError('CREDENTIAL_MISSING', message, 422),
  // --- GSC read-only connector (§4.1 table) ---
  gscCredentialMissing: (message: string) =>
    new GrowthAgentError('GSC_CREDENTIAL_MISSING', message, 422),
  /** refresh token revoked: re-run the OAuth installed-app flow (401, non-retryable). */
  gscAuthRevoked: (message: string, details?: unknown) =>
    new GrowthAgentError('GSC_AUTH_REVOKED', message, 401, false, details),
  /** token lacks webmasters.readonly scope: install-time fail-closed (403). */
  gscScopeInsufficient: (message: string, details?: unknown) =>
    new GrowthAgentError('GSC_SCOPE_INSUFFICIENT', message, 403, false, details),
  /** quotaExceeded / userRateLimit: bounded backoff, partial snapshot (429, retryable). */
  gscQuota: (message: string, details?: unknown) =>
    new GrowthAgentError('GSC_QUOTA', message, 429, true, details),
  /** site not shared with this OAuth client / deleted: flag site disabled (403). */
  gscSiteForbidden: (message: string, details?: unknown) =>
    new GrowthAgentError('GSC_SITE_FORBIDDEN', message, 403, false, details),
  /** online ads mode selected without an authorized ad account (422, non-retryable). */
  adsCredentialMissing: (message: string) =>
    new GrowthAgentError('ADS_CREDENTIAL_MISSING', message, 422),
  /** online sentiment mode selected without per-source keys (422, non-retryable). */
  sentimentCredentialMissing: (message: string) =>
    new GrowthAgentError('SENTIMENT_CREDENTIAL_MISSING', message, 422),
  /** sentiment source rate-limited (429, retryable). */
  sentimentQuota: (message: string, details?: unknown) =>
    new GrowthAgentError('SENTIMENT_QUOTA', message, 429, true, details),
  /** Network error / upstream 5xx for GSC and SERP connectors (503, retryable). */
  upstreamUnavailable: (message: string, details?: unknown) =>
    new GrowthAgentError('UPSTREAM_UNAVAILABLE', message, 503, true, details),
  /** Provider balance exhausted (§4.2): notify owner to top up; never retry. */
  providerBilling: (message: string, details?: unknown) =>
    new GrowthAgentError('PROVIDER_BILLING', message, 402, false, details),
  /** Publisher token invalid / missing write scope (§4.3, non-retryable). */
  publishAuth: (message: string, details?: unknown) =>
    new GrowthAgentError('PUBLISH_AUTH', message, 401, false, details),
  /** Token accepted but write access denied / forbidden (§4.3, 403 non-retryable). */
  publishForbidden: (message: string, details?: unknown) =>
    new GrowthAgentError('PUBLISH_FORBIDDEN', message, 403, false, details),
  /** Master key absent at runtime / wrong length / GCM auth-tag failure (§8). */
  credentialStorageInvalid: (message: string, details?: unknown) =>
    new GrowthAgentError('CREDENTIAL_STORAGE_INVALID', message, 500, false, details),
};
