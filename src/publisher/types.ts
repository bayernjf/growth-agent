// Multi-site publisher port (design §4.3). Growth-agent only ever OPENS a
// change (branch + files + PR / CMS draft); the final publish step is always
// performed by a human (bot never merges, never pushes directly to main,
// never publishes a CMS draft live).
//
// Idempotency contract (fixed by interface + tests this wave; GitHub adapter
// lands in T-D2/W6): openChange MUST treat `taskId` as the idempotency key —
// re-opening the same taskId returns the previously created change {ref,url,
// number} instead of opening a duplicate PR.

export type PublisherPlatform = 'github' | 'webflow' | 'framer' | 'wordpress';

export interface PublisherFile {
  path: string;
  content: string;
}

export interface OpenChangeInput {
  /** gt_* task id — the idempotency key for openChange. */
  taskId: string;
  title: string;
  /**
   * PR / draft body. MUST be produced by buildPrBody() so it always carries
   * the target query, evidence, QA scores and the "do not auto-merge" line.
   */
  body: string;
  files: PublisherFile[];
}

export interface ChangeRef {
  /** Opaque platform ref (branch name / PR number / draft id). */
  ref: string;
  /** Deep link for the human reviewer. */
  url: string;
  /** PR / draft number (0 for platforms without numeric ids). */
  number: number;
}

export type ChangeStatus = 'open' | 'merged' | 'closed';

export interface SitePublisher {
  readonly platform: PublisherPlatform;
  openChange(input: OpenChangeInput): Promise<ChangeRef>;
  getChangeStatus(ref: string): Promise<ChangeStatus>;
}
