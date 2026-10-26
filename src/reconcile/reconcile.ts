// Startup reconciliation (T-A6, design §9.2): zeus webhooks are not
// guaranteed to be delivered (zeus restarts lose in-memory subscriptions,
// network blips lose pushes), so the decision of record is the zeus audit
// timeline. At startup and periodically, every local `deciding` task is
// reconciled against GET /decisions/:id/replay:
//
//   approved  -> drafting
//   rejected  -> rejected
//   timed-out -> expired
//   (created/late/no terminal event) -> unchanged
//
// Illegal local drift is recorded as a channel_failure and left for the
// owner; reconciliation never force-resets state (fail-closed).

import { ChannelFailureRepository } from '../connector/zeus/webhook-repository.js';
import type { ZeusDecisionClient, ZeusDecisionReplay } from '../connector/zeus/types.js';
import { GrowthTaskRepository } from '../task/repository.js';
import { assertTaskTransition } from '../task/state-machine.js';
import type { GrowthTaskStatus } from '../task/types.js';
import { GrowthAgentError } from '../errors.js';

export interface ReconcileSummary {
  reconciled: number;
  unchanged: number;
  /** Terminal-event tasks whose local state already drifted (fail-closed). */
  drifted: number;
  /** Tasks missing a zeus decision id (cannot reconcile; left deciding). */
  missingDecision: number;
}

interface ReconcileDeps {
  tasks: GrowthTaskRepository;
  zeus: ZeusDecisionClient;
  failures?: ChannelFailureRepository;
  now: () => string;
}

const TERMINAL_EVENT_TARGET: Record<string, GrowthTaskStatus> = {
  approved: 'drafting',
  rejected: 'rejected',
  'timed-out': 'expired',
};

/**
 * Reconcile all deciding tasks (or a specific list). Returns counts; the
 * audit timeline is the source of truth, but local illegal drift is never
 * overwritten.
 */
export async function reconcileDecisions(deps: ReconcileDeps): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    reconciled: 0,
    unchanged: 0,
    drifted: 0,
    missingDecision: 0,
  };
  const tasks = await deps.tasks.list('deciding');
  for (const task of tasks) {
    if (task.zeusDecisionId === undefined) {
      summary.missingDecision += 1;
      continue;
    }
    let replay: ZeusDecisionReplay;
    try {
      replay = await deps.zeus.getDecisionAudit(task.zeusDecisionId);
    } catch (err) {
      // Unreachable zeus: leave the task deciding, do not fabricate state.
      if (err instanceof GrowthAgentError && err.status === 404) {
        await deps.failures?.upsert({
          channel: 'zeus',
          reason: 'DECISION_NOT_FOUND',
          retryable: false,
          lastError: `task ${task.id} references missing decision ${task.zeusDecisionId}`,
          externalRef: JSON.stringify({
            decisionId: task.zeusDecisionId,
            taskId: task.id,
          }),
          now: deps.now(),
        });
      }
      summary.unchanged += 1;
      continue;
    }

    const terminal = replay.events.find(e =>
      e.type === 'approved' || e.type === 'rejected' || e.type === 'timed-out',
    );
    if (terminal === undefined) {
      summary.unchanged += 1;
      continue;
    }

    const target = TERMINAL_EVENT_TARGET[terminal.type];
    if (target === undefined) {
      summary.unchanged += 1;
      continue;
    }

    try {
      assertTaskTransition('deciding', target);
    } catch {
      summary.drifted += 1;
      await deps.failures?.upsert({
        channel: 'zeus',
        reason: 'STATE_DRIFT',
        retryable: false,
        lastError: `task ${task.id} deciding but zeus audit reports ${terminal.type}; reconcile refused`,
        externalRef: JSON.stringify({
          decisionId: task.zeusDecisionId,
          taskId: task.id,
          event: terminal.type,
        }),
        now: deps.now(),
      });
      continue;
    }

    await deps.tasks.setStatus(task.id, target, deps.now());
    summary.reconciled += 1;
  }
  return summary;
}
