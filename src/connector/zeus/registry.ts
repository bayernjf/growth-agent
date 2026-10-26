// Zeus decision client registry. Mirrors growth-os provider/decision registry:
//   - off (default)  -> deterministic OfflineZeusClient (zero network).
//   - online + url/token -> OnlineZeusClient over fetch.
//   - online without url/token -> RejectingZeusClient (422 on any call); it is
//     never silently downgraded to the offline fixture.

import type { AppConfig } from '../../config.js';
import { OfflineZeusClient } from './offline.js';
import { OnlineZeusClient } from './http.js';
import { RejectingZeusClient } from './rejecting.js';
import type { ZeusDecisionClient } from './types.js';

export function createZeusDecisionClient(config: AppConfig): ZeusDecisionClient {
  if (config.zeusMode === 'online') {
    if (!config.zeusUrl || !config.zeusToken) {
      return new RejectingZeusClient(
        'GA_ZEUS_MODE=online requires GA_ZEUS_URL and GA_ZEUS_TOKEN',
      );
    }
    return new OnlineZeusClient({ baseUrl: config.zeusUrl, token: config.zeusToken });
  }
  return new OfflineZeusClient();
}
