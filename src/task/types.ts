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
}
