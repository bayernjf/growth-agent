// Loom content pipeline client port (T-E4; openapi-reconciled).
//
// WIRE CONTRACT — verified against the loom FastAPI sources read-only
// (backend/app/content/router.py, schemas.py, service.generate_content,
// statemachine.py, core/staff_auth/deps.py). No loom runtime is needed to
// test this adapter; the shapes below mirror the real request/response
// envelope exactly.
//
//   POST /api/content/generate                        -> 201 ContentProductView
//     body { final_id, kind='article', language,
//             actor: { id, roles: ['operations'] } }
//     errors: 403 actor lacks operations role / staff gate on
//             404 final_id not issued (ContentFcwNotFound)
//             409 FCW revoked / duplicate final+lang+kind / generation state
//             422 unknown kind / language not eligible
//             502 generation output invalid
//   GET  /api/content/{content_id}?tenant_id=<required> -> 200 ContentProductView
//     errors: 404 content not found (tenant mismatch -> 404 as well)
//   status enum: draft | generating | review | ready_for_publish
//               | rejected | revising | discarded
//   error envelope: FastAPI {"detail": "..."} (422 detail is a list).
//   auth: default deployment has no gate; when staff_auth_enabled the caller
//         must send `Authorization: Bearer <staff-token>` (401 otherwise).
//
// KNOWN GAPS (operator workflow, deliberately NOT bridged by this adapter):
//   - loom issues final_id out-of-band via POST /api/fcw/assemble, which
//     requires product_space_id + platform + slot_id + goal. growth-agent has
//     no model for those, so submitTopicDraft takes a pre-issued finalId.
//   - approve/reject/revise are the human review console: growth-agent never
//     calls them; D2 human approval stays with the human.
//   - the 13-segment chain runs async (generating -> review); polling cadence
//     belongs to the scheduler, not this port.

/** Loom content lifecycle states (wire `status`, verbatim). */
export type LoomContentStatus =
  | 'draft'
  | 'generating'
  | 'review'
  | 'ready_for_publish'
  | 'rejected'
  | 'revising'
  | 'discarded';

/**
 * Topic draft submission. Only taskId/finalId/language travel on the wire;
 * query/angle/siteId/evidenceSignalIds are local audit fields the loom wire
 * contract does not accept (documented, never fabricated into the request).
 */
export interface LoomTopicDraftInput {
  /** GrowthTask id; wire: actor.id (audit / idempotency trace). */
  taskId: string;
  /** Pre-issued FCW final_id (loom side, out-of-band). Wire: final_id. */
  finalId: string;
  /** Local audit record only; NOT sent over the loom wire. */
  query: string;
  /** Local audit record only; NOT sent over the loom wire. */
  angle: string;
  /** Local audit record only; NOT sent over the loom wire. */
  siteId: string;
  /** Local audit record only; NOT sent over the loom wire. */
  evidenceSignalIds: string[];
  /** Wire: language; default GA_LOOM_LANGUAGE or 'en' when unset. */
  language?: string | undefined;
}

/** Accepted draft response (POST /api/content/generate -> ContentProductView). */
export interface LoomTopicDraftRef {
  /** Wire: content_id — the polling handle for getContent/getReviewStatus. */
  contentId: string;
  /** Wire: final_id echo. */
  finalId: string;
  status: LoomContentStatus;
}

/**
 * Full content record (GET /api/content/{content_id} -> ContentProductView).
 * `body` is the single assembled article string (wire: body); the wire has no
 * paragraphs array and no separate title field — goal carries the article goal.
 */
export interface LoomContent {
  contentId: string;
  finalId: string;
  status: LoomContentStatus;
  /** Wire: goal (frozen article goal from the FCW). */
  goal: string;
  /** Wire: platform. */
  platform: string;
  /** Wire: body — assembled article text; null while generating. */
  body: string | null;
  /** Wire: published_url; non-null once ops backfill the published link. */
  publishedUrl: string | null;
  /** Wire: quality_score; advisory only (never auto-approves). */
  qualityScore: number | null;
}

export interface LoomClient {
  readonly name: string;
  readonly mode: 'mock' | 'online';
  /** Kick off the 13-segment chain for a pre-issued finalId. */
  submitTopicDraft(input: LoomTopicDraftInput): Promise<LoomTopicDraftRef>;
  /** Fetch the content by content id (wire: path content_id, tenant_id query). */
  getContent(contentId: string): Promise<LoomContent>;
  /** Review-console status short read (wire: status field of the same view). */
  getReviewStatus(contentId: string): Promise<LoomContentStatus>;
}
