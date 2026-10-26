// Loom content pipeline client port (T-E4).
//
// IMPORTANT — openapi reconciliation: loom exposes ~219 paths and its
// real request/response shapes MUST be verified against the loom openapi
// spec before any online adapter is built. The shapes below mirror the
// documented intent (topic draft submission -> final_id -> review console
// state) but are explicitly marked 待 openapi 对照. This wave ships the
// port plus a deterministic mock only; there is deliberately no HTTP
// adapter and no real loom call.

/**
 * Submitted topic draft.
 * 待 openapi 对照: real field names/path (draft submission endpoint).
 */
export interface LoomTopicDraftInput {
  /** GrowthTask id that requested this content; carried as idempotency key. */
  taskId: string;
  /** The target query (article intent). */
  query: string;
  /** Selected angle / outline hint from the QA intent gate. */
  angle: string;
  /** Target site id; loom must know which adapter/project this is for. */
  siteId: string;
  /** Growth evidence to render in the loom review card. */
  evidenceSignalIds: string[];
}

/**
 * Accepted draft response.
 * 待 openapi 对照: loom may return a draft id or a content id directly.
 */
export interface LoomTopicDraftRef {
  /** In-process loom id for the accepted draft. */
  draftId: string;
  /** 待 openapi 对照: final_id is the only exit id; may arrive later. */
  finalId?: string;
  status: LoomContentStatus;
}

/**
 * Loom review-console states.
 * 待 openapi 对照: exact enum names.
 */
export type LoomContentStatus =
  | 'drafting'
  | 'awaiting_review'
  | 'approved'
  | 'changes_requested'
  | 'rejected'
  | 'published';

/** Full content record once the 13-segment chain finishes. */
export interface LoomContent {
  finalId: string;
  status: LoomContentStatus;
  /** Relative CMS path when approved (the page slug). */
  path?: string;
  title?: string;
  /** Assembled paragraphs; the production batch turns these into PR files. */
  paragraphs?: string[];
}

export interface LoomClient {
  readonly name: string;
  readonly mode: 'mock' | 'online';
  /** Submit a topic draft (idempotent on taskId). */
  submitTopicDraft(input: LoomTopicDraftInput): Promise<LoomTopicDraftRef>;
  /** Fetch the content by final id (polled during the drafting wait). */
  getContent(finalId: string): Promise<LoomContent>;
  /** Review-console status short read. */
  getReviewStatus(finalId: string): Promise<LoomContentStatus>;
}
