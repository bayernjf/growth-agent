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
  | 'CREDENTIAL_MISSING';

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
};
