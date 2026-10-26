// Domain error type for growth-agent, aligned with the Tier0 error body
// convention { code, message, retryable, details? } (zeus / growth-os share it).
// The HTTP layer maps `status`; the pure domain layer only ever throws this.

export type GrowthAgentErrorCode =
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'INVALID_TRANSITION';

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
};
