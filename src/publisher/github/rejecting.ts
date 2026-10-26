// Fail-closed publisher: selected online without complete configuration.
// Never silently falls back to the offline fake publisher (which would leave
// real tasks unopened). Mirrors the rejecting GSC/SERP/zeus adapters.

import { GrowthAgentErrors } from '../../errors.js';
import type { ChangeRef, ChangeStatus, OpenChangeInput, SitePublisher } from '../types.js';

export class RejectingGithubPublisher implements SitePublisher {
  readonly platform = 'github' as const;

  constructor(private readonly reason: string) {}

  async openChange(_input: OpenChangeInput): Promise<ChangeRef> {
    throw GrowthAgentErrors.credentialMissing(this.reason);
  }

  async getChangeStatus(_ref: string): Promise<ChangeStatus> {
    throw GrowthAgentErrors.credentialMissing(this.reason);
  }
}
