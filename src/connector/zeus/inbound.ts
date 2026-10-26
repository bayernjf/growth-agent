// Inbound zeus decision-event webhook handler (design §2.2 event flow,
// §6.1 dual-track writeback: verify signature -> dedupe by delivery-id ->
// drive the GrowthTask state machine -> audit/failure ledger writes).
//
// Contract, verified against zeus/src/core/decision-service/webhook.ts:
//   POST with `x-zeus-signature: sha256=<hex>` over the EXACT JSON body,
//   `x-zeus-delivery-id: <decisionId>:<type>:<at>` (deterministic per
//   transition; zeus is at-least-once and retries on 5xx/429 only).
//
// Status policy (read before changing):
//   - 401 INVALID_SIGNATURE: unauthenticated -> no state machine, no delivery
//     row (body untrusted; one aggregated channel_failures row instead).
//   - 200 + duplicate:true: a delivery-id already durably classified
//     (accepted OR rejected) is acknowledged so zeus stops retrying. Recovery
//     for rejected events runs through the §9 restart reconciliation
//     (GET /decisions/:id), never through re-delivery.
//   - 422 UNKNOWN_TASK: zeus decision cannot be linked to a local growth_tasks
//     row by zeus_decision_id. Recorded as a rejected delivery + channel_failure;
//     4xx (non-429) tells zeus "business rejection, do not retry" because a
//     200ms retry cannot materialize the missing local task.
//   - 409 INVALID_TRANSITION: real drift (event for a task already past the
//     source state). Recorded as rejected delivery + channel_failure; 409 is
//     the GrowthAgentError vocabulary code and a non-retryable business reply.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { GrowthAgentError } from '../../errors.js';
import { GrowthTaskRepository } from '../../task/repository.js';
import { assertTaskTransition } from '../../task/state-machine.js';
import type { GrowthTaskStatus } from '../../task/types.js';
import type {
  ChannelFailureRepository,
  WebhookDeliveryRepository,
} from './webhook-repository.js';

export type DecisionEventType =
  | 'created'
  | 'late'
  | 'approved'
  | 'rejected'
  | 'timed-out';

const DECISION_EVENT_TYPES: readonly DecisionEventType[] = [
  'created',
  'late',
  'approved',
  'rejected',
  'timed-out',
];

/** The event body zeus POSTs (events.ts decisionEventFromRecord). */
export interface ZeusDecisionEvent {
  type: DecisionEventType;
  decisionId: string;
  at: string;
  domain: string;
  intent: string;
  grade: string;
  mode: string;
  status: string;
  ruleId: string;
  slaHours?: number;
  timeoutAt?: string;
  lateAt?: string;
  outcome?: string;
  approver?: string;
}

/** Verify the `x-zeus-signature` header over the raw body (mirrors zeus signer). */
export function signZeusBody(secret: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
}

/**
 * Constant-time verification. Length mismatch returns false early (timingSafe
 * Equal would throw on unequal buffers); the expected vs received header are
 * both compared as raw strings so a tampered `sha256=<hex>` never passes.
 */
export function verifyZeusSignature(
  secret: string,
  rawBody: string,
  header: string | null | undefined,
): boolean {
  if (secret === '' || header === null || header === undefined) return false;
  const expected = Buffer.from(signZeusBody(secret, rawBody), 'utf8');
  const received = Buffer.from(header, 'utf8');
  if (expected.length !== received.length) return false;
  try {
    return timingSafeEqual(expected, received);
  } catch {
    return false;
  }
}

/** Event type -> required GrowthTaskStatus transition (§3.2). */
const EVENT_TRANSITIONS: Partial<Record<DecisionEventType, GrowthTaskStatus>> = {
  approved: 'drafting',
  rejected: 'rejected',
  'timed-out': 'expired',
};

export interface InboundDeps {
  /** HMAC secret; empty/undefined means the receiver is not configured. */
  secret: string;
  deliveries: WebhookDeliveryRepository;
  failures: ChannelFailureRepository;
  tasks: GrowthTaskRepository;
  now: () => string;
}

export interface InboundResult {
  status: number;
  body: Record<string, unknown>;
}

function failureBody(
  code: string,
  message: string,
  retryable: boolean,
  details?: Record<string, unknown>,
): Record<string, unknown> {
  return { code, message, retryable, ...(details !== undefined ? { details } : {}) };
}

/**
 * Handle one inbound signed POST. Never throws; returns the exact HTTP result
 * the route should send. All ledger writes are best-effort audit: a failure to
 * record must not turn into a crash path, but verification/state results are
 * decided by the state machine, not by the ledger.
 */
export async function handleInboundZeusEvent(
  deps: InboundDeps,
  rawBody: string,
  headers: { signature: string | null; deliveryId: string | null },
): Promise<InboundResult> {
  if (deps.secret === '') {
    return {
      status: 503,
      body: failureBody(
        'WEBHOOK_NOT_CONFIGURED',
        'inbound zeus webhook secret not set; refusing to trust unsigned events',
        true,
      ),
    };
  }
  if (headers.deliveryId === null || headers.deliveryId === undefined || headers.deliveryId === '') {
    return {
      status: 400,
      body: failureBody('MISSING_DELIVERY_ID', 'x-zeus-delivery-id header required', false),
    };
  }
  const deliveryId = headers.deliveryId;

  if (!verifyZeusSignature(deps.secret, rawBody, headers.signature)) {
    await deps.failures.upsert({
      channel: 'zeus_webhook',
      reason: 'INVALID_SIGNATURE',
      ...(deliveryId !== '' ? { externalRef: deliveryId } : {}),
      retryable: false,
      lastError: 'x-zeus-signature missing or mismatch; delivery rejected without state changes',
      now: deps.now(),
    });
    return {
      status: 401,
      body: failureBody('INVALID_SIGNATURE', 'x-zeus-signature mismatch', false),
    };
  }

  let event: ZeusDecisionEvent;
  try {
    const parsed = JSON.parse(rawBody) as Partial<ZeusDecisionEvent>;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      typeof parsed.decisionId !== 'string' ||
      typeof parsed.type !== 'string' ||
      typeof parsed.at !== 'string' ||
      !DECISION_EVENT_TYPES.includes(parsed.type as DecisionEventType)
    ) {
      return {
        status: 400,
        body: failureBody(
          'BAD_EVENT',
          'event must include decisionId, at and a known zeus event type',
          false,
        ),
      };
    }
    event = parsed as ZeusDecisionEvent;
  } catch {
    return { status: 400, body: failureBody('BAD_JSON', 'request body must be JSON', false) };
  }

  // Dedupe: any previously durably classified delivery-id (accepted or
  // rejected) is acknowledged 200 so zeus stops retrying. The state machine
  // is never driven twice; rejected events recover via §9 reconciliation.
  const existing = await deps.deliveries.find(deliveryId);
  if (existing !== undefined) {
    return {
      status: 200,
      body: { ok: true, duplicate: true, deliveryId, decisionId: event.decisionId, type: event.type },
    };
  }

  const desired = EVENT_TRANSITIONS[event.type];

  if (desired === undefined) {
    // created/late: audit-only per the task brief (the orchestrator itself
    // drives signaled->deciding when it POSTs /decisions); late feeds SLA
    // monitoring through this row, no state transition.
    await deps.deliveries.record({
      deliveryId,
      decisionId: event.decisionId,
      eventType: event.type,
      signatureValid: true,
      processingResult: 'accepted',
      eventPayload: event,
      createdAt: deps.now(),
      updatedAt: deps.now(),
    });
    return {
      status: 200,
      body: { ok: true, accepted: true, auditOnly: true, decisionId: event.decisionId, type: event.type },
    };
  }

  const task = await deps.tasks.findByZeusDecisionId(event.decisionId);
  const now = deps.now();

  if (task === undefined) {
    await deps.deliveries.record({
      deliveryId,
      decisionId: event.decisionId,
      eventType: event.type,
      signatureValid: true,
      processingResult: 'rejected',
      errorCode: 'UNKNOWN_TASK',
      eventPayload: event,
      createdAt: now,
      updatedAt: now,
    });
    await deps.failures.upsert({
      channel: 'zeus_webhook',
      reason: 'UNKNOWN_TASK',
      externalRef: event.decisionId,
      retryable: false,
      lastError: `no growth_tasks row references zeus_decision_id=${event.decisionId}`,
      now: deps.now(),
    });
    return {
      status: 422,
      body: failureBody(
        'UNKNOWN_TASK',
        'decision event cannot be linked to a local growth task; reconciliation will catch up',
        false,
        { decisionId: event.decisionId, eventType: event.type },
      ),
    };
  }

  try {
    assertTaskTransition(task.status, desired, { qaRevisionCount: task.qaRevisionCount });
  } catch (err) {
    const code = err instanceof GrowthAgentError ? err.code : 'INVALID_TRANSITION';
    await deps.deliveries.record({
      deliveryId,
      decisionId: event.decisionId,
      eventType: event.type,
      taskId: task.id,
      signatureValid: true,
      processingResult: 'rejected',
      errorCode: code,
      eventPayload: event,
      createdAt: now,
      updatedAt: now,
    });
    await deps.failures.upsert({
      channel: 'zeus_webhook',
      reason: code,
      externalRef: event.decisionId,
      retryable: false,
      lastError: `growth task ${task.id} in status ${task.status} cannot accept ${event.type}`,
      now: deps.now(),
    });
    return {
      status: 409,
      body: failureBody(
        code,
        err instanceof Error ? err.message : `illegal transition to ${desired}`,
        false,
        { taskId: task.id, from: task.status, to: desired },
      ),
    };
  }

  const changed = await deps.tasks.setStatus(task.id, desired, now);
  await deps.deliveries.record({
    deliveryId,
    decisionId: event.decisionId,
    eventType: event.type,
    taskId: task.id,
    signatureValid: true,
    processingResult: 'accepted',
    eventPayload: event,
    createdAt: now,
    updatedAt: now,
  });
  if (changed === 0) {
    // Task vanished between read and write: never happened in practice, but
    // fail loud rather than silently reporting success.
    return {
      status: 500,
      body: failureBody(
        'INTERNAL_ERROR',
        `growth task ${task.id} vanished during state transition`,
        true,
        { taskId: task.id },
      ),
    };
  }
  return {
    status: 200,
    body: { ok: true, accepted: true, decisionId: event.decisionId, taskId: task.id, status: desired },
  };
}
