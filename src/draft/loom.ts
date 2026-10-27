// Loom-backed draft source (§5.C online half). loom writes the article; the
// operator still owns the envelope, because loom issues `final_id` out-of-band
// via POST /api/fcw/assemble (needs product_space_id + platform + slot_id, which
// growth-agent deliberately has no model for). So this provider reads the same
// inbox file as InboxDraftProvider — for slug / title / changeSummary / finalId
// — and takes the body from loom.
//
// Fail-closed discipline: loom errors propagate (a RejectingLoomClient 422 must
// surface, never degrade to the inbox body). A chain that is still generating is
// reported as `unavailable` WITH its content id so the runner persists it and the
// next cron tick polls instead of re-submitting.

import type { CostRecorder } from '../cost/recorder.js';
import type { LoomClient } from '../connector/loom/types.js';
import { MIN_PARAGRAPHS } from '../qa/value-gate.js';
import { readInboxFile } from './inbox.js';
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
    const finalId = envelope.file.finalId;
    if (finalId === undefined) {
      return {
        status: 'unavailable',
        reason:
          `draft file for ${input.taskId} carries no finalId: loom issues final_id ` +
          'out-of-band via POST /api/fcw/assemble (product_space_id + platform + slot_id)',
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
