// Deterministic in-memory loom mock (T-E4). It implements the port with the
// openapi-shaped payloads the online adapter will eventually send, so the
// daily/production pipeline can be exercised end-to-end with no loom
// process. Records are keyed by taskId (submit) and finalId (fetch); tests
// can seed a terminal status via constructor state.

import { GrowthAgentErrors } from '../../errors.js';
import type {
  LoomClient,
  LoomContent,
  LoomContentStatus,
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
  private readonly byFinalId = new Map<string, LoomContent>();
  private readonly statusByFinalId: Map<string, LoomContentStatus>;

  constructor(state: MockLoomState = {}) {
    this.statusByFinalId = state.statusByFinalId ?? new Map();
  }

  async submitTopicDraft(input: LoomTopicDraftInput): Promise<LoomTopicDraftRef> {
    if (input.taskId === '' || input.query === '') {
      throw GrowthAgentErrors.validation('submitTopicDraft: taskId and query are required');
    }
    const existing = this.byTaskId.get(input.taskId);
    if (existing !== undefined) return existing;

    const finalId = `loom_final_${input.taskId}`;
    const status: LoomContentStatus = this.statusByFinalId.get(finalId) ?? 'awaiting_review';
    const ref: LoomTopicDraftRef = { draftId: `loom_draft_${input.taskId}`, finalId, status };
    this.byTaskId.set(input.taskId, ref);
    this.byFinalId.set(finalId, {
      finalId,
      status,
      path: `guides/${input.query.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      title: input.query,
      paragraphs: [
        `Mock loom segment for: ${input.query}`,
        'The angle was selected by the growth-agent intent gate.',
        'Replace this mock content with the real 13-segment chain output.',
      ],
    });
    return ref;
  }

  async getContent(finalId: string): Promise<LoomContent> {
    const content = this.byFinalId.get(finalId);
    if (content === undefined) {
      throw GrowthAgentErrors.notFound(`loom content ${finalId}`);
    }
    const overridden = this.statusByFinalId.get(finalId);
    return overridden === undefined ? { ...content } : { ...content, status: overridden };
  }

  async getReviewStatus(finalId: string): Promise<LoomContentStatus> {
    const overridden = this.statusByFinalId.get(finalId);
    if (overridden !== undefined) return overridden;
    const content = this.byFinalId.get(finalId);
    if (content === undefined) {
      throw GrowthAgentErrors.notFound(`loom content ${finalId}`);
    }
    return content.status;
  }
}
