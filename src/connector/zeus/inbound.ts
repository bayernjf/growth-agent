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
import type { StorageDriver } from '../../storage/driver.js';
import { GrowthTaskRepository } from '../../task/repository.js';
import { assertTaskTransition } from '../../task/state-machine.js';
import type { GrowthTaskStatus } from '../../task/types.js';
import {
  ChannelFailureRepository,
  WebhookDeliveryRepository,
  WebhookNonceRepository,
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

/** Verify the legacy `x-zeus-signature` header over the raw body (mirrors zeus signer). */
export function signZeusBody(secret: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
}

/**
 * v2 signature (mirrors zeus signWebhookPayload): HMAC over the canonical
 * `<unixSeconds>\n<nonce>\n<body>`. Binds the freshness headers to the body.
 */
export function signZeusPayload(secret: string, timestamp: string, nonce: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', secret)
    .update(`${timestamp}\n${nonce}\n${rawBody}`, 'utf8')
    .digest('hex')}`;
}

export interface ZeusRequestHeaders {
  /** Legacy body-only signature. */
  signature: string | null;
  deliveryId: string | null;
  /** v2 freshness headers. */
  webhookSignature?: string | null;
  webhookTimestamp?: string | null;
  webhookNonce?: string | null;
}

type SignatureVerdict =
  | { accepted: true; legacy: boolean }
  | { accepted: false; code: string; message: string };

const NONCE_PATTERN = /^[0-9a-f]{16,128}$/;
const TIMESTAMP_PATTERN = /^\d{10}$/;

/**
 * Verify the request authentication. Prefers v2 when its signature header is
 * present: checks the canonical HMAC, the timestamp skew and the nonce shape;
 * nonce replay is enforced separately by the durable nonce store. Falls back
 * to the legacy body-only signature while zeus and receivers roll out v2.
 */
export function verifyZeusRequest(
  secret: string,
  rawBody: string,
  headers: ZeusRequestHeaders,
  nowEpochSeconds: number,
  maxSkewSeconds = DEFAULT_MAX_SKEW_SECONDS,
): SignatureVerdict {
  if (headers.webhookSignature) {
    const ts = headers.webhookTimestamp ?? null;
    const nonce = headers.webhookNonce ?? null;
    if (ts === null || nonce === null || !TIMESTAMP_PATTERN.test(ts) || !NONCE_PATTERN.test(nonce)) {
      return { accepted: false, code: 'INVALID_SIGNATURE', message: 'malformed v2 freshness headers' };
    }
    const expected = Buffer.from(signZeusPayload(secret, ts, nonce, rawBody), 'utf8');
    const received = Buffer.from(headers.webhookSignature, 'utf8');
    const sigOk =
      expected.length === received.length &&
      (() => {
        try {
          return timingSafeEqual(expected, received);
        } catch {
          return false;
        }
      })();
    if (!sigOk) return { accepted: false, code: 'INVALID_SIGNATURE', message: 'x-zeus-webhook-signature mismatch' };
    const skew = Math.abs(nowEpochSeconds - Number(ts));
    if (skew > maxSkewSeconds) {
      return { accepted: false, code: 'STALE_TIMESTAMP', message: `webhook timestamp outside ${maxSkewSeconds}s skew window` };
    }
    return { accepted: true, legacy: false };
  }
  return verifyZeusSignature(secret, rawBody, headers.signature)
    ? { accepted: true, legacy: true }
    : { accepted: false, code: 'INVALID_SIGNATURE', message: 'x-zeus-signature mismatch' };
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

/**
 * zeus grade ordering (zeus/src/core/grading/grade.ts GRADE_MODES):
 * D0 auto < D1 approve-async < D2 approve-sync < D3 human-led. Note D1 is a
 * genuine human approval too and zeus emits `approved` for it; the >=D2 floor
 * below is therefore growth-agent's OWN domain contract (README: every growth
 * task is graded D2), not a general property of zeus events. A D1 reaching
 * this service means the policy/config is wrong, and failing closed is the
 * wanted behavior.
 */
const GRADE_RANK: Readonly<Record<string, number>> = { D0: 0, D1: 1, D2: 2, D3: 3 };
const MIN_APPROVED_GRADE = 2;

/**
 * Defense in depth (code review H5): the transition webhook is authenticated,
 * but an `approved` event still has to prove it carries the decision grade and
 * SLA the kernel would have required. grade/slaHours are otherwise only type
 * fields that nothing reads.
 */
function approvalGateViolation(event: ZeusDecisionEvent): string | undefined {
  const gradeRank = GRADE_RANK[event.grade];
  if (gradeRank === undefined || gradeRank < MIN_APPROVED_GRADE) {
    return `approved event requires grade >= D2 (got ${JSON.stringify(event.grade)})`;
  }
  if (typeof event.slaHours !== 'number' || !Number.isFinite(event.slaHours) || event.slaHours <= 0) {
    return `approved event requires a positive slaHours (got ${JSON.stringify(event.slaHours)})`;
  }
  return undefined;
}

/** Internal marker: task row vanished between the guarded update and commit. */
class TaskVanishedError extends Error {}

/** Default accepted clock skew for the v2 freshness headers (5 minutes). */
const DEFAULT_MAX_SKEW_SECONDS = 300;

export interface InboundDeps {
  /** HMAC secret; empty/undefined means the receiver is not configured. */
  secret: string;
  driver: StorageDriver;
  deliveries: WebhookDeliveryRepository;
  failures: ChannelFailureRepository;
  tasks: GrowthTaskRepository;
  /** v2 replay-defense store; legacy body-only deliveries do not need it. */
  nonces?: WebhookNonceRepository;
  /** Allowed timestamp skew in seconds (default 300). */
  maxSkewSeconds?: number;
  /** Build repositories bound to a transaction handle (tests inject fakes). */
  txTasks?: (tx: StorageDriver) => GrowthTaskRepository;
  txDeliveries?: (tx: StorageDriver) => WebhookDeliveryRepository;
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
  headers: ZeusRequestHeaders,
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

  const nowIso = deps.now();
  const nowEpoch = Math.floor(Date.parse(nowIso) / 1000);
  const verdict = verifyZeusRequest(deps.secret, rawBody, headers, nowEpoch, deps.maxSkewSeconds);
  if (!verdict.accepted) {
    await deps.failures.upsert({
      channel: 'zeus_webhook',
      reason: verdict.code,
      ...(deliveryId !== '' ? { externalRef: deliveryId } : {}),
      retryable: false,
      lastError: verdict.message,
      now: nowIso,
    });
    return {
      status: 401,
      body: failureBody(verdict.code, verdict.message, false),
    };
  }

  // v2: durably claim the nonce before any state change. A replay of a
  // captured signed request fails here even though its body still parses.
  let webhookNonce: string | undefined;
  if (!verdict.legacy) {
    webhookNonce = headers.webhookNonce ?? undefined;
    if (!deps.nonces || !webhookNonce) {
      return {
        status: 503,
        body: failureBody('NONCE_STORE_UNCONFIGURED', 'v2 webhook accepted but nonce store missing', true),
      };
    }
    const fresh = await deps.nonces.consume(webhookNonce, nowIso);
    if (!fresh) {
      await deps.failures.upsert({
        channel: 'zeus_webhook',
        reason: 'REPLAY_DETECTED',
        ...(deliveryId !== '' ? { externalRef: deliveryId } : {}),
        retryable: false,
        lastError: 'x-zeus-webhook-nonce was already consumed',
        now: nowIso,
      });
      return {
        status: 401,
        body: failureBody('REPLAY_DETECTED', 'webhook nonce already used', false),
      };
    }
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

  if (event.type === 'approved') {
    const gateReason = approvalGateViolation(event);
    if (gateReason !== undefined) {
      // Authenticated but semantically untrusted: never drive the state
      // machine. A 4xx tells zeus not to retry; reconciliation is the path.
      await deps.deliveries.record({
        deliveryId,
        decisionId: event.decisionId,
        eventType: event.type,
        signatureValid: true,
        processingResult: 'rejected',
        errorCode: 'INVALID_APPROVAL_GATE',
        eventPayload: event,
        createdAt: deps.now(),
        updatedAt: deps.now(),
      });
      await deps.failures.upsert({
        channel: 'zeus_webhook',
        reason: 'INVALID_APPROVAL_GATE',
        externalRef: event.decisionId,
        retryable: false,
        lastError: gateReason,
        now: deps.now(),
      });
      return {
        status: 422,
        body: failureBody('INVALID_APPROVAL_GATE', gateReason, false, {
          decisionId: event.decisionId,
        }),
      };
    }
  }

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

  // State transition + delivery ledger are one atomic unit (code review H4):
  // if the ledger write fails the status update rolls back, so a zeus retry
  // replays cleanly instead of hitting a 409 invalid-transition.
  try {
    await deps.driver.withTransaction(async (tx) => {
      const txTasks = deps.txTasks?.(tx) ?? new GrowthTaskRepository(tx);
      const txDeliveries = deps.txDeliveries?.(tx) ?? new WebhookDeliveryRepository(tx);
      const changed = await txTasks.setStatus(task.id, desired, now);
      if (changed === 0) throw new TaskVanishedError(task.id);
      await txDeliveries.record({
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
    });
  } catch (err) {
    if (err instanceof TaskVanishedError) {
      // Task vanished between read and write: never happened in practice, but
      // fail loud rather than silently reporting success.
      return {
        status: 500,
        body: failureBody(
          'INTERNAL_ERROR',
          `growth task ${err.message} vanished during state transition`,
          true,
          { taskId: err.message },
        ),
      };
    }
    // Ledger/transaction failure: nothing committed; tell zeus to retry.
    deps.failures
      .upsert({
        channel: 'zeus_webhook',
        reason: 'TRANSACTION_FAILED',
        externalRef: event.decisionId,
        retryable: true,
        lastError: err instanceof Error ? err.message : 'transaction failed',
        now: deps.now(),
      })
      .catch(() => undefined);
    return {
      status: 500,
      body: failureBody(
        'INTERNAL_ERROR',
        'failed to persist the state transition and delivery ledger',
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
