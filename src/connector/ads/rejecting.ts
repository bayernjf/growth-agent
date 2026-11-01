// Fail-closed ads provider returned when GA_ADS_MODE=online is selected.
//
// The real 巨量引擎 read-only transport is OP-31 and is blocked on the
// operator's ad-account authorization; until it lands, every read call fails
// 422 ADS_CREDENTIAL_MISSING instead of silently substituting the offline
// fixture (same discipline as RejectingGscProvider / RejectingSearchProvider).

import { GrowthAgentErrors } from '../../errors.js';
import type { AdsReadonlyProvider, AdsReportInput, AdsReportRow } from './types.js';

export class RejectingAdsProvider implements AdsReadonlyProvider {
  readonly name = 'ads-rejecting';
  readonly mode = 'online' as const;

  constructor(private readonly message: string) {}

  private fail(): Promise<never> {
    return Promise.reject(GrowthAgentErrors.adsCredentialMissing(this.message));
  }

  queryReport(_input: AdsReportInput): Promise<AdsReportRow[]> {
    return this.fail();
  }
}
