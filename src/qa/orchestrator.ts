// QA orchestrator: runs the three hard-coded gates (§6.3) for a task in the
// `drafting` state and produces the next state action, validating it against
// the §3.2 state machine:
//
//   all gates pass        drafting → pr_opened
//   any gate fails, once  drafting → qa_revision (counter 0 → 1)
//   fails after rework    drafting → failed      (counter >= 1, no PR)
//
// The runner is transport-agnostic (no Hono); `applyQaDecision` is the
// persistence wiring used by the future production-batch step (W7).

import { assertTaskTransition } from '../task/state-machine.js';
import type { GrowthTaskRepository } from '../task/repository.js';
import type { QaResult } from '../task/types.js';
import { intentGate } from './intent-gate.js';
import { dedupeGate } from './dedupe-gate.js';
import { valueGate } from './value-gate.js';
import type {
  ContentKind,
  GateVerdict,
  QaDecision,
  QaRunReport,
  RunQaInput,
} from './types.js';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function contentKindOf(draft: RunQaInput['draft']): ContentKind {
  return draft.taskType === 'fix' ? 'page_fix' : 'informational_article';
}

/** Run the three gates. All gates always run so the report is complete. */
export async function runQaGates(input: RunQaInput): Promise<QaDecision> {
  const kind = contentKindOf(input.draft);
  const intent = await intentGate(
    {
      query: input.draft.query,
      contentKind: kind,
      serp: input.serp,
    },
    input.classifier,
  );
  const dedupe = dedupeGate({
    draft: input.draft,
    gscPages: input.gscPages,
    existingOpenChanges: input.existingOpenChanges,
    publishedContent: input.publishedContent,
  });
  const value = valueGate({
    draft: input.draft,
    keywordVolume: input.keywordVolume,
    gscPages: input.gscPages,
  });
  const report: QaRunReport = { intent, dedupe, value };
  const qaResult: QaResult = {
    intent: intent.pass,
    dedupe: dedupe.pass,
    value: value.pass,
    scores: [round2(intent.score), round2(dedupe.score), round2(value.score)],
  };

  const allPass = intent.pass && dedupe.pass && value.pass;
  if (allPass) {
    assertTaskTransition('drafting', 'pr_opened');
    return { action: 'pr_opened', qaResult, report, nextRevisionCount: input.qaRevisionCount };
  }

  if (input.qaRevisionCount === 0) {
    assertTaskTransition('drafting', 'qa_revision', { qaRevisionCount: 0 });
    return { action: 'qa_revision', qaResult, report, nextRevisionCount: 1 };
  }

  // One rework already used (§3.2): the second QA failure is terminal.
  assertTaskTransition('drafting', 'failed', {
    qaRevisionCount: input.qaRevisionCount,
  });
  return {
    action: 'failed',
    qaResult,
    report,
    nextRevisionCount: input.qaRevisionCount,
  };
}

/**
 * Persist a QA decision on the task: qaResult snapshot is always written, the
 * rework counter is incremented on qa_revision, then status moves.
 * Returns rows changed by the status update (0 = task vanished).
 */
export async function applyQaDecision(
  repo: GrowthTaskRepository,
  taskId: string,
  decision: QaDecision,
  now: string,
): Promise<number> {
  if (decision.action === 'qa_revision') {
    await repo.patch(
      taskId,
      { qaResult: decision.qaResult, qaRevisionCount: decision.nextRevisionCount },
      now,
    );
  } else {
    await repo.patch(taskId, { qaResult: decision.qaResult }, now);
  }
  return repo.setStatus(taskId, decision.action, now);
}

/** Suggested gate dispositions (for logging / candidate routing). */
export function failedGateActions(report: QaRunReport): GateVerdict[] {
  return [report.intent, report.dedupe, report.value].filter((v) => !v.pass);
}
