// GrowthTask state machine (design §3.2). Pure functions: no Hono, no DB.
// Illegal transitions fail closed with INVALID_TRANSITION (HTTP 409), matching
// the growth-os CRM state-machine convention.

import { GrowthAgentErrors } from '../errors.js';
import type { GrowthTaskStatus } from './types.js';

export const GROWTH_TASK_STATUSES: readonly GrowthTaskStatus[] = [
  'signaled',
  'deciding',
  'drafting',
  'qa_revision',
  'pr_opened',
  'awaiting_merge',
  'merged',
  'verifying',
  'done',
  'rejected',
  'expired',
  'cancelled',
  'failed',
];

/**
 * Allowed transitions (§3.2 table + diagram):
 * signaled→deciding; deciding→drafting/rejected/expired/failed(exception);
 * drafting→pr_opened/qa_revision/failed(exception); qa_revision→drafting/failed;
 * pr_opened→awaiting_merge; awaiting_merge→merged/cancelled; merged→verifying;
 * verifying→done. Terminal states have no outgoing edges.
 */
export const GROWTH_TASK_TRANSITIONS: Record<
  GrowthTaskStatus,
  readonly GrowthTaskStatus[]
> = {
  signaled: ['deciding'],
  deciding: ['drafting', 'rejected', 'expired', 'failed'],
  drafting: ['pr_opened', 'qa_revision', 'failed'],
  qa_revision: ['drafting', 'failed'],
  pr_opened: ['awaiting_merge'],
  awaiting_merge: ['merged', 'cancelled'],
  merged: ['verifying'],
  verifying: ['done'],
  done: [],
  rejected: [],
  expired: [],
  cancelled: [],
  failed: [],
};

export const GROWTH_TASK_TERMINAL_STATUSES: ReadonlySet<GrowthTaskStatus> = new Set([
  'done',
  'rejected',
  'expired',
  'cancelled',
  'failed',
]);

export interface TransitionContext {
  /** qa_revision_count persisted on the task; enforces the one-shot rework rule. */
  qaRevisionCount?: number;
}

export function isTerminalStatus(status: GrowthTaskStatus): boolean {
  return GROWTH_TASK_TERMINAL_STATUSES.has(status);
}

/**
 * Assert that moving from `from` to `to` is a legal §3.2 transition. Throws
 * GrowthAgentError(INVALID_TRANSITION, 409) on any illegal move.
 *
 * The qa_revision rework may be used exactly once: the second QA failure after
 * rework must route to `failed`, not back into qa_revision.
 */
export function assertTaskTransition(
  from: GrowthTaskStatus,
  to: GrowthTaskStatus,
  ctx: TransitionContext = {},
): void {
  if (!GROWTH_TASK_STATUSES.includes(to)) {
    throw GrowthAgentErrors.validation('unknown growth task status', { status: to });
  }
  const allowed = GROWTH_TASK_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw GrowthAgentErrors.invalidTransition(
      `cannot move growth task from ${from} to ${to}`,
    );
  }
  const usedRework = ctx.qaRevisionCount ?? 0;
  if (from === 'drafting' && to === 'qa_revision' && usedRework >= 1) {
    throw GrowthAgentErrors.invalidTransition(
      `qa_revision rework already used once; the second QA failure must move drafting→failed`,
    );
  }
}
