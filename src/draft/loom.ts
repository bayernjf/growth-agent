// Loom-backed draft source (§5.C online half). loom writes the article; the
// operator still owns the envelope, supplying either a pre-issued `finalId` or
// the assemble material (productSpaceId + platform + slotId + goal) that lets
// this provider issue the final_id itself via POST /api/fcw/assemble.
// growth-agent still has no model for loom's publishing-asset topology — those
// ids arrive verbatim from the envelope, never derived here. So this provider
// reads the same inbox file as InboxDraftProvider — for slug / title /
// changeSummary / finalId (or issue material) — and takes the body from loom.
//
// Fail-closed discipline: loom errors propagate (a RejectingLoomClient 422 must
// surface, never degrade to the inbox body). A chain that is still generating is
// reported as `unavailable` WITH its content id so the runner persists it and the
// next cron tick polls instead of re-submitting.

import type { CostRecorder } from '../cost/recorder.js';
import type { LoomClient } from '../connector/loom/types.js';
import { MIN_PARAGRAPHS } from '../qa/value-gate.js';
import { readInboxFile } from './inbox.js';
import type { InboxDraftFile } from './inbox.js';
import type { DraftOutcome, DraftProvider, DraftRequest } from './types.js';

export interface LoomDraftDeps {
  loom: LoomClient;
  /** Directory holding the operator envelope (finalId / slug / title). */
  inboxDir: string;
  /** When present, loom calls are metered into the §11.1 ledger as `llm`. */
  recorder?: CostRecorder | undefined;
}

/**
 * loom's wire `body` is one assembled article string with no paragraphs array;
 * split on blank lines. Markdown headings survive as their own paragraph, which
 * the value gate treats as body text.
 */
export function splitBodyParagraphs(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map(paragraph => paragraph.trim())
    .filter(paragraph => paragraph !== '');
}

/** loom states that no amount of polling will move forward. */
const ENDED_LOOM_STATUSES: ReadonlySet<string> = new Set(['rejected', 'discarded']);

export class LoomDraftProvider implements DraftProvider {
  readonly name = 'draft-loom';
  readonly mode = 'loom' as const;

  constructor(private readonly deps: LoomDraftDeps) {}

  async obtain(input: DraftRequest): Promise<DraftOutcome> {
    const envelope = readInboxFile(this.deps.inboxDir, input.taskId, {
      requireParagraphs: false,
    });
    if (envelope.status !== 'ok') {
      return { status: 'unavailable', reason: envelope.reason };
    }
    const finalId = await this.resolveFinalId(envelope.file);
    if (finalId === null) {
      return {
        status: 'unavailable',
        reason:
          `draft file for ${input.taskId} carries no finalId and no loom issue material ` +
          '(productSpaceId + platform + slotId + goal): issue final_id via POST /api/fcw/assemble ' +
          'or add the issue material to the envelope',
      };
    }

    const contentId = await this.resolveContentId(input, finalId);
    const content = await this.measure('GET', 'loom:content:get', () =>
      this.deps.loom.getContent(contentId),
    );

    if (ENDED_LOOM_STATUSES.has(content.status)) {
      return {
        status: 'unavailable',
        reason: `loom content ${content.contentId} ended as ${content.status}; a new final_id must be issued`,
        loomContentId: contentId,
      };
    }
    if (content.body === null || content.body.trim() === '') {
      return {
        status: 'unavailable',
        reason: `loom content ${content.contentId} still ${content.status}; no assembled body yet`,
        loomContentId: contentId,
      };
    }

    const paragraphs = splitBodyParagraphs(content.body);
    if (paragraphs.length < MIN_PARAGRAPHS) {
      return {
        status: 'unavailable',
        reason:
          `loom body for ${content.contentId} split into ${paragraphs.length} paragraphs, ` +
          `below the value gate minimum ${MIN_PARAGRAPHS}`,
        loomContentId: contentId,
      };
    }

    return {
      status: 'ready',
      draft: {
        taskType: input.taskType,
        query: input.query,
        slug: envelope.file.slug,
        title: envelope.file.title,
        paragraphs,
      },
      changeSummary: envelope.file.changeSummary,
      loomContentId: contentId,
    };
  }

  /**
   * Resolve the final_id to submit under: reuse the operator-issued finalId when
   * present, otherwise auto-issue one from the envelope's assemble material. The
   * four required assemble fields live in the envelope, so the operator no longer
   * has to issue and paste the final_id out-of-band.
   */
  private async resolveFinalId(file: InboxDraftFile): Promise<string | null> {
    if (file.finalId !== undefined) return file.finalId;
    const { productSpaceId, platform, slotId, goal } = file;
    if (productSpaceId === undefined || platform === undefined || slotId === undefined || goal === undefined) {
      return null;
    }
    return this.measure('POST', 'loom:fcw:assemble', () =>
      this.deps.loom.issueFinal({
        productSpaceId,
        platform,
        slotId,
        goal,
        country: file.country,
        pwsId: file.pwsId,
      }),
    );
  }

  /**
   * Reuse a previously submitted content id, or start the chain once. loom's
   * generate has no idempotency key, so submitting twice would run two chains
   * for one task.
   */
  private async resolveContentId(input: DraftRequest, finalId: string): Promise<string> {
    if (input.loomContentId !== undefined) return input.loomContentId;
    const ref = await this.measure('POST', 'loom:content:generate', () =>
      this.deps.loom.submitTopicDraft({
        taskId: input.taskId,
        finalId,
        query: input.query,
        angle: input.angle ?? '',
        siteId: input.siteId,
        evidenceSignalIds: [],
      }),
    );
    return ref.contentId;
  }

  private async measure<T>(method: string, endpoint: string, fn: () => Promise<T>): Promise<T> {
    const recorder = this.deps.recorder;
    if (recorder === undefined) return fn();
    return recorder.measure(
      { provider: 'llm', method, endpoint },
      async () => ({ data: await fn(), units: 1, httpStatus: 200 }),
    );
  }
}
