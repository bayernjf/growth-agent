// Draft-source port (§5.C). runProductionBatch takes an already-assembled
// ContentDraft; nothing in the orchestrator ever produced one, so the
// production batch had no caller outside tests. This port is the missing
// supply side: it turns a task in `drafting` into a draft the QA gates can
// judge.
//
// Two modes, both routed through the same registry discipline as the
// connectors:
//   inbox (default) — the operator drops <GA_DRAFT_INBOX_DIR>/<taskId>.json.
//                     Zero network, zero credentials.
//   loom            — the operator supplies only a pre-issued FCW final_id in
//                     that same file; loom writes the article over HTTP.
//
// A draft that is not there yet is the NORMAL state, not an error: `unavailable`
// lets the batch skip the task and leave it in `drafting` for the next run, so
// the CLI is safe to invoke from cron before anyone has written anything.

import type { ContentDraft } from '../qa/types.js';
import type { GrowthTaskType } from '../task/types.js';

export interface DraftRequest {
  taskId: string;
  taskType: GrowthTaskType;
  siteId: string;
  /** Write: the target query. Fix: the declining page URL. */
  query: string;
  /** Fix tasks: the GSC page URL under repair. */
  targetUrl?: string | undefined;
  /** Candidate angle persisted by the morning batch (local loom audit field). */
  angle?: string | undefined;
  /**
   * Already-submitted loom content id, when a previous run started the chain.
   * Passed back so a re-run polls instead of submitting a duplicate generate.
   */
  loomContentId?: string | undefined;
}

export type DraftOutcome =
  | {
      status: 'ready';
      draft: ContentDraft;
      /** Short human-readable summary for the PR body. */
      changeSummary: string;
      /** Set when loom produced the content (persisted as loom_content_id). */
      loomContentId?: string | undefined;
    }
  | {
      status: 'unavailable';
      /** Machine-readable cause, echoed in the batch log. */
      reason: string;
      /**
       * Set when loom already accepted a generate call. The runner persists it
       * even though no draft arrived, so the next run polls this content
       * instead of submitting a second 13-segment chain.
       */
      loomContentId?: string | undefined;
    };

export interface DraftProvider {
  readonly name: string;
  readonly mode: 'inbox' | 'loom';
  obtain(input: DraftRequest): Promise<DraftOutcome>;
}
