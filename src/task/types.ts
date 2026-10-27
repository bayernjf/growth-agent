// GrowthTask domain types (design §3.1). The orchestrator's own state machine;
// external systems (zeus, loom, GitHub) are referenced by id only.

export type GrowthTaskType = 'write' | 'fix' | 'monitor';

export type GrowthTaskStatus =
  | 'signaled'
  | 'deciding'
  | 'drafting'
  | 'qa_revision'
  | 'pr_opened'
  | 'awaiting_merge'
  | 'merged'
  | 'verifying'
  | 'done'
  | 'rejected'
  | 'expired'
  | 'cancelled'
  | 'failed';

/** §3.1: release-adapter output stored on the task. */
export interface PrRef {
  platform: string;
  repo: string;
  number: number;
  url: string;
  branch: string;
}

/** §3.1: pre-PR QA gate snapshot (intent / dedupe / value). */
export interface QaResult {
  intent: boolean;
  dedupe: boolean;
  value: boolean;
  scores: number[];
}

/** §3.1: next-day GSC diff snapshot. */
export interface VerifyResult {
  impressionsDelta: number;
  clicksDelta: number;
  positionDelta: number;
  /**
   * §5.D outcome (extension beyond the three §3.1 deltas, recorded in the
   * same JSON column): `verified` = gain observed; `verified_no_gain` = two
   * consecutive checks with no improvement (also ends the task in done).
   */
  outcome?: 'verified' | 'verified_no_gain';
}

/** §5.D: one next-day recheck record (migration 005 verify_checks). */
export interface VerifyCheck {
  at: string;
  position: number;
  impressions: number;
  clicks: number;
  /** vs baseline: negative positionDelta = moved up in rankings. */
  positionDelta: number;
  impressionsDelta: number;
  clicksDelta: number;
}

/**
 * Candidate context captured by the morning batch (migration 007). The daily
 * runner scores a query (write) or a declining page (fix) and sends both to
 * zeus; persisting them here is what lets the production and verification
 * batches run later, in a separate process, against the stored task alone.
 */
export interface GrowthTaskContext {
  /** Write: the target query. Fix: the declining page URL. */
  query: string;
  /** Fix tasks: the GSC page URL rechecked by §5.D verification. */
  targetUrl?: string | undefined;
  /** The angle string submitted to zeus alongside the decision. */
  angle: string;
  /**
   * Write tasks: the absolute URL the opened PR is expected to publish, derived
   * from the draft slug at PR time so §5.D verification has a page to recheck.
   * A human reviewer who moves the file during review invalidates this; the
   * task then reports no gain rather than guessing a new path.
   */
  publishedUrl?: string | undefined;
}

export interface GrowthTask {
  /** `gt_*` application-generated id (§3.1). */
  id: string;
  siteId: string;
  type: GrowthTaskType;
  signalId?: string;
  zeusDecisionId?: string;
  loomContentId?: string;
  prRef?: PrRef;
  status: GrowthTaskStatus;
  qaResult?: QaResult;
  verifyResult?: VerifyResult;
  /** §5.D accumulated recheck history (migration 005). */
  verifyChecks?: VerifyCheck[];
  /** §5.A candidate context (migration 007): query / targetUrl / angle. */
  context?: GrowthTaskContext;
  /** Persisted counter for the §3.2 one-shot qa_revision rework guard. */
  qaRevisionCount: number;
  costMicrosTotal: number;
  /** `gt:<id>` idempotency key sent to zeus. */
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface GrowthTaskCreateInput {
  id: string;
  siteId: string;
  type: GrowthTaskType;
  signalId?: string;
  /** Defaults to `signaled` (§3.2 entry state). */
  status?: GrowthTaskStatus;
  costMicrosTotal?: number;
  /** §5.A candidate context; required by the later production/verify batches. */
  context?: GrowthTaskContext;
}
