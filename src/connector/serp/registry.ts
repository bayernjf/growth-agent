// SERP provider registry (growth-os / zeus discipline):
//   off (default)  -> deterministic OfflineSerpProvider (zero BYOK spend).
//   online + login/password -> DataForSeoProvider (T-C1 transport skeleton;
//     real-key smoke test is T-C2).
//   online without login/password -> RejectingSerpProvider (422 on every
//     call); never silently downgraded to the offline fixture.

import type { AppConfig } from '../../config.js';
import { DataForSeoProvider } from './http.js';
import { OfflineSerpProvider } from './offline.js';
import { RejectingSerpProvider } from './rejecting.js';
import type { SerpKeywordProvider } from './types.js';

export function createSerpKeywordProvider(config: AppConfig): SerpKeywordProvider {
  if (config.serpMode === 'online') {
    if (!config.serpLogin || !config.serpPassword) {
      return new RejectingSerpProvider(
        'GA_SERP_MODE=online requires GA_SERP_DATAFORSEO_LOGIN and GA_SERP_DATAFORSEO_PASSWORD (BYOK)',
      );
    }
    return new DataForSeoProvider({ login: config.serpLogin, password: config.serpPassword });
  }
  return new OfflineSerpProvider();
}
