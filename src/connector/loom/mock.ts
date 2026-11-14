// Deterministic offline loom mock (T-E4; openapi-reconciled). It implements
// the port with the real wire shapes the HttpLoomClient speaks, so the daily
// production pipeline runs end-to-end with no loom process. Records are keyed
// by taskId (submit) and contentId (fetch); tests can seed a terminal status
// via constructor state. The offline shortcut: the 13-segment chain completes
// instantly and lands in `review` (awaiting the human review console).

import { GrowthAgentErrors } from '../../errors.js';
import type {
  LoomClient,
  LoomContent,
  LoomContentStatus,
  LoomFinalIssueInput,
  LoomTopicDraftInput,
  LoomTopicDraftRef,
} from './types.js';

export interface MockLoomState {
  /** Override the status returned for a final id. */
  statusByFinalId?: Map<string, LoomContentStatus>;
}

export class MockLoomClient implements LoomClient {
  readonly name = 'loom-mock';
  readonly mode = 'mock' as const;
  private readonly byTaskId = new Map<string, LoomTopicDraftRef>();
  private readonly byContentId = new Map<string, LoomContent>();
  private readonly statusByFinalId: Map<string, LoomContentStatus>;

  constructor(state: MockLoomState = {}) {
    this.statusByFinalId = state.statusByFinalId ?? new Map();
  }

  async issueFinal(input: LoomFinalIssueInput): Promise<string> {
    if (input.productSpaceId === '' || input.platform === '' || input.slotId === '' || input.goal === '') {
      throw GrowthAgentErrors.validation(
        'issueFinal: productSpaceId, platform, slotId and goal are required',
      );
    }
    // Deterministic per space+slot: mirrors loom's DuplicateIssuance idempotency
    // (same material -> same final_id), so repeated assembly reuses the id.
    return `fcw_${input.productSpaceId}_${input.slotId}`;
  }

  async submitTopicDraft(input: LoomTopicDraftInput): Promise<LoomTopicDraftRef> {
    if (input.taskId === '' || input.query === '' || input.finalId === '') {
      throw GrowthAgentErrors.validation(
        'submitTopicDraft: taskId, query and finalId are required',
      );
    }
    const existing = this.byTaskId.get(input.taskId);
    if (existing !== undefined) return existing;

    const contentId = `loom_content_${input.taskId}`;
    const status: LoomContentStatus = this.statusByFinalId.get(input.finalId) ?? 'review';
    const body = [
      `# ${input.query}`,
      '',
      `The angle was selected by the growth-agent ${input.angle} gate.`,
      '',
      'Offline mock body: replace with the real 13-segment chain output ' +
        '(wire GET /api/content/{content_id} -> body).',
    ].join('\n');
    const ref: LoomTopicDraftRef = { contentId, finalId: input.finalId, status };
    this.byTaskId.set(input.taskId, ref);
    this.byContentId.set(contentId, {
      contentId,
      finalId: input.finalId,
      status,
      goal: input.query,
      platform: input.siteId,
      body,
      publishedUrl: null,
      qualityScore: null,
    });
    return ref;
  }

  async getContent(contentId: string): Promise<LoomContent> {
    const content = this.byContentId.get(contentId);
    if (content === undefined) {
      throw GrowthAgentErrors.notFound(`loom content ${contentId}`);
    }
    const overridden = this.statusByFinalId.get(content.finalId);
    return overridden === undefined ? { ...content } : { ...content, status: overridden };
  }

  async getReviewStatus(contentId: string): Promise<LoomContentStatus> {
    const content = this.byContentId.get(contentId);
    if (content === undefined) {
      throw GrowthAgentErrors.notFound(`loom content ${contentId}`);
    }
    const overridden = this.statusByFinalId.get(content.finalId);
    return overridden ?? content.status;
  }
}
