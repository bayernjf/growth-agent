// Inbound GitHub pull_request webhook handler (T-D3, design §6.1).
//
// Flow mirrors the zeus inbound handler: verify X-Hub-Signature-256 over the
// EXACT raw body -> dedupe by (PR number, normalized action) -> drive the
// GrowthTask state machine -> audit/failure ledger writes.
//
// Status policy (read before changing):
//   - 401 INVALID_SIGNATURE: body untrusted -> no state machine, no delivery
//     row; one aggregated channel_failures row instead.
//   - 200 + duplicate:true: a (number, action) already durably classified is
//     acknowledged so GitHub stops redelivering; the state machine is never
//     driven twice.
//   - 422 UNKNOWN_TASK: PR number cannot be linked to a local growth_tasks
//     row by pr_ref.number. Rejected delivery + channel_failure; a retry
//     cannot materialize the missing local task.
//   - 409 INVALID_TRANSITION: real drift (event for a task past the source
//     state). Rejected delivery + channel_failure; non-retryable business
//     reply.
//
// State mapping (§3.2):
//   opened / reopened      -> pr_opened -> awaiting_merge (idempotent if the
//                             task is already awaiting_merge)
//   closed + merged=true   -> awaiting_merge -> merged -> verifying (the
//                             merged queue records the PR ref, then enters
//                             the next-day verification queue)
//   closed + merged=false  -> awaiting_merge -> cancelled
//   synchronize / others   -> audit only (no state edge in §3.2)
//
// Both merged and unmerged deliveries carry GitHub action 'closed'; the
// ledger action normalizes them to closed-merged / closed-unmerged so a
// legitimate close-after-reopen sequence is not wrongly deduplicated.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { GrowthAgentError } from '../../errors.js';
import type { StorageDriver } from '../../storage/driver.js';
import { assertTaskTransition } from '../../task/state-machine.js';
import type { GrowthTaskStatus, PrRef } from '../../task/types.js';
import { GrowthTaskRepository } from '../../task/repository.js';
import { ChannelFailureRepository } from '../../connector/zeus/webhook-repository.js';
import {
  githubDeliveryId,
  legacyGithubDeliveryId,
  GithubWebhookRepository,
} from './webhook-repository.js';

export interface GithubPullRequest {
  number: number;
  html_url: string;
  state: string;
  merged?: boolean;
  head: { ref: string; sha?: string };
  base: { ref: string };
}

export interface GithubPullRequestEvent {
  action: string;
  pull_request: GithubPullRequest;
  repository: { full_name: string };
}

/** Sign the exact raw body as GitHub does (X-Hub-Signature-256). */
export function signGithubBody(secret: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
}

/** Constant-time verification (mirrors the zeus signature check). */
export function verifyGithubSignature(
  secret: string,
  rawBody: string,
  header: string | null | undefined,
): boolean {
  if (secret === '' || header === null || header === undefined) return false;
  const expected = Buffer.from(signGithubBody(secret, rawBody), 'utf8');
  const received = Buffer.from(header, 'utf8');
  if (expected.length !== received.length) return false;
  try {
    return timingSafeEqual(expected, received);
  } catch {
    return false;
  }
}

/**
 * Normalize the GitHub action + merged flag into the ledger action key.
 * closed-merged and closed-unmerged are distinct (see file header).
 */
export function normalizeAction(event: GithubPullRequestEvent): string {
  if (event.action === 'closed') {
    return event.pull_request.merged === true ? 'closed-merged' : 'closed-unmerged';
  }
  return event.action;
}

export interface GithubInboundDeps {
  secret: string;
  driver: StorageDriver;
  deliveries: GithubWebhookRepository;
  failures: ChannelFailureRepository;
  tasks: GrowthTaskRepository;
  /** Build repositories bound to a transaction handle (tests inject fakes). */
  txTasks?: (tx: StorageDriver) => GrowthTaskRepository;
  txDeliveries?: (tx: StorageDriver) => GithubWebhookRepository;
  now: () => string;
}

export interface GithubInboundResult {
  status: number;
  body: Record<string, unknown>;
}

/** Internal marker: task row vanished between the guarded update and commit. */
class TaskVanishedError extends Error {}

function failureBody(
  code: string,
  message: string,
  retryable: boolean,
  details?: Record<string, unknown>,
): Record<string, unknown> {
  return { code, message, retryable, ...(details !== undefined ? { details } : {}) };
}

function prRefFrom(event: GithubPullRequestEvent): PrRef {
  return {
    platform: 'github',
    repo: event.repository.full_name,
    number: event.pull_request.number,
    url: event.pull_request.html_url,
    branch: event.pull_request.head.ref,
  };
}

export async function handleInboundGithubEvent(
  deps: GithubInboundDeps,
  rawBody: string,
  headers: {
    event: string | null;
    delivery: string | null;
    signature: string | null;
  },
): Promise<GithubInboundResult> {
  if (deps.secret === '') {
    return {
      status: 503,
      body: failureBody(
        'WEBHOOK_NOT_CONFIGURED',
        'inbound github webhook secret not set; refusing to trust unsigned events',
        true,
      ),
    };
  }
  if (headers.event !== 'pull_request') {
    // Other GitHub event types (ping, push, issues...) are out of scope:
    // acknowledge without touching the task state machine.
    return { status: 200, body: { ok: true, ignored: true, event: headers.event ?? null } };
  }
  if (!verifyGithubSignature(deps.secret, rawBody, headers.signature)) {
    await deps.failures.upsert({
      channel: 'github_webhook',
      reason: 'INVALID_SIGNATURE',
      ...(headers.delivery !== null ? { externalRef: headers.delivery } : {}),
      retryable: false,
      lastError: 'x-hub-signature-256 missing or mismatch; delivery rejected without state changes',
      now: deps.now(),
    });
    return {
      status: 401,
      body: failureBody('INVALID_SIGNATURE', 'x-hub-signature-256 mismatch', false),
    };
  }

  let event: GithubPullRequestEvent;
  try {
    const parsed = JSON.parse(rawBody) as Partial<GithubPullRequestEvent>;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      typeof parsed.action !== 'string' ||
      parsed.pull_request === null ||
      typeof parsed.pull_request !== 'object' ||
      typeof parsed.pull_request.number !== 'number' ||
      parsed.repository === null ||
      typeof parsed.repository !== 'object' ||
      typeof (parsed.repository as { full_name?: unknown }).full_name !== 'string'
    ) {
      return {
        status: 400,
        body: failureBody('BAD_EVENT', 'event must include action, pull_request.number and repository.full_name', false),
      };
    }
    event = parsed as GithubPullRequestEvent;
  } catch {
    return { status: 400, body: failureBody('BAD_JSON', 'request body must be JSON', false) };
  }

  const action = normalizeAction(event);
  const prNumber = event.pull_request.number;

  // Audit-only actions: no state edge in §3.2 (new PR commits, reviews, ...).
  // They are repeatable per PR, so the ledger id carries the push head SHA
  // (or the GitHub delivery GUID); lifecycle actions keep a deterministic id.
  // Both shapes are scoped by repository (F-03); the legacy pre-scope id is
  // still probed below so redeliveries of pre-fix events stay deduped.
  const auditOnly = action === 'synchronize' || action === 'edited' || action === 'assigned'
    || action === 'review_requested' || action === 'labeled' || action === 'unlabeled';
  const repoFullName = event.repository.full_name;
  let id: string;
  let legacyId: string;
  if (auditOnly) {
    const repeatKey = event.pull_request.head.sha ?? headers.delivery;
    if (repeatKey === null || repeatKey === '') {
      return {
        status: 400,
        body: failureBody('BAD_EVENT', 'repeatable audit events need a head SHA or delivery id', false),
      };
    }
    id = githubDeliveryId(repoFullName, prNumber, action, repeatKey);
    legacyId = legacyGithubDeliveryId(prNumber, action, repeatKey);
  } else {
    id = githubDeliveryId(repoFullName, prNumber, action);
    legacyId = legacyGithubDeliveryId(prNumber, action);
  }

  const existing = (await deps.deliveries.find(id)) ?? (await deps.deliveries.find(legacyId));
  if (existing !== undefined) {
    return {
      status: 200,
      body: { ok: true, duplicate: true, prNumber, action },
    };
  }

  const now = deps.now();

  // Audit-only actions: record and acknowledge (no state edge).
  if (auditOnly) {
    await deps.deliveries.record({
      id,
      prNumber,
      eventType: 'pull_request',
      action,
      signatureValid: true,
      processingResult: 'ignored',
      eventPayload: event,
      createdAt: now,
      updatedAt: now,
    });
    return {
      status: 200,
      body: { ok: true, accepted: true, auditOnly: true, prNumber, action },
    };
  }

  const desired: { flow: GrowthTaskStatus[]; patchPrRef?: boolean } | undefined =
    action === 'opened' || action === 'reopened'
      ? { flow: ['awaiting_merge'] }
      : action === 'closed-merged'
        ? { flow: ['merged', 'verifying'], patchPrRef: true }
        : action === 'closed-unmerged'
          ? { flow: ['cancelled'] }
          : undefined;

  if (desired === undefined) {
    // Unknown action: audit only and keep the repository reacting safely.
    await deps.deliveries.record({
      id,
      prNumber,
      eventType: 'pull_request',
      action,
      signatureValid: true,
      processingResult: 'ignored',
      eventPayload: event,
      createdAt: now,
      updatedAt: now,
    });
    return {
      status: 200,
      body: { ok: true, accepted: true, ignored: true, prNumber, action },
    };
  }

  const task = await deps.tasks.findByPrNumber(event.repository.full_name, prNumber);
  if (task === undefined) {
    await deps.deliveries.record({
      id,
      prNumber,
      eventType: 'pull_request',
      action,
      signatureValid: true,
      processingResult: 'rejected',
      errorCode: 'UNKNOWN_TASK',
      eventPayload: event,
      createdAt: now,
      updatedAt: now,
    });
    await deps.failures.upsert({
      channel: 'github_webhook',
      reason: 'UNKNOWN_TASK',
      externalRef: String(prNumber),
      retryable: false,
      lastError: `no growth_tasks row references PR #${prNumber} (${event.repository.full_name})`,
      now,
    });
    return {
      status: 422,
      body: failureBody(
        'UNKNOWN_TASK',
        'pull_request event cannot be linked to a local growth task',
        false,
        { prNumber, action },
      ),
    };
  }

  // Walk the transition chain; an illegal edge is rejected without partial
  // writes (the two-step merged -> verifying transition either fully applies
  // or not at all).
  let currentStatus = task.status;
  try {
    for (const target of desired.flow) {
      assertTaskTransition(currentStatus, target, { qaRevisionCount: task.qaRevisionCount });
      currentStatus = target;
    }
  } catch (err) {
    const code = err instanceof GrowthAgentError ? err.code : 'INVALID_TRANSITION';
    await deps.deliveries.record({
      id,
      prNumber,
      eventType: 'pull_request',
      action,
      taskId: task.id,
      signatureValid: true,
      processingResult: 'rejected',
      errorCode: code,
      eventPayload: event,
      createdAt: now,
      updatedAt: now,
    });
    await deps.failures.upsert({
      channel: 'github_webhook',
      reason: code,
      externalRef: String(prNumber),
      retryable: false,
      lastError: `growth task ${task.id} in status ${task.status} cannot accept PR #${prNumber} ${action}`,
      now,
    });
    return {
      status: 409,
      body: failureBody(
        code,
        err instanceof Error ? err.message : `illegal transition chain for ${action}`,
        false,
        { taskId: task.id, from: task.status, to: desired.flow },
      ),
    };
  }

  // Reopened/opened when the task is already in the target state: idempotent
  // no-op (still recorded as accepted so redelivery stops).
  if (currentStatus === task.status) {
    await deps.deliveries.record({
      id,
      prNumber,
      eventType: 'pull_request',
      action,
      taskId: task.id,
      signatureValid: true,
      processingResult: 'accepted',
      eventPayload: event,
      createdAt: now,
      updatedAt: now,
    });
    return {
      status: 200,
      body: { ok: true, accepted: true, noChange: true, taskId: task.id, status: task.status },
    };
  }

  // Persist the final state of the chain (intermediate 'merged' state passes
  // in the same dispatch; no inbound event exists between the two edges).
  const finalStatus = desired.flow[desired.flow.length - 1];
  if (finalStatus === undefined) {
    throw new Error('desired transition chain must not be empty');
  }

  // F-11 (2026-11-02 review): status, optional prRef patch and the delivery
  // ledger are one atomic unit. Previously three independent writes meant a
  // crash after setStatus but before deliveries.record left the task advanced
  // and the event un-ledgered, so GitHub's retry re-drove the state machine
  // (or was rejected as drift). With one transaction a mid-write failure
  // rolls back everything and a redelivery replays cleanly — the ledger row
  // (ON CONFLICT DO NOTHING) keeps the re-entry idempotent once committed.
  try {
    await deps.driver.withTransaction(async (tx) => {
      const txTasks = deps.txTasks?.(tx) ?? new GrowthTaskRepository(tx);
      const txDeliveries = deps.txDeliveries?.(tx) ?? new GithubWebhookRepository(tx);
      const changed = await txTasks.setStatus(task.id, finalStatus, now);
      if (changed === 0) throw new TaskVanishedError(task.id);
      if (desired.patchPrRef === true) {
        await txTasks.patch(task.id, { prRef: prRefFrom(event) }, now);
      }
      await txDeliveries.record({
        id,
        prNumber,
        eventType: 'pull_request',
        action,
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
    // Nothing committed: tell GitHub to retry. The failure row is written
    // outside the rolled-back transaction so the operator sees the cause.
    deps.failures
      .upsert({
        channel: 'github_webhook',
        reason: 'TRANSACTION_FAILED',
        externalRef: String(prNumber),
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
        { taskId: task.id, prNumber, action },
      ),
    };
  }
  return {
    status: 200,
    body: {
      ok: true,
      accepted: true,
      taskId: task.id,
      prNumber,
      status: finalStatus,
    },
  };
}
