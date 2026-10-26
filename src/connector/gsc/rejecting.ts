// Fail-closed GSC provider returned when GA_GSC_MODE=online is selected but
// the OAuth client / master key configuration is incomplete (mirrors
// growth-os RejectingSearchProvider / RejectingZeusClient). The process can
// still boot; every read call fails 422 GSC_CREDENTIAL_MISSING instead of
// silently substituting the offline fixture.

import { GrowthAgentErrors } from '../../errors.js';
import type { GscAnalyticsInput, GscReadonlyProvider, GscRow, GscSite } from './types.js';

export class RejectingGscProvider implements GscReadonlyProvider {
  readonly name = 'gsc-rejecting';
  readonly mode = 'online' as const;

  constructor(private readonly message: string) {}

  private fail(): Promise<never> {
    return Promise.reject(GrowthAgentErrors.gscCredentialMissing(this.message));
  }

  listSites(): Promise<GscSite[]> {
    return this.fail();
  }

  queryAnalytics(_input: GscAnalyticsInput): Promise<GscRow[]> {
    return this.fail();
  }
}
