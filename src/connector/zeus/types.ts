// Zeus decision client port (T-A3). Growth-agent never grades locally; it only
// speaks the zeus Decision API v1 over HTTP/openapi.
//
// Endpoint facts verified against zeus source (do not re-guess):
//   POST /api/v1/decisions            -> 201 DecisionResponse  (decision-v1.ts createDecisionRoute; server.ts:2772)
//   GET  /api/v1/decisions/:id/replay?format=json -> audit timeline (decision-v1.ts replayRoute; server.ts:2780)
//                                      NOTE: there is NO `/decisions/:id/audit` route; the audit
//                                      chain is exposed by `/replay`. The task brief named
//                                      `/audit`; the real, callable audit endpoint is `/replay`.
//   GET  /api/v1/policy               -> DecisionPolicy      (decision-v1.ts getPolicyRoute; server.ts:2782).
//                                      NOTE: singular `/policy`, NOT `/policies`. Used for ping.
//   GET  /api/v1/decision-webhooks    -> { webhooks: [{id,url,active}] } (server.ts:2791)
//   POST /api/v1/decision-webhooks    -> 201 {id,url,active}; body {url, secret>=16, active?} (server.ts:2793, addWebhookRoute)
//   Auth: every route uses `Authorization: Bearer <ZEUS_INTERNAL_TOKEN>` (server.ts:445 requireBearer).
//
// Error body (decision-v1.ts sendDecisionError): { code, message, retryable, details? }.
// Status mapping (decision-v1.ts statusForDecisionError):
//   GRADE_REQUIRES_APPROVAL / IDEMPOTENCY_CONFLICT / APPROVAL_TIMEOUT -> 409
//   DECISION_NOT_FOUND -> 404 ; POLICY_NOT_FOUND -> 500 ; everything else -> 400.

import { GrowthAgentError } from '../../errors.js';

/** POST /api/v1/decisions 201 body (decision-v1.ts DecisionResponse). */
export interface ZeusDecisionResponse {
  decisionId: string;
  grade: string;
  mode: string;
  status: string;
  ruleId: string;
  proposal?: unknown;
  auditSeq: number;
}

/** GET /api/v1/decisions/:id/replay?format=json body (decision-v1.ts replayRoute). */
export interface ZeusDecisionReplay {
  format: 'json';
  record: unknown;
  events: Array<{ type: string; at: string; detail?: Record<string, unknown> }>;
}

/** GET /api/v1/policy body (decision-v1.ts getPolicyRoute -> DecisionPolicy). */
export interface ZeusPolicy {
  version: number;
  defaultGrade: string;
  rules: Array<{ id: string; grade: string; slaHours?: number }>;
}

/**
 * What the orchestrator hands the client for one daily write/fix task.
 * The §3.3 growth-domain field mapping (domain=intent/impact/reversibility/
 * riskTags/proposal of growth.content vs growth.fix) is applied INSIDE the
 * client, so callers never hand-craft zeus wire fields.
 */
export interface GrowthDecisionInput {
  /** `gt_*` task id; becomes idempotencyKey `gt:<taskId>` (types.ts GrowthTask). */
  taskId: string;
  /** write -> growth.content ; fix -> growth.fix. */
  kind: 'write' | 'fix';
  query: string;
  /** Human-readable angle rationale (goes into proposal.angle). */
  angle: string;
  /** Target page URL (fix tasks carry the dropping page). */
  targetUrl?: string;
  /** growth-os signal ids backing this decision. */
  evidenceSignalIds: string[];
}

/** Wire body for POST /api/v1/decision-webhooks (addWebhookRoute). */
export interface ZeusWebhookSubscriptionBody {
  url: string;
  secret: string;
  active: boolean;
}

export interface ZeusSelfCheckResult {
  ping: boolean;
  policyVersion: number;
  policyDefaultGrade: string;
  /** True only when this boot actually re-registered the callback webhook. */
  resubscribed: boolean;
  webhookUrl?: string;
}

/** Port implemented by offline / online / rejecting variants. */
export interface ZeusDecisionClient {
  readonly name: string;
  readonly mode: 'offline' | 'online';
  submitDecision(input: GrowthDecisionInput): Promise<ZeusDecisionResponse>;
  getDecisionAudit(decisionId: string): Promise<ZeusDecisionReplay>;
  getPolicies(): Promise<ZeusPolicy>;
  /** Lightweight liveness probe; resolves false (never throws) on any failure. */
  ping(): Promise<boolean>;
  /** Build the POST /api/v1/decision-webhooks body (§6.2; secret>=16 enforced). */
  buildSubscriptionPayload(args: {
    callbackUrl: string;
    secret: string;
  }): ZeusWebhookSubscriptionBody;
  /**
   * Boot sequence (§6.2): ping -> policy reachability -> idempotently re-attach
   * the decision webhook (zeus subscriptions are in-memory and lost on restart).
   * Fails closed on any reachability step.
   */
  startupSelfCheck(args?: {
    callbackUrl?: string;
    secret?: string;
  }): Promise<ZeusSelfCheckResult>;
}

/**
 * Build the POST /api/v1/decisions wire body from a growth input (§3.3).
 * Keys are exactly the ones zeus validateDecisionRequest accepts (service.ts):
 * intent, domain, amount, riskTags, impact, reversibility, proposal, idempotencyKey.
 */
export function buildDecisionRequest(input: GrowthDecisionInput): Record<string, unknown> {
  const domain = input.kind === 'write' ? 'growth.content' : 'growth.fix';
  const intent =
    input.kind === 'write'
      ? `write: "${input.query}"`
      : `fix: ${input.targetUrl ?? input.query}`;
  return {
    intent,
    domain,
    impact: 'org',
    reversibility: 'hard',
    riskTags: ['seo_quality'],
    proposal: {
      query: input.query,
      angle: input.angle,
      evidenceSignalIds: input.evidenceSignalIds,
      ...(input.targetUrl !== undefined ? { targetUrl: input.targetUrl } : {}),
    },
    idempotencyKey: `gt:${input.taskId}`,
  };
}

/**
 * Map a zeus error body to a GrowthAgentError. The upstream code is preserved
 * verbatim; status is derived from the code per zeus's own status table so a
 * mis-wired upstream cannot silently re-classify a 409 as a 2xx.
 */
export function mapUpstreamError(status: number, rawBody: unknown): GrowthAgentError {
  const body = (rawBody ?? {}) as {
    code?: unknown;
    message?: unknown;
    retryable?: unknown;
    details?: unknown;
  };
  const code = typeof body.code === 'string' ? body.code : '';
  const message =
    typeof body.message === 'string' && body.message !== ''
      ? body.message
      : `zeus returned HTTP ${status}`;
  const retryable = body.retryable === true;

  switch (code) {
    case 'DECISION_NOT_FOUND':
      return new GrowthAgentError('DECISION_NOT_FOUND', message, 404, false, body.details);
    case 'GRADE_REQUIRES_APPROVAL':
    case 'IDEMPOTENCY_CONFLICT':
    case 'APPROVAL_TIMEOUT':
      return new GrowthAgentError(code, message, 409, false, body.details);
    case 'POLICY_NOT_FOUND':
    case 'INTERNAL_ERROR':
      return new GrowthAgentError(code, message, 500, false, body.details);
    default:
      // VALIDATION_FAILED and any structural/unknown upstream code -> 400, but
      // the raw code is preserved in details so nothing is swallowed.
      return new GrowthAgentError('VALIDATION_FAILED', message, 400, retryable, {
        ...(code !== '' ? { zeusCode: code } : {}),
        upstreamStatus: status,
        ...(body.details !== undefined ? { upstreamDetails: body.details } : {}),
      });
  }
}
