// Ads provider registry (OP-30). Mirrors the GSC registry discipline:
//   - off (default) -> deterministic OfflineAdsProvider (zero network).
//   - online        -> RejectingAdsProvider (422 on every call).
//
// The online branch is deliberately not implemented yet: the real 巨量引擎
// read-only transport is OP-31 and requires the operator's ad-account
// authorization. Selecting online therefore fails closed rather than silently
// falling back to the offline fixture.

import type { AppConfig } from '../../config.js';
import { OfflineAdsProvider } from './offline.js';
import { RejectingAdsProvider } from './rejecting.js';
import type { AdsReadonlyProvider } from './types.js';

export function createAdsReadonlyProvider(config: AppConfig): AdsReadonlyProvider {
  if (config.adsMode === 'online') {
    return new RejectingAdsProvider(
      'GA_ADS_MODE=online requires the ad-account authorization that lands with OP-31 (read-only reporting); no ads credentials are configured',
    );
  }
  return new OfflineAdsProvider();
}
