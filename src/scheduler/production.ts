// Production batch (T-A4, design §5.C): after a human approves the zeus
// decision and the task is in drafting, the (external) atlas/loom pipeline
// produces a draft; this runner executes the local portion:
//
//   run QA gates -> on failure apply the one-shot rework transition ->
//   on pass build the PR body and open the change (PR only, never merge) ->
//   persist prRef and move drafting -> pr_opened.
//
// The draft itself is injected (atlas/loom are external and out of scope in
// the offline waves); the runner is transport-agnostic.

import { CostRecorder } from '../cost/recorder.js';
import { buildPrBody } from '../publisher/pr-body.js';
import type { SitePublisher } from '../publisher/types.js';
import { GrowthTaskRepository } from '../task/repository.js';
import { applyQaDecision, runQaGates } from '../qa/orchestrator.js';
import type { ContentDraft, ExistingContent, GscPageEvidence } from '../qa/types.js';
import type { SerpResult } from '../connector/serp/types.js';
import type { PrRef } from '../task/types.js';
import { branchForTask } from '../publisher/github/http.js';
import { GrowthAgentErrors } from '../errors.js';

export interface ProductionBatchInput {
  taskId: string;
  draft: ContentDraft;
  serp: SerpResult[];
  gscPages: GscPageEvidence[];
  existingOpenChanges: ExistingContent[];
  publishedContent: ExistingContent[];
  keywordVolume?: number | undefined;
  /** Short human-readable change summary for the PR body. */
  changeSummary: string;
  /** Repository full name for the prRef (site config in W9). */
  repoFullName: string;
}

export interface ProductionDeps {
  tasks: GrowthTaskRepository;
  publisher: SitePublisher;
  recorder: CostRecorder;
  now: () => string;
}

export interface ProductionBatchResult {
  action: 'pr_opened' | 'qa_revision' | 'failed';
  prRef?: PrRef;
}

export async function runProductionBatch(
  deps: ProductionDeps,
  input: ProductionBatchInput,
): Promise<ProductionBatchResult> {
  const task = await deps.tasks.get(input.taskId);
  if (task === undefined) {
    throw GrowthAgentErrors.notFound(`growth task ${input.taskId}`);
  }
  if (task.status !== 'drafting') {
    throw GrowthAgentErrors.invalidTransition(
      `production batch requires drafting status, got ${task.status}`,
    );
  }

  const decision = await runQaGates({
    draft: input.draft,
    serp: input.serp,
    gscPages: input.gscPages,
    ...(input.keywordVolume !== undefined ? { keywordVolume: input.keywordVolume } : {}),
    existingOpenChanges: input.existingOpenChanges,
    publishedContent: input.publishedContent,
    qaRevisionCount: task.qaRevisionCount,
  });
  await applyQaDecision(deps.tasks, input.taskId, decision, deps.now());

  if (decision.action !== 'pr_opened') {
    return { action: decision.action };
  }

  const [intent, dedupe, value] = decision.qaResult.scores;
  const body = buildPrBody({
    query: input.draft.query,
    changeSummary: input.changeSummary,
    gscEvidence: input.gscPages.map(p => `${p.url} (pos ${p.position}, ${p.impressions} impr)`).join('\n'),
    serpEvidence: input.serp.slice(0, 5).map(r => `#${r.position} ${r.url}`).join('\n'),
    qaScores: { intent: intent ?? 0, dedupe: dedupe ?? 0, value: value ?? 0 },
    taskId: input.taskId,
  });

  const change = await deps.recorder.measure(
    { provider: 'github', method: 'POST', endpoint: 'pulls', taskId: input.taskId },
    async () => {
      // The real atlas/loom pipeline supplies the assembled file; offline
      // runs assemble a deterministic page so the publisher contract runs.
      const content = `# ${input.draft.title}\n\n${input.draft.paragraphs.join('\n\n')}\n`;
      const ref = await deps.publisher.openChange({
        taskId: input.taskId,
        title: `growth-agent: ${input.draft.title}`,
        body,
        files: [{ path: input.draft.slug.replace(/^\/+/, ''), content }],
      });
      return { data: ref, units: 1, httpStatus: 201 };
    },
  );

  const prRef: PrRef = {
    platform: deps.publisher.platform,
    repo: input.repoFullName,
    number: change.number,
    url: change.url,
    // GitHubPublisher derives this exact branch; offline fakes have their own
    // ref convention, so prefer the task-derived branch name for github.
    branch: deps.publisher.platform === 'github' ? branchForTask(input.taskId) : change.ref,
  };
  await deps.tasks.patch(input.taskId, { prRef }, deps.now());
  return { action: 'pr_opened', prRef };
}
