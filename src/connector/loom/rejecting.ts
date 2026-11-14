// Fail-closed loom client: GA_LOOM_MODE=online selected without
// GA_LOOM_URL / GA_LOOM_TENANT_ID. Every call rejects 422 CREDENTIAL_MISSING
// instead of silently falling back to the offline mock (same discipline as
// the SERP and zeus registries).

import { GrowthAgentErrors } from '../../errors.js';
import type {
  LoomClient,
  LoomContent,
  LoomContentStatus,
  LoomFinalIssueInput,
  LoomTopicDraftInput,
  LoomTopicDraftRef,
} from './types.js';

export class RejectingLoomClient implements LoomClient {
  readonly name = 'loom-rejecting';
  readonly mode = 'online' as const;

  constructor(private readonly message: string) {}

  private fail(): Promise<never> {
    return Promise.reject(GrowthAgentErrors.credentialMissing(this.message));
  }

  issueFinal(_input: LoomFinalIssueInput): Promise<string> {
    return this.fail();
  }

  submitTopicDraft(_input: LoomTopicDraftInput): Promise<LoomTopicDraftRef> {
    return this.fail();
  }

  getContent(_contentId: string): Promise<LoomContent> {
    return this.fail();
  }

  getReviewStatus(_contentId: string): Promise<LoomContentStatus> {
    return this.fail();
  }
}
