// GSC provider registry. Mirrors growth-os provider registry + zeus registry:
//   - off (default)  -> deterministic OfflineGscProvider (zero network).
//   - online + client id/secret + master key -> OnlineGscClient (real
//     searchAnalytics transport, T-B4).
//   - online without full OAuth config -> RejectingGscProvider (422 on any
//     call); never silently downgraded to the offline fixture.

import type { AppConfig } from '../../config.js';
import { decodeMasterKey } from './crypto.js';
import { OnlineGscClient } from './online.js';
import { OfflineGscProvider } from './offline.js';
import { RejectingGscProvider } from './rejecting.js';
import { GscTokenStore } from './token-store.js';
import type { GscReadonlyProvider } from './types.js';

export function createGscReadonlyProvider(config: AppConfig): GscReadonlyProvider {
  if (config.gscMode === 'online') {
    if (!config.gscClientId || !config.gscClientSecret || !config.growthMasterKey) {
      return new RejectingGscProvider(
        'GA_GSC_MODE=online requires GA_GSC_CLIENT_ID, GA_GSC_CLIENT_SECRET and GA_GROWTH_MASTER_KEY (strictly read-only OAuth)',
      );
    }
    // Master-key length/format errors surface as CREDENTIAL_STORAGE_INVALID
    // at registry time (fail-closed boot), they are NOT retried against offline.
    const masterKey = decodeMasterKey(config.growthMasterKey);
    const tokenStore = new GscTokenStore({ dir: config.gscTokenDir, masterKey });
    return new OnlineGscClient({
      clientId: config.gscClientId,
      clientSecret: config.gscClientSecret,
      tokenStore,
    });
  }
  return new OfflineGscProvider(undefined, undefined, {
    rolling: config.gscOfflineRolling === true,
  });
}
